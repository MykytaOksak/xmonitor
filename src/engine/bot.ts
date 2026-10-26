// The website's link to the bot server (server/), through the /px/bot rewrite.
//
// The server holds the copy of record of the shared settings (alerts, sizes,
// network toggles, custom pairs). Local edits are sent to it as key-level ops
// the moment they happen; its copy is pulled back every POLL_MS, so a change
// made in Telegram shows up here too. Nothing syncs until the owner pastes the
// server's ADMIN_TOKEN — the site is public, and visitors only browse quotes.
import { setCustomPairs } from '../config/pairs';
import { useApp } from '../state/store';
import { applyOps, diffSettings, emptySettings, pickShared } from './settings';
import type { BotNotification, BotStatus, SettingsOp, SharedSettings } from './types';

const BASE = '/px/bot/api';
const POLL_MS = 20_000;
const RETRY_MS = 10_000;

class BotHttpError extends Error {
  constructor(readonly status: number) {
    super(`bot server: HTTP ${status}`);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const token = useApp.getState().botToken;
  if (!token) throw new BotHttpError(401);
  const r = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  if (!r.ok) {
    void r.body?.cancel().catch(() => {});
    throw new BotHttpError(r.status);
  }
  return r.json() as Promise<T>;
}

function failed(e: unknown): void {
  useApp.getState().set({ botState: e instanceof BotHttpError && e.status === 401 ? 'unauthorized' : 'offline' });
}

// ——— outgoing edits ———

// Applying the server's copy must not echo back to it as local edits.
let applying = false;
let pending: SettingsOp[] = [];
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function queue(ops: SettingsOp[]): void {
  // Last write per key wins: typing a notional sends one op, not one per keystroke.
  const key = (o: SettingsOp) => `${o.section}\u0000${o.key}`;
  const incoming = new Set(ops.map(key));
  pending = [...pending.filter((o) => !incoming.has(key(o))), ...ops];
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flush(), 400);
}

async function flush(): Promise<void> {
  clearTimeout(flushTimer);
  if (!pending.length) return;
  const ops = pending;
  try {
    await call('/settings', { method: 'PATCH', body: JSON.stringify({ ops }) });
    pending = pending.filter((o) => !ops.includes(o));
    const s = useApp.getState();
    s.set({ botState: 'online', ...(s.saveState === 'saving' ? { saveState: 'saved' } : {}) });
  } catch (e) {
    failed(e);
    const s = useApp.getState();
    if (s.saveState === 'saving') s.set({ saveState: 'error' });
    flushTimer = setTimeout(() => void flush(), RETRY_MS);
  }
}

// ——— incoming state ———

function applyServer(settings: SharedSettings, status: BotStatus): void {
  // Edits still on their way up are laid over the server copy, so a pull that
  // races a flush can't revert what was just typed.
  const merged = applyOps({ ...emptySettings(), ...settings }, pending);
  applying = true;
  try {
    setCustomPairs(merged.customPairs);
    useApp.setState({ ...merged, botStatus: status, botState: 'online' });
  } finally {
    applying = false;
  }
}

export async function pullBot(): Promise<void> {
  if (!useApp.getState().botToken) return;
  try {
    const [state, history] = await Promise.all([
      call<{ version: number; settings: SharedSettings; status: BotStatus }>('/state'),
      call<{ notifications: BotNotification[] }>('/history?limit=20'),
    ]);
    if (state.version === 0) {
      // A server that has never been written to: this browser's settings —
      // alerts and custom pairs made before the bot existed — seed it.
      const ops = diffSettings(emptySettings(), pickShared(useApp.getState()));
      if (ops.length) {
        queue(ops);
        await flush();
      }
      useApp.setState({ botStatus: state.status, botState: 'online', botHistory: history.notifications });
      return;
    }
    applyServer(state.settings, state.status);
    useApp.setState({ botHistory: history.notifications });
  } catch (e) {
    failed(e);
  }
}

// ——— lifecycle ———

let pollTimer: ReturnType<typeof setInterval> | undefined;
let subscribed = false;

export function initBotSync(): void {
  if (!subscribed) {
    subscribed = true;
    useApp.subscribe((s, prev) => {
      if (applying || !s.botToken) return;
      // Quotes update the store many times a second; only the four shared
      // sections matter here, and they change by reference when edited.
      if (
        s.savedAlerts === prev.savedAlerts &&
        s.amounts === prev.amounts &&
        s.disabledNets === prev.disabledNets &&
        s.customPairs === prev.customPairs
      ) {
        return;
      }
      const ops = diffSettings(pickShared(prev), pickShared(s));
      if (ops.length) queue(ops);
    });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) void pullBot();
      });
    }
  }
  // Restartable: React's dev double-mount stops and starts this once more.
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (typeof document === 'undefined' || !document.hidden) void pullBot();
  }, POLL_MS);
  void pullBot();
}

export function stopBotSync(): void {
  clearInterval(pollTimer);
}

export async function connectBot(token: string): Promise<void> {
  useApp.getState().set({ botToken: token.trim(), botState: 'connecting' });
  await pullBot();
}

export function disconnectBot(): void {
  pending = [];
  clearTimeout(flushTimer);
  useApp.getState().set({ botToken: null, botState: 'off', botStatus: null, botHistory: [] });
}

/** Deliver a message through the bot (portfolio range alerts). True once sent. */
export async function sendBotNotification(text: string): Promise<boolean> {
  if (!useApp.getState().botToken) return false;
  try {
    const r = await call<{ delivered: boolean }>('/notify', { method: 'POST', body: JSON.stringify({ text }) });
    return r.delivered;
  } catch (e) {
    failed(e);
    return false;
  }
}
