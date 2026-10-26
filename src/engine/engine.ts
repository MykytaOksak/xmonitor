import { NET, NETWORKS, type NetworkId } from '../config/networks';
import { allPairs, pairById, type PairConfig } from '../config/pairs';
import { isXStock, tokenOn, type TokenDeployment } from '../config/tokens';
import { fmtPrice, nowTime } from './format';
import { quote } from './providers';
import { refreshRates, usdcUsdtRate, vaultRate, xstockUiScale, xstockWrapRate } from './rates';
import { sendTelegram } from './telegram';
import { setBackgroundTimeout } from './timers';
import { defaultAlert, useApp } from '../state/store';
import type { NetQuote } from './types';

const CONCURRENCY = 4;

// ——— token resolution (with per-chain substitutions) ———
// A resolved token carries its on-chain deployment plus converters between the
// pair's nominal token and the token actually quoted, so prices stay expressed
// in the nominal token's terms.
interface ResolvedToken {
  dep: TokenDeployment;
  /** nominal amount -> amount to send to the quote (actual token units). */
  toActual: (nominal: number) => number;
  /** actual amount received -> amount in nominal-token terms. */
  toNominal: (actual: number) => number;
}

/**
 * Ethereum apxUSD/USDC quote, both sides, in USDC per apxUSD: `sell` is what
 * selling apxUSD realises, `buy` is what buying it back costs. Cached as a pair
 * from the same row so the two always belong to one quote, and so a cycle in
 * which Ethereum is mid-refresh doesn't drop the rows that depend on it.
 *
 * The cache expires: when Ethereum keeps failing (as it does when apxUSD
 * liquidity thins out) the last good quote would otherwise be reused for
 * hours. Zero means "cannot price yet", which callers turn into ERR.
 */
const APX_RATE_MAX_AGE_MS = 10 * 60_000; // a couple of missed scan cycles
const _apxUsdc = { buy: 0, sell: 0, at: 0 };
function apxUsdcRates(): { buy: number; sell: number } {
  const row = useApp.getState().snapshots['apxUSD-USDC']?.rows.ethereum;
  const ok = (v: number | null | undefined): v is number => v != null && isFinite(v) && v > 0;
  if (row?.status === 'live' && ok(row.buy) && ok(row.sell)) {
    _apxUsdc.buy = row.buy;
    _apxUsdc.sell = row.sell;
    _apxUsdc.at = row.at;
  }
  return Date.now() - _apxUsdc.at <= APX_RATE_MAX_AGE_MS ? _apxUsdc : { buy: 0, sell: 0 };
}

