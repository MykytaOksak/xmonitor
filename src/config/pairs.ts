import { NETWORKS, type NetworkId } from './networks';
import { tokenOn, type TokenDeployment } from './tokens';

export type Unit = '$' | 'ETH';

export interface PairConfig {
  id: string;
  t0: string;
  t1: string;
  unit: Unit;
  /** Default notional (in t1 units: USD for $ pairs, ETH for ETH pairs). */
  defaultNotional: number;
  /** Price decimal places in the quotes table. */
  dp: number;
  networks: NetworkId[];
  /** Extra capability noted in the spec (rendered as a hint, engine hook later). */
  note?: string;
  /**
   * User-defined pairs carry their own per-network deployments instead of
   * resolving through the TOKENS registry by symbol.
   */
  custom?: Partial<
    Record<NetworkId, { t0: TokenDeployment; t1: TokenDeployment; usdcAdjust?: boolean }>
  >;
}

const P = (
  t0: string,
  t1: string,
  networks: NetworkId[],
  opts: Partial<Pick<PairConfig, 'unit' | 'defaultNotional' | 'dp' | 'note'>> = {},
): PairConfig => ({
  id: `${t0}-${t1}`,
  t0,
  t1,
  unit: opts.unit ?? '$',
  defaultNotional: opts.defaultNotional ?? 50_000,
  dp: opts.dp ?? 5,
  networks,
  note: opts.note,
});

/** Full pair/network matrix from the spec. */
export const PAIRS: PairConfig[] = [
  P('sUSDe', 'USDC', ['ethereum', 'arbitrum', 'mantle', 'monad', 'hyperevm', 'plasma']),
  P('USDe', 'USDC', ['bybitCex', 'ethereum', 'mantle', 'monad', 'hyperevm', 'plasma', 'solana']),
  // ETH-denominated pairs: notional is in WETH, so ~15 WETH ≈ $50k
  // (matches the 50k default for $ pairs without exceeding pool depth).
  P('wstETH', 'WETH', ['ethereum', 'katana', 'plasma', 'monad'], { unit: 'ETH', defaultNotional: 15 }),
  P('weETH', 'WETH', ['ethereum', 'katana', 'plasma', 'monad'], { unit: 'ETH', defaultNotional: 15 }),
  P('GHO', 'USDC', ['ethereum', 'arbitrum', 'base', 'ink', 'monad', 'plasma']),
  P('USDC', 'USDT', ['binanceCex', 'ethereum', 'arbitrum', 'bnb', 'avalanche', 'monad', 'solana']),
  P('sUSDAI', 'USDC', ['ethereum', 'arbitrum', 'base', 'plasma']),
  P('THBILL', 'USDC', ['arbitrum', 'hyperevm']),
  P('AUSD', 'USDC', ['ethereum', 'avalanche', 'katana', 'monad']),
  P('USD1', 'USDC', ['binanceCex', 'ethereum', 'bnb', 'solana']),
  P('savUSD', 'USDC', ['ethereum', 'avalanche', 'avalancheMint', 'monad'], {
    note: '+mint/redeem on Avalanche',
  }),
  // 10k rather than the 50k default: Solana's Whirlpool holds ~$620k, where
  // 50k would take several percent of impact.
  P('apyUSD', 'apxUSD', ['ethereum', 'base', 'bnb', 'solana', 'hydration'], { defaultNotional: 10_000 }),
  P('apxUSD', 'USDC', ['ethereum', 'base', 'bnb', 'solana'], { defaultNotional: 10_000 }),
  P('msUSD', 'USDC', ['ethereum', 'optimism', 'base', 'plasma']),
  P('msETH', 'WETH', ['ethereum', 'optimism', 'base', 'plasma'], { unit: 'ETH', defaultNotional: 15 }),
  P('USDG', 'USDC', ['ethereum', 'arbitrum', 'ink', 'solana', 'xlayer']),
  P('reUSD', 'USDC', ['ethereum'], { note: '+mint/redeem' }),
  P('frxUSD', 'USDC', ['ethereum']),
  P('PYUSD', 'USDC', ['bybitCex', 'ethereum', 'arbitrum', 'solana']),
  P('RLUSD', 'USDC', ['binanceCex', 'bybitCex', 'ethereum']),
  // ——— xStocks: same equity quoted on a CEX and two chains ———
  // The USD leg differs per venue (OKX always prices against USDT — see
  // tokens.ts) and per token on X Layer, where each one is paired with
  // whichever stable actually holds its Uniswap liquidity. NB GOOGLx has a
  // ~$1k USDG dust pool on X Layer; USDC is its real market.
  P('SPYx', 'USDG', ['okxCex', 'solana', 'xlayer'], { defaultNotional: 5000, dp: 3 }),
  P('SPCXx', 'USDG', ['okxCex', 'solana', 'xlayer'], { defaultNotional: 5000, dp: 3 }),
  P('NVDAx', 'USDG', ['okxCex', 'solana', 'xlayer'], { defaultNotional: 5000, dp: 3 }),
  P('AAPLx', 'USDG', ['okxCex', 'solana', 'xlayer'], { defaultNotional: 5000, dp: 3 }),
  P('GOOGLx', 'USDC', ['okxCex', 'solana', 'xlayer'], { defaultNotional: 5000, dp: 3 }),
  P('MSFTx', 'USDG', ['okxCex', 'solana', 'xlayer'], { defaultNotional: 5000, dp: 3 }),
  P('QQQx', 'USDC', ['okxCex', 'solana', 'xlayer'], { defaultNotional: 5000, dp: 3 }),
  P('sUSDnr', 'USDnr', ['fluent', 'fluentStake'], { note: '+stake/unstake in the same chain' }),
];

