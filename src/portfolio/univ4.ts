// Uniswap v4 position tracking. Unlike v3 (reader.ts), v4 pools live in a
// singleton PoolManager: the PositionManager NFT holds the PoolKey + packed tick
// range, poolId = keccak256(abi.encode(poolKey)), and the pool's slot0 is read
// from the PoolManager's storage via extsload (the `_pools` mapping). Enumeration
// of a wallet's position token ids uses the Etherscan v2 API (Routescan does not
// index Monad and the v4 PositionManager is not ERC-721 Enumerable); individual
// positions can also be read by id with no key. Output maps to the shared
// Position shape so the UI renders v4 rows like any other.
import { PF_CHAINS, chainV4Protocols, type ProtocolV4Def } from './config';
import { positionAmounts } from './ticks';
import type { Position, PositionToken } from './reader';

const ETHERSCAN = '/px/etherscan';
const LLAMA = '/px/llama';

// ——— compact keccak256 (for poolId + storage slots) ———
const M64 = (1n << 64n) - 1n;
const RC = [
  0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x8an, 0x88n, 0x80008009n, 0x8000000an,
  0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n,
];
const RO = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const rotl = (v: bigint, s: number) => (s === 0 ? v & M64 : (((v << BigInt(s)) & M64) | (v >> BigInt(64 - s))) & M64);
function keccakF(st: BigUint64Array) {
  const c = new BigUint64Array(5), d = new BigUint64Array(5), b = new BigUint64Array(25);
  for (let r = 0; r < 24; r++) {
    for (let x = 0; x < 5; x++) c[x] = st[x] ^ st[x + 5] ^ st[x + 10] ^ st[x + 15] ^ st[x + 20];
    for (let x = 0; x < 5; x++) d[x] = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) st[x + 5 * y] = (st[x + 5 * y] ^ d[x]) & M64;
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) { const i = x + 5 * y; b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(st[i], RO[i]); }
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) { const i = x + 5 * y; st[i] = b[i] ^ (((~b[((x + 1) % 5) + 5 * y]) & M64) & b[((x + 2) % 5) + 5 * y]); }
    st[0] = (st[0] ^ RC[r]) & M64;
  }
}
const hexToBytes = (h: string) => {
  h = h.replace(/^0x/, '');
  if (h.length % 2) h = '0' + h;
  const o = new Uint8Array(h.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return o;
};
function keccak(data: Uint8Array): string {
  const st = new BigUint64Array(25);
  const RATE = 136;
  const pl = Math.ceil((data.length + 1) / RATE) * RATE;
  const p = new Uint8Array(pl);
  p.set(data);
  p[data.length] = 0x01;
  p[pl - 1] |= 0x80;
  for (let off = 0; off < pl; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let j = 0; j < 8; j++) lane |= BigInt(p[off + i * 8 + j] || 0) << BigInt(8 * j);
      st[i] = (st[i] ^ lane) & M64;
    }
    keccakF(st);
  }
  const out = new Uint8Array(32);
  let oi = 0, li = 0;
  while (oi < 32) { const lane = st[li]; for (let j = 0; j < 8 && oi < 32; j++) out[oi++] = Number((lane >> BigInt(8 * j)) & 0xffn); li++; }
  return '0x' + Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
}
const keccakHex = (hex: string) => keccak(hexToBytes(hex));

// ——— abi helpers ———
const encAddr = (a: string) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const encUint = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0');
const encInt = (v: number) => { const m = 1n << 256n; return (((BigInt(v) % m) + m) % m).toString(16).padStart(64, '0'); };
const addrFromWord = (w: string) => '0x' + w.slice(24);
const s24 = (x: bigint) => (x >= 1n << 23n ? Number(x - (1n << 24n)) : Number(x));

// ——— selectors (verified on Monad) ———
const SEL_LIQUIDITY = '0x1efeed33'; // getPositionLiquidity(uint256)
const SEL_POOL_INFO = '0x7ba03aad'; // getPoolAndPositionInfo(uint256)
const SEL_OWNER_OF = '0x6352211e'; // ownerOf(uint256)
const SEL_EXTSLOAD = '0x1e2eaeaf'; // extsload(bytes32)
const SEL_DECIMALS = '0x313ce567';
const SEL_SYMBOL = '0x95d89b41';

const BATCH_MAX = 20;
async function batchCall(rpc: string, calls: { to: string; data: string }[]): Promise<(string | null)[]> {
  const out: (string | null)[] = new Array(calls.length).fill(null);
  for (let start = 0; start < calls.length; start += BATCH_MAX) {
    const chunk = calls.slice(start, start + BATCH_MAX);
    const body = chunk.map((c, i) => ({ jsonrpc: '2.0', id: i, method: 'eth_call', params: [{ to: c.to, data: c.data }, 'latest'] }));
    let arr: any[] = [];
    try {
      const j = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
      arr = Array.isArray(j) ? j : [];
    } catch { /* whole chunk failed */ }
    for (const it of arr) if (typeof it?.id === 'number' && it.result) out[start + it.id] = it.result;
  }
  return out;
}