function resolveToken(symbol: string, netId: NetworkId, pair: PairConfig): ResolvedToken | null {
  // Hydration lists no apxUSD, so the apyUSD/apxUSD pair trades its USDC market
  // and converts at the rate each direction would really pay on Ethereum:
  //  - funding a buy means SELLING apxUSD for USDC -> Ethereum sell rate;
  //  - proceeds of a sell come back as USDC and must BUY apxUSD -> Ethereum buy
  //    rate. One rate for both would overstate Hydration's sell price by the
  //    whole apxUSD/USDC spread (~0.65% when measured), surfacing opportunities
  //    that vanish once the buy-back is paid for.
  // Without the rates the size would be off by ~1.4%, so the row errors rather
  // than guessing 1:1. Both pairs default to the same notional, so the
  // conversion is priced at the trade's own size.
  if (netId === 'hydration' && symbol === 'apxUSD') {
    const dep = tokenOn('USDC', 'hydration');
    const { buy, sell } = apxUsdcRates();
    if (!dep || buy <= 0 || sell <= 0) return null;
    return {
      dep,
      toActual: (n) => n * sell, // apxUSD sold -> USDC to spend on Hydration
      toNominal: (a) => a / buy, // USDC received -> apxUSD bought back
    };
  }
  // A custom pair carries its own deployments, so take them literally — no
  // registry lookup and none of the substitutions below. The only conversion
  // is the opt-in USDT -> USDC one, for venues that only list against USDT.
  const own = pair.custom?.[netId];
  if (own) {
    const dep = symbol === pair.t0 ? own.t0 : own.t1;
    if (!dep) return null;
    if (dep.cexQuote && own.usdcAdjust) {
      const rate = usdcUsdtRate(); // USDT per USDC
      return { dep, toActual: (n) => n * rate, toNominal: (a) => a / rate };
    }
    // Same shape as the built-in X Layer xStock wrapper: the vault is what
    // trades, so quote it and convert amounts by its redemption rate.
    if (dep.wrappedVault) {
      const rate = vaultRate(netId, dep.address); // underlying per wrapped
      return { dep, toActual: (n) => n / rate, toNominal: (a) => a * rate };
    }
    return { dep, toActual: (n) => n, toNominal: (a) => a };
  }
  // Plasma has no canonical USDC — quote against USDT0 and convert amounts by
  // the live Binance USDC/USDT rate so prices remain in USDC terms.
  if (netId === 'plasma' && symbol === 'USDC') {
    const dep = tokenOn('USDT', 'plasma');
    if (dep) {
      const rate = usdcUsdtRate(); // USDT per USDC
      return { dep, toActual: (n) => n * rate, toNominal: (a) => a / rate };
    }
  }
  // Ink is the same story: its USDC is effectively unquotable on-chain (the
  // USDC/USDG pool holds cents) while the deep market is against USD₮0, so
  // quote that and convert back by the live Binance rate to keep USDC terms.
  if (netId === 'ink' && symbol === 'USDC') {
    const dep = tokenOn('USDT', 'ink');
    if (dep) {
      const rate = usdcUsdtRate(); // USDT per USDC
      return { dep, toActual: (n) => n * rate, toNominal: (a) => a / rate };
    }
  }
  // Binance lists RLUSD against USDT only. Scoped to the RLUSD market because
  // Binance's USDC mapping is real USDC — USD1/USDC trades USD1USDC there, and
  // a venue-wide swap would move it to the wrong book.
  if (netId === 'binanceCex' && symbol === 'USDC' && pair.t0 === 'RLUSD') {
    const dep = tokenOn('USDT', 'binanceCex');
    if (dep) {
      const rate = usdcUsdtRate(); // USDT per USDC
      return { dep, toActual: (n) => n * rate, toNominal: (a) => a / rate };
    }
  }
  // Bybit lists USDe against USDT only, so quote that book and convert the
  // amounts by the live Binance USDC/USDT rate to keep prices in USDC terms —
  // the same substitution the USDT-only chains above make.
  if (netId === 'bybitCex' && symbol === 'USDC') {
    const dep = tokenOn('USDT', 'bybitCex');
    if (dep) {
      const rate = usdcUsdtRate(); // USDT per USDC
      return { dep, toActual: (n) => n * rate, toNominal: (a) => a / rate };
    }
  }
  // X Layer routes USDG through USD₮0: the USDG/USD₮0 pool is ~5x the USDG/USDC
  // one (3.7M + 1.6M vs 312k + 691k), so quote that and convert by the live
  // Binance rate to keep prices in USDC terms. Scoped to the USDG market on
  // purpose — GOOGLx and QQQx genuinely trade against USDC on X Layer, and
  // substituting their quote leg would move them to the wrong market.
  if (netId === 'xlayer' && symbol === 'USDC' && (pair.t0 === 'USDG' || pair.t1 === 'USDG')) {
    const dep = tokenOn('USDT', 'xlayer');
    if (dep) {
      const rate = usdcUsdtRate(); // USDT per USDC
      return { dep, toActual: (n) => n * rate, toNominal: (a) => a / rate };
    }
  }
  // xStocks trade through a proxy on two of their three venues:
  //  - X Layer: the Uniswap liquidity sits in the wrapped ERC-4626 vault, so
  //    quote w<SYM> and convert by the vault's live convertToAssets() rate.
  //  - Solana: the mint is Token-2022 with the scaled-UI-amount extension and
  //    Jupiter quotes in RAW units, so convert to the displayed balance.
  // Both factors are the same underlying accrual; OKX needs no conversion.
  if (isXStock(symbol)) {
    if (netId === 'xlayer') {
      const dep = tokenOn(`w${symbol}`, 'xlayer');
      if (dep) {
        const rate = xstockWrapRate(symbol); // base per wrapped
        return { dep, toActual: (n) => n / rate, toNominal: (a) => a * rate };
      }
    }
    if (netId === 'solana') {
      const dep = tokenOn(symbol, 'solana');
      if (dep) {
        const scale = xstockUiScale(symbol); // displayed per raw unit
        return { dep, toActual: (n) => n / scale, toNominal: (a) => a * scale };
      }
    }
  }
  const dep = tokenOn(symbol, netId);
  return dep ? { dep, toActual: (n) => n, toNominal: (a) => a } : null;
}

