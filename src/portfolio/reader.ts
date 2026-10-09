import { PF_CHAINS, PROTOCOLS, chainProtocolManagers, protocolByManager, type ProtocolDef } from './config';
import { positionAmounts } from './ticks';
import { fetchYuzuPositions, isMovementAddress } from './yuzu';
import { fetchUniv4Positions, fetchUniv4PositionsByIds } from './univ4';
import { sleep as bgSleep } from '../engine/timers';

const ROUTESCAN = '/px/routescan';
const LLAMA = '/px/llama';

export interface PositionToken {
  address: string;
  symbol: string;
  decimals: number;
  amount: number;
  price: number;
  usd: number;
}
export interface Position {
  id: string; // `${chain}:${manager}:${tokenId}`
  owner: string; // wallet address that holds this position
  protocol: string;
  chain: string;
  chainName: string;
  tokenId: string;
  token0: PositionToken;
  token1: PositionToken;
  feeBps: number;
  tickLower: number;
  tickUpper: number;
  inRange: boolean;
  usd: number;
}

// ——— low-level helpers ———
const addr = (word: string) => '0x' + word.slice(24);
const s24 = (word: string) => {
  const x = parseInt(word.slice(-6), 16);
  return x >= 0x800000 ? x - 0x1000000 : x;
};
const pad = (v: string | number | bigint) => BigInt(v).toString(16).padStart(64, '0');

// Public RPCs (rpc.plasma.to is QuickNode-backed) cap requests/second and count
// EACH item of a JSON-RPC batch separately. Stay well under 25/s: send chunks of
// BATCH_MAX, spaced BATCH_GAP_MS apart, and retry any call that gets rate-limited.
const BATCH_MAX = 20;
const BATCH_GAP_MS = 1100;
const RETRY_MAX = 4;
// Worker-backed so batch pacing keeps its real duration in a background tab.
const sleep = bgSleep;

/** Throttled + retrying JSON-RPC batch eth_call; returns result hex per call (or null). */
async function batchCall(
  rpc: string,
  calls: { to: string; data: string }[],
  attempt = 0,
): Promise<(string | null)[]> {
  const out: (string | null)[] = new Array(calls.length).fill(null);
  const retry: number[] = [];
  for (let start = 0; start < calls.length; start += BATCH_MAX) {
    if (start > 0) await sleep(BATCH_GAP_MS);
    const chunk = calls.slice(start, start + BATCH_MAX);
    const body = chunk.map((c, i) => ({
      jsonrpc: '2.0',
      id: i,
      method: 'eth_call',
      params: [{ to: c.to, data: c.data }, 'latest'],
    }));
    let arr: any[] = [];
    try {
      const r = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      arr = Array.isArray(j) ? j : [];
    } catch {
      /* whole chunk failed — retry every call */
    }
    const byId: Record<number, any> = {};
    for (const it of arr) if (typeof it?.id === 'number') byId[it.id] = it;
    chunk.forEach((_, i) => {
      const it = byId[i];
      if (it?.result) out[start + i] = it.result;
      else retry.push(start + i); // missing or rate-limited (-32007) → retry
    });
  }
  if (retry.length && attempt < RETRY_MAX) {
    await sleep(BATCH_GAP_MS);
    const sub = await batchCall(rpc, retry.map((k) => calls[k]), attempt + 1);
    retry.forEach((k, i) => {
      if (sub[i] != null) out[k] = sub[i];
    });
  }
  return out;
}

/** Enumerate a wallet's ERC-721 holdings on a chain, keep only our managers. */
async function enumeratePositions(chain: string, wallet: string) {
  const c = PF_CHAINS[chain];
  const managers = new Set(chainProtocolManagers(chain));
  const found: { manager: string; tokenId: string }[] = [];
  let url: string | null =
    `${ROUTESCAN}/v2/network/mainnet/evm/${c.routescanId}/address/${wallet}/erc721-holdings?limit=100`;
  let guard = 0;
  while (url && guard++ < 10) {
    const j: any = await fetch(url, { headers: { accept: 'application/json' } }).then((r) => r.json());
    for (const it of j.items ?? []) {
      const m = String(it.tokenAddress).toLowerCase();
      if (managers.has(m)) found.push({ manager: m, tokenId: String(it.tokenId) });
    }
    url = j.link?.next ?? null;
  }
  return found;
}

