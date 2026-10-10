export type NetworkId =
  | 'ethereum'
  | 'arbitrum'
  | 'optimism'
  | 'base'
  | 'bnb'
  | 'avalanche'
  | 'avalancheMint'
  | 'mantle'
  | 'katana'
  | 'ink'
  | 'plasma'
  | 'hyperevm'
  | 'monad'
  | 'solana'
  | 'fluent'
  | 'fluentStake'
  | 'xlayer'
  | 'okxCex'
  | 'binanceCex'
  | 'bybitCex'
  | 'hydration';

// Quote routing, primary first (see the endpoint list in the handoff):
//  canoe-okx        — Canoe via OKX; the default Canoe market wherever OKX is
//                     available (Ethereum, Arbitrum, Optimism, Base, BNB,
//                     Avalanche, Mantle, Monad)
//  canoe-kyberswap  — Canoe via KyberSwap; used on chains OKX doesn't cover
//                     (Katana, Plasma, Hyper EVM)
//  canoe-openocean  — Canoe via OpenOcean (fallback market)
//  kyberswap        — KyberSwap aggregator, fallback / main EVM quote
//  openocean        — OpenOcean v4, fallback when Canoe market = openocean
//  eisen            — Eisen, Katana with internal split fallback
//  enso             — Enso, Ink (needs ENSO_KEY, attached server-side)
//  jupiter          — Jupiter Ultra with Lite fallback, Solana
//  avalanche-savusd-mintredeem — Avalanche savUSD direct mint/redeem preview
//  fluent-susdnr-stakeunstake — Fluent sUSDnr/USDnr Nerona stake/unstake preview
//  oku-flowstream  — OKU Flowstream, special Monad savUSD/USDC route
export type QuoteRoute =
  | 'canoe-okx'
  | 'canoe-kyberswap'
  | 'canoe-openocean'
  | 'kyberswap'
  | 'openocean'
  | 'eisen'
  | 'enso'
  | 'jupiter'
  | 'avalanche-savusd-mintredeem'
  | 'fluent-susdnr-stakeunstake'
  | 'oku-flowstream'
  | 'fluent'
  | 'xlayer-univ3'
  | 'okx-cex'
  | 'binance-cex'
  | 'bybit-cex'
  | 'hydration'
  | 'ink-cl';

export interface Network {
  id: NetworkId;
  name: string;
  /** 1–2 char monogram shown in the placeholder logo square. */
  mono: string;
  /** Placeholder logo color — the only decorative color allowed by the design. */
  color: string;
  kind: 'evm' | 'solana' | 'move' | 'cex' | 'other';
  chainId?: number;
  /** Canoe `chain` body field (network key, not chainId). */
  canoeChain?: string;
  /** aggregator-api.kyberswap.com/{slug} */
  kyberSlug?: string;
  /** open-api.openocean.finance/v4/{slug} */
  openOceanSlug?: string;
  /** Primary route first, then fallbacks. Empty = no quote source (rows show ERR). */
  routes: QuoteRoute[];
}