// ——— tiny promise pool ———
function pLimit(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      const run = () => {
        active++;
        fn().then(resolve, reject).finally(next);
      };
      active < max ? run() : queue.push(run);
    });
}

const limit = pLimit(CONCURRENCY);

// ——— per-network quote fetch ———
async function fetchNetQuote(pair: PairConfig, netId: NetworkId, notional: number): Promise<NetQuote> {
  const net = NET(netId);
  const t0 = resolveToken(pair.t0, netId, pair);
  const t1 = resolveToken(pair.t1, netId, pair);
  if (!t0 || !t1) {
    return {
      netId, buy: null, sell: null, router: '—', status: 'error', at: Date.now(),
      err: `no ${t0 ? pair.t1 : pair.t0} quote leg on ${netId}`,
    };
  }
  try {
    // Quote at the real notional so BUY/SELL reflect the rate you'd actually
    // get at that size (including price impact) — a small probe would show a
    // marginal rate that differs from a real trade on shallow pools. Genuinely
    // thin/broken pools blow the round-trip apart and get caught by the gate.
    // BUY t0 with t1: buyPrice = t1 per t0.
    const buyRes = await quote({
      net, tokenIn: t1.dep, tokenOut: t0.dep, amountInHuman: t1.toActual(notional),
    });
    // outHuman is in the ACTUAL traded token; convert to the nominal token the
    // pair is denominated in (identity unless t0 was substituted, e.g. wSPYx).
    const t0Out = buyRes.outHuman;
    const t0OutNominal = t0.toNominal(t0Out);
    const buyPrice = notional / t0OutNominal;
    // SELL exactly what the buy produced: convert t1 received back to nominal.
    const sellRes = await quote({
      net, tokenIn: t0.dep, tokenOut: t1.dep, amountInHuman: t0Out,
    });
    const sellPrice = t1.toNominal(sellRes.outHuman) / t0OutNominal;

    // Sanity gate: a healthy market round-trips near par (buy ≈ sell). A large
    // gap means the route hit a broken / near-empty pool or a wrong token —
    // surface ERR instead of a nonsense number.
    if (![buyPrice, sellPrice].every((p) => isFinite(p) && p > 0)) {
      throw new Error('non-finite quote');
    }
    if (Math.abs(sellPrice - buyPrice) / buyPrice > 0.15) {
      throw new Error('unreliable quote — thin/broken liquidity');
    }
    return {
      netId, buy: buyPrice, sell: sellPrice, router: buyRes.router, status: 'live', at: Date.now(),
    };
  } catch (e) {
    return {
      netId, buy: null, sell: null, router: '—', status: 'error', at: Date.now(),
      err: e instanceof Error ? e.message : String(e),
    };
  }
}

function notionalFor(pairId: string): number {
  const s = useApp.getState();
  return s.amounts[pairId] ?? pairById(pairId).defaultNotional;
}