const decodeSymbol = (hex?: string | null): string => {
  if (!hex || hex === '0x') return '?';
  const b = hex.slice(2);
  if (b.length >= 128) {
    const len = parseInt(b.slice(64, 128), 16);
    if (len > 0 && len < 64) {
      try { return decodeURIComponent(b.slice(128, 128 + len * 2).replace(/(..)/g, '%$1')); } catch { /* fall through */ }
    }
  }
  try { return decodeURIComponent(b.replace(/00+$/, '').replace(/(..)/g, '%$1')); } catch { return '?'; }
};

async function fetchPricesLlama(chain: string, addresses: string[]): Promise<Record<string, number>> {
  const llamaChain = PF_CHAINS[chain].llama;
  const out: Record<string, number> = {};
  try {
    const ids = addresses.map((a) => `${llamaChain}:${a}`).join(',');
    const j: any = await fetch(`${LLAMA}/prices/current/${ids}`).then((r) => r.json());
    for (const [k, v] of Object.entries<any>(j.coins ?? {})) out[k.split(':')[1].toLowerCase()] = v?.price ?? 0;
  } catch { /* best-effort */ }
  return out;
}

/**
 * Candidate position token ids a wallet may hold in the PositionManager. Uses the
 * FREE Etherscan v2 `tokennfttx` action (the `addresstokennftinventory` inventory
 * endpoint is Pro-only): walk the ERC-721 transfers for this (wallet, contract)
 * and keep ids whose latest transfer landed on the wallet. Ownership is
 * re-verified on-chain in readPositions, so a stale transfer list is harmless.
 */
async function enumerateViaEtherscan(proto: ProtocolV4Def, wallet: string): Promise<string[]> {
  // apikey is appended server-side by /px/etherscan from ETHERSCAN_KEY.
  const url =
    `${ETHERSCAN}/v2/api?chainid=${proto.etherscanChainId}&module=account&action=tokennfttx` +
    `&address=${wallet}&contractaddress=${proto.positionManager}` +
    `&page=1&offset=1000&startblock=0&endblock=latest&sort=asc`;
  try {
    const j: any = await fetch(url).then((r) => r.json());
    if (j.status !== '1' || !Array.isArray(j.result)) return [];
    const latestTo = new Map<string, string>();
    for (const t of j.result) latestTo.set(String(t.tokenID), String(t.to).toLowerCase());
    const w = wallet.toLowerCase();
    return [...latestTo.entries()].filter(([, to]) => to === w).map(([id]) => id);
  } catch {
    return [];
  }
}

type Entry = { tokenId: string; owner?: string };

