import type { Network, QuoteRoute } from '../config/networks';
import { tokenOn, type TokenDeployment } from '../config/tokens';
import { sleep } from './timers';
import { quoteUniV3Pool, quoteUniV3PoolAt } from './univ3pool';

// In dev, requests go through the Vite proxy (see vite.config.ts) to dodge
// CORS. Production builds hit the real origins directly.
const BASE = {
  canoe: '/px/canoe',
  oku: '/px/oku',
  kyber: '/px/kyber',
  openocean: '/px/openocean',
  eisen: '/px/eisen',
  enso: '/px/enso',
  jupUltra: '/px/jup-ultra',
  jupLite: '/px/jup-lite',
  avalancheRpc: '/px/avax-rpc',
  fluentRpc: '/px/fluent',
  xlayerRpc: '/px/xlayer',
  okx: '/px/okx',
  inkRpc: '/px/ink',
  binance: '/px/binance',
  bybit: '/px/bybit',
} as const;

// Address used purely as quote context (msg.sender) by the aggregators that
// require one. No transaction is ever signed — this is a read-only monitor.
const QUOTE_ACCOUNT = '0xBD73cF5baf12F120Ee3f6C4ad82df9a12649e578';

export interface QuoteReq {
  net: Network;
  tokenIn: TokenDeployment;
  tokenOut: TokenDeployment;
  amountInHuman: number;
}

export interface QuoteRes {
  outHuman: number;
  /** Aggregator/router that produced the quote (KyberSwap, OKX, …). */
  router: string;
}

type Provider = (req: QuoteReq) => Promise<QuoteRes>;

// ——— helpers ———

type RateBucket =
  | 'canoe'
  | 'oku'
  | 'kyber'
  | 'openocean'
  | 'eisen'
  | 'enso'
  | 'jupiter'
  | 'avalancheRpc'
  | 'fluent'
  | 'xlayerRpc'
  | 'okxCex'
  | 'binanceCex'
  | 'bybitCex'
  | 'inkRpc';

const RATE_LIMITS: Record<RateBucket, { minDelayMs: number; maxRetries: number }> = {
  canoe: { minDelayMs: 900, maxRetries: 2 },
  // Oku advertises RateLimit-Limit "400, 16000" (~400 req/s) and headroom is
  // ample, so 150ms is safe. (The 500s seen earlier were not rate-related —
  // Oku's Update 500s "chain not supported" for chains it doesn't cover, which
  // are no longer routed through Oku; see networks.ts.)
  oku: { minDelayMs: 150, maxRetries: 2 },
  kyber: { minDelayMs: 650, maxRetries: 2 },
  openocean: { minDelayMs: 900, maxRetries: 2 },
  eisen: { minDelayMs: 800, maxRetries: 2 },
  enso: { minDelayMs: 1_100, maxRetries: 2 },
  jupiter: { minDelayMs: 300, maxRetries: 2 },
  avalancheRpc: { minDelayMs: 350, maxRetries: 1 },
  fluent: { minDelayMs: 350, maxRetries: 1 },
  xlayerRpc: { minDelayMs: 250, maxRetries: 1 },
  inkRpc: { minDelayMs: 250, maxRetries: 1 },
  // Binance allows 1200 request-weight/min; a depth call costs 5.
  binanceCex: { minDelayMs: 200, maxRetries: 2 },
  // OKX public market data allows 20 req/2s per endpoint; 200ms is well under.
  okxCex: { minDelayMs: 200, maxRetries: 2 },
  // Bybit public market data allows 600 req/5s per IP; 200ms is well under.
  bybitCex: { minDelayMs: 200, maxRetries: 2 },
};

const rateState: Record<RateBucket, { nextAt: number; tail: Promise<void> }> = {
  canoe: { nextAt: 0, tail: Promise.resolve() },
  oku: { nextAt: 0, tail: Promise.resolve() },
  kyber: { nextAt: 0, tail: Promise.resolve() },
  openocean: { nextAt: 0, tail: Promise.resolve() },
  eisen: { nextAt: 0, tail: Promise.resolve() },
  enso: { nextAt: 0, tail: Promise.resolve() },
  jupiter: { nextAt: 0, tail: Promise.resolve() },
  avalancheRpc: { nextAt: 0, tail: Promise.resolve() },
  fluent: { nextAt: 0, tail: Promise.resolve() },
  xlayerRpc: { nextAt: 0, tail: Promise.resolve() },
  inkRpc: { nextAt: 0, tail: Promise.resolve() },
  binanceCex: { nextAt: 0, tail: Promise.resolve() },
  okxCex: { nextAt: 0, tail: Promise.resolve() },
  bybitCex: { nextAt: 0, tail: Promise.resolve() },
};

// Worker-backed: a scan performs hundreds of these short sleeps, and plain
// setTimeout is clamped to ~1/minute in a background tab (see timers.ts).
const sameAddr = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const word = (hex: bigint) => hex.toString(16).padStart(64, '0');
const addrWord = (a: string) => a.slice(2).toLowerCase().padStart(64, '0');

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

async function waitTurn(bucket: RateBucket): Promise<void> {
  const state = rateState[bucket];
  const prev = state.tail;
  let release!: () => void;
  state.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  const waitMs = Math.max(0, state.nextAt - Date.now());
  if (waitMs > 0) await sleep(waitMs);
  state.nextAt = Date.now() + RATE_LIMITS[bucket].minDelayMs;
  release();
}

