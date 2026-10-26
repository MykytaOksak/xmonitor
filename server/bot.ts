// The Telegram side: delivers alerts to the owner's chat and lets the owner
// manage them — turn pairs on and off, change targets, read the history.
//
// Long-polls getUpdates, so the server needs no public webhook URL. Only one
// process may poll a bot token at a time: run local copies with TG_POLL=0 (or
// a different bot) while the hosted one is live.
import { NET } from '../src/config/networks';
import { allPairs, pairName, type PairConfig } from '../src/config/pairs';
import { fmtAge, fmtNotional, fmtPrice } from '../src/engine/format';
import type { BotNotification, BotStatus, NetQuote, PairAlert, SideAlert } from '../src/engine/types';
import { defaultAlert, useApp } from '../src/state/store';
import { addNotification, kvGet, kvSet, markDelivered, recentNotifications } from './db';
import { alertIsActive, getSettings, updateAlert, watchedPairs } from './settings';

const TOKEN = process.env.TG_BOT_TOKEN ?? '';
const OWNER = (process.env.TG_OWNER_CHAT_ID ?? '').trim();
const POLL = process.env.TG_POLL !== '0';
const TZ = process.env.TZ || 'UTC';
const STARTED_AT = Date.now();
// Undelivered alerts are retried this long; after that they are stale news.
const RETRY_WINDOW_MS = 15 * 60_000;

let botUsername: string | null = null;

type Btn = { text: string; callback_data: string };
type Markup = { inline_keyboard: Btn[][] } | { force_reply: true; input_field_placeholder?: string };
type View = { text: string; markup?: Markup };

class TgError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

async function tg<T = any>(method: string, body: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j: any = await r.json().catch(() => null);
  if (!j?.ok) {
    throw new TgError(j?.description ?? `telegram ${method}: HTTP ${r.status}`, j?.error_code ?? r.status, j?.parameters?.retry_after);
  }
  return j.result as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const kb = (rows: Btn[][]): Markup => ({ inline_keyboard: rows });
const btn = (text: string, callback_data: string): Btn => ({ text, callback_data });

// Callback data is capped at 64 bytes and custom pair ids can be long, so
// buttons carry a short hash of the id instead.
export function keyOf(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}
const pairByKey = (k: string): PairConfig | undefined => allPairs().find((p) => keyOf(p.id) === k);

const notionalOf = (p: PairConfig) => getSettings().amounts[p.id] ?? p.defaultNotional;
const alertOf = (id: string): PairAlert | undefined => getSettings().savedAlerts[id];
const baseAlert = (id: string) => () => defaultAlert(id, useApp.getState().snapshots);
const hasEnabledSide = (a?: PairAlert) => !!a && (a.buy.enabled || a.sell.enabled);

const pairIcon = (a?: PairAlert) => (alertIsActive(a) ? '🔔' : hasEnabledSide(a) && a!.paused ? '🔕' : '▫️');

const when = (ms: number) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);

function uptime(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}

// ——— views ———

function homeView(): View {
  return {
    text:
      '<b>XARB monitor</b>\n' +
      'Price alerts from the cross-chain monitor, checked around the clock.\n\n' +
      '/alerts — pairs and their price targets\n' +
      '/history — recent notifications\n' +
      '/status — what the monitor is doing',
    markup: kb([[btn('🔔 Alerts', 'l'), btn('📜 History', 'h'), btn('📊 Status', 'st')]]),
  };
}

function listView(): View {
  const pairs = allPairs();
  const rows: Btn[][] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    rows.push(pairs.slice(i, i + 2).map((p) => btn(`${pairIcon(alertOf(p.id))} ${pairName(p)}`, `p:${keyOf(p.id)}`)));
  }
  rows.push([btn('📜 History', 'h'), btn('📊 Status', 'st')]);
  return {
    text: '<b>Price alerts</b>\n🔔 on · 🔕 paused · ▫️ not set\nTap a pair to change it.',
    markup: kb(rows),
  };
}

