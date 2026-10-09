// Background-safe timers.
//
// A hidden tab has its setTimeout/setInterval clamped (~1s, then ~1/minute once
// Chrome's intensive throttling kicks in). The quotes engine sleeps *inside*
// every quote (provider rate-limit throttling + Oku's Create/Update/poll loop),
// so a full scan performs hundreds of short sleeps — at ~60s each it never
// finishes in the background, which is why quotes froze while the portfolio
// monitor (only a handful of sleeps per scan) kept working.
//
// Timers inside a dedicated Worker are not subject to that clamping, so we run
// the timing there and only resolve promises on the main thread. Falls back to
// plain setTimeout when Workers aren't available.

type Pending = { resolve: () => void };

const WORKER_SRC = `
self.onmessage = (e) => {
  const { id, ms } = e.data;
  setTimeout(() => self.postMessage(id), ms);
};
`;

let worker: Worker | null = null;
const pending = new Map<number, Pending>();
let nextId = 1;

function getWorker(): Worker | null {
  if (worker !== null) return worker;
  try {
    if (typeof Worker === 'undefined') return null;
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
    worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = (e: MessageEvent<number>) => {
      const p = pending.get(e.data);
      if (p) {
        pending.delete(e.data);
        p.resolve();
      }
    };
    worker.onerror = () => {
      worker = null; // fall back to main-thread timers from here on
      for (const [id, p] of pending) {
        pending.delete(id);
        p.resolve();
      }
    };
    return worker;
  } catch {
    return null;
  }
}

/** Sleep that keeps its real duration in a background tab. */
export function sleep(ms: number): Promise<void> {
  const w = getWorker();
  if (!w) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, { resolve });
    w.postMessage({ id, ms });
  });
}

/** setTimeout equivalent that keeps firing on time in a background tab. */
export function setBackgroundTimeout(fn: () => void, ms: number): () => void {
  let cancelled = false;
  void sleep(ms).then(() => {
    if (!cancelled) fn();
  });
  return () => {
    cancelled = true;
  };
}

/** setInterval equivalent that keeps firing on time in a background tab. */
export function setBackgroundInterval(fn: () => void, ms: number): () => void {
  let cancelled = false;
  const loop = async () => {
    while (!cancelled) {
      await sleep(ms);
      if (cancelled) return;
      fn();
    }
  };
  void loop();
  return () => {
    cancelled = true;
  };
}
