// Server-side half of the upstreams that need a secret.
//
// Anything prefixed VITE_ is compiled into the public bundle, so the Enso key,
// the Etherscan key and the Telegram bot token live only here: the browser
// calls /px/enso, /px/etherscan and /px/tg without them, and this module adds
// the secret before forwarding. It runs as a Vercel Edge Function in
// production (api/px.ts) and as a Vite middleware in dev (vite.config.ts), so
// both environments enforce exactly the same rules.
//
// Leading underscore keeps Vercel from exposing this file as a route itself.

export interface KeyedEnv {
  ENSO_KEY?: string;
  ETHERSCAN_KEY?: string;
  TG_BOT_TOKEN?: string;
}

export interface KeyedRequest {
  /** Which upstream: enso | etherscan | tg. */
  svc: string;
  /** Path after /px/<svc>/, e.g. "api/v1/shortcuts/route". */
  path: string;
  params: URLSearchParams;
  method: string;
  contentType: string | null;
  body: ArrayBuffer | null;
}

export const KEYED_SERVICES = ['enso', 'etherscan', 'tg'] as const;

// Only what the app actually calls. Everything else a bot token can do —
// setWebhook, deleteWebhook, logOut, editing or deleting messages — is refused.
const TG_METHODS = new Set(['getMe', 'sendMessage', 'getUpdates']);
// Matches the store's profile id generator: 'usr_' + 4 random bytes as hex.
const PROFILE_RE = /^usr_[0-9a-f]{8}$/;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// `description` mirrors Telegram's own error field, which the client surfaces.
const fail = (status: number, message: string): Response =>
  json(status, { ok: false, error: message, description: message });

export async function handleKeyed(r: KeyedRequest, env: KeyedEnv): Promise<Response> {
  const headers = new Headers({ accept: 'application/json' });
  if (r.contentType) headers.set('content-type', r.contentType);
  const params = new URLSearchParams(r.params);
  let url: string;
  let tgProfile: string | null = null;

  switch (r.svc) {
    case 'enso':
      if (!env.ENSO_KEY) return fail(503, 'ENSO_KEY is not configured on the server');
      headers.set('authorization', `Bearer ${env.ENSO_KEY}`);
      url = `https://api.enso.finance/${r.path}`;
      break;

    case 'etherscan':
      if (!env.ETHERSCAN_KEY) return fail(503, 'ETHERSCAN_KEY is not configured on the server');
      params.set('apikey', env.ETHERSCAN_KEY);
      url = `https://api.etherscan.io/${r.path}`;
      break;

    case 'tg': {
      if (!env.TG_BOT_TOKEN) return fail(503, 'TG_BOT_TOKEN is not configured on the server');
      const method = r.path.replace(/^\/+|\/+$/g, '');
      if (!TG_METHODS.has(method)) return fail(403, `telegram method not allowed: ${method}`);
      if (method === 'getUpdates') {
        // Raw getUpdates returns every message sent to the bot, i.e. every
        // user's chat id. Callers only ever learn about their own /start.
        tgProfile = params.get('profile');
        if (!tgProfile || !PROFILE_RE.test(tgProfile)) {
          return fail(400, 'getUpdates requires a valid profile');
        }
        params.delete('profile');
        // Never acknowledge (offset) from here: one visitor confirming the
        // queue would drop another visitor's pending /start.
        params.delete('offset');
        params.set('limit', '100');
        params.set('timeout', '0');
      }
      url = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${method}`;
      break;
    }

    default:
      return fail(404, `unknown upstream: ${r.svc}`);
  }

  const qs = params.toString();
  const upstream = await fetch(qs ? `${url}?${qs}` : url, {
    method: r.method,
    headers,
    body: r.method === 'GET' || r.method === 'HEAD' ? undefined : (r.body ?? undefined),
    signal: AbortSignal.timeout(30_000),
  });

  if (tgProfile) {
    const j: any = await upstream.json().catch(() => null);
    if (!j?.ok) return fail(502, j?.description ?? 'telegram getUpdates failed');
    const want = `/start ${tgProfile}`;
    const result = (Array.isArray(j.result) ? j.result : [])
      .filter((u: any) => String(u?.message?.text ?? '').trim() === want)
      // Strip names, usernames and everything else down to what the client reads.
      .map((u: any) => ({ update_id: u.update_id, message: { text: want, chat: { id: u.message.chat.id } } }));
    return json(200, { ok: true, result });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}