// ——— dead-venue breaker ———
// A venue that is down answers every quote with a 5xx or not at all (Canoe and
// Oku returned HTTP 525 to everything for days), and each of those attempts
// costs a proxy request and a rate-limit slot before the route falls back.
// After a few failures in a row the venue is skipped outright for a while —
// quote() moves straight on to the next route — then a single success
// re-opens it. Request-specific failures (400/404: no route, bad pair) don't
// count.
const BREAKER_TRIP = 3;
const BREAKER_PAUSE_MS = 10 * 60_000;
const breaker: Partial<Record<RateBucket, { fails: number; until: number; why: string }>> = {};

function checkBreaker(bucket: RateBucket): void {
  const b = breaker[bucket];
  if (b && Date.now() < b.until) {
    const at = new Date(b.until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    throw new Error(`${bucket}: down (${b.why}), retrying at ${at}`);
  }
}

function venueFailed(bucket: RateBucket, why: string): void {
  const b = (breaker[bucket] ??= { fails: 0, until: 0, why });
  b.fails++;
  b.why = why;
  // Once tripped, each failed retry pauses it again straight away.
  if (b.fails >= BREAKER_TRIP) b.until = Date.now() + BREAKER_PAUSE_MS;
}

const venueOk = (bucket: RateBucket): void => void delete breaker[bucket];

async function requestJson(
  bucket: RateBucket,
  url: string,
  init?: RequestInit,
): Promise<any> {
  const { maxRetries, minDelayMs } = RATE_LIMITS[bucket];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    checkBreaker(bucket);
    await waitTurn(bucket);
    let r: Response;
    try {
      r = await fetch(url, init);
    } catch (e) {
      venueFailed(bucket, 'unreachable');
      throw e;
    }
    if (r.ok) {
      venueOk(bucket);
      return r.json();
    }
    // An unread body keeps the whole request alive in Chrome (see net-timeout.ts).
    void r.body?.cancel().catch(() => {});
    // 5xx: the venue is down. 401/403: it refuses us (bad key, blocked
    // address) — every request would fail the same way.
    if (r.status >= 500 || r.status === 401 || r.status === 403) venueFailed(bucket, `HTTP ${r.status}`);

    if (r.status === 429 && attempt < maxRetries) {
      const pause =
        retryAfterMs(r.headers.get('retry-after')) ??
        Math.min(20_000, minDelayMs * 2 ** (attempt + 2));
      rateState[bucket].nextAt = Math.max(rateState[bucket].nextAt, Date.now() + pause);
      await sleep(pause);
      continue;
    }

    throw new Error(`${bucket}: HTTP ${r.status}`);
  }
  throw new Error(`${bucket}: rate limit retry exhausted`);
}

async function jget(bucket: RateBucket, url: string): Promise<any> {
  const j = await requestJson(bucket, url, { headers: { accept: 'application/json' } });
  return j;
}

async function jpost(
  bucket: RateBucket,
  url: string,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Promise<any> {
  const j = await requestJson(bucket, url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });
  return j;
}

/** Human amount -> raw integer string, BigInt-safe for 18-decimals notionals. */
export function toRaw(amountHuman: number, decimals: number): string {
  const fixed = amountHuman.toFixed(Math.min(decimals, 9));
  const [int, frac = ''] = fixed.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return (BigInt(int) * 10n ** BigInt(decimals) + BigInt(fracPadded || '0')).toString();
}

export const fromRaw = (raw: string | number | bigint, decimals: number): number =>
  Number(raw) / 10 ** decimals;

const OUT_KEYS = [
  'outTokenAmount',
  'outputTokenAmount',
  'outAmount',
  'amountOut',
  'outputAmount',
  'dstAmount',
  'dst_amount',
  'out_amount',
  'amount_out',
  'toAmount',
  'toTokenAmount',
  'returnAmount',
  'buyAmount',
];

/** Tolerant BFS for the output amount in an unknown response shape. */
function findOutAmount(obj: any): string | number | undefined {
  const queue: any[] = [obj];
  let guard = 0;
  while (queue.length && guard++ < 300) {
    const cur = queue.shift();
    if (cur == null || typeof cur !== 'object') continue;
    for (const k of OUT_KEYS) {
      const v = cur[k];
      if (typeof v === 'string' || typeof v === 'number') return v;
      if (Array.isArray(v) && (typeof v[0] === 'string' || typeof v[0] === 'number')) return v[0];
    }
    for (const v of Object.values(cur)) if (v && typeof v === 'object') queue.push(v);
  }
  return undefined;
}

/** Interpret an amount that may be raw units or already human-readable. */
function parseOut(v: string | number, outDecimals: number): number {
  const s = String(v);
  if (s.includes('.')) return Number(s); // already human
  return fromRaw(s, outDecimals);
}

