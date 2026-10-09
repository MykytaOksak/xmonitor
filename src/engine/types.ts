import type { NetworkId } from '../config/networks';

export type QuoteStatus = 'live' | 'loading' | 'error';

export interface NetQuote {
  netId: NetworkId;
  /** Price of t0 in t1 units when buying t0 (t1 -> t0). */
  buy: number | null;
  /** Price of t0 in t1 units when selling t0 (t0 -> t1). */
  sell: number | null;
  /** Aggregator/router name for the ROUTER column (KyberSwap, OKX, …). */
  router: string;
  status: QuoteStatus;
  /** ms timestamp of last successful quote. */
  at: number;
  err?: string;
  /** true while this row's quote is being re-fetched (keeps last price shown). */
  refreshing?: boolean;
}

export interface BestRoute {
  buyNet: NetworkId;
  sellNet: NetworkId;
  buy: number;
  sell: number;
  spreadPct: number;
  sameChain: boolean;
}

export interface PairSnapshot {
  pairId: string;
  rows: Partial<Record<NetworkId, NetQuote>>;
  /** ms timestamp of last completed scan for this pair. */
  at: number;
}

export type SyncState = 'synced' | 'syncing' | 'stale' | 'error';
export type SaveState = 'idle' | 'saving' | 'saved' | 'error';
export type TgState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface SideAlert {
  enabled: boolean;
  op: 'above' | 'below';
  price: string;
  cooldown: string; // minutes, numeric string
  netMode: 'all' | 'selected';
  /** network name -> enabled (missing = enabled), mirrors the prototype. */
  nets: Record<string, boolean>;
}

export interface PairAlert {
  buy: SideAlert;
  sell: SideAlert;
}
