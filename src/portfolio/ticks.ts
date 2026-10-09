// Exact Uniswap v3 TickMath + LiquidityAmounts (BigInt), ported from the
// reference contracts so position token amounts are precise.

const Q96 = 2n ** 96n;

/** sqrt(1.0001^tick) * 2^96, exact. Valid for |tick| <= 887272. */
export function getSqrtRatioAtTick(tick: number): bigint {
  const abs = BigInt(Math.abs(tick));
  let ratio =
    (abs & 0x1n) !== 0n
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  const mul = (m: bigint) => {
    ratio = (ratio * m) >> 128n;
  };
  if ((abs & 0x2n) !== 0n) mul(0xfff97272373d413259a46990580e213an);
  if ((abs & 0x4n) !== 0n) mul(0xfff2e50f5f656932ef12357cf3c7fdccn);
  if ((abs & 0x8n) !== 0n) mul(0xffe5caca7e10e4e61c3624eaa0941cd0n);
  if ((abs & 0x10n) !== 0n) mul(0xffcb9843d60f6159c9db58835c926644n);
  if ((abs & 0x20n) !== 0n) mul(0xff973b41fa98c081472e6896dfb254c0n);
  if ((abs & 0x40n) !== 0n) mul(0xff2ea16466c96a3843ec78b326b52861n);
  if ((abs & 0x80n) !== 0n) mul(0xfe5dee046a99a2a811c461f1969c3053n);
  if ((abs & 0x100n) !== 0n) mul(0xfcbe86c7900a88aedcffc83b479aa3a4n);
  if ((abs & 0x200n) !== 0n) mul(0xf987a7253ac413176f2b074cf7815e54n);
  if ((abs & 0x400n) !== 0n) mul(0xf3392b0822b70005940c7a398e4b70f3n);
  if ((abs & 0x800n) !== 0n) mul(0xe7159475a2c29b7443b29c7fa6e889d9n);
  if ((abs & 0x1000n) !== 0n) mul(0xd097f3bdfd2022b8845ad8f792aa5825n);
  if ((abs & 0x2000n) !== 0n) mul(0xa9f746462d870fdf8a65dc1f90e061e5n);
  if ((abs & 0x4000n) !== 0n) mul(0x70d869a156d2a1b890bb3df62baf32f7n);
  if ((abs & 0x8000n) !== 0n) mul(0x31be135f97d08fd981231505542fcfa6n);
  if ((abs & 0x10000n) !== 0n) mul(0x9aa508b5b7a84e1c677de54f3e99bc9n);
  if ((abs & 0x20000n) !== 0n) mul(0x5d6af8dedb81196699c329225ee604n);
  if ((abs & 0x40000n) !== 0n) mul(0x2216e584f5fa1ea926041bedfe98n);
  if ((abs & 0x80000n) !== 0n) mul(0x48a170391f7dc42444e8fa2n);
  if (tick > 0) ratio = (2n ** 256n - 1n) / ratio;
  // From Q128.128 to Q64.96, rounding up.
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

const mulDiv = (a: bigint, b: bigint, d: bigint) => (a * b) / d;

function amount0(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return mulDiv((liquidity << 96n) * (sqrtB - sqrtA), 1n, sqrtB) / sqrtA;
}
function amount1(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return mulDiv(liquidity, sqrtB - sqrtA, Q96);
}

/** Token amounts (raw) held by `liquidity` in [tickLower, tickUpper] at sqrtP. */
export function positionAmounts(
  sqrtP: bigint,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  const sqrtA = getSqrtRatioAtTick(tickLower);
  const sqrtB = getSqrtRatioAtTick(tickUpper);
  if (sqrtP <= sqrtA) return { amount0: amount0(sqrtA, sqrtB, liquidity), amount1: 0n };
  if (sqrtP >= sqrtB) return { amount0: 0n, amount1: amount1(sqrtA, sqrtB, liquidity) };
  return { amount0: amount0(sqrtP, sqrtB, liquidity), amount1: amount1(sqrtA, sqrtP, liquidity) };
}