// ——— Canoe (icarus.tools) — kyberswap | okx | openocean markets ———
// POST /market/{market}/swap_quote with a human-amount body.
const canoe =
  (market: 'kyberswap' | 'okx' | 'openocean'): Provider =>
  async ({ net, tokenIn, tokenOut, amountInHuman }) => {
    if (!net.canoeChain) throw new Error('canoe: no chain key for network');
    const j = await jpost('canoe', `${BASE.canoe}/market/${market}/swap_quote`, {
      chain: net.canoeChain,
      account: QUOTE_ACCOUNT,
      inTokenAddress: tokenIn.address,
      outTokenAddress: tokenOut.address,
      isExactIn: true,
      slippage: 1,
      inTokenAmount: String(amountInHuman), // human, not atomic
    });
    const out = findOutAmount(j);
    if (out == null) throw new Error('canoe: no outTokenAmount in response');
    // Input is human, so the returned outTokenAmount is human as well.
    const label = market === 'okx' ? 'OKX' : market === 'kyberswap' ? 'KyberSwap' : 'OpenOcean';
    return { outHuman: Number(out), router: label };
  };

// ——— KyberSwap aggregator (fallback / main EVM) ———
const kyberswap: Provider = async ({ net, tokenIn, tokenOut, amountInHuman }) => {
  if (!net.kyberSlug) throw new Error('kyberswap: unsupported chain');
  const qs = new URLSearchParams({
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    amountIn: toRaw(amountInHuman, tokenIn.decimals),
    gasInclude: 'false',
  });
  const j = await jget('kyber', `${BASE.kyber}/${net.kyberSlug}/api/v1/routes?${qs}`);
  const rs = j?.data?.routeSummary;
  if (!rs?.amountOut) throw new Error('kyberswap: no route');
  return { outHuman: fromRaw(rs.amountOut, tokenOut.decimals), router: 'KyberSwap' };
};

// ——— OKU Flowstream — single fastest aggregator on Oku-supported chains ———
const OKU_SWAP_PATH = '/connect/gfxcafe.oku.account.v2.SimpleSwapServiceV2';
// Oku exposes several markets (okx, zeroex, enso, usor). Benchmarked
// time-to-quote: enso ~0.85s (fastest + most consistent) > zeroex ~0.89s >
// okx ~1.0s (spiky) > usor ~2.4s. We query only enso to keep the poll short.
const OKU_MARKETS = ['enso'];
const OKU_LABEL: Record<string, string> = { okx: 'OKX', zeroex: '0x', enso: 'Enso', usor: 'USOR' };

// savUSD on Monad — enso 404s for this pool, but OKX has it.
const MONAD_SAVUSD = '0x9648db94f1e6b19e7d755585542981f97dc806c6';

// Per-case market override where the default (enso) has no quote.
function okuMarketsFor(net: Network, tokenIn: TokenDeployment, tokenOut: TokenDeployment): string[] {
  // enso doesn't support Mantle ("chain not supported"); OKX does.
  if (net.id === 'mantle') return ['okx'];
  if (
    net.id === 'monad' &&
    (sameAddr(tokenIn.address, MONAD_SAVUSD) || sameAddr(tokenOut.address, MONAD_SAVUSD))
  ) {
    return ['okx'];
  }
  return OKU_MARKETS;
}

// Each quote uses its OWN Oku order (Create → Update → poll). Reusing one
// shared order across the scan looked tempting (skip Create), but the Oku
// server 500s when the same order is Updated in rapid succession — and a
// shared order can only hold the latest quote, forcing serialization. Fresh
// per-quote orders run safely in parallel; the rate limit (~400 req/s, see
// RATE_LIMITS) makes the extra Create calls cheap.
const okuFlowstream: Provider = async ({ net, tokenIn, tokenOut, amountInHuman }) => {
  const markets = okuMarketsFor(net, tokenIn, tokenOut);
  const create = await jpost('oku', `${BASE.oku}${OKU_SWAP_PATH}/Create`, { params: {} });
  const orderId = create?.orderId;
  if (!orderId) throw new Error('oku: no orderId');

  const params = {
    account: QUOTE_ACCOUNT,
    chain: String(net.chainId),
    enableJit: true,
    enabledMarkets: markets,
    inTokenAddress: tokenIn.address,
    isExactIn: true,
    outTokenAddress: tokenOut.address,
    slippage: 2, // basis points (0.02%); only affects minAmountOut, not the quoted outAmount
    tokenAmount: String(amountInHuman),
    usePermit2: true,
  };
  const update = await jpost('oku', `${BASE.oku}${OKU_SWAP_PATH}/UpdateQuoteParams`, { orderId, params });
  const timeline = update?.timeline ?? create?.timeline ?? 1;

  // Markets fill in across polls (quotes are frozen per timeline). Keep the
  // best rate seen so far; stop once every market has resolved (quote or error).
  let best: { out: number; id: string } | null = null;
  let anyErr: string | null = null;
  for (let i = 0; i < 5; i++) {
    const q = await jpost('oku', `${BASE.oku}${OKU_SWAP_PATH}/GetFlowstreamQuotes`, {
      orderId,
      timeline,
      fetchedRouters: markets,
      waitTime: 3_000,
    });
    const quotes = q?.quotes ?? {};
    for (const id of markets) {
      const m = quotes[id];
      if (!m) continue;
      const raw = m.quote?.simulation?.amountOut ?? m.quote?.outAmount;
      const out = raw != null ? Number(raw) : NaN;
      if (isFinite(out) && out > 0) {
        if (!best || out > best.out) best = { out, id }; // exact-in → higher = better
      } else if (m.error?.message && !anyErr) {
        anyErr = m.error.message;
      }
    }
    if (markets.every((id) => quotes[id]?.quote || quotes[id]?.error)) break;
    await sleep(200);
  }
  if (best) return { outHuman: best.out, router: OKU_LABEL[best.id] ?? best.id.toUpperCase() };
  throw new Error(`oku: ${anyErr ?? 'no quote'}`);
};

