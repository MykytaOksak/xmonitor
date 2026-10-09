import { RULES, type PairConfig } from '../config/pairs';
import type { BestRoute, NetQuote } from './types';

/**
 * Pick the best buy/sell combination for a pair from its per-network quotes,
 * applying the arbitrage rules:
 *  - only live quotes fresher than maxQuoteAgeSec
 *  - hard side/network exclusions
 *  - same-chain combos only for allow-listed pairs, optionally requiring
 *    different markets (with a single quote source per network the market is
 *    the same, so same-chain effectively needs distinct venues)
 */
export function computeBest(pair: PairConfig, rows: NetQuote[], now: number): BestRoute | null {
  const fresh = rows.filter(
    (r) => r.status === 'live' && now - r.at <= RULES.maxQuoteAgeSec * 1000,
  );

  const excluded = (side: 'buy' | 'sell', netId: string) =>
    RULES.exclusions.some((e) => e.pairId === pair.id && e.side === side && e.net === netId);

  let best: BestRoute | null = null;
  for (const b of fresh) {
    if (b.buy == null || excluded('buy', b.netId)) continue;
    for (const s of fresh) {
      if (s.sell == null || excluded('sell', s.netId)) continue;
      const sameChain = b.netId === s.netId;
      if (sameChain) {
        if (!RULES.sameChainAllowed.includes(pair.id)) continue;
        if (RULES.sameChainRequireDifferentMarkets && b.router === s.router) continue;
      }
      const spreadPct = ((s.sell - b.buy) / b.buy) * 100;
      if (!best || spreadPct > best.spreadPct) {
        best = { buyNet: b.netId, sellNet: s.netId, buy: b.buy, sell: s.sell, spreadPct, sameChain };
      }
    }
  }
  return best;
}

export const tagFor = (best: BestRoute): string =>
  best.sameChain ? 'SAME-CHAIN' : Math.abs(best.spreadPct) < 0.03 ? 'THIN' : 'CROSS-CHAIN';
