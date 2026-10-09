import { useApp } from '../state/store';

// Direct browser -> Telegram Bot API (no backend). The bot token is baked in
// (VITE_TG_BOT_TOKEN) so users just open the deep link and press Start; the
// captured chat id is persisted, so the connection is remembered across reloads.
// In dev the call is proxied by Vite. NOTE: the token is exposed in the bundle.
const TG = '/px/tg';
const BOT_TOKEN = import.meta.env.VITE_TG_BOT_TOKEN as string | undefined;

const api = async (method: string, params?: Record<string, string>) => {
  if (!BOT_TOKEN) throw new Error('telegram: VITE_TG_BOT_TOKEN not set');
  const qs = params ? `?${new URLSearchParams(params)}` : '';
  const r = await fetch(`${TG}/bot${BOT_TOKEN}/${method}${qs}`);
  const j = await r.json();
  if (!j.ok) throw new Error(j.description ?? `telegram: ${method} failed`);
  return j.result;
};

export const deepLink = (bot: string | null, profileId: string) =>
  `t.me/${bot ?? '<bot>'}?start=${profileId}`;

let pollTimer: ReturnType<typeof setInterval> | undefined;

/** Fetch the bot username once so the deep link renders correctly up-front. */
export async function initTelegram(): Promise<void> {
  if (!BOT_TOKEN) return;
  try {
    const me = await api('getMe');
    const s = useApp.getState();
    const patch: Partial<Parameters<typeof s.set>[0]> = { tgBot: me.username };
    // If the bot token was swapped, the persisted chat id belongs to the old
    // bot and won't accept messages — drop the stale connection so the user
    // reconnects to the new bot.
    if (s.tgBot && s.tgBot !== me.username && s.tgState === 'connected') {
      patch.tgState = 'disconnected';
      patch.tgChatId = null;
    }
    s.set(patch);
  } catch {
    /* the displayed link falls back to <bot> until this succeeds */
  }
}

/**
 * Connect flow: open the deep link (t.me/<bot>?start=<profileId>) and poll
 * getUpdates until the user presses Start; capture their chat id and persist it.
 */
export async function connectTelegram(): Promise<void> {
  if (!BOT_TOKEN) {
    useApp.getState().set({ tgState: 'error' });
    return;
  }
  const { profileId, set } = useApp.getState();
  set({ tgState: 'connecting' });
  try {
    const me = await api('getMe');
    set({ tgBot: me.username });
    window.open(`https://${deepLink(me.username, profileId)}`, '_blank');

    clearInterval(pollTimer);
    const startedAt = Date.now();
    pollTimer = setInterval(async () => {
      if (useApp.getState().tgState !== 'connecting' || Date.now() - startedAt > 180_000) {
        clearInterval(pollTimer);
        if (useApp.getState().tgState === 'connecting') useApp.getState().set({ tgState: 'error' });
        return;
      }
      try {
        const updates = await api('getUpdates', { timeout: '0', limit: '30' });
        for (const u of updates ?? []) {
          const parts = String(u.message?.text ?? '').split(' ');
          // Match this profile's /start payload (or a bare /start as fallback).
          if (parts[0] === '/start' && (parts.length < 2 || parts[1] === profileId)) {
            clearInterval(pollTimer);
            const chatId = String(u.message.chat.id);
            useApp.getState().set({ tgChatId: chatId, tgState: 'connected' });
            // Acknowledge the update so the queue doesn't keep replaying it.
            void api('getUpdates', { offset: String(u.update_id + 1), timeout: '0' });
            void api('sendMessage', {
              chat_id: chatId,
              text: `✓ Connected to XARB monitor (profile ${profileId}). Price alerts will arrive here.`,
            });
            return;
          }
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
  } catch {
    set({ tgState: 'error' });
  }
}

export function disconnectTelegram(): void {
  clearInterval(pollTimer);
  useApp.getState().set({ tgState: 'disconnected', tgChatId: null });
}

/** Send a message to the connected chat. Returns true only if it was delivered. */
export async function sendTelegram(text: string): Promise<boolean> {
  const { tgState, tgChatId } = useApp.getState();
  if (tgState !== 'connected' || !BOT_TOKEN || !tgChatId) return false;
  try {
    await api('sendMessage', { chat_id: tgChatId, text });
    return true;
  } catch {
    return false; // delivery failure is non-fatal for the monitor
  }
}