// ——— OpenOcean v4 (fallback when Canoe market = openocean) ———
const openocean: Provider = async ({ net, tokenIn, tokenOut, amountInHuman }) => {
  const chain = net.openOceanSlug ?? String(net.chainId ?? '');
  if (!chain) throw new Error('openocean: unsupported chain');
  const qs = new URLSearchParams({
    inTokenAddress: tokenIn.address,
    outTokenAddress: tokenOut.address,
    amount: String(amountInHuman), // v4 takes human units
    gasPrice: '1',
  });
  const j = await jget('openocean', `${BASE.openocean}/v4/${chain}/quote?${qs}`);
  const out = j?.data?.outAmount;
  if (out == null) throw new Error('openocean: no outAmount');
  return { outHuman: fromRaw(out, tokenOut.decimals), router: 'OpenOcean' };
};

// ——— Eisen (Katana, chain 747474) ———
// POST /v1/chains/{chainId}/v2/quote with an atomic amount.
const EISEN_SPLIT_PARTS = [2, 3, 4, 8, 16] as const;

function eisenBody(tokenIn: TokenDeployment, tokenOut: TokenDeployment, amount: string) {
  return {
    tokenInAddr: tokenIn.address,
    tokenOutAddr: tokenOut.address,
    from: QUOTE_ACCOUNT,
    amount,
    maxEdge: '3',
    maxSplit: '5',
    withCycle: false,
    dexIdFilter: [],
    customTokens: [],
  };
}

function parseEisen(j: any): { outRaw: bigint; router: string } {
  const dexAgg = j?.result?.dexAgg;
  const dexAggOut = dexAgg?.expectedAmountOut;
  if (dexAggOut != null) {
    const dexId = dexAgg?.splitInfos?.[0]?.swapInfo?.dexId;
    return { outRaw: BigInt(String(dexAggOut)), router: dexId ? `Eisen ${dexId}` : 'Eisen' };
  }

  const single = Array.isArray(j?.result?.singleDexes)
    ? j.result.singleDexes.find((x: any) => x?.expectedAmountOut != null)
    : null;
  if (single) {
    const dexId = single?.swapInfo?.dexId ?? single?.dexId;
    return { outRaw: BigInt(String(single.expectedAmountOut)), router: dexId ? `Eisen ${dexId}` : 'Eisen' };
  }

  throw new Error('eisen: no expectedAmountOut');
}

async function eisenQuoteRaw(
  net: Network,
  tokenIn: TokenDeployment,
  tokenOut: TokenDeployment,
  amountRaw: string,
): Promise<{ outRaw: bigint; router: string }> {
  const j = await jpost('eisen', `${BASE.eisen}/v1/chains/${net.chainId}/v2/quote`, (
    eisenBody(tokenIn, tokenOut, amountRaw)
  ));
  return parseEisen(j);
}

async function eisenSplitQuoteRaw(
  net: Network,
  tokenIn: TokenDeployment,
  tokenOut: TokenDeployment,
  amountRaw: string,
): Promise<{ outRaw: bigint; router: string }> {
  const total = BigInt(amountRaw);
  for (const parts of EISEN_SPLIT_PARTS) {
    const base = total / BigInt(parts);
    const remainder = total % BigInt(parts);
    if (base <= 0n) continue;

    let outRaw = 0n;
    let router = 'Eisen Split';
    try {
      for (let i = 0; i < parts; i++) {
        const partAmount = base + (i === 0 ? remainder : 0n);
        const res = await eisenQuoteRaw(net, tokenIn, tokenOut, partAmount.toString());
        outRaw += res.outRaw;
        if (res.router !== 'Eisen') router = `Eisen Split ${res.router.replace(/^Eisen\s*/, '')}`.trim();
      }
      return { outRaw, router };
    } catch {
      // Try the next split size; route discovery can be liquidity-size sensitive.
    }
  }
  throw new Error('eisen: split quote failed');
}

const eisen: Provider = async ({ net, tokenIn, tokenOut, amountInHuman }) => {
  const amountRaw = toRaw(amountInHuman, tokenIn.decimals);
  try {
    const res = await eisenQuoteRaw(net, tokenIn, tokenOut, amountRaw);
    return { outHuman: fromRaw(res.outRaw, tokenOut.decimals), router: res.router };
  } catch {
    const res = await eisenSplitQuoteRaw(net, tokenIn, tokenOut, amountRaw);
    return { outHuman: fromRaw(res.outRaw, tokenOut.decimals), router: res.router };
  }
};

