// Vercel Edge Function behind /px/enso, /px/etherscan and /px/tg (see the
// rewrites in vercel.json). Secrets come from the project's environment
// variables — ENSO_KEY, ETHERSCAN_KEY, TG_BOT_TOKEN — which never reach the
// browser. The rules live in _keyed.ts, shared with the dev server.
import { handleKeyed } from './_keyed';

export const config = { runtime: 'edge' };

declare const process: { env: Record<string, string | undefined> };

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  // Set by the rewrite; double-underscored so they can't collide with the
  // upstream's own query parameters, which the rewrite passes through.
  const svc = url.searchParams.get('__svc') ?? '';
  const path = url.searchParams.get('__path') ?? '';
  url.searchParams.delete('__svc');
  url.searchParams.delete('__path');

  try {
    return await handleKeyed(
      {
        svc,
        path,
        params: url.searchParams,
        method: req.method,
        contentType: req.headers.get('content-type'),
        body: req.method === 'GET' || req.method === 'HEAD' ? null : await req.arrayBuffer(),
      },
      process.env,
    );
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, description: String((e as Error)?.message ?? e) }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}
