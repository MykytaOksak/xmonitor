// The one HTTP server: the website and its /px proxies (web.ts), plus the API
// the website uses to share settings with the bot. The site reaches the API
// as /px/bot/api/…, the same path it uses in dev, where Vite proxies it here.
//
// Everything under /api requires `Authorization: Bearer <ADMIN_TOKEN>`: the
// site is public, and this API changes what alerts fire and sends messages.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { validOps } from '../src/engine/settings';
import { getStatus, notify } from './bot';
import { recentNotifications } from './db';
import { getSettings, getVersion, patchSettings } from './settings';
import { proxyPx, serveStatic } from './web';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';
const MAX_BODY = 1 << 20;

const digest = (s: string) => createHash('sha256').update(s).digest();
const ADMIN_DIGEST = digest(ADMIN_TOKEN);

function authorized(req: IncomingMessage): boolean {
  if (ADMIN_TOKEN.length < 16) return false; // refuse to run open
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  return !!m && timingSafeEqual(digest(m[1]), ADMIN_DIGEST);
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://bot.local');
  let path = url.pathname.replace(/\/+$/, '') || '/';

  if (path.startsWith('/px/bot/') || path === '/px/bot') path = path.slice('/px/bot'.length) || '/';
  else if (path.startsWith('/px/')) return proxyPx(req, res, url);
  if (path === '/health') return reply(res, 200, { ok: true });
  if (!path.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  if (!authorized(req)) return reply(res, 401, { error: 'unauthorized' });

  if (req.method === 'GET' && path === '/api/state') {
    return reply(res, 200, { version: getVersion(), settings: getSettings(), status: getStatus() });
  }
  if (req.method === 'PATCH' && path === '/api/settings') {
    const body = (await readJson(req)) as { ops?: unknown } | null;
    const ops = validOps(body?.ops);
    if (!ops) return reply(res, 400, { error: 'invalid ops' });
    return reply(res, 200, { version: patchSettings(ops) });
  }
  if (req.method === 'GET' && path === '/api/history') {
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10) || 50;
    return reply(res, 200, { notifications: recentNotifications(limit) });
  }
  if (req.method === 'POST' && path === '/api/notify') {
    const body = (await readJson(req)) as { text?: unknown } | null;
    const text = typeof body?.text === 'string' ? body.text.trim().slice(0, 1000) : '';
    if (!text) return reply(res, 400, { error: 'text required' });
    const note = await notify('portfolio', text);
    return reply(res, 200, { delivered: note.delivered });
  }
  return reply(res, 404, { error: 'not found' });
}

export function startHttp(port: number): void {
  if (ADMIN_TOKEN.length < 16) {
    console.warn('[http] ADMIN_TOKEN missing or shorter than 16 chars — the API will refuse every request');
  }
  createServer((req, res) => {
    route(req, res).catch((e) => {
      console.error('[http]', e);
      if (!res.headersSent) reply(res, 500, { error: 'internal error' });
    });
  }).listen(port, '0.0.0.0', () => console.log(`[http] listening on :${port}`));
}
