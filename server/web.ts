// The website, served from the bot server: the Vite build in dist/ plus the
// /px/* proxies its quote engine calls. One host for site, proxy and bot, with
// no per-request quota (Vercel's free tier counted every proxied quote and
// ran out at 1M a month).
import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { isPxService } from './polyfill';

const DIST = resolve(process.env.WEB_DIST ?? './dist');
const MAX_BODY = 1 << 20;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function fileFor(pathname: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const file = resolve(DIST, `.${rel}`);
  if (file !== DIST && !file.startsWith(DIST + sep)) return null; // no escaping dist/
  try {
    const st = statSync(file);
    if (st.isFile()) return file;
    if (st.isDirectory()) {
      const index = join(file, 'index.html');
      if (statSync(index).isFile()) return index;
    }
  } catch {
    /* not found */
  }
  return null;
}

/** Static files; a path without an extension falls back to the app shell. */
export function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  const file = fileFor(pathname) ?? (extname(pathname) ? null : fileFor('/index.html'));
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    // Vite fingerprints everything under /assets, so those never change; the
    // shell and the root files must be revalidated so a deploy shows up.
    'cache-control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * /px/<svc>/… → the upstream from upstreams.json (or the keyed handler). The
 * routing itself is the server's fetch shim (polyfill.ts), the same one the
 * server's own quote engine goes through.
 */
export async function proxyPx(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!isPxService(url.pathname.split('/')[2] ?? '')) {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"unknown upstream"}');
    return;
  }
  let upstream: Response;
  try {
    const headers: Record<string, string> = { accept: req.headers.accept ?? 'application/json' };
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
    upstream = await fetch(`${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: await readBody(req),
    });
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream unavailable', detail: String((e as Error)?.message ?? e) }));
    return;
  }
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
    'cache-control': 'no-store',
  });
  if (!upstream.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream);
  // A browser that gives up mid-response must not leave the upstream open.
  res.on('close', () => body.destroy());
  body.on('error', () => res.destroy());
  body.pipe(res);
}