function sideLine(side: 'buy' | 'sell', cfg: SideAlert, pair: PairConfig): string {
  const nets =
    cfg.netMode === 'all'
      ? 'all networks'
      : pair.networks
          .map((n) => NET(n).name)
          .filter((name) => cfg.nets[name] !== false)
          .join(', ') || 'no networks';
  return (
    `${side === 'buy' ? 'BUY ' : 'SELL'} ${cfg.enabled ? '✅' : '⛔'} ${cfg.op} <code>${esc(cfg.price)}</code>` +
    ` · every ${esc(cfg.cooldown || '15')} min · ${esc(nets)}`
  );
}

function liveLine(pair: PairConfig): string {
  const snap = useApp.getState().snapshots[pair.id];
  const now = Date.now();
  const live = Object.values(snap?.rows ?? {}).filter(
    (r): r is NetQuote => !!r && r.status === 'live' && now - r.at < 5 * 60_000,
  );
  if (!live.length) {
    return watchedPairs().includes(pair.id)
      ? '<i>No live quotes yet.</i>'
      : '<i>Not being quoted — pairs are only quoted while they have an active alert.</i>';
  }
  const buy = live.reduce((a, b) => ((b.buy ?? Infinity) < (a.buy ?? Infinity) ? b : a));
  const sell = live.reduce((a, b) => ((b.sell ?? -Infinity) > (a.sell ?? -Infinity) ? b : a));
  return (
    `Now: buy <code>${fmtPrice(buy.buy, pair.dp)}</code> (${esc(NET(buy.netId).name)})` +
    ` · sell <code>${fmtPrice(sell.sell, pair.dp)}</code> (${esc(NET(sell.netId).name)})` +
    ` · ${fmtAge(now - Math.max(...live.map((r) => r.at)))}`
  );
}

function cardView(pair: PairConfig): View {
  const saved = alertOf(pair.id);
  const a = saved ?? baseAlert(pair.id)();
  const k = keyOf(pair.id);
  const state = alertIsActive(saved) ? '🔔 on' : hasEnabledSide(saved) && saved!.paused ? '🔕 paused' : '▫️ off';
  const rows: Btn[][] = [
    [
      btn(`BUY ${a.buy.enabled ? '✅ on' : '⛔ off'}`, `b:${k}`),
      btn(`SELL ${a.sell.enabled ? '✅ on' : '⛔ off'}`, `s:${k}`),
    ],
    [btn('✏️ BUY target', `eb:${k}`), btn('✏️ SELL target', `es:${k}`)],
    [btn(`BUY: ${a.buy.op} ⇄`, `ob:${k}`), btn(`SELL: ${a.sell.op} ⇄`, `os:${k}`)],
  ];
  if (hasEnabledSide(saved)) rows.push([btn(saved!.paused ? '▶️ Resume pair' : '⏸ Pause pair', `z:${k}`)]);
  rows.push([btn('🔄 Refresh', `p:${k}`), btn('« All pairs', 'l')]);
  return {
    text:
      `<b>${esc(pairName(pair))}</b> · ${state}\n` +
      `Size ${fmtNotional(notionalOf(pair), pair.unit)}\n\n` +
      `${sideLine('buy', a.buy, pair)}\n${sideLine('sell', a.sell, pair)}\n\n` +
      liveLine(pair),
    markup: kb(rows),
  };
}

function historyView(limit = 15): View {
  const notes = recentNotifications(limit);
  const body = notes.length
    ? notes
        .map((n) => `<code>${when(n.at)}</code> ${esc(n.text)}${n.delivered ? '' : ' <i>(not delivered)</i>'}`)
        .join('\n')
    : 'No notifications yet.';
  const title = notes.length ? `Last ${notes.length} notifications` : 'Notifications';
  return { text: `<b>${title}</b>\n\n${body}`.slice(0, 4000) };
}