async function scanPair(pair: PairConfig): Promise<boolean> {
  const s = useApp.getState();
  if (s.disabledPairs[pair.id]) return false;
  const nets = pair.networks.filter((n) => !s.disabledNets[`${pair.id}:${n}`]);
  const notional = notionalFor(pair.id);
  // Seed rows that have never produced data as "loading"; keep last prices
  // visible during refresh otherwise (terminal-crisp, no flicker).
  for (const n of nets) {
    const existing = s.snapshots[pair.id]?.rows[n];
    if (!existing || existing.status === 'loading') {
      s.updateRow(pair.id, { netId: n, buy: null, sell: null, router: '—', status: 'loading', at: 0 });
    }
  }
  // Fetch each network independently: mark it "refreshing" when its turn in the
  // concurrency pool comes up, then write its result the moment it lands — so
  // rows update live one-by-one instead of all-at-once at the end.
  const rows = await Promise.all(
    nets.map((n) =>
      limit(async () => {
        useApp.getState().setRefreshing(pair.id, n, true);
        const row = await fetchNetQuote(pair, n, notional);
        useApp.getState().updateRow(pair.id, row);
        return row;
      }),
    ),
  );
  useApp.getState().finishPair(pair.id);
  return rows.some((r) => r.status === 'live');
}

// ——— alert evaluation (client-side; the app has no backend) ———
// Alert cooldowns are kept in localStorage and re-read on every pass rather
// than cached in a module variable: a second app tab (or a duplicated module
// after HMR) is a separate engine with its own memory, and each one would fire
// the same alert while the other's write went unseen — which is how a 30-minute
// cooldown produced two identical messages a second apart.
const FIRED_KEY = 'xmonitor.fired';

