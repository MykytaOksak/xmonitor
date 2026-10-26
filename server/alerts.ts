// Price-alert evaluation, run after every engine cycle. Same rules the browser
// used to apply, now in the one process that is always running.
import { NET } from '../src/config/networks';
import { allPairs, pairName } from '../src/config/pairs';
import { fmtPrice } from '../src/engine/format';
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

export function evaluateAlerts(now = Date.now()): AlertHit[] {
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
        if (!row || row.status !== 'live' || now - row.at > MAX_QUOTE_AGE_MS) continue;
        const price = side === 'buy' ? row.buy : row.sell;
        if (price == null) continue;
        const crossed = cfg.op === 'above' ? price >= target : price <= target;
        if (!crossed) continue;

        fired[key] = now;
        hits.push({
          pairId: pair.id,
          side,
          text:
            `⚡ ${pairName(pair)} ${side.toUpperCase()} on ${netName}: ` +
            `${fmtPrice(price, pair.dp)} is ${cfg.op} target ${cfg.price} (${row.router})`,
        });
        break; // one firing per side per cooldown window
      }
    }
  }
  if (hits.length) kvSet('fired', fired);
  return hits;
}
