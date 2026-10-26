// Cap every fetch with a client-side timeout. A backgrounded/frozen tab can
// leave a request pending indefinitely (the browser parks it, or the socket to
// the dev-server proxy dies while the tab sleeps); the scan that awaits it then
// never settles and its `scanning` guard stays stuck true, so the app looks
// frozen on return. AbortController guarantees every fetch settles (aborts →
// rejects, handled as a normal failure by callers) within FETCH_TIMEOUT_MS.
// Installed once, before anything else runs (imported first in main.tsx).
//
// It also releases bodies nobody reads. Chrome keeps a response — its loader,
// body stream and buffered data — alive until the body is read or cancelled,
// even once nothing references it, so every `if (!r.ok) throw` without reading
// the body leaked a request for the life of the page. With an upstream
// failing on every quote that was thousands an hour, until the renderer ran
// out of memory and the window went black.
const FETCH_TIMEOUT_MS = 30_000;
const UNREAD_BODY_MS = 30_000;

const original = window.fetch.bind(window);
const patched: typeof window.fetch = (input, init) => {
  if (init?.signal) return original(input, init); // caller manages its own abort
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return original(input, { ...init, signal: controller.signal }).then(
    (res) => {
      clearTimeout(timer);
      // Aborting errors a body that was never started, which frees it; one
      // already read (or being read) is left alone.
      setTimeout(() => {
        if (!res.bodyUsed) controller.abort();
      }, UNREAD_BODY_MS);
      return res;
    },
    (e) => {
      clearTimeout(timer);
      throw e;
    },
  );
};
window.fetch = patched;