function readFired(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(FIRED_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function writeFired(fired: Record<string, number>): void {
  try {
    localStorage.setItem(FIRED_KEY, JSON.stringify(fired));
  } catch {
    /* ignore quota/serialisation errors */
  }
}

function evalAlerts() {
  const s = useApp.getState();
  const now = Date.now();
  const lastFired = readFired();
  for (const [pairId, alert] of Object.entries(s.savedAlerts)) {
    if (s.disabledPairs[pairId]) continue;
    const pair = pairById(pairId);
    const snap = s.snapshots[pairId];
    if (!snap) continue;
    for (const side of ['buy', 'sell'] as const) {
      const cfg = alert[side];
      if (!cfg.enabled) continue;
      const target = parseFloat(cfg.price);
      if (!isFinite(target)) continue;
      const cooldownMs = Math.max(1, parseInt(cfg.cooldown || '15', 10)) * 60_000;
      const key = `${pairId}:${side}`;
      if (now - (lastFired[key] ?? 0) < cooldownMs) continue;

      for (const netId of pair.networks) {
        if (s.disabledNets[`${pairId}:${netId}`]) continue;
        const netName = NET(netId).name;
        if (cfg.netMode === 'selected' && cfg.nets[netName] === false) continue;
        const row = snap.rows[netId];
        if (!row || row.status !== 'live') continue;
        const price = side === 'buy' ? row.buy : row.sell;
        if (price == null) continue;
        const crossed = cfg.op === 'above' ? price >= target : price <= target;
        if (!crossed) continue;

        // Re-read immediately before committing so a fire from another tab
        // between this pass starting and now still wins the cooldown.
        const fresh = readFired();
        if (now - (fresh[key] ?? 0) < cooldownMs) break;
        fresh[key] = now;
        lastFired[key] = now;
        writeFired(fresh);
        const text =
          `⚡ ${pair.t0}/${pair.t1} ${side.toUpperCase()} on ${netName}: ` +
          `${fmtPrice(price, pair.dp)} is ${cfg.op} target ${cfg.price}`;
        void sendTelegram(text);
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification('XARB alert', { body: text });
        }
        break; // one firing per side per cooldown window
      }
    }
  }
}

// ——— scan loop ———
let scanning = false;
let scanStartedAt = 0;
// If a scan has "run" longer than this it's presumed stuck (e.g. its fetches
// froze with the tab), so a new scan is allowed through instead of being
// blocked forever by the guard — this is what let the app hang on return.
// A legitimate full scan of every pair takes tens of seconds, so keep this well
// above that — it only exists to release a scan whose fetches never settled.
const STUCK_SCAN_MS = 180_000;
let cancelLoop: (() => void) | undefined;
let staleTimer: ReturnType<typeof setInterval> | undefined;
let started = false;

export async function scanAll(): Promise<void> {
  if (scanning && Date.now() - scanStartedAt < STUCK_SCAN_MS) return;
  scanning = true;
  scanStartedAt = Date.now();
  const app = useApp.getState();
  app.set({ engineSync: 'syncing' });
  try {
    // A rate-fetch failure must not abort the scan — Plasma scaling falls back
    // to the last cached USDC/USDT rate.
    try {
      await refreshRates();
    } catch {
      /* keep last cached rate */
    }
    const activePairs = allPairs().filter((p) => !useApp.getState().disabledPairs[p.id]);
    // Never let one rejected pair reject the whole cycle (which would break the
    // reschedule chain and freeze the engine — see scheduleNext).
    const liveFlags = await Promise.all(activePairs.map((p) => scanPair(p).catch(() => false)));
    const anyLive = liveFlags.some(Boolean);
    useApp.getState().set({
      engineSync: anyLive || activePairs.length === 0 ? 'synced' : 'error',
      lastSync: nowTime(),
      lastSyncAt: Date.now(),
    });
    evalAlerts();
  } catch {
    useApp.getState().set({ engineSync: 'error' });
  } finally {
    scanning = false;
  }
}

/** Manual refresh (banners' Refresh now / Retry, Settings SYNCING). */
export function refreshNow(): void {
  useApp.getState().set({ simulatedSync: null });
  void scanAll().then(scheduleNext, scheduleNext);
}

function scheduleNext(): void {
  cancelLoop?.();
  const secs = Math.max(5, useApp.getState().refresh || 15);
  // Worker-backed so the loop keeps its real cadence in a background tab.
  cancelLoop = setBackgroundTimeout(
    () => void scanAll().then(scheduleNext, scheduleNext),
    secs * 1000,
  );
}

// Background tabs throttle (or fully suspend) timers, so refresh slows or the
// last scan can stall mid-flight. Re-scan the moment the tab is shown again so
// data is fresh on return and the loop is re-armed if it had gone quiet.
function onVisible(): void {
  if (typeof document !== 'undefined' && !document.hidden) {
    void scanAll().then(scheduleNext, scheduleNext);
  }
}

export function startEngine(): void {
  if (started) return;
  started = true;
  void scanAll().then(scheduleNext, scheduleNext);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  // Stale watchdog: engine data older than 2× the refresh interval (+5s grace).
  staleTimer = setInterval(() => {
    const s = useApp.getState();
    if (s.engineSync === 'synced' && s.lastSyncAt > 0) {
      const limitMs = (Math.max(5, s.refresh || 15) * 2 + 5) * 1000;
      if (Date.now() - s.lastSyncAt > limitMs) s.set({ engineSync: 'stale' });
    }
  }, 1000);
}

export function stopEngine(): void {
  started = false;
  cancelLoop?.();
  clearInterval(staleTimer);
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
}

/**
 * Quote one pair right now, outside the shared cycle. `scanAll` captures its
 * pair list when a cycle starts, so a pair added mid-cycle would otherwise sit
 * at LOADING until the next sweep begins.
 */
export async function scanPairNow(pairId: string): Promise<void> {
  const pair = allPairs().find((p) => p.id === pairId);
  if (!pair) return;
  // Force a rate refresh: a pair added seconds ago has never had its wrapper
  // vault read, and an unresolved rate defaults to 1 — a silently wrong price.
  await refreshRates(true).catch(() => {});
  await scanPair(pair).catch(() => false);
}

/** Debug helper: how many networks have a configured token pair. */
export const configuredNets = (): number =>
  allPairs().reduce(
    (acc, p) =>
      acc +
      p.networks.filter(
        (n) => (p.custom?.[n] || (tokenOn(p.t0, n) && tokenOn(p.t1, n))) && NETWORKS[n].routes.length > 0,
      ).length,
    0,
  );

export { defaultAlert };
