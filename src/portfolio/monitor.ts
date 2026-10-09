// App-wide portfolio monitor. Runs independently of the Portfolio view (which
// unmounts on tab switch) so positions keep refreshing every 3 minutes and
// range-change alerts fire even when the user is on another tab. Tracks a list
// of wallets (EVM and/or Movement). State is exposed via a tiny
// subscribe/getSnapshot store for useSyncExternalStore.
import { fetchWalletPositions, parseAddresses, type Position } from './reader';
import { sendTelegram } from '../engine/telegram';
import { useApp } from '../state/store';
import { setBackgroundInterval } from '../engine/timers';

const REFRESH_MS = 180_000; // 3 minutes
const WALLETS_KEY = 'xmonitor.pfwallets'; // JSON string[] of tracked wallets
const LEGACY_WALLET_KEY = 'xmonitor.pfwallet'; // pre-multi-wallet single string
const ALERTS_KEY = 'xmonitor.pfalerts';
const RANGE_KEY = 'xmonitor.pfrange'; // baseline inRange per position id
const EVENTS_KEY = 'xmonitor.pfevents';

export interface RangeEvent {
  id: string;
  label: string;
  inRange: boolean; // the NEW state after the flip
  at: number;
  sent?: boolean; // delivered to Telegram (so we can retry once connected)
}

export interface MonitorState {
  wallets: string[];
  positions: Position[] | null;
  status: 'idle' | 'scanning' | 'refreshing' | 'error';
  error: string | null;
  alertsOn: boolean;
  events: RangeEvent[];
  lastRefreshAt: number;
  nextRefreshAt: number;
}

const readLS = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const writeLS = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore quota/serialisation errors */
  }
};

/** Load the wallet list, migrating the pre-multi-wallet single-string key. */
function loadWallets(): string[] {
  const list = readLS<string[]>(WALLETS_KEY, []);
  if (list.length) return list;
  const legacy = localStorage.getItem(LEGACY_WALLET_KEY);
  if (legacy && legacy.trim()) {
    // The legacy field allowed space/comma-separated addresses.
    const migrated = legacy.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (migrated.length) writeLS(WALLETS_KEY, migrated);
    return migrated;
  }
  return [];
}

let prevRange: Record<string, boolean> = readLS(RANGE_KEY, {});

let state: MonitorState = {
  wallets: loadWallets(),
  positions: null,
  status: 'idle',
  error: null,
  alertsOn: readLS<boolean>(ALERTS_KEY, false),
  events: readLS<RangeEvent[]>(EVENTS_KEY, []),
  lastRefreshAt: 0,
  nextRefreshAt: 0,
};

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const setState = (patch: Partial<MonitorState>) => {
  state = { ...state, ...patch };
  emit();
};

export const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const getSnapshot = (): MonitorState => state;

let cancelTimer: (() => void) | undefined;
let scanning = false;
let scanStartedAt = 0;
const STUCK_SCAN_MS = 90_000; // a scan running longer than this is presumed stuck (frozen tab)
let rescanQueued = false;

const eventText = (e: RangeEvent) =>
  e.inRange ? `✅ ${e.label} is back IN RANGE` : `⚠️ ${e.label} moved OUT OF RANGE`;

/** Fire an immediate browser notification for a fresh flip (best-effort). */
function notify(e: RangeEvent) {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification('XARB — position range change', { body: eventText(e) });
    }
  } catch {
    /* notifications are best-effort */
  }
}

/**
 * Deliver any events not yet pushed to Telegram. This retries on every scan, so
 * flips detected before Telegram was connected (or while offline) still arrive
 * once the connection is live — delivery is no longer one-shot at flip time.
 */
async function flushTelegram() {
  if (!state.events.some((e) => !e.sent)) return;
  let changed = false;
  for (const e of state.events) {
    if (e.sent) continue;
    if (await sendTelegram(eventText(e))) {
      e.sent = true;
      changed = true;
    } else {
      break; // not connected / delivery failing — try again next scan
    }
  }
  if (changed) {
    writeLS(EVENTS_KEY, state.events);
    setState({ events: [...state.events] });
  }
}

