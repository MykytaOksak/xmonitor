import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
// The Hydration SDK ships its pool math as WASM and reaches for node's Buffer.
// Both need help in a browser build; neither affects the rest of the app.
// Top-level await comes from the esnext target below rather than a plugin —
// vite-plugin-top-level-await crashes on the swc version in this tree.
import wasm from 'vite-plugin-wasm';
// vercel.json is the single source of truth for the /px/* upstreams: Vercel
// rewrites them in production, and the dev server mirrors the same table here,
// so the two environments cannot drift apart.
import vercel from './vercel.json';

// Dev-server proxies work around CORS for quote APIs that do not send
// Access-Control-Allow-Origin. In production builds the app calls the
// real origins directly (see src/engine/providers.ts) — endpoints that
// block browser CORS will surface as ERR rows, which the design supports.
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

const devProxies: Record<string, ProxyOptions> = Object.fromEntries(
  vercel.rewrites
    .filter((r) => !r.source.includes(':path*'))
    .map((r) => [r.source, proxy(r.destination)]),
);

export default defineConfig({
  plugins: [react(), wasm()],
  resolve: { alias: { buffer: 'buffer/' } },
  define: { global: 'globalThis' },
  build: { target: 'esnext' },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
  server: {
    proxy: devProxies,
  },
});
