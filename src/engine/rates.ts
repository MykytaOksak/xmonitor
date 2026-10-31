// Live conversion rates used when a venue trades a proxy for the token a pair
// is denominated in, so prices stay expressed in the nominal token's terms.
// See the substitutions in engine.ts (resolveToken).
import { NET, type NetworkId } from '../config/networks';
import { allPairs } from '../config/pairs';
import { XSTOCK_SYMBOLS, tokenOn } from '../config/tokens';
import { quote } from './providers';

const XLAYER_RPC = '/px/xlayer';

/**
 * Chains a custom pair's wrapper vault can be read on — those the app already
 * proxies an RPC for. The dialog only offers the wrapper option here, so a
 * user cannot configure a conversion the engine could never resolve.
 */
const VAULT_RPC: Partial<Record<NetworkId, string>> = {
  xlayer: XLAYER_RPC,
  ink: '/px/ink',
  plasma: '/px/plasma',
  base: '/px/base',
  monad: '/px/monad',
  avalanche: '/px/avax-rpc',
  fluent: '/px/fluent',
};

export const canReadVault = (net: NetworkId): boolean => VAULT_RPC[net] !== undefined;
const JUP_PRICE = '/px/jup-lite';

// ERC-4626 convertToAssets(1e18) — base token per 1 wrapped token.
const CONVERT_TO_ASSETS_1E18 = '0x07a2d13a' + (10n ** 18n).toString(16).padStart(64, '0');

// USDT per 1 USDC on Ethereum. Defaults to 1 until first fetch.
let _usdcUsdt = 1;
const USDC_USDT_SIZE = 50_000; // the USDC/USDT pair's default notional
// One bad route would skew every USDT-substituted row, so a quote that loses
// more than this on the round trip is ignored and the last rate kept.
const USDC_USDT_MAX_SPREAD = 0.01;
let _at = 0;

// Per-xStock rates, keyed by symbol. Both default to 1 (no conversion) until
// first read, and both describe the SAME underlying accrual factor — verified
// identical to 9 decimals across all six tokens.
const _wrapRate: Record<string, number> = {}; // X Layer: base per 1 wrapped
const _uiScale: Record<string, number> = {}; // Solana: displayed per 1 raw unit
// Custom pairs' own vaults, keyed `${net}:${lowercased address}`.
const _vaultRate: Record<string, number> = {};

export const usdcUsdtRate = (): number => _usdcUsdt;
/** X Layer ERC-4626 vault rate: base xStock per 1 wrapped token. */
export const xstockWrapRate = (symbol: string): number => _wrapRate[symbol] ?? 1;
/**
 * Solana Token-2022 scaled-UI multiplier: displayed xStock per 1 raw unit.
 * Jupiter quotes in RAW units, so without this the price is overstated.
 */
export const xstockUiScale = (symbol: string): number => _uiScale[symbol] ?? 1;

/** Custom pair wrapper vault: underlying per 1 wrapped token. */
export const vaultRate = (net: NetworkId, address: string): number =>
  _vaultRate[`${net}:${address.toLowerCase()}`] ?? 1;

/**
 * Mid of the Ethereum USDC/USDT market: the rate selling USDC gets and the rate
 * buying it costs, each at real size, so the route's fee doesn't lean the
 * conversion to one side.
 */
async function refreshUsdcUsdt(): Promise<void> {
  const net = NET('ethereum');
  const usdc = tokenOn('USDC', 'ethereum');
  const usdt = tokenOn('USDT', 'ethereum');
  if (!usdc || !usdt) return;
  const [sold, bought] = await Promise.all([
    quote({ net, tokenIn: usdc, tokenOut: usdt, amountInHuman: USDC_USDT_SIZE }),
    quote({ net, tokenIn: usdt, tokenOut: usdc, amountInHuman: USDC_USDT_SIZE }),
  ]);
  const sell = sold.outHuman / USDC_USDT_SIZE; // USDT received per USDC sold
  const buy = USDC_USDT_SIZE / bought.outHuman; // USDT paid per USDC bought
  if (!isFinite(sell) || !isFinite(buy) || sell <= 0 || buy <= 0) return;
  if (Math.abs(buy - sell) / buy > USDC_USDT_MAX_SPREAD) return;
  _usdcUsdt = (buy + sell) / 2;
}

