import type { NetworkId } from '../config/networks';

const OKX = '/px/okx';
const BINANCE = '/px/binance';
const BYBIT = '/px/bybit';

/** One spot market on a CEX venue. */
export interface Ticker {
  /** Display form: "XSPY-USDT" on OKX, "BTCUSDT" on Binance. */
  instId: string;
  base: string;
  quote: string;
}

// Instrument lists are static for a session and large (Binance ships a few
// thousand), so fetch once per venue and keep the trimmed result.
const cache = new Map<NetworkId, Promise<Ticker[]>>();

async function fetchOkx(): Promise<Ticker[]> {
  const r = await fetch(`${OKX}/api/v5/public/instruments?instType=SPOT`);
  if (!r.ok) throw new Error(`okx instruments: ${r.status}`);
  const j = await r.json();
  return (j?.data ?? [])
    .filter((d: { state?: string }) => d.state === 'live')
    .map((d: { instId: string; baseCcy: string; quoteCcy: string }) => ({
      instId: d.instId,
      base: d.baseCcy,
      quote: d.quoteCcy,
    }));
}

async function fetchBinance(): Promise<Ticker[]> {
  const r = await fetch(`${BINANCE}/api/v3/exchangeInfo?permissions=SPOT`);
  if (!r.ok) throw new Error(`binance exchangeInfo: ${r.status}`);
  const j = await r.json();
  return (j?.symbols ?? [])
    .filter((d: { status?: string }) => d.status === 'TRADING')
    .map((d: { symbol: string; baseAsset: string; quoteAsset: string }) => ({
      instId: d.symbol,
      base: d.baseAsset,
      quote: d.quoteAsset,
    }));
}

async function fetchBybit(): Promise<Ticker[]> {
  const r = await fetch(`${BYBIT}/v5/market/instruments-info?category=spot&limit=1000`);
  if (!r.ok) throw new Error(`bybit instruments: ${r.status}`);
  const j = await r.json();
  if (j?.retCode !== 0) throw new Error(`bybit instruments: ${j?.retMsg ?? 'bad response'}`);
  return (j?.result?.list ?? [])
    .filter((d: { status?: string }) => d.status === 'Trading')
    .map((d: { symbol: string; baseCoin: string; quoteCoin: string }) => ({
      instId: d.symbol,
      base: d.baseCoin,
      quote: d.quoteCoin,
    }));
}

/** Live spot markets for a CEX venue; empty for anything else. */
export function loadTickers(net: NetworkId): Promise<Ticker[]> {
  const hit = cache.get(net);
  if (hit) return hit;
  const loader =
    net === 'okxCex'
      ? fetchOkx()
      : net === 'binanceCex'
        ? fetchBinance()
        : net === 'bybitCex'
          ? fetchBybit()
          : Promise.resolve([]);
  // A failed fetch must not poison the cache — let the next keystroke retry.
  const p = loader.catch((e) => {
    cache.delete(net);
    throw e;
  });
  cache.set(net, p);
  return p;
}

/**
 * Markets matching `q`, base-symbol matches first. Typing "spy" surfaces
 * XSPY-USDT ahead of markets that merely contain the letters.
 */
export function searchTickers(list: Ticker[], q: string, limit = 40): Ticker[] {
  const needle = q.trim().toUpperCase();
  if (!needle) return [];
  const exact: Ticker[] = [];
  const prefix: Ticker[] = [];
  const rest: Ticker[] = [];
  for (const t of list) {
    if (t.base === needle) exact.push(t);
    else if (t.base.startsWith(needle)) prefix.push(t);
    else if (t.instId.includes(needle) || t.quote === needle) rest.push(t);
    if (exact.length + prefix.length >= limit) break;
  }
  // Stable, deterministic ordering inside each band.
  const byId = (a: Ticker, b: Ticker) => a.instId.localeCompare(b.instId);
  return [...exact.sort(byId), ...prefix.sort(byId), ...rest.sort(byId)].slice(0, limit);
}