/** Read a set of v4 positions on one chain and map them to Position rows. */
async function readPositions(chain: string, proto: ProtocolV4Def, entries: Entry[]): Promise<Position[]> {
  if (entries.length === 0) return [];
  const rpc = PF_CHAINS[chain].rpc;
  const PM = proto.positionManager;

  // 1) liquidity + pool/position info + ownerOf (ownership is always verified
  //    on-chain, so a stale enumeration list can't surface positions the wallet
  //    no longer holds).
  const calls: { to: string; data: string }[] = [];
  for (const e of entries) {
    calls.push({ to: PM, data: SEL_LIQUIDITY + encUint(BigInt(e.tokenId)) });
    calls.push({ to: PM, data: SEL_POOL_INFO + encUint(BigInt(e.tokenId)) });
    calls.push({ to: PM, data: SEL_OWNER_OF + encUint(BigInt(e.tokenId)) });
  }
  const stride = 3;
  const res = await batchCall(rpc, calls);

  type Parsed = {
    tokenId: string; owner: string; token0: string; token1: string; fee: number;
    tickLower: number; tickUpper: number; liquidity: bigint; poolId: string;
  };
  const parsed: Parsed[] = [];
  entries.forEach((e, i) => {
    const liqRaw = res[i * stride];
    const infoRaw = res[i * stride + 1];
    if (!liqRaw || !infoRaw || infoRaw === '0x') return;
    const liquidity = BigInt(liqRaw);
    if (liquidity <= 0n) return;
    const b = infoRaw.slice(2);
    const w = (k: number) => b.slice(k * 64, k * 64 + 64);
    const token0 = addrFromWord(w(0)).toLowerCase();
    const token1 = addrFromWord(w(1)).toLowerCase();
    const fee = parseInt(w(2), 16);
    const tickSpacing = s24(BigInt('0x' + w(3)) & ((1n << 24n) - 1n));
    const hooks = addrFromWord(w(4)).toLowerCase();
    const packed = BigInt('0x' + w(5));
    const mask24 = (1n << 24n) - 1n;
    const tickLower = s24((packed >> 8n) & mask24);
    const tickUpper = s24((packed >> 32n) & mask24);
    const poolId = keccakHex(encAddr(token0) + encAddr(token1) + encUint(fee) + encInt(tickSpacing) + encAddr(hooks));
    const o = res[i * stride + 2];
    const owner = o && o !== '0x' ? addrFromWord(o.slice(2)).toLowerCase() : e.owner ?? '';
    parsed.push({ tokenId: e.tokenId, owner, token0, token1, fee, tickLower, tickUpper, liquidity, poolId });
  });
  if (parsed.length === 0) return [];

  // 2) slot0 for each unique pool, read from PoolManager storage via extsload.
  const uniquePools = [...new Set(parsed.map((p) => p.poolId))];
  const slotOf = (poolId: string, mappingSlot: number) => keccakHex(poolId.replace(/^0x/, '').padStart(64, '0') + encUint(mappingSlot));
  const slotRes = await batchCall(rpc, uniquePools.map((pid) => ({ to: proto.poolManager, data: SEL_EXTSLOAD + slotOf(pid, proto.poolsSlot).slice(2) })));
  const sqrtByPool: Record<string, bigint> = {};
  uniquePools.forEach((pid, i) => {
    const r = slotRes[i];
    if (r && r !== '0x') {
      const val = BigInt(r);
      const sqrtP = val & ((1n << 160n) - 1n);
      if (sqrtP > 0n) sqrtByPool[pid] = sqrtP;
    }
  });

  // 3) token decimals + symbol
  const tokens = [...new Set(parsed.flatMap((p) => [p.token0, p.token1]))];
  const NATIVE = '0x0000000000000000000000000000000000000000';
  const erc20 = tokens.filter((t) => t !== NATIVE);
  const metaRes = await batchCall(rpc, erc20.flatMap((t) => [{ to: t, data: SEL_DECIMALS }, { to: t, data: SEL_SYMBOL }]));
  const meta: Record<string, { decimals: number; symbol: string }> = {
    [NATIVE]: { decimals: 18, symbol: 'MON' },
  };
  erc20.forEach((t, i) => {
    const dec = metaRes[i * 2];
    meta[t] = { decimals: dec && dec !== '0x' ? parseInt(dec.slice(-64), 16) : 18, symbol: decodeSymbol(metaRes[i * 2 + 1]) };
  });

  // 4) prices, then assemble
  const prices = await fetchPricesLlama(chain, tokens);
  const positions: Position[] = [];
  for (const p of parsed) {
    const sqrtP = sqrtByPool[p.poolId];
    if (!sqrtP) continue;
    const { amount0, amount1 } = positionAmounts(sqrtP, p.tickLower, p.tickUpper, p.liquidity);
    const m0 = meta[p.token0];
    const m1 = meta[p.token1];
    const amt0 = Number(amount0) / 10 ** m0.decimals;
    const amt1 = Number(amount1) / 10 ** m1.decimals;
    const price0 = prices[p.token0] ?? 0;
    const price1 = prices[p.token1] ?? 0;
    const t0: PositionToken = { address: p.token0, symbol: m0.symbol, decimals: m0.decimals, amount: amt0, price: price0, usd: amt0 * price0 };
    const t1: PositionToken = { address: p.token1, symbol: m1.symbol, decimals: m1.decimals, amount: amt1, price: price1, usd: amt1 * price1 };
    positions.push({
      id: `${chain}:${PM}:${p.tokenId}`,
      owner: p.owner,
      protocol: proto.label,
      chain,
      chainName: PF_CHAINS[chain].name,
      tokenId: p.tokenId,
      token0: t0,
      token1: t1,
      feeBps: p.fee,
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      inRange: amount0 > 0n && amount1 > 0n,
      usd: t0.usd + t1.usd,
    });
  }
  return positions;
}

/** All v4 positions a wallet holds on `chain` (enumerated via Etherscan v2; needs a key). */
export async function fetchUniv4Positions(chain: string, wallet: string): Promise<Position[]> {
  const w = wallet.toLowerCase();
  const out: Position[] = [];
  for (const proto of chainV4Protocols(chain)) {
    const ids = await enumerateViaEtherscan(proto, wallet);
    if (ids.length === 0) continue;
    const rows = await readPositions(chain, proto, ids.map((tokenId) => ({ tokenId })));
    out.push(...rows.filter((r) => r.owner.toLowerCase() === w)); // drop any stale/transferred ids
  }
  return out;
}

/** Read specific v4 positions by token id (keyless — owner resolved via ownerOf). */
export async function fetchUniv4PositionsByIds(chain: string, tokenIds: string[]): Promise<Position[]> {
  const proto = chainV4Protocols(chain)[0];
  if (!proto || tokenIds.length === 0) return [];
  return readPositions(chain, proto, tokenIds.map((tokenId) => ({ tokenId })));
}