// ——— Enso (Ink) — POST with array token fields; needs an API key ———
// Enso rejects keyless requests (403). The key is attached server-side by the
// /px/enso function (api/_keyed.ts) from ENSO_KEY, so it never ships to the
// browser. https://developers.enso.build
const enso: Provider = async ({ net, tokenIn, tokenOut, amountInHuman }) => {
  const j = await jpost(
    'enso',
    `${BASE.enso}/api/v1/shortcuts/route`,
    {
      chainId: net.chainId,
      fromAddress: QUOTE_ACCOUNT,
      receiver: QUOTE_ACCOUNT,
      amountIn: [toRaw(amountInHuman, tokenIn.decimals)],
      tokenIn: [tokenIn.address],
      tokenOut: [tokenOut.address],
      slippage: '100',
      routingStrategy: 'router',
    },
  );
  const out = findOutAmount(j);
  if (out == null) throw new Error('enso: no amountOut');
  return { outHuman: parseOut(out, tokenOut.decimals), router: 'Enso' };
};

// ——— Jupiter (Solana): Ultra first, Lite fallback ———
// Prefer the plain quote endpoint over Ultra: Ultra's /order applies a 10 bps
// platform fee (its outAmount is already net of it), which you do not pay when
// executing the route yourself — so the lite quote is the right reference for
// an arbitrage monitor. Ultra stays as a fallback if the quote endpoint fails.
const jupiter: Provider = async ({ tokenIn, tokenOut, amountInHuman }) => {
  const amount = toRaw(amountInHuman, tokenIn.decimals);
  const common = { inputMint: tokenIn.address, outputMint: tokenOut.address, amount };
  try {
    const j = await jget(
      'jupiter',
      `${BASE.jupLite}/swap/v1/quote?${new URLSearchParams({ ...common, slippageBps: '50' })}`,
    );
    const out = j?.outAmount;
    if (out == null) throw new Error('no outAmount');
    return { outHuman: fromRaw(out, tokenOut.decimals), router: 'Jupiter' };
  } catch {
    const j = await jget('jupiter', `${BASE.jupUltra}/order?${new URLSearchParams(common)}`);
    const out = findOutAmount(j);
    if (out == null) throw new Error('jupiter: no outAmount');
    return { outHuman: parseOut(out, tokenOut.decimals), router: 'Jupiter' };
  }
};

// ——— Avalanche savUSD — direct mint/redeem preview against the ERC-4626 vault ———
const AVALANCHE_SAVUSD = '0x06d47F3fb376649c3A9Dafe069B3D6E35572219E';
const AVALANCHE_USDC = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
const AVALANCHE_SAVUSD_ASSET_DECIMALS = 18;
const SEL_PREVIEW_DEPOSIT = '0xef8b30f7'; // previewDeposit(uint256)
const SEL_PREVIEW_REDEEM = '0x4cdad506'; // previewRedeem(uint256)

async function avalancheEthCall(to: string, data: string): Promise<string> {
  const j = await jpost('avalancheRpc', BASE.avalancheRpc, {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to, data }, 'latest'],
  });
  if (j.error) throw new Error(`avalanche rpc: ${j.error.message}`);
  return j.result as string;
}

function parseReturnAmount(res: string, decimals: number): number {
  if (!res || res === '0x') throw new Error('empty eth_call result');
  return fromRaw(BigInt('0x' + res.slice(2, 66)), decimals);
}

const avalancheSavUsdMintRedeem: Provider = async ({ net, tokenIn, tokenOut, amountInHuman }) => {
  if (net.id !== 'avalancheMint') throw new Error('savusd mint/redeem: unsupported network');

  if (sameAddr(tokenIn.address, AVALANCHE_USDC) && sameAddr(tokenOut.address, AVALANCHE_SAVUSD)) {
    const assets = BigInt(toRaw(amountInHuman, AVALANCHE_SAVUSD_ASSET_DECIMALS));
    const res = await avalancheEthCall(AVALANCHE_SAVUSD, SEL_PREVIEW_DEPOSIT + word(assets));
    return { outHuman: parseReturnAmount(res, tokenOut.decimals), router: 'Mint/Redeem' };
  }

  if (sameAddr(tokenIn.address, AVALANCHE_SAVUSD) && sameAddr(tokenOut.address, AVALANCHE_USDC)) {
    const shares = BigInt(toRaw(amountInHuman, tokenIn.decimals));
    const res = await avalancheEthCall(AVALANCHE_SAVUSD, SEL_PREVIEW_REDEEM + word(shares));
    return {
      outHuman: parseReturnAmount(res, AVALANCHE_SAVUSD_ASSET_DECIMALS),
      router: 'Mint/Redeem',
    };
  }

  throw new Error('savusd mint/redeem: unsupported pair');
};

// ——— Fluent — sUSDnr/USDnr DEX quote via the FluxFlow quoter ———
const FLUX_QUOTER = '0x4cfc01cE8bcEEC0371e4C03223F9d1E46622b4Ec';
const FLUX_FEE = 500n;
// quoteExactInputSingle((tokenIn,tokenOut,amountIn,fee,sqrtPriceLimitX96))
const SEL_QUOTE_V2 = '0xc6a5026a';
const NERONA_VAULT = '0x50AE83DBDC44208eDa1Ef722F87Bab0FFB195Eea';
const FLUENT_SUSDNR = '0xFa9b3B45587f9fcdE14759121C3868C2733DCbf4';
const FLUENT_USDNR = '0xD48e565561416dE59DA1050ED70b8d75e8eF28f9';
const SEL_NERONA_PREVIEW_DEPOSIT = '0xb8f82b26';
const SEL_NERONA_PREVIEW_REDEMPTION = '0xb4db4be8';

