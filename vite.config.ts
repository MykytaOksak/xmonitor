import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
// The Hydration SDK ships its pool math as WASM and reaches for node's Buffer.
// Both need help in a browser build; neither affects the rest of the app.
// Top-level await comes from the esnext target below rather than a plugin —
// vite-plugin-top-level-await crashes on the swc version in this tree.
import wasm from 'vite-plugin-wasm';
// upstreams.json is the single source of truth for the /px/* upstreams: the
// bot server proxies them in production (server/web.ts), and the dev server
// mirrors the same table here, so the two environments cannot drift apart.
import upstreams from './upstreams.json';
import { KEYED_SERVICES, handleKeyed, type KeyedEnv } from './server/keyed';

// The /px/* proxies exist because most quote APIs don't send
// Access-Control-Allow-Origin. The bot server provides them in production;
// this is the dev-server equivalent.
//
// The timeouts + error handler below stop the long-running dev server from
// leaking sockets/file descriptors across the portfolio monitor's thousands of
// periodic calls: without them a stalled/failed upstream (transient DNS
// ENOTFOUND, resets, hangs) keeps its socket open (the browser fetch waits
// minutes), and over many hours these pile up until getaddrinfo itself fails
// and the server crashes.
const proxy = (target: string): ProxyOptions => ({
  target,
  changeOrigin: true,
  timeout: 30_000, // abort a stalled browser <-> proxy socket
  proxyTimeout: 30_000, // abort a stalled proxy <-> upstream socket
  rewrite: (p) => p.replace(/^\/px\/[^/]+/, ''),
  configure: (server) => {
    // A transient upstream failure must never bubble as an unhandled 'error'
    // and take down the dev server — respond 502 (or close) and carry on.
    server.on('error', (_err, _req, res) => {
      const r = res as any;
      try {
        if (r && !r.headersSent && typeof r.writeHead === 'function') {
          r.writeHead(502, { 'content-type': 'application/json' });
          r.end('{"error":"upstream unavailable"}');
        } else if (r && typeof r.destroy === 'function') {
          r.destroy();
        }
      } catch {
        /* ignore */
      }
    });
  },
});

// Plain upstreams only: the keyed ones are handled by the middleware below.
const devProxies: Record<string, ProxyOptions> = Object.fromEntries(
  Object.entries(upstreams).map(([svc, url]) => [`/px/${svc}`, proxy(url)]),
);

const KEYED_PATH = new RegExp(`^/px/(${KEYED_SERVICES.join('|')})(?:/(.*))?$`);

/**
 * Runs the same handler as the production server (server/keyed.ts), so
 * secrets are attached identically in dev. Keys
 * come from .env.local under their server-side names.
 */
function keyedUpstreams(env: KeyedEnv): Plugin {
  return {
    name: 'xarb-keyed-upstreams',
    configureServer(server) {
      server.middlewares.use(async (req: any, res: any, next: any) => {
        const u = new URL(req.url ?? '/', 'http://localhost');
        const m = u.pathname.match(KEYED_PATH);
        if (!m) return next();
        try {
          const chunks: Uint8Array[] = [];
          for await (const c of req) chunks.push(c);
          const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
          let at = 0;
          for (const c of chunks) {
            body.set(c, at);
            at += c.length;
          }
          const r = await handleKeyed(
            {
              svc: m[1],
              path: m[2] ?? '',
              params: u.searchParams,
              method: req.method ?? 'GET',
              contentType: req.headers['content-type'] ?? null,
              body: body.length ? body.buffer : null,
            },
            env,
          );
          res.statusCode = r.status;
          res.setHeader('content-type', r.headers.get('content-type') ?? 'application/json');
          res.end(new Uint8Array(await r.arrayBuffer()));
        } catch (e) {
          res.statusCode = 502;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: false, description: String((e as Error)?.message ?? e) }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // '' prefix: load every variable, not just VITE_ ones — these stay in Node.
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), wasm(), keyedUpstreams(env as KeyedEnv)],
    resolve: { alias: { buffer: 'buffer/' } },
    define: { global: 'globalThis' },
    build: { target: 'esnext' },
    optimizeDeps: { esbuildOptions: { target: 'esnext' } },
    server: {
      // BOT_URL points /px/bot at a bot server on this machine instead of the
      // hosted one (npm run server).
      proxy: { ...devProxies, ...(env.BOT_URL ? { '/px/bot': proxy(env.BOT_URL) } : {}) },
    },
  };
});
