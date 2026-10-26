// Durable state: shared settings, alert cooldowns, the Telegram update offset
// and the notification history. One SQLite file on the host's volume.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BotNotification } from '../src/engine/types';

const DB_PATH = process.env.DB_PATH ?? './data/xarb.db';
const KEEP_NOTIFICATIONS = 1000;

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0
  );
`);

const getKv = db.prepare('SELECT v FROM kv WHERE k = ?');
const putKv = db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');

export function kvGet<T>(k: string, fallback: T): T {
  const row = getKv.get(k) as { v: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.v) as T;
  } catch {
    return fallback;
  }
}

export function kvSet(k: string, v: unknown): void {
  putKv.run(k, JSON.stringify(v));
}

const insertNote = db.prepare('INSERT INTO notifications (at, kind, text, delivered) VALUES (?, ?, ?, ?)');
const markNote = db.prepare('UPDATE notifications SET delivered = 1 WHERE id = ?');
const listNotes = db.prepare('SELECT id, at, kind, text, delivered FROM notifications ORDER BY id DESC LIMIT ?');
const pruneNotes = db.prepare('DELETE FROM notifications WHERE id <= (SELECT MAX(id) FROM notifications) - ?');

export function addNotification(kind: BotNotification['kind'], text: string): BotNotification {
  const at = Date.now();
  const { lastInsertRowid } = insertNote.run(at, kind, text, 0);
  pruneNotes.run(KEEP_NOTIFICATIONS);
  return { id: Number(lastInsertRowid), at, kind, text, delivered: false };
}

export function markDelivered(id: number): void {
  markNote.run(id);
}

export function recentNotifications(limit: number): BotNotification[] {
  return (listNotes.all(Math.max(1, Math.min(200, limit))) as any[]).map((r) => ({
    id: Number(r.id),
    at: Number(r.at),
    kind: r.kind,
    text: String(r.text),
    delivered: Boolean(r.delivered),
  }));
}
