// Yuzu LP position tracking on Movement (Move-VM). Unlike the EVM path in
// reader.ts (ERC-721 + eth_call), Yuzu positions are Move objects: pools come
// from a `::view` call, ownership from the Aptos-style Sentio indexer, and each
// position/pool/token from Yuzu's own REST API. All three hosts send CORS
// headers, so we call them directly (no Vite proxy needed). Output is mapped to
// the same Position shape the EVM reader returns so the UI renders uniformly.
import type { Position, PositionToken } from './reader';

const RPC = 'https://rpcproxy.yuzu.finance/v1';
const INDEXER = 'https://rpc.sentio.xyz/movement-indexer/v1/graphql';
const API = 'https://mainnet-api.yuzu.finance/v1';
const CONTRACT = '0x46566b4a16a1261ab400ab5b9067de84ba152b5eb4016b217187f2a2ca980c5a';

// ——— address helpers ———
/** Movement/Aptos addresses are 32 bytes; the indexer wants the 0x + 64-hex form. */
const normMove = (a: string) => `0x${a.trim().toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
/** Compact (leading zeros stripped) form used by pool ids and token metadata. */
const compact = (a: string) => `0x${String(a).replace(/^0x/, '').replace(/^0+/, '') || '0'}`;
export const isMovementAddress = (a: string) => /^0x[0-9a-f]{1,64}$/i.test(a.trim());

// ——— Move sqrt-price / tick math (Q80, ticks centered at 443636) ———
const Q80 = 1n << 80n;
const TICK_CENTER = 443636;
const MAX_UINT256 = (1n << 256n) - 1n;

/** sqrt(1.0001^(tick-443636)) in Q80. Ticks come from Yuzu already centered. */
function sqrtRatioAtTick(tick: number): bigint {
  const absTick = tick < TICK_CENTER ? TICK_CENTER - tick : tick - TICK_CENTER;
  let ratio =
    absTick & 1
      ? 340265354078544976698082559843614326784n
      : 340282366920938463463374607431768211456n;
  if (absTick & 0x2) ratio = (ratio * 340248342086729784833163084424934326272n) >> 128n;
  if (absTick & 0x4) ratio = (ratio * 340214320654664318389990405825464631296n) >> 128n;
  if (absTick & 0x8) ratio = (ratio * 340146287995602338275853453755324301312n) >> 128n;
  if (absTick & 0x10) ratio = (ratio * 340010263488231178223853832463785656320n) >> 128n;
  if (absTick & 0x20) ratio = (ratio * 339738377640345476870261989487337799680n) >> 128n;
  if (absTick & 0x40) ratio = (ratio * 339195258003219658561184762853115035648n) >> 128n;
  if (absTick & 0x80) ratio = (ratio * 338111622100602086564262494681729859584n) >> 128n;
  if (absTick & 0x100) ratio = (ratio * 335954724994790710924045888443083915264n) >> 128n;
  if (absTick & 0x200) ratio = (ratio * 331682121138380177001083646313987309568n) >> 128n;
  if (absTick & 0x400) ratio = (ratio * 323299236684854836574038915838422024192n) >> 128n;
  if (absTick & 0x800) ratio = (ratio * 307163716377036449298628741423763030016n) >> 128n;
  if (absTick & 0x1000) ratio = (ratio * 277268403626902478617217471084343853056n) >> 128n;
  if (absTick & 0x2000) ratio = (ratio * 225923453940452822857498961015547625472n) >> 128n;
  if (absTick & 0x4000) ratio = (ratio * 149997214084980533347406722303197708288n) >> 128n;
  if (absTick & 0x8000) ratio = (ratio * 66119101136036705030569676839239811072n) >> 128n;
  if (absTick & 0x10000) ratio = (ratio * 12847376061813933090541833434062389248n) >> 128n;
  if (absTick & 0x20000) ratio = (ratio * 485053260817416266108873772866994176n) >> 128n;
  if (absTick & 0x40000) ratio = (ratio * 691415978907519520719790451720192n) >> 128n;
  if (tick > TICK_CENTER) ratio = MAX_UINT256 / ratio;
  return ratio >> 48n; // Q128 -> Q80
}

/** token1-per-token0 price implied by a Q80 sqrt price. */
const priceFromSqrtX80 = (sqrtX80: bigint, dec0: number, dec1: number): number => {
  if (sqrtX80 <= 0n) return NaN;
  const r = Number(sqrtX80) / Number(Q80);
  return r * r * 10 ** (dec0 - dec1);
};

/** Raw token amounts held by `liquidity` in [tickLower, tickUpper] at the current sqrt price. */
function positionAmounts(
  liquidity: bigint,
  cur: bigint,
  tickLower: number,
  tickUpper: number,
): { a0: bigint; a1: bigint } {
  if (liquidity <= 0n) return { a0: 0n, a1: 0n };
  const lo = sqrtRatioAtTick(tickLower);
  const hi = sqrtRatioAtTick(tickUpper);
  if (cur <= lo) return { a0: (liquidity * Q80 * (hi - lo)) / lo / hi, a1: 0n };
  if (cur < hi)
    return {
      a0: (liquidity * Q80 * (hi - cur)) / cur / hi,
      a1: (liquidity * (cur - lo)) / Q80,
    };
  return { a0: 0n, a1: (liquidity * (hi - lo)) / Q80 };
}

// ——— transport ———
const jsonFetch = async <T>(url: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`Yuzu HTTP ${r.status}`);
  return (await r.json()) as T;
};
const view = <T>(fn: string, args: unknown[] = []) =>
  jsonFetch<T>(`${RPC}/view`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ function: `${CONTRACT}::${fn}`, type_arguments: [], arguments: args }),
  });

interface YuzuTokenMeta {
  metadata: string;
  symbol: string;
  decimals: number;
  isStable?: boolean;
}
interface YuzuPoolMeta {
  poolAddr: string;
  currentSqrtPrice: string;
  currentTick: number;
  feeRate: string;
  token0: string;
  token0Decimals: number;
  token1: string;
  token1Decimals: number;
}
interface YuzuRawPosition {
  id: string;
  liquidity: string;
  tick_lower: number;
  tick_upper: number;
}

let poolIdCache: string[] | null = null;
async function fetchPoolIds(): Promise<string[]> {
  if (poolIdCache) return poolIdCache;
  const raw = await view<Array<Array<{ inner: string }>>>('liquidity_pool::get_all_pools');
  poolIdCache = (raw[0] ?? []).map((p) => compact(p.inner)).filter(Boolean);
  return poolIdCache;
}

/** Discover (poolId, tokenId) pairs the owner holds, via the Aptos token indexer. */
async function fetchOwned(owner: string): Promise<{ poolId: string; tokenId: string }[]> {
  const poolIds = await fetchPoolIds();
  if (poolIds.length === 0) return [];
  const creators = poolIds.map((p) => `"${normMove(p)}"`).join(',');
  const query = `query { current_token_ownerships_v2(where:{ current_token_data:{ current_collection:{ creator_address:{ _in:[${creators}] } } } owner_address:{ _eq:"${normMove(owner)}" } amount:{_gt:"0"} }) { current_token_data { token_name current_collection { creator_address } } } }`;
  const res = await jsonFetch<{
    data?: { current_token_ownerships_v2?: Array<{ current_token_data?: { token_name?: string; current_collection?: { creator_address?: string } } }> };
    errors?: Array<{ message?: string }>;
  }>(INDEXER, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (res.errors?.length) throw new Error(res.errors.map((e) => e.message).join('; ') || 'Yuzu indexer error');
  return (res.data?.current_token_ownerships_v2 ?? [])
    .map((it) => ({
      tokenId: String(it.current_token_data?.token_name ?? '').trim(),
      poolId: compact(String(it.current_token_data?.current_collection?.creator_address ?? '')),
    }))
    .filter((it) => it.tokenId && it.poolId !== '0x0');
}

async function fetchRawPosition(poolId: string, tokenId: string): Promise<YuzuRawPosition | null> {
  const raw = await view<Array<Array<{ vec?: YuzuRawPosition[] }>>>(
    'position_nft_manager::get_positions',
    [[compact(poolId)], [tokenId]],
  );
  return raw[0]?.[0]?.vec?.[0] ?? null;
}

let tokenMapCache: Map<string, YuzuTokenMeta> | null = null;
async function fetchTokenMap(): Promise<Map<string, YuzuTokenMeta>> {
  if (tokenMapCache) return tokenMapCache;
  const res = await jsonFetch<{ data?: YuzuTokenMeta[] }>(`${API}/tokens`);
  const map = new Map<string, YuzuTokenMeta>();
  for (const t of res.data ?? []) if (t.metadata) map.set(compact(t.metadata).toLowerCase(), t);
  tokenMapCache = map;
  return map;
}

const poolMetaCache = new Map<string, YuzuPoolMeta>();
async function fetchPoolMeta(poolId: string): Promise<YuzuPoolMeta | null> {
  const id = compact(poolId).toLowerCase();
  const cached = poolMetaCache.get(id);
  if (cached) return cached;
  const res = await jsonFetch<{ data?: YuzuPoolMeta[] }>(`${API}/pools?keyword=${encodeURIComponent(compact(poolId))}`);
  const pool = (res.data ?? []).find((p) => compact(p.poolAddr).toLowerCase() === id) ?? null;
  if (pool) poolMetaCache.set(id, pool);
  return pool;
}

/** Top pools by TVL — used to anchor USD prices for non-stable tokens (e.g. MOVE). */
async function fetchTopPools(): Promise<YuzuPoolMeta[]> {
  try {
    const res = await jsonFetch<{ data?: YuzuPoolMeta[] }>(`${API}/pools`);
    return res.data ?? [];
  } catch {
    return [];
  }
}

/**
 * Build a token -> USD price map: stablecoins anchor at $1, then prices propagate
 * across pools via their sqrt price (token1-per-token0). No external oracle.
 */
function buildPriceMap(tokens: Map<string, YuzuTokenMeta>, pools: YuzuPoolMeta[]): Record<string, number> {
  const price: Record<string, number> = {};
  for (const [addr, t] of tokens) if (t.isStable) price[addr] = 1;
  for (let pass = 0; pass < 4; pass++) {
    for (const p of pools) {
      const t0 = compact(p.token0).toLowerCase();
      const t1 = compact(p.token1).toLowerCase();
      const px = priceFromSqrtX80(BigInt(p.currentSqrtPrice || '0'), p.token0Decimals, p.token1Decimals);
      if (!Number.isFinite(px) || px <= 0) continue;
      if (price[t0] != null && price[t1] == null) price[t1] = price[t0] / px;
      else if (price[t1] != null && price[t0] == null) price[t0] = price[t1] * px;
    }
  }
  return price;
}

/** All tracked Yuzu positions for a Movement wallet, as Position rows. */
export async function fetchYuzuPositions(owner: string): Promise<Position[]> {
  const owned = await fetchOwned(owner);
  if (owned.length === 0) return [];

  const [tokens, topPools] = await Promise.all([fetchTokenMap(), fetchTopPools()]);
  const uniquePools = [...new Set(owned.map((o) => o.poolId))];
  const poolMetas = await Promise.all(uniquePools.map((id) => fetchPoolMeta(id)));
  const poolById = new Map<string, YuzuPoolMeta>();
  uniquePools.forEach((id, i) => {
    const m = poolMetas[i];
    if (m) poolById.set(id, m);
  });

  const priceMap = buildPriceMap(tokens, [...topPools, ...poolById.values()]);

  const rows = await Promise.all(
    owned.map(async (o): Promise<Position | null> => {
      const pool = poolById.get(o.poolId);
      if (!pool) return null;
      const raw = await fetchRawPosition(o.poolId, o.tokenId).catch(() => null);
      if (!raw || BigInt(raw.liquidity || '0') <= 0n) return null;

      const a0 = compact(pool.token0).toLowerCase();
      const a1 = compact(pool.token1).toLowerCase();
      const m0 = tokens.get(a0);
      const m1 = tokens.get(a1);
      const dec0 = m0?.decimals ?? pool.token0Decimals;
      const dec1 = m1?.decimals ?? pool.token1Decimals;
      const cur = BigInt(pool.currentSqrtPrice || '0');
      const tickLower = Number(raw.tick_lower);
      const tickUpper = Number(raw.tick_upper);
      const { a0: rawAmt0, a1: rawAmt1 } = positionAmounts(BigInt(raw.liquidity), cur, tickLower, tickUpper);
      const amt0 = Number(rawAmt0) / 10 ** dec0;
      const amt1 = Number(rawAmt1) / 10 ** dec1;
      const price0 = priceMap[a0] ?? 0;
      const price1 = priceMap[a1] ?? 0;

      const token0: PositionToken = {
        address: a0,
        symbol: m0?.symbol ?? 'TOKEN0',
        decimals: dec0,
        amount: amt0,
        price: price0,
        usd: amt0 * price0,
      };
      const token1: PositionToken = {
        address: a1,
        symbol: m1?.symbol ?? 'TOKEN1',
        decimals: dec1,
        amount: amt1,
        price: price1,
        usd: amt1 * price1,
      };
      const lo = sqrtRatioAtTick(tickLower);
      const hi = sqrtRatioAtTick(tickUpper);
      return {
        id: `movement:yuzu:${o.poolId}:${o.tokenId}`,
        owner,
        protocol: 'Yuzu',
        chain: 'movement',
        chainName: 'Movement',
        tokenId: o.tokenId,
        token0,
        token1,
        feeBps: Number(pool.feeRate),
        tickLower,
        tickUpper,
        inRange: cur > lo && cur < hi,
        usd: token0.usd + token1.usd,
      };
    }),
  );
  return rows.filter((r): r is Position => r !== null);
}