/** One JSON-RPC batch of convertToAssets(1e18); null where the call failed. */
async function convertToAssetsBatch(rpc: string, addresses: string[]): Promise<(number | null)[]> {
  const out: (number | null)[] = addresses.map(() => null);
  if (addresses.length === 0) return out;
  const r = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(
      addresses.map((address, id) => ({
        jsonrpc: '2.0',
        id,
        method: 'eth_call',
        params: [{ to: address, data: CONVERT_TO_ASSETS_1E18 }, 'latest'],
      })),
    ),
  });
  const j = await r.json();
  for (const item of Array.isArray(j) ? j : []) {
    if (typeof item?.id !== 'number' || !item.result || item.result === '0x') continue;
    const v = Number(BigInt(item.result.slice(0, 66))) / 1e18;
    if (isFinite(v) && v > 0) out[item.id] = v;
  }
  return out;
}

/** One JSON-RPC batch for every wrapped xStock vault on X Layer. */
async function refreshWrapRates(): Promise<void> {
  const wrapped: { symbol: string; address: string }[] = [];
  for (const s of XSTOCK_SYMBOLS) {
    const dep = tokenOn(`w${s}`, 'xlayer');
    if (dep) wrapped.push({ symbol: s, address: dep.address });
  }
  const vals = await convertToAssetsBatch(XLAYER_RPC, wrapped.map((w) => w.address));
  vals.forEach((v, i) => {
    if (v !== null) _wrapRate[wrapped[i].symbol] = v;
  });
}

/** Vaults referenced by custom pairs, one batch per chain. */
async function refreshVaultRates(): Promise<void> {
  const byNet = new Map<NetworkId, Set<string>>();
  for (const p of allPairs()) {
    if (!p.custom) continue;
    for (const [net, legs] of Object.entries(p.custom) as [NetworkId, { t0?: { address: string; wrappedVault?: boolean }; t1?: { address: string; wrappedVault?: boolean } }][]) {
      if (!canReadVault(net)) continue;
      for (const dep of [legs.t0, legs.t1]) {
        if (!dep?.wrappedVault) continue;
        let set = byNet.get(net);
        if (!set) byNet.set(net, (set = new Set()));
        set.add(dep.address.toLowerCase());
      }
    }
  }
  await Promise.all(
    [...byNet].map(async ([net, addrs]) => {
      const list = [...addrs];
      const vals = await convertToAssetsBatch(VAULT_RPC[net]!, list);
      vals.forEach((v, i) => {
        if (v !== null) _vaultRate[`${net}:${list[i]}`] = v;
      });
    }),
  );
}

/** One Jupiter price call for every Solana xStock mint. */
async function refreshUiScales(): Promise<void> {
  const mints: { symbol: string; address: string }[] = [];
  for (const s of XSTOCK_SYMBOLS) {
    const dep = tokenOn(s, 'solana');
    if (dep) mints.push({ symbol: s, address: dep.address });
  }
  if (mints.length === 0) return;
  const r = await fetch(`${JUP_PRICE}/price/v3?ids=${mints.map((m) => m.address).join(',')}`);
  const j = await r.json();
  for (const m of mints) {
    const v = j?.[m.address];
    // usdPricePrescaled is per raw unit and usdPrice per displayed unit, so
    // their ratio is the live multiplier — self-correcting as it accrues.
    const pre = Number(v?.scaledUiConfig?.usdPricePrescaled);
    const ui = Number(v?.usdPrice);
    if (isFinite(pre) && isFinite(ui) && pre > 0 && ui > 0) _uiScale[m.symbol] = pre / ui;
  }
}

/**
 * Refresh cached rates; cheap no-op if fetched within the last 15s. Pass
 * `force` when a pair has just been added — its vault has never been read, and
 * an unresolved rate silently defaults to 1 (i.e. no conversion at all).
 */
export async function refreshRates(force = false): Promise<void> {
  if (!force && Date.now() - _at < 15_000) return;
  _at = Date.now();
  // Independent sources — a failure in one keeps the last known value for it.
  await Promise.all([
    refreshUsdcUsdt().catch(() => {}),
    refreshWrapRates().catch(() => {}),
    refreshUiScales().catch(() => {}),
    refreshVaultRates().catch(() => {}),
  ]);
}