function statusView(): View {
  const s = useApp.getState();
  const watching = watchedPairs();
  const lines = watching.map((id) => {
    const pair = allPairs().find((p) => p.id === id);
    if (!pair) return `• ${esc(id)}`;
    const rows = Object.values(s.snapshots[id]?.rows ?? {});
    const live = rows.filter((r) => r?.status === 'live').length;
    const failing = rows
      .filter((r) => r?.status === 'error')
      .map((r) => `${NET(r!.netId).name}: ${r!.err ?? 'error'}`)
      .slice(0, 3);
    return (
      `• ${esc(pairName(pair))} — ${live}/${pair.networks.length} live` +
      (failing.length ? `\n   <i>${esc(failing.join('; ').slice(0, 300))}</i>` : '')
    );
  });
  return {
    text:
      `<b>Status</b>\nUp ${uptime(Date.now() - STARTED_AT)} · last scan ` +
      `${s.lastSyncAt ? fmtAge(Date.now() - s.lastSyncAt) : 'not yet'}\n\n` +
      (watching.length
        ? `Watching ${watching.length} pair${watching.length === 1 ? '' : 's'}:\n${lines.join('\n')}`
        : 'No active alerts, so nothing is being quoted. Turn one on in /alerts.'),
  };
}

// ——— sending ———

async function send(chatId: string, v: View): Promise<void> {
  await tg('sendMessage', {
    chat_id: chatId,
    text: v.text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(v.markup ? { reply_markup: v.markup } : {}),
  });
}

async function edit(chatId: string, messageId: number, v: View): Promise<void> {
  try {
    await tg('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: v.text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(v.markup ? { reply_markup: v.markup } : {}),
    });
  } catch (e) {
    // Pressing Refresh on an unchanged card is not an error worth surfacing.
    if (!(e instanceof TgError && /not modified/i.test(e.message))) throw e;
  }
}

const alertButtons = (pairId: string): Markup => {
  const k = keyOf(pairId);
  return kb([[btn(alertOf(pairId)?.paused ? '▶️ Resume pair' : '⏸ Pause pair', `za:${k}`), btn('⚙️ Pair', `pa:${k}`)]]);
};

/** Record a notification and deliver it to the owner. */
export async function notify(kind: BotNotification['kind'], text: string, pairId?: string): Promise<BotNotification> {
  const note = addNotification(kind, text);
  if (await deliver(text, pairId)) {
    markDelivered(note.id);
    note.delivered = true;
  }
  return note;
}

async function deliver(text: string, pairId?: string): Promise<boolean> {
  if (!TOKEN || !OWNER) return false;
  try {
    await tg('sendMessage', { chat_id: OWNER, text, ...(pairId ? { reply_markup: alertButtons(pairId) } : {}) });
    return true;
  } catch (e) {
    console.warn('[bot] delivery failed:', (e as Error).message);
    return false;
  }
}

async function retryUndelivered(): Promise<void> {
  const cutoff = Date.now() - RETRY_WINDOW_MS;
  for (const n of recentNotifications(50).reverse()) {
    if (n.delivered || n.at < cutoff) continue;
    if (!(await deliver(`${n.text}\n(delayed — ${when(n.at)})`))) return;
    markDelivered(n.id);
  }
}

export function getStatus(): BotStatus {
  return {
    startedAt: STARTED_AT,
    lastScanAt: useApp.getState().lastSyncAt,
    watching: watchedPairs(),
    botUsername,
    ownerLinked: !!TOKEN && !!OWNER,
  };
}

// ——— input ———

// A chat waiting to type a new target, after pressing ✏️.
const pending = new Map<string, { pairId: string; side: 'buy' | 'sell' }>();

/**
 * "0.9985", "below 0.9985", "> 1.001", "cooldown 20", "above 1.001 cd 5" —
 * any combination, in any order. Null when nothing recognisable was sent.
 */