// selectors
const SEL_POSITIONS = '0x99fbab88'; // positions(uint256)
const SEL_FACTORY = '0xc45a0155'; // factory()
const SEL_GETPOOL = '0x1698ee82'; // getPool(address,address,uint24)
const SEL_SLOT0 = '0x3850c7bd'; // slot0()
const SEL_DECIMALS = '0x313ce567';
const SEL_SYMBOL = '0x95d89b41';

const decodeString = (hex?: string | null): string => {
  if (!hex || hex === '0x') return '?';
  const b = hex.slice(2);
  // ABI dynamic string: offset(32) len(32) data
  if (b.length >= 128) {
    const len = parseInt(b.slice(64, 128), 16);
    if (len > 0 && len < 64) {
      const data = b.slice(128, 128 + len * 2);
      try {
        return decodeURIComponent(data.replace(/(..)/g, '%$1'));
      } catch {
        /* fall through */
      }
    }
  }
  // bytes32 string
  const raw = b.replace(/00+$/, '');
  try {
    return decodeURIComponent(raw.replace(/(..)/g, '%$1'));
  } catch {
    return '?';
  }
};

async function fetchPricesLlama(chain: string, addresses: string[]): Promise<Record<string, number>> {
  const llamaChain = PF_CHAINS[chain].llama;
  const ids = addresses.map((a) => `${llamaChain}:${a}`).join(',');
  const out: Record<string, number> = {};
  try {
    const j: any = await fetch(`${LLAMA}/prices/current/${ids}`).then((r) => r.json());
    for (const [k, v] of Object.entries<any>(j.coins ?? {})) {
      out[k.split(':')[1].toLowerCase()] = v?.price ?? 0;
    }
  } catch {
    /* prices best-effort */
  }
  return out;
}

async function readChain(chain: string, wallet: string): Promise<Position[]> {
  const c = PF_CHAINS[chain];
  const matches = await enumeratePositions(chain, wallet);
  if (matches.length === 0) return [];

  // 1) positions(tokenId) for every matched NFT
  const posRes = await batchCall(
    c.rpc,
    matches.map((m) => ({ to: m.manager, data: SEL_POSITIONS + pad(m.tokenId) })),
  );
  type Parsed = {
    manager: string;
    protocol: ProtocolDef;
    tokenId: string;
    token0: string;
    token1: string;
    fee: number;
    tickLower: number;
    tickUpper: number;
    liquidity: bigint;
  };
  const parsed: Parsed[] = [];
  matches.forEach((m, i) => {
    const r = posRes[i];
    if (!r || r === '0x') return;
    const b = r.slice(2);
    const w = (k: number) => b.slice(k * 64, k * 64 + 64);
    const liquidity = BigInt('0x' + w(7));
    if (liquidity === 0n) return; // skip empty/closed positions
    const protocol = protocolByManager(chain, m.manager);
    if (!protocol) return;
    parsed.push({
      manager: m.manager,
      protocol,
      tokenId: m.tokenId,
      token0: addr(w(2)).toLowerCase(),
      token1: addr(w(3)).toLowerCase(),
      fee: parseInt(w(4), 16),
      tickLower: s24(w(5)),
      tickUpper: s24(w(6)),
      liquidity,
    });
  });
  if (parsed.length === 0) return [];

  // 2) factory() per manager
  const managers = [...new Set(parsed.map((p) => p.manager))];
  const facRes = await batchCall(c.rpc, managers.map((m) => ({ to: m, data: SEL_FACTORY })));
  const factoryOf: Record<string, string> = {};
  managers.forEach((m, i) => {
    if (facRes[i]) factoryOf[m] = addr(facRes[i]!.slice(2));
  });

  // 3) getPool(token0, token1, fee) per unique (factory, t0, t1, fee)
  const poolKey = (p: Parsed) => `${p.token0}:${p.token1}:${p.fee}`;
  const uniquePools = [...new Map(parsed.map((p) => [poolKey(p), p])).values()];
  const poolRes = await batchCall(
    c.rpc,
    uniquePools.map((p) => ({
      to: factoryOf[p.manager],
      data: SEL_GETPOOL + p.token0.slice(2).padStart(64, '0') + p.token1.slice(2).padStart(64, '0') + pad(p.fee),
    })),
  );
  const poolByKey: Record<string, string> = {};
  uniquePools.forEach((p, i) => {
    if (poolRes[i]) poolByKey[poolKey(p)] = addr(poolRes[i]!.slice(2));
  });

  // 4) slot0() per unique pool
  const pools = [...new Set(Object.values(poolByKey))];
  const slotRes = await batchCall(c.rpc, pools.map((pool) => ({ to: pool, data: SEL_SLOT0 })));
  const sqrtByPool: Record<string, bigint> = {};
  pools.forEach((pool, i) => {
    const r = slotRes[i];
    if (r && r !== '0x') sqrtByPool[pool] = BigInt('0x' + r.slice(2, 66));
  });

  // 5) decimals + symbol for every token
  const tokens = [...new Set(parsed.flatMap((p) => [p.token0, p.token1]))];
  const metaRes = await batchCall(
    c.rpc,
    tokens.flatMap((t) => [
      { to: t, data: SEL_DECIMALS },
      { to: t, data: SEL_SYMBOL },
    ]),
  );
  const meta: Record<string, { decimals: number; symbol: string }> = {};
  tokens.forEach((t, i) => {
    const dec = metaRes[i * 2];
    const sym = metaRes[i * 2 + 1];
    meta[t] = {
      decimals: dec && dec !== '0x' ? parseInt(dec.slice(-64), 16) : 18,
      symbol: decodeString(sym),
    };
  });

  // 6) prices
  const prices = await fetchPricesLlama(chain, tokens);

  // 7) assemble
  const positions: Position[] = [];
  for (const p of parsed) {
    const pool = poolByKey[poolKey(p)];
    const sqrtP = pool ? sqrtByPool[pool] : undefined;
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
    // current tick from sqrtP vs range
    const inRange = amount0 > 0n && amount1 > 0n;
    positions.push({
      id: `${chain}:${p.manager}:${p.tokenId}`,
      owner: wallet,
      protocol: p.protocol.label,
      chain,
      chainName: c.name,
      tokenId: p.tokenId,
      token0: t0,
      token1: t1,
      feeBps: p.fee,
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      inRange,
      usd: t0.usd + t1.usd,
    });
  }
  return positions;
}

const isEvmAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());
// A Monad Uniswap-v4 position is tracked by its NFT id (Monad can't be
// enumerated without an indexer key): `monad:599441`, `monad-v4:599441`, or a
// bare integer (Monad is the only v4 chain).
const MONAD_V4_RE = /^(?:monad(?:-v4)?:)?(\d{1,20})$/i;

/** Split free-form input into EVM, Movement addresses and Monad v4 position ids. */
export function parseAddresses(input: string): { evm: string[]; movement: string[]; monadV4: string[] } {
  const evm: string[] = [];
  const movement: string[] = [];
  const monadV4: string[] = [];
  for (const part of input.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)) {
    const v4 = part.match(MONAD_V4_RE);
    if (isEvmAddress(part)) evm.push(part);
    else if (v4) monadV4.push(v4[1]);
    else if (isMovementAddress(part) && part.length > 42) movement.push(part);
  }
  return { evm, movement, monadV4 };
}

/**
 * Fetch all tracked DeFi positions for one or more wallets. EVM addresses are
 * read on-chain across the configured chains (v3) plus Uniswap v4 on Monad
 * (enumerated via Etherscan when a key is set); Movement addresses go to Yuzu;
 * bare Monad v4 position ids are read directly.
 */
export async function fetchWalletPositions(input: string): Promise<Position[]> {
  const { evm, movement, monadV4 } = parseAddresses(input);
  const chains = [...new Set(PROTOCOLS.map((p) => p.chain))];
  const tasks: Promise<Position[]>[] = [];
  for (const wallet of evm) {
    for (const chain of chains) tasks.push(readChain(chain, wallet).catch(() => [] as Position[]));
    tasks.push(fetchUniv4Positions('monad', wallet).catch(() => [] as Position[]));
  }
  for (const wallet of movement) tasks.push(fetchYuzuPositions(wallet).catch(() => [] as Position[]));
  if (monadV4.length) tasks.push(fetchUniv4PositionsByIds('monad', monadV4).catch(() => [] as Position[]));
  const results = await Promise.all(tasks);
  return results.flat().sort((a, b) => b.usd - a.usd);
}
