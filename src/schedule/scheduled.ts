/**
 * Messages scheduled for later: the server keeps them (text encrypted) and sends them itself at the
 * time asked, with no chat open, across restarts. When the connection is down at that time it keeps
 * trying for a few hours; when it cannot send, it says so in the user's own chat. Shared, file for
 * file, by the WhatsApp and Telegram connectors.
 */
import { randomBytes } from 'node:crypto';
import { decryptBytes, deriveKey, encryptBytes } from '../crypto.js';
import type { Db } from '../db.js';
import type { Logger } from '../log.js';

export type ScheduledStatus = 'pending' | 'sent' | 'failed' | 'cancelled';

export interface ScheduledMessage {
  id: string;
  chatId: string;
  chatName: string;
  text: string;
  /** When it is due (ms). */
  sendAt: number;
  status: ScheduledStatus;
  attempts: number;
  lastError?: string;
  sentAt?: number;
  messageId?: string;
  createdAt: number;
}

interface Row {
  id: string;
  chat_id: string;
  chat_name: string;
  text_enc: Uint8Array;
  send_at: number;
  next_try_at: number;
  status: ScheduledStatus;
  attempts: number;
  last_error: string | null;
  sent_at: number | null;
  message_id: string | null;
  created_at: number;
}

/** Most messages waiting at once. */
export const MAX_PENDING = 200;
/** How far ahead a message may be scheduled. */
export const MAX_AHEAD_MS = 90 * 24 * 3600 * 1000;
/** How long after its time a message is still sent when the connection was down (then it fails). */
export const LATE_LIMIT_MS = 6 * 3600 * 1000;
const RETRY_MS = 2 * 60 * 1000;
const MAX_SEND_ERRORS = 3;

export class ScheduledStore {
  private readonly keys: Buffer[];

  constructor(
    private readonly db: Db,
    masterKeys: (Buffer | undefined)[],
    private readonly now: () => number = Date.now,
  ) {
    this.keys = masterKeys.filter((k): k is Buffer => Boolean(k)).map((k) => deriveKey(k, 'scheduled messages v1'));
    db.exec(`CREATE TABLE IF NOT EXISTS scheduled_messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      chat_name TEXT NOT NULL,
      text_enc BLOB NOT NULL,
      send_at INTEGER NOT NULL,
      next_try_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      sent_at INTEGER,
      message_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scheduled_messages_due ON scheduled_messages (status, next_try_at);`);
  }

  private open(r: Row): ScheduledMessage {
    let text = '';
    try {
      text = decryptBytes(r.text_enc, this.keys, r.id).toString('utf8');
    } catch {
      text = '[unreadable: the encryption key changed]';
    }
    return {
      id: r.id,
      chatId: r.chat_id,
      chatName: r.chat_name,
      text,
      sendAt: r.send_at,
      status: r.status,
      attempts: r.attempts,
      createdAt: r.created_at,
      ...(r.last_error ? { lastError: r.last_error } : {}),
      ...(r.sent_at ? { sentAt: r.sent_at } : {}),
      ...(r.message_id ? { messageId: r.message_id } : {}),
    };
  }

  add(m: { chatId: string; chatName: string; text: string; sendAt: number }): ScheduledMessage {
    const pending = (this.db.prepare("SELECT COUNT(*) AS n FROM scheduled_messages WHERE status = 'pending'").get() as { n: number }).n;
    if (pending >= MAX_PENDING) throw new Error(`There are already ${MAX_PENDING} scheduled messages waiting; cancel some first.`);
    const id = `sch_${randomBytes(6).toString('base64url')}`;
    this.db
      .prepare('INSERT INTO scheduled_messages (id, chat_id, chat_name, text_enc, send_at, next_try_at, status, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)')
      .run(id, m.chatId, m.chatName, encryptBytes(Buffer.from(m.text, 'utf8'), this.keys[0]!, id), m.sendAt, m.sendAt, 'pending', this.now());
    return this.get(id)!;
  }

  get(id: string): ScheduledMessage | undefined {
    const r = this.db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(id) as Row | undefined;
    return r ? this.open(r) : undefined;
  }

  /** Waiting ones by time; with all, also the last 30 days of sent, failed and cancelled ones. */
  list(opts: { all?: boolean } = {}): ScheduledMessage[] {
    const rows = opts.all
      ? (this.db.prepare('SELECT * FROM scheduled_messages ORDER BY send_at').all() as unknown as Row[])
      : (this.db.prepare("SELECT * FROM scheduled_messages WHERE status = 'pending' ORDER BY send_at").all() as unknown as Row[]);
    return rows.map((r) => this.open(r));
  }