export function parseEdit(text: string): Partial<Pick<SideAlert, 'op' | 'price' | 'cooldown'>> | null {
  const t = text.toLowerCase().replace(/(\d),(\d)/g, '$1.$2').split(/[\s,]+/).filter(Boolean);
  const out: Partial<Pick<SideAlert, 'op' | 'price' | 'cooldown'>> = {};
  for (let i = 0; i < t.length; i++) {
    const w = t[i];
    if (['above', '>', '>='].includes(w)) out.op = 'above';
    else if (['below', '<', '<='].includes(w)) out.op = 'below';
    else if (['cooldown', 'cd', 'every'].includes(w) && /^\d+$/.test(t[i + 1] ?? '')) out.cooldown = String(parseInt(t[++i], 10));
    else if (/^\d+m(in)?$/.test(w)) out.cooldown = String(parseInt(w, 10));
    else if (/^\d*\.?\d+$/.test(w) && parseFloat(w) > 0) out.price = w;
    else if (/^(min|minutes?)$/.test(w)) continue;
    else return null;
  }
  if (out.cooldown === '0') return null;
  return Object.keys(out).length ? out : null;
}

async function onText(chatId: string, raw: string): Promise<void> {
  const text = raw.trim();
  const [cmd, arg] = text.split(/\s+/, 2);
  const command = cmd.startsWith('/') ? cmd.slice(1).split('@')[0].toLowerCase() : null;

  if (command === 'cancel') {
    pending.delete(chatId);
    return send(chatId, { text: 'Cancelled.' });
  }
  const waiting = pending.get(chatId);
  if (waiting && !command) {
    const patch = parseEdit(text);
    const pair = allPairs().find((p) => p.id === waiting.pairId);
    if (!pair) {
      pending.delete(chatId);
      return send(chatId, { text: 'That pair no longer exists.' });
    }
    if (!patch) {
      return send(chatId, {
        text: 'Didn’t catch that. Send a price like <code>0.9985</code>, optionally with <code>above</code>/<code>below</code> or <code>cooldown 20</code>. /cancel to stop.',
      });
    }
    pending.delete(chatId);
    // Setting a target means you want it watched: switch the side on too.
    updateAlert(pair.id, (a) => ({ ...a, [waiting.side]: { ...a[waiting.side], ...patch, ...(patch.price ? { enabled: true } : {}) } }), baseAlert(pair.id));
    return send(chatId, cardView(pair));
  }

  switch (command) {
    case 'alerts':
      return send(chatId, listView());
    case 'history':
      return send(chatId, historyView(Math.min(50, parseInt(arg ?? '', 10) || 15)));
    case 'status':
      return send(chatId, statusView());
    default:
      return send(chatId, homeView());
  }
}

async function askTarget(chatId: string, pair: PairConfig, side: 'buy' | 'sell'): Promise<void> {
  const saved = alertOf(pair.id);
  const cfg = (saved ?? baseAlert(pair.id)())[side];
  pending.set(chatId, { pairId: pair.id, side });
  const now = saved ? `now ${cfg.op} <code>${esc(cfg.price)}</code>, every ${esc(cfg.cooldown || '15')} min` : `not set yet; fires when the price is ${cfg.op} the target`;
  await send(chatId, {
    text:
      `New <b>${side.toUpperCase()}</b> target for <b>${esc(pairName(pair))}</b> — ${now}.\n\n` +
      'Send a price, e.g. <code>0.9985</code>, <code>above 1.001</code> or <code>below 0.999 cooldown 20</code>. Setting a price turns this side on. /cancel to keep it as is.',
    markup: { force_reply: true, input_field_placeholder: cfg.price },
  });
}