async function ethCall(to: string, data: string): Promise<string> {
  const j = await jpost('fluent', BASE.fluentRpc, {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to, data }, 'latest'],
  });
  if (j.error) throw new Error(`fluent rpc: ${j.error.message}`);
  return j.result as string;
}

const fluent: Provider = async ({ tokenIn, tokenOut, amountInHuman }) => {
  const amt = BigInt(toRaw(amountInHuman, tokenIn.decimals));
  const data =
    SEL_QUOTE_V2 +
    addrWord(tokenIn.address) +
    addrWord(tokenOut.address) +
    word(amt) +
    word(FLUX_FEE) +
    word(0n);
  const res = await ethCall(FLUX_QUOTER, data);
  if (!res || res === '0x') throw new Error('fluent: empty quote');
  // QuoterV2 returns (amountOut, sqrtPriceX96After, ticksCrossed, gasEstimate);
  // amountOut is the first 32-byte word.
  const amountOut = BigInt('0x' + res.slice(2, 66));
  return { outHuman: fromRaw(amountOut, tokenOut.decimals), router: 'FluxFlow' };
};

const fluentStakeUnstake: Provider = async ({ net, tokenIn, tokenOut, amountInHuman }) => {
  if (net.id !== 'fluentStake') throw new Error('nerona: unsupported network');

  if (sameAddr(tokenIn.address, FLUENT_USDNR) && sameAddr(tokenOut.address, FLUENT_SUSDNR)) {
    const assets = BigInt(toRaw(amountInHuman, tokenIn.decimals));
    const res = await ethCall(
      NERONA_VAULT,
      SEL_NERONA_PREVIEW_DEPOSIT + addrWord(tokenIn.address) + word(assets),
    );
    return { outHuman: parseReturnAmount(res, tokenOut.decimals), router: 'Stake/Unstake' };
  }

  if (sameAddr(tokenIn.address, FLUENT_SUSDNR) && sameAddr(tokenOut.address, FLUENT_USDNR)) {
    const shares = BigInt(toRaw(amountInHuman, tokenIn.decimals));
    const res = await ethCall(NERONA_VAULT, SEL_NERONA_PREVIEW_REDEMPTION + word(shares) + word(0n));
    if (!res || res.length < 130) throw new Error('nerona: empty redemption preview');
    const amountOut = BigInt('0x' + res.slice(66, 130));
    return { outHuman: fromRaw(amountOut, tokenOut.decimals), router: 'Stake/Unstake' };
  }

  throw new Error('nerona: unsupported pair');
};

// ——— X Layer: straight from the Uniswap v3 pool ———
// No aggregator quotes X Layer (chain 196), so we read pool state and run the
// v3 exact-in math ourselves (see univ3pool.ts). SPYx liquidity actually sits
// in the wSPYx ERC-4626 vault; engine.ts substitutes that token and converts
// the amounts back to SPYx terms.
const XLAYER_UNIV3_FACTORY = '0x4b2ab38dbf28d31d467aa8993f6c2585981d6804';

// Hop candidates when a pair has no direct pool — X Layer's liquidity hubs.
const xlayerHubs = (): { address: string; symbol: string }[] => {
  const out: { address: string; symbol: string }[] = [];
  for (const symbol of ['USDC', 'USDT', 'USDG'] as const) {
    const dep = tokenOn(symbol, 'xlayer');
    // USDT on X Layer is USD₮0; label it as the market actually names it.
    if (dep) out.push({ address: dep.address, symbol: symbol === 'USDT' ? 'USD₮0' : symbol });
  }
  return out;
};

const xlayerUniV3: Provider = async ({ tokenIn, tokenOut, amountInHuman }) => {
  const amountInRaw = BigInt(toRaw(amountInHuman, tokenIn.decimals));
  const { amountOutRaw, via } = await quoteUniV3Pool(
    BASE.xlayerRpc,
    XLAYER_UNIV3_FACTORY,
    tokenIn.address,
    tokenOut.address,
    amountInRaw,
    xlayerHubs(),
  );
  return {
    outHuman: fromRaw(amountOutRaw, tokenOut.decimals),
    router: via ? `Uniswap v3 · via ${via}` : 'Uniswap v3',
  };
};

// ——— Ink: Velodrome Slipstream concentrated-liquidity pool ———
// Nothing aggregates Ink (Enso needs a key that 403s; KyberSwap/OpenOcean do
// not cover chain 57073), so quote the pool directly as on X Layer. Slipstream
// keys pools by tickSpacing rather than fee, so the factory lookup does not
// apply — the pool is configured explicitly and its fee() read on the fly.
const poolKey = (a: string, b: string) => [a.toLowerCase(), b.toLowerCase()].sort().join('|');

const INK_POOLS: Record<string, string> = {
  // USDG / USD₮0 — the only deep USDG market on Ink (~$760k; the USDC/USDG
  // pool holds cents). Extremely concentrated: $50k moves it ~0.0007%.
  [poolKey('0xe343167631d89b6ffc58b88d6b7fb0228795491d', '0x0200c29006150606b650577bbe7b6248f58470c1')]:
    '0x31826a86cd62c6fa12a0a8441ec4c8bcfee8a453',
};