// ——— user-defined pairs ———

/**
 * One side of a custom pair on one network: either a registry stablecoin
 * (decimals come from TOKENS) or a raw address the user pasted.
 */
export interface CustomLeg {
  /** Registry symbol, or '' when `address` is supplied directly. */
  symbol: string;
  /** EVM address, Solana mint, or — on a CEX — the currency code. */
  address: string;
  decimals: number;
  /**
   * The address is an ERC-4626 wrapper holding the liquidity, not the token
   * itself — quote it and convert by its live redemption rate.
   */
  wrapped?: boolean;
}

/** A custom pair exactly as persisted in the store. */
export interface CustomPairSpec {
  id: string;
  t0: string;
  t1: string;
  notional: number;
  dp: number;
  networks: NetworkId[];
  /**
   * Per network: the two legs, plus — for a CEX market that only lists against
   * USDT — an opt-in conversion of the quote into USDC terms via the live
   * Binance USDC/USDT rate.
   */
  legs: Partial<Record<NetworkId, { t0: CustomLeg; t1: CustomLeg; usdcAdjust?: boolean }>>;
}

export const CUSTOM_PREFIX = 'custom:';
export const isCustomPair = (id: string): boolean => id.startsWith(CUSTOM_PREFIX);

/** Networks a custom pair may be quoted on — everything except routes hardwired
 *  to one token (savUSD mint/redeem, sUSDnr stake/unstake). CEX venues qualify. */
export const customPairNetworks = (): NetworkId[] =>
  (Object.keys(NETWORKS) as NetworkId[]).filter((n) =>
    NETWORKS[n].routes.some(
      (r) => r !== 'avalanche-savusd-mintredeem' && r !== 'fluent-susdnr-stakeunstake',
    ),
  );

export const isCexNet = (net: NetworkId): boolean => NETWORKS[net].kind === 'cex';

const legDeployment = (
  leg: CustomLeg | undefined,
  net: NetworkId,
  isQuoteSide: boolean,
): TokenDeployment | null => {
  if (!leg) return null;
  if (leg.symbol) return tokenOn(leg.symbol, net);
  if (!leg.address) return null;
  // Pasted by hand, so never claim it is verified.
  return {
    address: leg.address,
    decimals: leg.decimals,
    verified: false,
    ...(isCexNet(net) && isQuoteSide ? { cexQuote: true } : {}),
    ...(leg.wrapped ? { wrappedVault: true } : {}),
  };
};

/** Networks whose two legs both resolve — the rest are silently dropped. */
export function toPairConfig(spec: CustomPairSpec): PairConfig {
  const custom: NonNullable<PairConfig['custom']> = {};
  const networks: NetworkId[] = [];
  for (const n of spec.networks) {
    const t0 = legDeployment(spec.legs[n]?.t0, n, false);
    const t1 = legDeployment(spec.legs[n]?.t1, n, true);
    if (!t0 || !t1) continue;
    custom[n] = { t0, t1, usdcAdjust: spec.legs[n]?.usdcAdjust };
    networks.push(n);
  }
  return {
    id: spec.id,
    t0: spec.t0,
    t1: spec.t1,
    unit: '$',
    defaultNotional: spec.notional,
    dp: spec.dp,
    networks,
    custom,
  };
}

// Kept as a module mirror of the store so the many synchronous `pairById`
// callers (engine, alerts) keep working without threading state through.
let CUSTOM: PairConfig[] = [];

export const setCustomPairs = (specs: CustomPairSpec[]): void => {
  CUSTOM = specs.map(toPairConfig);
};

/** Built-in pairs followed by the user's own. */
export const allPairs = (): PairConfig[] => (CUSTOM.length === 0 ? PAIRS : [...PAIRS, ...CUSTOM]);

export const pairById = (id: string): PairConfig => {
  const p = allPairs().find((x) => x.id === id);
  if (!p) throw new Error(`unknown pair ${id}`);
  return p;
};

export const pairName = (p: PairConfig) => `${p.t0}/${p.t1}`;

// ——— Arbitrage rules (engine + Settings display) ———

export interface ArbRules {
  /** Pairs allowed to arb within a single chain. */
  sameChainAllowed: string[];
  sameChainRequireDifferentMarkets: boolean;
  /** Quotes older than this are discarded from best-route calc. */
  maxQuoteAgeSec: number;
  /** Hard exclusions: never use this side of this pair on this network. */
  exclusions: { pairId: string; side: 'buy' | 'sell'; net: NetworkId | 'polygon' }[];
}

export const RULES: ArbRules = {
  sameChainAllowed: ['USDC-USDT'],
  sameChainRequireDifferentMarkets: true,
  maxQuoteAgeSec: 20,
  exclusions: [{ pairId: 'GHO-USDC', side: 'sell', net: 'polygon' }],
};

export const RULES_DISPLAY = [
  { text: 'Same-chain arbitrage — allowed for USDC/USDT only', badge: 'SCOPED', green: true },
  { text: 'Same-chain — require different markets', badge: 'ON', green: true },
  { text: 'Exclude SELL side on Polygon for GHO', badge: 'RULE', green: false },
  { text: `Reject quotes older than ${RULES.maxQuoteAgeSec}s`, badge: `${RULES.maxQuoteAgeSec}s`, green: false },
];