async function onCallback(chatId: string, messageId: number, data: string, callbackId: string): Promise<void> {
  const [action, k] = data.split(':', 2);
  const pair = k ? pairByKey(k) : undefined;
  let toast = '';

  if (k && !pair) {
    toast = 'That pair no longer exists.';
  } else if (action === 'l') {
    await edit(chatId, messageId, listView());
  } else if (action === 'h') {
    await send(chatId, historyView());
  } else if (action === 'st') {
    await send(chatId, statusView());
  } else if (action === 'p') {
    await edit(chatId, messageId, cardView(pair!));
  } else if (action === 'pa') {
    await send(chatId, cardView(pair!));
  } else if (action === 'b' || action === 's') {
    const side = action === 'b' ? 'buy' : 'sell';
    if (!alertOf(pair!.id)) {
      // Never set: its target is only a placeholder from the current quote (or
      // 1.0000 when the pair isn't quoted), which could fire at once. Ask first.
      await askTarget(chatId, pair!, side);
    } else {
      const a = updateAlert(pair!.id, (x) => ({ ...x, [side]: { ...x[side], enabled: !x[side].enabled } }), baseAlert(pair!.id));
      toast = `${side.toUpperCase()} alert ${a[side].enabled ? 'on' : 'off'}`;
      await edit(chatId, messageId, cardView(pair!));
    }
  } else if (action === 'ob' || action === 'os') {
    const side = action === 'ob' ? 'buy' : 'sell';
    updateAlert(pair!.id, (x) => ({ ...x, [side]: { ...x[side], op: x[side].op === 'above' ? 'below' : 'above' } }), baseAlert(pair!.id));
    await edit(chatId, messageId, cardView(pair!));
  } else if (action === 'eb' || action === 'es') {
    await askTarget(chatId, pair!, action === 'eb' ? 'buy' : 'sell');
  } else if (action === 'z' || action === 'za') {
    const a = updateAlert(pair!.id, (x) => ({ ...x, paused: !x.paused }), baseAlert(pair!.id));
    toast = `${pairName(pair!)} ${a.paused ? 'paused' : 'resumed'}`;
    if (action === 'z') await edit(chatId, messageId, cardView(pair!));
    else await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: alertButtons(pair!.id) }).catch(() => {});
  }
  await tg('answerCallbackQuery', { callback_query_id: callbackId, ...(toast ? { text: toast } : {}) }).catch(() => {});
}

/** One Telegram update (exported for tests). */
export async function handleUpdate(u: any): Promise<void> {
  const msg = u.message ?? u.callback_query?.message;
  const chatId = msg?.chat?.id != null ? String(msg.chat.id) : null;
  if (!chatId) return;

  if (chatId !== OWNER) {
    if (u.callback_query) return;
    // Private bot. The chat id is shown so the owner can find theirs.
    await send(chatId, {
      text: OWNER
        ? 'This is a private bot.'
        : `This bot has no owner yet. Your chat id is <code>${chatId}</code> — set it as TG_OWNER_CHAT_ID on the server to link this chat.`,
    }).catch(() => {});
    return;
  }

  if (u.callback_query) {
    await onCallback(chatId, msg.message_id, String(u.callback_query.data ?? ''), u.callback_query.id);
  } else if (typeof msg.text === 'string') {
    await onText(chatId, msg.text);
  }
}

async function pollLoop(): Promise<void> {
  let offset = kvGet<number>('tgOffset', 0);
  for (;;) {
    try {
      const updates = await tg<any[]>(
        'getUpdates',
        { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] },
        65_000,
      );
      for (const u of updates) {
        offset = u.update_id + 1;
        kvSet('tgOffset', offset);
        await handleUpdate(u).catch((e) => console.error('[bot] update failed:', e));
      }
    } catch (e) {
      const err = e as TgError;
      if (err.code === 409) console.warn('[bot] another process is polling this bot token — retrying in 15s');
      else console.warn('[bot] getUpdates failed:', err.message);
      await sleep(err.code === 409 ? 15_000 : err.retryAfter ? err.retryAfter * 1000 : 5_000);
    }
  }
}

export async function startBot(): Promise<void> {
  if (!TOKEN) {
    console.warn('[bot] TG_BOT_TOKEN not set — Telegram is off');
    return;
  }
  if (!OWNER) console.warn('[bot] TG_OWNER_CHAT_ID not set — message the bot to get your chat id');
  try {
    botUsername = (await tg<{ username: string }>('getMe')).username;
    await tg('setMyCommands', {
      commands: [
        { command: 'alerts', description: 'Pairs and price targets' },
        { command: 'history', description: 'Recent notifications' },
        { command: 'status', description: 'What the monitor is doing' },
        { command: 'help', description: 'What this bot does' },
      ],
    });
    console.log(`[bot] @${botUsername} ready${POLL ? '' : ' (polling off)'}`);
  } catch (e) {
    console.warn('[bot] getMe failed:', (e as Error).message);
  }
  setInterval(() => void retryUndelivered().catch(() => {}), 60_000);
  if (POLL) void pollLoop();
}