const inkCl: Provider = async ({ tokenIn, tokenOut, amountInHuman }) => {
  const pool = INK_POOLS[poolKey(tokenIn.address, tokenOut.address)];
  if (!pool) throw new Error('ink: no configured pool for this pair');
  const amountInRaw = BigInt(toRaw(amountInHuman, tokenIn.decimals));
  const { amountOutRaw } = await quoteUniV3PoolAt(
    BASE.inkRpc,
    pool,
    tokenIn.address,
    tokenOut.address,
    amountInRaw,
  );
  return { outHuman: fromRaw(amountOutRaw, tokenOut.decimals), router: 'Velodrome CL' };
};

// ——— Centralised venues (OKX, Binance) ———
// Priced by walking the live order book so the quote reflects what the notional
// would actually fill at, matching how the DEX legs are priced. On these venues
// a token's "address" is its exchange currency code (see tokens.ts).

/** VWAP-walk a book. `payingQuote`: spending the quote ccy into asks (buying
 *  the base); otherwise pushing the base into bids (selling it). */
function walkBook(levels: [string, string][], payingQuote: boolean, amountIn: number): number {
  let remaining = amountIn;
  let out = 0;
  for (const [pxStr, szStr] of levels) {
    const px = Number(pxStr);
    const sz = Number(szStr);
    if (!isFinite(px) || !isFinite(sz) || px <= 0 || sz <= 0) continue;
    if (payingQuote) {
      const spend = Math.min(remaining, px * sz);
      out += spend / px;
      remaining -= spend;
    } else {
      const take = Math.min(remaining, sz);
      out += take * px;
      remaining -= take;
    }
    if (remaining <= amountIn * 1e-12) break;
  }
  if (remaining > amountIn * 1e-9) throw new Error('book too thin for this size');
  return out;
}

const OKX_QUOTE_CCYS = new Set(['USDT', 'USDC']);
// OKX spot taker fee, charged on the currency received. Applied to each leg, so
// a round trip costs it twice — the same way the DEX legs pay their pool fee.
const OKX_TAKER_FEE = 0.0008; // 0.08%

const okxCex: Provider = async ({ tokenIn, tokenOut, amountInHuman }) => {
  // Custom pairs state their instrument's quote side outright; built-ins fall
  // back to the currency heuristic (which cannot disambiguate a market whose
  // base is itself a common quote currency).
  const payingQuote =
    tokenIn.cexQuote === true
      ? true
      : tokenOut.cexQuote === true
        ? false
        : OKX_QUOTE_CCYS.has(tokenIn.address);
  const base = payingQuote ? tokenOut.address : tokenIn.address;
  const quoteCcy = payingQuote ? tokenIn.address : tokenOut.address;
  const j = await jget('okxCex', `${BASE.okx}/api/v5/market/books?instId=${base}-${quoteCcy}&sz=400`);
  const book = j?.data?.[0];
  const levels: [string, string][] = payingQuote ? book?.asks : book?.bids;
  if (!levels?.length) throw new Error(`okx: no book for ${base}-${quoteCcy}`);
  return { outHuman: walkBook(levels, payingQuote, amountInHuman) * (1 - OKX_TAKER_FEE), router: 'OKX' };
};

// Binance runs these stablecoin markets fee-free, so nothing is deducted here.
// Kept as a constant: set it to the taker rate if that ever changes, or if the
// venue is extended to pairs that do charge.
const BINANCE_TAKER_FEE = 0; // 0%
// Binance symbols are BASEQUOTE with no separator and only one orientation
// exists, so resolve it once per direction and remember which side is the base.
const binanceSymbols = new Map<string, { symbol: string; tokenInIsBase: boolean }>();

const binanceCex: Provider = async ({ tokenIn, tokenOut, amountInHuman }) => {
  const key = `${tokenIn.address}|${tokenOut.address}`;
  let resolved = binanceSymbols.get(key);
  if (!resolved) {
    for (const tokenInIsBase of [true, false]) {
      const symbol = tokenInIsBase
        ? `${tokenIn.address}${tokenOut.address}`
        : `${tokenOut.address}${tokenIn.address}`;
      try {
        await jget('binanceCex', `${BASE.binance}/api/v3/depth?symbol=${symbol}&limit=5`);
        resolved = { symbol, tokenInIsBase };
        break;
      } catch {
        /* wrong orientation — try the other */
      }
    }
    if (!resolved) throw new Error(`binance: no market for ${tokenIn.address}/${tokenOut.address}`);
    binanceSymbols.set(key, resolved);
  }
  const book = await jget('binanceCex', `${BASE.binance}/api/v3/depth?symbol=${resolved.symbol}&limit=500`);
  const payingQuote = !resolved.tokenInIsBase; // spending the quote buys the base
  const levels: [string, string][] = payingQuote ? book?.asks : book?.bids;
  if (!levels?.length) throw new Error(`binance: empty book for ${resolved.symbol}`);
  return {
    outHuman: walkBook(levels, payingQuote, amountInHuman) * (1 - BINANCE_TAKER_FEE),
    router: 'Binance',
  };
};

