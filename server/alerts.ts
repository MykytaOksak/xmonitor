// Price-alert evaluation, run after every engine cycle. Same rules the browser
// used to apply, now in the one process that is always running.
import { NET, type NetworkId } from '../src/config/networks';
import { allPairs, pairName } from '../src/config/pairs';
import { requoteNet } from '../src/engine/engine';
import { fmtPrice } from '../src/engine/format';
import type { NetQuote } from '../src/engine/types';
import { useApp } from '../src/state/store';
import { kvGet, kvSet } from './db';
import { alertIsActive, getSettings } from './settings';

// A quote older than this is a leftover from a network that has since stopped
// answering, not a price anyone could trade at.
const MAX_QUOTE_AGE_MS = 5 * 60_000;

export interface AlertHit {
  pairId: string;
  side: 'buy' | 'sell';
  text: string;
}

const fired: Record<string, number> = kvGet('fired', {});

/**
 * Selling for more than it costs to buy back is a round trip that pays, which
 * no real market offers. Aggregators produce it now and then (a stale
 * prop-AMM price, an odd route), and those are exactly the outliers that cross
 * a tight target, so such a quote never fires an alert.
 */
const isCrossed = (row: NetQuote): boolean => row.buy != null && row.sell != null && row.sell > row.buy;

const usable = (row: NetQuote | null | undefined, now: number): row is NetQuote =>
  !!row && row.status === 'live' && now - row.at <= MAX_QUOTE_AGE_MS && !isCrossed(row);

const meets = (price: number | null, op: 'above' | 'below', target: number): price is number =>
  price != null && (op === 'above' ? price >= target : price <= target);

let running = false;

/**
 * Checks every active alert against the latest quotes. A quote that meets a
 * target is quoted once more before anything is sent, and the alert fires only
 * if the fresh quote meets it too, so a one-off outlier never reaches Telegram.
 */
export async function evaluateAlerts(now = Date.now()): Promise<AlertHit[]> {
  // A confirmation can outlast a short cycle; never check the same pair twice
  // at once, or one crossing could be confirmed and sent twice.
  if (running) return [];
  running = true;
  try {
    return await check(now);
  } finally {
    running = false;
  }
}

async function check(now: number): Promise<AlertHit[]> {
  const { savedAlerts, disabledNets } = getSettings();
  const { snapshots } = useApp.getState();
  const hits: AlertHit[] = [];

  for (const pair of allPairs()) {
    const alert = savedAlerts[pair.id];
    if (!alertIsActive(alert)) continue;
    const snap = snapshots[pair.id];
    if (!snap) continue;

    for (const side of ['buy', 'sell'] as const) {
      const cfg = alert![side];
      if (!cfg.enabled) continue;
      const target = parseFloat(cfg.price);
      if (!isFinite(target)) continue;
      const cooldownMs = Math.max(1, parseInt(cfg.cooldown || '15', 10)) * 60_000;
      const key = `${pair.id}:${side}`;
      if (now - (fired[key] ?? 0) < cooldownMs) continue;

      for (const netId of pair.networks) {
        if (disabledNets[`${pair.id}:${netId}`]) continue;
        const netName = NET(netId).name;
        if (cfg.netMode === 'selected' && cfg.nets[netName] === false) continue;
        const row = snap.rows[netId];
        if (!usable(row, now) || !meets(row[side], cfg.op, target)) continue;

        const fresh = await confirm(pair.id, netId);
        if (!usable(fresh, Date.now())) continue;
        const price = fresh[side];
        if (!meets(price, cfg.op, target)) continue;

        fired[key] = Date.now();
        hits.push({
          pairId: pair.id,
          side,
          text:
            `⚡ ${pairName(pair)} ${side.toUpperCase()} on ${netName}: ` +
            `${fmtPrice(price, pair.dp)} is ${cfg.op} target ${cfg.price} (${fresh.router})`,
        });
        break; // one firing per side per cooldown window
      }
    }
  }
  if (hits.length) kvSet('fired', fired);
  return hits;
}

async function confirm(pairId: string, netId: NetworkId): Promise<NetQuote | null> {
  try {
    return await requoteNet(pairId, netId);
  } catch {
    return null;
  }
}
