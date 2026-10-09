// Cap every fetch with a client-side timeout. A backgrounded/frozen tab can
// leave a request pending indefinitely (the browser parks it, or the socket to
// the dev-server proxy dies while the tab sleeps); the scan that awaits it then
// never settles and its `scanning` guard stays stuck true, so the app looks
// frozen on return. AbortController guarantees every fetch settles (aborts →
// rejects, handled as a normal failure by callers) within FETCH_TIMEOUT_MS.
// Installed once, before anything else runs (imported first in main.tsx).
const FETCH_TIMEOUT_MS = 30_000;

const original = window.fetch.bind(window);
const patched: typeof window.fetch = (input, init) => {
  if (init?.signal) return original(input, init); // caller manages its own abort
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return original(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
};
window.fetch = patched;