// ——— Hydration: Galactic Council router over the parachain's pools ———
// No HTTP quote endpoint exists (app.hydration.net drives the chain over a
// websocket and routes client-side), so the SDK is the supported way in. It is
// imported dynamically: polkadot-js is far larger than the rest of the app, and
// this keeps it out of the main chunk until a Hydration pair is actually
// scanned.
const HYDRATION_WSS = 'wss://rpc.hydradx.cloud';

let hydrationSdk: Promise<any> | null = null;
function hydrationCtx(): Promise<any> {
  if (!hydrationSdk) {
    hydrationSdk = (async () => {
      const [{ ApiPromise, WsProvider }, { createSdkContext }] = await Promise.all([
        import('@polkadot/api'),
        import('@galacticcouncil/sdk'),
      ]);
      const api = await ApiPromise.create({
        provider: new WsProvider(HYDRATION_WSS),
        noInitWarn: true,
      });
      return createSdkContext(api);
    })().catch((e) => {
      // Never cache a failed connection — the next scan should retry.
      hydrationSdk = null;
      throw e;
    });
  }
  return hydrationSdk;
}

const hydrationDex: Provider = async ({ tokenIn, tokenOut, amountInHuman }) => {
  const sdk = await hydrationCtx();
  // Asset ids ride in `address`; amounts are human units in, raw units out.
  const trade = await sdk.api.router.getBestSell(tokenIn.address, tokenOut.address, amountInHuman);
  const last = trade.swaps?.[trade.swaps.length - 1];
  const decimals = last?.assetOutDecimals ?? tokenOut.decimals;
  const outHuman = fromRaw(trade.amountOut.toString(), decimals);
  if (!isFinite(outHuman) || outHuman <= 0) throw new Error('hydration: empty quote');
  return { outHuman, router: 'Hydration' };
};

// Bybit runs the USDe/USDT market fee-free, so nothing is deducted here. Kept
// as a constant: set it to the taker rate if that ever changes, or if the venue
// is extended to pairs that do charge.
const BYBIT_TAKER_FEE = 0; // 0%
// Bybit symbols are BASEQUOTE with no separator and only one orientation
// exists, so resolve it once per direction and remember which side is the base.
const bybitSymbols = new Map<string, { symbol: string; tokenInIsBase: boolean }>();

/** Bybit returns retCode 0 on success; anything else carries the reason. */
async function bybitBook(symbol: string, limit: number) {
  const j = await jget('bybitCex', `${BASE.bybit}/v5/market/orderbook?category=spot&symbol=${symbol}&limit=${limit}`);
  if (j?.retCode !== 0) throw new Error(`bybit: ${j?.retMsg ?? 'bad response'} (${symbol})`);
  return j.result as { a?: [string, string][]; b?: [string, string][] };
}

const bybitCex: Provider = async ({ tokenIn, tokenOut, amountInHuman }) => {
  const key = `${tokenIn.address}|${tokenOut.address}`;
  let resolved = bybitSymbols.get(key);
  if (!resolved) {
    for (const tokenInIsBase of [true, false]) {
      const symbol = tokenInIsBase
        ? `${tokenIn.address}${tokenOut.address}`
        : `${tokenOut.address}${tokenIn.address}`;
      try {
        await bybitBook(symbol, 1);
        resolved = { symbol, tokenInIsBase };
        break;
      } catch {
        /* wrong orientation — try the other */
      }
    }
    if (!resolved) throw new Error(`bybit: no market for ${tokenIn.address}/${tokenOut.address}`);
    bybitSymbols.set(key, resolved);
  }
  // Top of book only: buys price at the best ask, sells at the best bid, for the
  // full notional regardless of the size resting there. Deliberately not a
  // book walk — Bybit rows show the quoted price, not an executable fill, so
  // thin top levels never turn the row into ERR.
  const book = await bybitBook(resolved.symbol, 1);
  const payingQuote = !resolved.tokenInIsBase; // spending the quote buys the base
  const top = (payingQuote ? book?.a : book?.b)?.[0];
  const px = Number(top?.[0]);
  if (!isFinite(px) || px <= 0) throw new Error(`bybit: empty book for ${resolved.symbol}`);
  const out = payingQuote ? amountInHuman / px : amountInHuman * px;
  return { outHuman: out * (1 - BYBIT_TAKER_FEE), router: 'Bybit' };
};

const PROVIDERS: Record<QuoteRoute, Provider> = {
  'canoe-okx': canoe('okx'),
  'canoe-kyberswap': canoe('kyberswap'),
  'canoe-openocean': canoe('openocean'),
  kyberswap,
  'oku-flowstream': okuFlowstream,
  openocean,
  eisen,
  enso,
  jupiter,
  'avalanche-savusd-mintredeem': avalancheSavUsdMintRedeem,
  'fluent-susdnr-stakeunstake': fluentStakeUnstake,
  fluent,
  'xlayer-univ3': xlayerUniV3,
  'ink-cl': inkCl,
  'okx-cex': okxCex,
  'binance-cex': binanceCex,
  'bybit-cex': bybitCex,
  hydration: hydrationDex,
};

/** Try the network's routes in order; first success wins. */
export async function quote(req: QuoteReq): Promise<QuoteRes> {
  if (req.net.routes.length === 0) throw new Error('no quote source for this network');
  let lastErr: unknown;
  for (const route of req.net.routes) {
    try {
      return await PROVIDERS[route](req);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
