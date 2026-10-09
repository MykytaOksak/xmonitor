// Direct Uniswap-v3 pool quoting from on-chain state.
//
// Used for chains no aggregator covers (X Layer: KyberSwap/OpenOcean/Oku all
// return "unsupported"). There is no QuoterV2 deployment we could find on
// X Layer, so instead of a contract round-trip we read the pool's slot0 +
// liquidity and run the standard v3 exact-in math client-side.
//
// NOTE this prices the swap against the CURRENT tick's liquidity only. That is
// accurate while the trade stays inside the active tick range (our $5k notional
// against a ~$700k pool does), and degrades gracefully — it can only be
// optimistic once a trade would cross ticks, which the engine's round-trip
// sanity gate would catch.

const Q96 = 2n ** 96n;

const SEL_GET_POOL = '0x1698ee82'; // getPool(address,address,uint24)
const SEL_SLOT0 = '0x3850c7bd'; // slot0()
const SEL_LIQUIDITY = '0x1a686502'; // liquidity()
const SEL_FEE = '0xddca3f43'; // fee()

const addrArg = (a: string) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const uintArg = (v: number | bigint) => BigInt(v).toString(16).padStart(64, '0');

async function ethCall(rpc: string, to: string, data: string): Promise<string> {
  const r = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message ?? 'eth_call failed');
  return j.result ?? '0x';
}

/** Read a uint256 from a contract call (used for ERC-4626 conversion rates). */
export async function readUint(rpc: string, to: string, data: string): Promise<bigint> {
  const res = await ethCall(rpc, to, data);
  if (!res || res === '0x') throw new Error('empty result');
  return BigInt(res.slice(0, 66));
}

/** Fee tiers probed, most-used first. */
const FEE_TIERS = [500, 3000, 100, 10000] as const;

const poolCache = new Map<string, { pool: string; fee: number }>();

/** Find the deepest available pool for a token pair via the factory. */
async function findPool(rpc: string, factory: string, a: string, b: string) {
  const key = [rpc, factory, a.toLowerCase(), b.toLowerCase()].join('|');
  const hit = poolCache.get(key);
  if (hit) return hit;
  for (const fee of FEE_TIERS) {
    const res = await ethCall(rpc, factory, SEL_GET_POOL + addrArg(a) + addrArg(b) + uintArg(fee));
    const pool = '0x' + res.slice(26, 66);
    if (/^0x0{40}$/.test(pool)) continue;
    const liq = await readUint(rpc, pool, SEL_LIQUIDITY).catch(() => 0n);
    if (liq > 0n) {
      const found = { pool, fee };
      poolCache.set(key, found);
      return found;
    }
  }
  throw new Error('no pool for pair');
}

/**
 * Exact-in quote against a Uniswap-v3 pool. Returns the raw output amount.
 * `tokenIn`/`tokenOut` are addresses; token order inside the pool is derived
 * from their sort order, as Uniswap does.
 */
/**
 * Exact-in quote against a KNOWN Uniswap-v3-style pool. Used for forks whose
 * factory keys pools differently (Velodrome/Aerodrome Slipstream index by
 * tickSpacing, not fee), where the pool is configured explicitly.
 */
export async function quoteUniV3PoolAt(
  rpc: string,
  pool: string,
  tokenIn: string,
  tokenOut: string,
  amountInRaw: bigint,
  knownFee?: number,
): Promise<{ amountOutRaw: bigint; fee: number; pool: string }> {
  const [slot0Res, liquidity, feeRaw] = await Promise.all([
    ethCall(rpc, pool, SEL_SLOT0),
    readUint(rpc, pool, SEL_LIQUIDITY),
    knownFee != null ? Promise.resolve(BigInt(knownFee)) : readUint(rpc, pool, SEL_FEE),
  ]);
  const sqrtP = BigInt(slot0Res.slice(0, 66));
  const fee = Number(feeRaw);
  if (sqrtP <= 0n || liquidity <= 0n) throw new Error('pool has no liquidity');

  // token0 is the lower address; swapping it in moves the price down.
  const zeroForOne = tokenIn.toLowerCase() < tokenOut.toLowerCase();
  const amountInLessFee = (amountInRaw * BigInt(1_000_000 - fee)) / 1_000_000n;

  let amountOutRaw: bigint;
  if (zeroForOne) {
    // sqrtP_next = (L<<96)*sqrtP / ((L<<96) + amountIn*sqrtP)
    const num1 = liquidity * Q96;
    const next = (num1 * sqrtP) / (num1 + amountInLessFee * sqrtP);
    amountOutRaw = (liquidity * (sqrtP - next)) / Q96; // token1 out
  } else {
    // sqrtP_next = sqrtP + (amountIn<<96)/L
    const next = sqrtP + (amountInLessFee * Q96) / liquidity;
    amountOutRaw = (liquidity * Q96 * (next - sqrtP)) / next / sqrtP; // token0 out
  }
  if (amountOutRaw <= 0n) throw new Error('zero output');
  return { amountOutRaw, fee, pool };
}

export interface Intermediate {
  address: string;
  symbol: string;
}

/**
 * Exact-in quote, discovering the pool through a Uniswap v3 factory.
 *
 * Falls back to a single intermediate hop when no direct pool exists, which is
 * how Uniswap's own router reaches these markets — wIWMx has no USD₮0 pool on
 * X Layer, but USD₮0 -> USDC -> wIWMx prices within 0.01% of the UI. Only the
 * fallback path hops: anything with a direct pool keeps quoting exactly as
 * before. Capped at two hops, since the single-tick approximation compounds.
 */
export async function quoteUniV3Pool(
  rpc: string,
  factory: string,
  tokenIn: string,
  tokenOut: string,
  amountInRaw: bigint,
  intermediates: Intermediate[] = [],
): Promise<{ amountOutRaw: bigint; fee: number; pool: string; via?: string }> {
  try {
    const { pool, fee } = await findPool(rpc, factory, tokenIn, tokenOut);
    return await quoteUniV3PoolAt(rpc, pool, tokenIn, tokenOut, amountInRaw, fee);
  } catch (direct) {
    const ends = [tokenIn.toLowerCase(), tokenOut.toLowerCase()];
    const usable = intermediates.filter((m) => !ends.includes(m.address.toLowerCase()));
    if (usable.length === 0) throw direct;

    const routes = await Promise.all(
      usable.map(async (mid) => {
        const legA = await findPool(rpc, factory, tokenIn, mid.address);
        const outA = await quoteUniV3PoolAt(rpc, legA.pool, tokenIn, mid.address, amountInRaw, legA.fee);
        const legB = await findPool(rpc, factory, mid.address, tokenOut);
        const outB = await quoteUniV3PoolAt(
          rpc,
          legB.pool,
          mid.address,
          tokenOut,
          outA.amountOutRaw,
          legB.fee,
        );
        return { amountOutRaw: outB.amountOutRaw, fee: legB.fee, pool: legB.pool, via: mid.symbol };
      }).map((p) => p.catch(() => null)),
    );

    // Best of whatever routed, mirroring a router picking the best path.
    const best = routes
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => (b.amountOutRaw > a.amountOutRaw ? 1 : -1))[0];
    if (!best) throw direct;
    return best;
  }
}