  cancel(id: string): ScheduledMessage | undefined {
    const changed = this.db.prepare("UPDATE scheduled_messages SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(id).changes;
    return changed ? this.get(id) : undefined;
  }

  due(): ScheduledMessage[] {
    return (this.db.prepare("SELECT * FROM scheduled_messages WHERE status = 'pending' AND next_try_at <= ? ORDER BY send_at LIMIT 20").all(this.now()) as unknown as Row[]).map((r) => this.open(r));
  }

  markSent(id: string, messageId: string): void {
    this.db.prepare("UPDATE scheduled_messages SET status = 'sent', sent_at = ?, message_id = ?, last_error = NULL WHERE id = ?").run(this.now(), messageId, id);
  }

  retry(id: string, error: string, countsAsAttempt: boolean): void {
    this.db.prepare('UPDATE scheduled_messages SET next_try_at = ?, last_error = ?, attempts = attempts + ? WHERE id = ?').run(this.now() + RETRY_MS, error.slice(0, 300), countsAsAttempt ? 1 : 0, id);
  }

  markFailed(id: string, error: string): void {
    this.db.prepare("UPDATE scheduled_messages SET status = 'failed', last_error = ? WHERE id = ?").run(error.slice(0, 300), id);
  }

  /** Forgets finished ones older than 30 days. */
  purge(): void {
    this.db.prepare("DELETE FROM scheduled_messages WHERE status != 'pending' AND send_at < ?").run(this.now() - 30 * 24 * 3600 * 1000);
  }

  clear(): void {
    this.db.exec('DELETE FROM scheduled_messages');
  }
}

export interface SenderPort {
  /** Whether messages can go out now. */
  ready(): boolean;
  send(chatId: string, text: string): Promise<string>;
  /** Tells the user, in their own chat, that a scheduled message could not be sent. */
  notify(text: string): Promise<void>;
}

/** Sends what is due, every 30 seconds. */
export class ScheduledSender {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly store: ScheduledStore,
    private readonly port: SenderPort,
    private readonly log: Logger,
    private readonly opts: { timezone: string; now?: () => number; intervalMs?: number },
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.opts.intervalMs ?? 30_000);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = (this.opts.now ?? Date.now)();
      for (const m of this.store.due()) {
        if (!this.port.ready()) {
          if (now - m.sendAt > LATE_LIMIT_MS) await this.fail(m, 'the connection was down for hours around its time');
          else this.store.retry(m.id, 'not connected', false);
          continue;
        }
        try {
          const id = await this.port.send(m.chatId, m.text);
          this.store.markSent(m.id, id);
          this.log.info('scheduled message sent', { late_s: Math.max(0, Math.round((now - m.sendAt) / 1000)) });
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          if (m.attempts + 1 >= MAX_SEND_ERRORS || now - m.sendAt > LATE_LIMIT_MS) await this.fail(m, why);
          else this.store.retry(m.id, why, true);
        }
      }
      this.store.purge();
    } finally {
      this.running = false;
    }
  }

  private async fail(m: ScheduledMessage, why: string): Promise<void> {
    this.store.markFailed(m.id, why);
    this.log.warn('scheduled message failed', { error: why.slice(0, 200) });
    const when = new Intl.DateTimeFormat('en-GB', { timeZone: this.opts.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(m.sendAt));
    const preview = m.text.length > 300 ? `${m.text.slice(0, 300)}…` : m.text;
    await this.port.notify(`⚠️ A scheduled message to ${m.chatName} (${when}) could not be sent: ${why}.\n\nIt said:\n${preview}`).catch((err: unknown) => {
      this.log.warn('could not tell the user about a failed scheduled message', { error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    });
  }
}

/** When to send, from "2026-11-26T08:30" (read in the default timezone) or an ISO time with offset; in the future and within 90 days. */
export function parseSendAt(value: string, tz: string, now = Date.now()): number {
  const v = value.trim();
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  let at: number;
  if (local) {
    const [, y, mo, d, h, mi, s] = local;
    const naive = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
    let utc = naive - offsetMinutes(naive, tz) * 60000;
    utc = naive - offsetMinutes(utc, tz) * 60000;
    at = utc;
  } else {
    if (!/\d{2}:\d{2}/.test(v) || !/(Z|[+-]\d{2}:?\d{2})$/.test(v)) throw new Error(`"${v.slice(0, 40)}" is not a send time: use a date and time such as 2026-11-26T08:30 (read in ${tz}).`);
    at = Date.parse(v);
    if (Number.isNaN(at)) throw new Error(`"${v.slice(0, 40)}" is not a send time: use a date and time such as 2026-11-26T08:30.`);
  }
  if (at < now - 60_000) throw new Error('That time is already past. Give a time in the future (or send the message now).');
  if (at > now + MAX_AHEAD_MS) throw new Error('Messages can be scheduled up to 90 days ahead.');
  return Math.max(at, now);
}

function offsetMinutes(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((asUtc - utcMs) / 60000);
}

/** A time for the user: "Wed 26 Nov 2026, 08:30 (Europe/Paris)". */
export function localTime(ms: number, tz: string): string {
  return `${new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms))} (${tz})`;
}