export const NETWORKS: Record<NetworkId, Network> = {
  ethereum: {
    id: 'ethereum', name: 'Ethereum', mono: 'Ξ', color: '#6E79D6', kind: 'evm',
    chainId: 1, canoeChain: 'ethereum', kyberSlug: 'ethereum', openOceanSlug: 'eth',
    routes: ['oku-flowstream', 'canoe-okx', 'kyberswap'],
  },
  arbitrum: {
    id: 'arbitrum', name: 'Arbitrum', mono: 'A', color: '#3E7FD0', kind: 'evm',
    chainId: 42161, canoeChain: 'arbitrum', kyberSlug: 'arbitrum', openOceanSlug: 'arbitrum',
    routes: ['oku-flowstream', 'canoe-okx', 'kyberswap'],
  },
  optimism: {
    id: 'optimism', name: 'Optimism', mono: 'O', color: '#D0524F', kind: 'evm',
    chainId: 10, canoeChain: 'optimism', kyberSlug: 'optimism', openOceanSlug: 'optimism',
    routes: ['oku-flowstream', 'canoe-okx', 'kyberswap'],
  },
  base: {
    id: 'base', name: 'Base', mono: 'B', color: '#3358D0', kind: 'evm',
    chainId: 8453, canoeChain: 'base', kyberSlug: 'base', openOceanSlug: 'base',
    routes: ['oku-flowstream', 'canoe-okx', 'kyberswap'],
  },
  bnb: {
    id: 'bnb', name: 'BNB Chain', mono: 'N', color: '#C9A227', kind: 'evm',
    chainId: 56, canoeChain: 'bnb', kyberSlug: 'bsc', openOceanSlug: 'bsc',
    routes: ['oku-flowstream', 'canoe-okx', 'kyberswap'],
  },
  avalanche: {
    id: 'avalanche', name: 'Avalanche', mono: 'AV', color: '#C94F4F', kind: 'evm',
    chainId: 43114, canoeChain: 'avalanche', kyberSlug: 'avalanche', openOceanSlug: 'avax',
    routes: ['oku-flowstream', 'canoe-okx', 'kyberswap'],
  },
  avalancheMint: {
    id: 'avalancheMint', name: 'Avalanche', mono: 'AV', color: '#C94F4F', kind: 'evm',
    chainId: 43114,
    routes: ['avalanche-savusd-mintredeem'],
  },
  mantle: {
    id: 'mantle', name: 'Mantle', mono: 'M', color: '#6FA095', kind: 'evm',
    chainId: 5000, canoeChain: 'mantle', kyberSlug: 'mantle', openOceanSlug: 'mantle',
    routes: ['oku-flowstream', 'canoe-okx', 'openocean'],
  },
  katana: {
    id: 'katana', name: 'Katana', mono: 'K', color: '#B08A3E', kind: 'evm',
    chainId: 747474, canoeChain: 'katana', kyberSlug: 'katana',
    // Oku doesn't support Katana (Update 500s "chain not supported").
    routes: ['eisen', 'canoe-kyberswap', 'kyberswap'],
  },
  ink: {
    id: 'ink', name: 'Ink', mono: 'I', color: '#6E5CD0', kind: 'evm',
    chainId: 57073,
    // Oku doesn't support Ink and Enso needs a working ENSO_KEY (the one
    // we have 403s), so quote Ink's Velodrome Slipstream pools directly.
    routes: ['ink-cl', 'enso'],
  },
  plasma: {
    id: 'plasma', name: 'Plasma', mono: 'PL', color: '#4FA08A', kind: 'evm',
    chainId: 9745, canoeChain: 'plasma', kyberSlug: 'plasma', openOceanSlug: 'plasma',
    routes: ['oku-flowstream', 'canoe-kyberswap', 'kyberswap', 'openocean'],
  },
  hyperevm: {
    id: 'hyperevm', name: 'Hyper EVM', mono: 'H', color: '#4FA6A0', kind: 'evm',
    chainId: 999, canoeChain: 'hyperevm', kyberSlug: 'hyperevm',
    routes: ['oku-flowstream', 'canoe-kyberswap', 'kyberswap'],
  },
  monad: {
    id: 'monad', name: 'Monad', mono: 'MO', color: '#7B6BD6', kind: 'evm',
    chainId: 143, canoeChain: 'monad', kyberSlug: 'monad',
    routes: ['oku-flowstream', 'canoe-okx', 'kyberswap'],
  },
  solana: {
    id: 'solana', name: 'Solana', mono: 'S', color: '#7A5CD0', kind: 'solana',
    routes: ['jupiter'],
  },
  fluent: {
    id: 'fluent', name: 'Fluent', mono: 'F', color: '#5C8AD0', kind: 'evm',
    chainId: 25363,
    routes: ['fluent'],
  },
  fluentStake: {
    id: 'fluentStake', name: 'Fluent', mono: 'F', color: '#5C8AD0', kind: 'evm',
    chainId: 25363,
    routes: ['fluent-susdnr-stakeunstake'],
  },
  xlayer: {
    // No aggregator covers X Layer (KyberSwap/OpenOcean/Oku all say
    // unsupported), so quotes come straight from the Uniswap v3 pool.
    id: 'xlayer', name: 'X Layer', mono: 'XL', color: '#4F86C9', kind: 'evm',
    chainId: 196,
    routes: ['xlayer-univ3'],
  },
  okxCex: {
    // Centralised venue: priced by walking the OKX spot order book, so the
    // BUY/SELL shown is what the notional would actually fill at.
    id: 'okxCex', name: 'OKX', mono: 'OK', color: '#9AA0A6', kind: 'cex',
    routes: ['okx-cex'],
  },
  binanceCex: {
    // Same order-book pricing as OKX; kept a distinct colour from BNB Chain so
    // the two don't read alike when both appear in one table.
    id: 'binanceCex', name: 'Binance', mono: 'BN', color: '#B99A3E', kind: 'cex',
    routes: ['binance-cex'],
  },
  hydration: {
    // Polkadot parachain: assets are numeric ids, quoted through the Galactic
    // Council SDK's router (Omnipool + stableswap), not an HTTP aggregator.
    id: 'hydration', name: 'Hydration', mono: 'HY', color: '#C2568C', kind: 'other',
    routes: ['hydration'],
  },
  bybitCex: {
    // Same order-book pricing as the other CEX venues. USDe trades against
    // USDT here, so the USDC leg is converted at the live USDC/USDT rate
    // (see the substitution in engine.ts) to keep prices USDC-denominated.
    id: 'bybitCex', name: 'Bybit', mono: 'BY', color: '#C98A4F', kind: 'cex',
    routes: ['bybit-cex'],
  },
};

export const NET = (id: NetworkId): Network => NETWORKS[id];
