import { useSyncExternalStore } from 'react';

function subscribe(cb: () => void): () => void {
  window.addEventListener('resize', cb);
  return () => window.removeEventListener('resize', cb);
}

/** Current viewport width, re-rendering on resize. */
export function useViewportWidth(): number {
  return useSyncExternalStore(
    subscribe,
    () => window.innerWidth,
    () => 1280, // SSR / no-window fallback
  );
}

/**
 * True below `bp` px — the layout switches to a stacked, small-screen form:
 * top horizontal nav, opportunities feed docked at the bottom.
 */
export function useIsNarrow(bp = 860): boolean {
  return useViewportWidth() < bp;
}

/**
 * True on phone-width viewports — the quotes table drops its ROUTER and
 * STATUS columns to keep NETWORK / BUY / SELL readable.
 */
export function useIsPhone(bp = 560): boolean {
  return useViewportWidth() < bp;
}
