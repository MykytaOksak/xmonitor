// Persistent record of runtime crashes, so a failure that only shows up after
// hours of running leaves evidence behind instead of a blank page.
//
// Kept in its own localStorage key (not the zustand store) so it survives a
// store that is itself the thing failing, and a reload.

import { setBackgroundInterval } from './engine/timers';

const KEY = 'xmonitor.crashlog';
const MAX = 25;

export interface Crash {
  at: number;
  /** Where it was caught: a view's error boundary, 'window' or 'promise'. */
  scope: string;
  message: string;
  stack?: string;
  componentStack?: string;
}

export function readCrashes(): Crash[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function clearCrashes(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable — nothing to clear */
  }
}

export function logCrash(c: Omit<Crash, 'at'>): void {
  try {
    const list = readCrashes();
    // One entry per distinct failure per minute, whatever caught it: a failure
    // that repeats every render would otherwise fill the log with copies and
    // push out the first, most useful entry. (In dev, React also re-reports
    // errors its boundaries already caught to window — same message.)
    const since = Date.now() - 60_000;
    if (list.some((e) => e.message === c.message && e.at >= since)) return;
    list.push({ at: Date.now(), ...c });
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX)));
  } catch {
    /* logging must never be the thing that throws */
  }
}

const describe = (e: unknown): { message: string; stack?: string } =>
  e instanceof Error
    ? { message: `${e.name}: ${e.message}`, stack: e.stack }
    : { message: String(e) };

/** Errors that escape everything else — outside React render, in timers, in promises. */
export function installGlobalCrashLogging(): void {
  window.addEventListener('error', (ev) => {
    // Failed <script>/<img> loads also fire 'error' but carry no Error object.
    if (!ev.error && !ev.message) return;
    // Deferred a tick so that when a boundary also catches this error, its
    // entry — which carries the component stack — is the one kept.
    const info = describe(ev.error ?? ev.message);
    setTimeout(() => logCrash({ scope: 'window', ...info }), 0);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    logCrash({ scope: 'promise', ...describe(ev.reason) });
  });
}

// ——— session watch: how did the previous page die? ———
//
// A renderer that is discarded by Chrome or killed (e.g. out of memory) runs no
// code on the way out, so nothing above can record it. Instead each session
// leaves a marker that only a normal unload clears, plus a heap reading every
// minute; the next load reads what the last one left behind.

const SESSION_KEY = 'xmonitor.session';
const BEAT_MS = 60_000;
const MAX_BEATS = 240; // four hours of one-minute readings

interface Session {
  startedAt: number;
  closed: boolean;
  /** [time, JS heap MB] — heap only where the browser exposes it (Chromium). */
  beats: [number, number | null][];
}

const heapMB = (): number | null => {
  const m = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return m ? Math.round(m.usedJSHeapSize / 1048576) : null;
};

const readSession = (): Session | null => {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null');
  } catch {
    return null;
  }
};

const writeSession = (s: Session): void => {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* storage full or unavailable */
  }
};

const mins = (ms: number): string =>
  ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)} h` : `${Math.round(ms / 60_000)} min`;

function describeSession(prev: Session): string {
  const last = prev.beats[prev.beats.length - 1];
  const ran = last ? mins(last[0] - prev.startedAt) : 'under a minute';
  const heaps = prev.beats.map((b) => b[1]).filter((v): v is number => v != null);
  const heap = heaps.length > 1 ? `; JS heap ${heaps[0]} → ${heaps[heaps.length - 1]} MB (peak ${Math.max(...heaps)})` : '';
  return `after running ${ran}${heap}`;
}

export function installSessionWatch(): void {
  const prev = readSession();
  // Set by Chrome when it reloads a page it had thrown away to save memory.
  const discarded = (document as Document & { wasDiscarded?: boolean }).wasDiscarded === true;

  if (prev && !prev.closed) {
    logCrash(
      discarded
        ? {
            scope: 'browser',
            message: `Chrome discarded the page to free memory ${describeSession(prev)}`,
          }
        : {
            scope: 'browser',
            message: `Previous session ended without unloading — renderer crashed or was killed ${describeSession(prev)}`,
          },
    );
  }

  const session: Session = { startedAt: Date.now(), closed: false, beats: [[Date.now(), heapMB()]] };
  writeSession(session);

  // Worker-backed so the beat keeps ticking while the window is in the background.
  setBackgroundInterval(() => {
    session.beats.push([Date.now(), heapMB()]);
    if (session.beats.length > MAX_BEATS) session.beats.splice(0, session.beats.length - MAX_BEATS);
    writeSession(session);
  }, BEAT_MS);

  // Fires on reload, navigation and closing the window — not on a crash or a discard.
  window.addEventListener('pagehide', () => {
    session.closed = true;
    writeSession(session);
  });
}
