// Lets the browser quote engine (src/engine) run unchanged under Node.
// Must be the first import in server/main.ts.
//
// - fetch('/px/<svc>/…'): the engine addresses every upstream through the
//   same-origin /px proxy. Here those paths are resolved against the very
//   table Vercel uses (vercel.json), and the keyed ones (Enso, Etherscan) go
//   through the shared handler that adds their secret — so server and site can
//   never disagree about where a venue lives.
// - localStorage: the zustand store persists through it. An in-memory stand-in
//   is enough; the server's durable state lives in SQLite (server/db.ts).
import vercel from '../vercel.json';
import { KEYED_SERVICES, handleKeyed } from '../api/_keyed';

const FETCH_TIMEOUT_MS = 30_000;
const UNREAD_BODY_MS = 30_000;

const upstream = new Map(
  vercel.rewrites
    .filter((r) => !r.source.includes(':path*') && r.destination.startsWith('http'))
    .map((r) => [r.source.replace(/^\/px\//, ''), r.destination]),
);

const original = globalThis.fetch.bind(globalThis);

async function resolvePx(url: string, init?: RequestInit): Promise<Response> {
  const u = new URL(url, 'http://px.local');
  const m = u.pathname.match(/^\/px\/([^/]+)(?:\/(.*))?$/);
  if (!m) throw new TypeError(`bad proxy path: ${url}`);
  const [, svc, rest = ''] = m;
  if ((KEYED_SERVICES as readonly string[]).includes(svc)) {
    const body = init?.body;
    return handleKeyed(
      {
        svc,
        path: rest,
        params: u.searchParams,
        method: init?.method ?? 'GET',
        contentType: new Headers(init?.headers).get('content-type'),
        body: typeof body === 'string' ? (new TextEncoder().encode(body).buffer as ArrayBuffer) : null,
      },
      process.env,
    );
  }
  const base = upstream.get(svc);
  if (!base) throw new TypeError(`no upstream for /px/${svc}`);
  return original(`${base}/${rest}${u.search}`, init);
}

// Same guarantees as src/net-timeout.ts in the browser: every request settles
// within 30s, and a body nobody reads is released rather than holding its
// connection open.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const run = (i?: RequestInit) => (url.startsWith('/px/') ? resolvePx(url, i) : original(input, i));
  if (init?.signal) return run(init);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await run({ ...init, signal: controller.signal });
    setTimeout(() => {
      if (!res.bodyUsed) controller.abort();
    }, UNREAD_BODY_MS).unref();
    return res;
  } finally {
    clearTimeout(timer);
  }
}) as typeof fetch;

const mem = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size;
    },
  } satisfies Storage,
});
