// The upstreams that need a secret, behind /px/enso and /px/etherscan.
//
// Anything prefixed VITE_ is compiled into the public bundle, so the Enso and
// Etherscan keys live only on the server: the browser calls the /px routes
// without them, and this module adds the secret before forwarding. It runs
// inside the bot server (which also serves the site) and as a Vite middleware
// in dev, so both enforce exactly the same rules. Telegram is not proxied at
// all: only the bot server holds that token.

export interface KeyedEnv {
  ENSO_KEY?: string;
  ETHERSCAN_KEY?: string;
}

export interface KeyedRequest {
  /** Which upstream: enso | etherscan. */
  svc: string;
  /** Path after /px/<svc>/, e.g. "api/v1/shortcuts/route". */
  path: string;
  params: URLSearchParams;
  method: string;
  contentType: string | null;
  body: ArrayBuffer | null;
}

export const KEYED_SERVICES = ['enso', 'etherscan'] as const;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fail = (status: number, message: string): Response =>
  json(status, { ok: false, error: message });

export async function handleKeyed(r: KeyedRequest, env: KeyedEnv): Promise<Response> {
  const headers = new Headers({ accept: 'application/json' });
  if (r.contentType) headers.set('content-type', r.contentType);
  const params = new URLSearchParams(r.params);
  let url: string;

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

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}