async function scan(kind: 'scanning' | 'refreshing') {
  if (scanning && Date.now() - scanStartedAt < STUCK_SCAN_MS) {
    rescanQueued = true; // a wallet was added/removed mid-scan — pick it up after
    return;
  }
  scanStartedAt = Date.now();
  if (state.wallets.length === 0) {
    setState({ positions: null, status: 'idle', error: null });
    return;
  }
  scanning = true;
  setState({ status: kind, error: null });
  try {
    const positions = await fetchWalletPositions(state.wallets.join(' '));

    // Detect range flips against the persisted baseline (only alert when enabled).
    let events = state.events;
    if (state.alertsOn) {
      const flips: RangeEvent[] = [];
      for (const p of positions) {
        const prev = prevRange[p.id];
        if (prev !== undefined && prev !== p.inRange) {
          flips.push({
            id: p.id,
            label: `${p.token0.symbol}/${p.token1.symbol} · ${p.protocol} #${p.tokenId}`,
            inRange: p.inRange,
            at: Date.now(),
          });
        }
      }
      if (flips.length) {
        flips.forEach(notify); // immediate browser notification
        events = [...flips, ...state.events].slice(0, 30);
        writeLS(EVENTS_KEY, events);
      }
    }

    // Refresh the baseline to the current positions.
    prevRange = Object.fromEntries(positions.map((p) => [p.id, p.inRange]));
    writeLS(RANGE_KEY, prevRange);

    setState({
      positions,
      status: 'idle',
      error: null,
      events,
      lastRefreshAt: Date.now(),
      nextRefreshAt: Date.now() + REFRESH_MS,
    });

    // Push any events not yet delivered to Telegram (retries once connected).
    if (state.alertsOn) void flushTelegram();
  } catch (e) {
    setState({ status: 'error', error: e instanceof Error ? e.message : 'Failed to load positions' });
  } finally {
    scanning = false;
    if (rescanQueued) {
      rescanQueued = false;
      void scan('refreshing'); // re-scan with the latest wallet list
    }
  }
}

function startTimer() {
  cancelTimer?.();
  // Worker-backed: a background tab clamps setInterval, delaying refreshes.
  cancelTimer = setBackgroundInterval(() => void scan('refreshing'), REFRESH_MS);
  setState({ nextRefreshAt: Date.now() + REFRESH_MS });
}

/** Normalise an address for de-dup/compare (lowercase, trimmed). */
const norm = (a: string) => a.trim().toLowerCase();

/**
 * Add a wallet (or space/comma-separated wallets) to the tracked list and
 * (re)scan. Returns an error string if the input holds no valid address.
 */
export function addWallet(input: string): string | null {
  const { evm, movement, monadV4 } = parseAddresses(input);
  const incoming = [...evm, ...movement, ...monadV4.map((id) => `monad:${id}`)];
  if (incoming.length === 0) {
    setState({ status: 'error', error: 'Enter a valid EVM / Movement address or a Monad v4 position id' });
    return 'invalid';
  }
  const existing = new Set(state.wallets.map(norm));
  const merged = [...state.wallets];
  for (const a of incoming) if (!existing.has(norm(a))) merged.push(a);
  writeLS(WALLETS_KEY, merged);
  setState({ wallets: merged, status: 'idle', error: null });
  startTimer();
  void scan(state.positions ? 'refreshing' : 'scanning');
  return null;
}

/** Remove a wallet (or Monad v4 position entry) and drop its positions from view. */
export function removeWallet(addr: string) {
  const wallets = state.wallets.filter((w) => norm(w) !== norm(addr));
  writeLS(WALLETS_KEY, wallets);
  const v4 = addr.match(/^monad(?:-v4)?:(\d+)$/i);
  const positions =
    state.positions?.filter((p) =>
      v4 ? !(p.chain === 'monad' && p.tokenId === v4[1]) : norm(p.owner) !== norm(addr),
    ) ?? null;
  setState({ wallets, positions });
  if (wallets.length === 0) {
    cancelTimer?.();
    setState({ positions: null, nextRefreshAt: 0 });
  } else {
    startTimer();
    void scan('refreshing');
  }
}

/** Manual refresh (also restarts the 3-min countdown). */
export function refreshNow() {
  if (state.wallets.length === 0) return;
  startTimer();
  void scan('refreshing');
}

export function setAlertsOn(on: boolean) {
  writeLS(ALERTS_KEY, on);
  setState({ alertsOn: on });
  if (on && typeof Notification !== 'undefined' && Notification.permission === 'default') {
    void Notification.requestPermission();
  }
}

export function clearEvents() {
  writeLS(EVENTS_KEY, []);
  setState({ events: [] });
}

let started = false;
/** Called once at app start — resume monitoring if wallets were previously tracked. */
export function initPortfolioMonitor() {
  if (started) return;
  started = true;

  // Flush pending alerts the moment Telegram connects (don't wait for the next scan).
  let lastTg = useApp.getState().tgState;
  useApp.subscribe((s) => {
    if (s.tgState === 'connected' && lastTg !== 'connected') void flushTelegram();
    lastTg = s.tgState;
  });

  if (state.wallets.length) {
    startTimer();
    void scan('scanning');
  }
}
