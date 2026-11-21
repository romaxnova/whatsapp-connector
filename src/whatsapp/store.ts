/**
 * The message index: chats, contacts, groups and messages the linked device
 * received (history sync when linking, then everything live). WhatsApp keeps
 * no history on its servers, so this index is what Claude reads.
 *
 * Message text and the raw message (which holds the keys to download its
 * file) are encrypted at rest with a key derived from TOKEN_ENCRYPTION_KEY.
 * Chat and contact names are kept in clear so a chat can be found by name.
 * Files are not stored: they are fetched from WhatsApp when asked for.
 */
import { isJidGroup, jidNormalizedUser, proto, toNumber, type WAMessage } from 'baileys';
import type { Db } from '../db.js';
import { decryptBytes, deriveKey, encryptBytes } from '../crypto.js';
import { isControl, isNoiseSystemText, MEDIA_KINDS, parseMessage, type MediaInfo, type MessageKind, type ParsedMessage } from './content.js';

export type ChatKind = 'direct' | 'group' | 'broadcast' | 'newsletter';

export interface ChatRow {
  jid: string;
  name: string | null;
  kind: ChatKind;
  unread: number;
  lastTs: number;
  archived: boolean;
  mutedUntil: number;
  pinned: boolean;
}

export interface StoredMessage {
  chatJid: string;
  id: string;
  fromMe: boolean;
  sender: string;
  ts: number;
  kind: MessageKind;
  text?: string;
  media?: MediaInfo;
  quotedId?: string;
  quotedText?: string;
  forwarded?: boolean;
  edited: boolean;
  deleted: boolean;
}

export interface GroupInfo {
  jid: string;
  subject: string | null;
  description: string | null;
  owner: string | null;
  created: number | null;
  participants: { jid: string; admin?: string | null }[];
}

export interface Contact {
  jid: string;
  name: string | null;
  notify: string | null;
  verifiedName: string | null;
}

interface Body {
  text?: string;
  media?: MediaInfo;
  quotedId?: string;
  quotedText?: string;
  forwarded?: boolean;
}

/** Lower case, without accents or punctuation: how names are compared ("Appart’ Paris" finds "appart paris"). */
export function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@+]+/gu, ' ')
    .trim();
}

export function chatKind(jid: string): ChatKind {
  if (isJidGroup(jid)) return 'group';
  if (jid.endsWith('@broadcast')) return 'broadcast';
  if (jid.endsWith('@newsletter')) return 'newsletter';
  return 'direct';
}

/** "+33 6 12 34 56 78" for 33612345678@s.whatsapp.net; undefined for anything that is not a phone number. */
export function phoneOf(jid: string): string | undefined {
  const m = /^(\d{6,15})@s\.whatsapp\.net$/.exec(jid);
  return m ? `+${m[1]}` : undefined;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wa_chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  kind TEXT NOT NULL,
  unread INTEGER NOT NULL DEFAULT 0,
  last_ts INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  muted_until INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS wa_contacts (
  jid TEXT PRIMARY KEY,
  name TEXT,
  notify TEXT,
  verified_name TEXT
);
CREATE TABLE IF NOT EXISTS wa_lid (
  lid TEXT PRIMARY KEY,
  pn TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wa_groups (
  jid TEXT PRIMARY KEY,
  subject TEXT,
  description TEXT,
  owner TEXT,
  created INTEGER,
  participants_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS wa_messages (
  chat_jid TEXT NOT NULL,
  id TEXT NOT NULL,
  from_me INTEGER NOT NULL,
  sender TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  mimetype TEXT,
  size INTEGER,
  body_enc BLOB,
  raw_enc BLOB,
  edited INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_jid, id)
);
CREATE INDEX IF NOT EXISTS wa_messages_chat_ts ON wa_messages(chat_jid, ts);
CREATE INDEX IF NOT EXISTS wa_messages_ts ON wa_messages(ts);
CREATE INDEX IF NOT EXISTS wa_messages_id ON wa_messages(id);
CREATE INDEX IF NOT EXISTS wa_messages_kind_ts ON wa_messages(kind, ts);
CREATE TABLE IF NOT EXISTS wa_reactions (
  chat_jid TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  emoji TEXT NOT NULL,
  PRIMARY KEY (chat_jid, msg_id, sender)
);
CREATE TABLE IF NOT EXISTS wa_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

interface MessageDbRow {
  chat_jid: string;
  id: string;
  from_me: number;
  sender: string;
  ts: number;
  kind: string;
  mimetype: string | null;
  size: number | null;
  body_enc: Uint8Array | null;
  raw_enc?: Uint8Array | null;
  edited: number;
  deleted: number;
}

const MSG_COLUMNS = 'chat_jid, id, from_me, sender, ts, kind, mimetype, size, body_enc, edited, deleted';

export class MessageStore {
  private readonly keys: Buffer[];
  private readonly key: Buffer;
  /** The linked account's own jid (phone number form), once known. */
  me: string | undefined;

  constructor(
    private readonly db: Db,
    masterKeys: (Buffer | undefined)[],
  ) {
    this.keys = masterKeys.filter((k): k is Buffer => Boolean(k)).map((k) => deriveKey(k, 'whatsapp-messages'));
    this.key = this.keys[0]!;
    db.exec(SCHEMA);
    this.me = this.getMeta('me');
  }

  // ---- encryption ----

  private seal(value: Uint8Array, context: string): Buffer {
    return encryptBytes(value, this.key, context);
  }

  private open(blob: Uint8Array | null | undefined, context: string): Buffer | undefined {
    if (!blob) return undefined;
    try {
      return decryptBytes(blob, this.keys, context);
    } catch {
      return undefined;
    }
  }

  // ---- meta ----

  getMeta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM wa_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO wa_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  setMe(jid: string): void {
    this.me = jidNormalizedUser(jid);
    this.setMeta('me', this.me);
  }

  // ---- identities: LID (WhatsApp's private ids) and phone numbers ----

  /** The phone-number jid of a LID, when WhatsApp told us. */
  pnForLid(lid: string): string | undefined {
    return (this.db.prepare('SELECT pn FROM wa_lid WHERE lid = ?').get(jidNormalizedUser(lid)) as { pn: string } | undefined)?.pn;
  }

  lidForPn(pn: string): string | undefined {
    return (this.db.prepare('SELECT lid FROM wa_lid WHERE pn = ?').get(jidNormalizedUser(pn)) as { lid: string } | undefined)?.lid;
  }

  /** Records that a LID and a phone number are the same person, and merges a chat kept under the LID into the phone number's. */
  mapLid(lid: string, pn: string): void {
    const l = jidNormalizedUser(lid);
    const p = jidNormalizedUser(pn);
    if (!l.endsWith('@lid') || !p.endsWith('@s.whatsapp.net')) return;
    if (this.pnForLid(l) === p) return;
    this.db.prepare('INSERT INTO wa_lid (lid, pn) VALUES (?, ?) ON CONFLICT(lid) DO UPDATE SET pn = excluded.pn').run(l, p);
    const lidChat = this.db.prepare('SELECT 1 FROM wa_chats WHERE jid = ?').get(l);
    if (lidChat) {
      this.db.exec('BEGIN');
      try {
        this.db.prepare('UPDATE OR IGNORE wa_messages SET chat_jid = ? WHERE chat_jid = ?').run(p, l);
        this.db.prepare('DELETE FROM wa_messages WHERE chat_jid = ?').run(l);
        this.db.prepare('UPDATE OR IGNORE wa_reactions SET chat_jid = ? WHERE chat_jid = ?').run(p, l);
        const old = this.db.prepare('SELECT * FROM wa_chats WHERE jid = ?').get(l) as { unread: number; last_ts: number; name: string | null };
        this.db
          .prepare(`INSERT INTO wa_chats (jid, name, kind, unread, last_ts) VALUES (?, ?, 'direct', ?, ?)
            ON CONFLICT(jid) DO UPDATE SET unread = wa_chats.unread + excluded.unread, last_ts = MAX(wa_chats.last_ts, excluded.last_ts), name = COALESCE(wa_chats.name, excluded.name)`)
          .run(p, old.name, old.unread, old.last_ts);
        this.db.prepare('DELETE FROM wa_chats WHERE jid = ?').run(l);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
    this.db.prepare('UPDATE wa_messages SET sender = ? WHERE sender = ?').run(p, l);
  }

  /** One jid per person: the phone-number form when known, without device suffix. */
  canonical(jid: string, alt?: string | null): string {
    const j = jidNormalizedUser(jid);
    if (j.endsWith('@lid')) {
      if (alt) {
        const a = jidNormalizedUser(alt);
        if (a.endsWith('@s.whatsapp.net')) {
          this.mapLid(j, a);
          return a;
        }
      }
      return this.pnForLid(j) ?? j;
    }
    if (alt && j.endsWith('@s.whatsapp.net')) {
      const a = jidNormalizedUser(alt);
      if (a.endsWith('@lid')) this.mapLid(a, j);
    }
    return j;
  }

  // ---- contacts ----

  upsertContact(c: { id: string; lid?: string | null; phoneNumber?: string | null; name?: string | null; notify?: string | null; verifiedName?: string | null }): void {
    if (!c.id) return;
    if (c.lid && c.id.endsWith('@s.whatsapp.net')) this.mapLid(c.lid, c.id);
    if (c.phoneNumber && c.id.endsWith('@lid')) this.mapLid(c.id, c.phoneNumber);
    const jid = this.canonical(c.id, c.phoneNumber);
    if (isJidGroup(jid)) return;
    this.db
      .prepare(`INSERT INTO wa_contacts (jid, name, notify, verified_name) VALUES (?, ?, ?, ?)
        ON CONFLICT(jid) DO UPDATE SET name = COALESCE(excluded.name, wa_contacts.name), notify = COALESCE(excluded.notify, wa_contacts.notify), verified_name = COALESCE(excluded.verified_name, wa_contacts.verified_name)`)
      .run(jid, c.name || null, c.notify || null, c.verifiedName || null);
  }

  contact(jid: string): Contact | undefined {
    const r = this.db.prepare('SELECT jid, name, notify, verified_name FROM wa_contacts WHERE jid = ?').get(jid) as { jid: string; name: string | null; notify: string | null; verified_name: string | null } | undefined;
    return r ? { jid: r.jid, name: r.name, notify: r.notify, verifiedName: r.verified_name } : undefined;
  }

  /** How a person shows in WhatsApp: the address-book name, else their WhatsApp name (marked ~), else their number. */
  personName(jid: string): string {
    const j = this.canonical(jid);
    if (this.me && j === this.me) return 'me';
    const c = this.contact(j);
    if (c?.name) return c.name;
    if (c?.verifiedName) return c.verifiedName;
    const phone = phoneOf(j);
    if (c?.notify) return phone ? `~${c.notify} (${phone})` : `~${c.notify}`;
    return phone ?? j.replace(/@.*$/, '');
  }

  searchContacts(query: string, limit = 20): { jid: string; name: string; phone?: string; hasChat: boolean }[] {
    const q = fold(query);
    const digits = query.replace(/\D/g, '');
    const rows = this.db.prepare('SELECT jid, name, notify, verified_name FROM wa_contacts').all() as { jid: string; name: string | null; notify: string | null; verified_name: string | null }[];
    const hits = rows.filter((r) => {
      const hay = fold([r.name, r.notify, r.verified_name].filter(Boolean).join(' '));
      return (q && hay.includes(q)) || (digits.length >= 4 && r.jid.startsWith(digits.replace(/^0+/, '')) ) || (digits.length >= 6 && r.jid.includes(digits.slice(-9)));
    });
    return hits.slice(0, limit).map((r) => ({ jid: r.jid, name: this.personName(r.jid), phone: phoneOf(r.jid), hasChat: Boolean(this.db.prepare('SELECT 1 FROM wa_chats WHERE jid = ?').get(r.jid)) }));
  }

  // ---- chats ----

  upsertChat(c: { id?: string | null; name?: string | null; unreadCount?: number | null; conversationTimestamp?: unknown; archived?: boolean | null; muteEndTime?: unknown; pinned?: unknown }, absoluteUnread: boolean): void {
    if (!c.id) return;
    const jid = this.canonical(c.id);
    if (jid === 'status@broadcast') return;
    this.db.prepare(`INSERT INTO wa_chats (jid, kind) VALUES (?, ?) ON CONFLICT(jid) DO NOTHING`).run(jid, chatKind(jid));
    if (c.name) this.db.prepare('UPDATE wa_chats SET name = ? WHERE jid = ?').run(c.name, jid);
    if (typeof c.unreadCount === 'number') {
      if (absoluteUnread || c.unreadCount === 0) this.db.prepare('UPDATE wa_chats SET unread = ? WHERE jid = ?').run(Math.max(0, c.unreadCount), jid);
      else if (c.unreadCount > 0) this.db.prepare('UPDATE wa_chats SET unread = unread + ? WHERE jid = ?').run(c.unreadCount, jid);
      else this.db.prepare('UPDATE wa_chats SET unread = MAX(unread, 1) WHERE jid = ?').run(jid); // -1: marked as unread
    }
    const ts = c.conversationTimestamp != null ? toNumber(c.conversationTimestamp as number) : 0;
    if (ts > 0) this.db.prepare('UPDATE wa_chats SET last_ts = MAX(last_ts, ?) WHERE jid = ?').run(ts, jid);
    if (typeof c.archived === 'boolean') this.db.prepare('UPDATE wa_chats SET archived = ? WHERE jid = ?').run(c.archived ? 1 : 0, jid);
    if (c.muteEndTime != null) this.db.prepare('UPDATE wa_chats SET muted_until = ? WHERE jid = ?').run(toNumber(c.muteEndTime as number), jid);
    if (c.pinned != null) this.db.prepare('UPDATE wa_chats SET pinned = ? WHERE jid = ?').run(toNumber(c.pinned as number) ? 1 : 0, jid);
  }

  deleteChat(jid: string): void {
    const j = this.canonical(jid);
    this.db.prepare('DELETE FROM wa_chats WHERE jid = ?').run(j);
    this.db.prepare('DELETE FROM wa_messages WHERE chat_jid = ?').run(j);
    this.db.prepare('DELETE FROM wa_reactions WHERE chat_jid = ?').run(j);
  }

  markChatRead(jid: string): void {
    this.db.prepare('UPDATE wa_chats SET unread = 0 WHERE jid = ?').run(this.canonical(jid));
  }

  private chatFromRow(r: { jid: string; name: string | null; kind: string; unread: number; last_ts: number; archived: number; muted_until: number; pinned: number }): ChatRow {
    return { jid: r.jid, name: r.name, kind: r.kind as ChatKind, unread: r.unread, lastTs: r.last_ts, archived: Boolean(r.archived), mutedUntil: r.muted_until, pinned: Boolean(r.pinned) };
  }

  chat(jid: string): ChatRow | undefined {
    const r = this.db.prepare('SELECT * FROM wa_chats WHERE jid = ?').get(this.canonical(jid)) as Parameters<MessageStore['chatFromRow']>[0] | undefined;
    return r ? this.chatFromRow(r) : undefined;
  }

  /** A chat's display name: the group's subject, or the person's name. */
  chatName(jid: string): string {
    const c = this.chat(jid);
    if (c?.kind === 'group') return c.name ?? this.group(jid)?.subject ?? 'Unnamed group';
    if (c?.kind === 'newsletter' || c?.kind === 'broadcast') return c.name ?? jid;
    return this.personName(jid);
  }

  /** Every chat, most recent first, with its display name. */
  chats(opts: { kind?: ChatKind; unreadOnly?: boolean; includeArchived?: boolean } = {}): (ChatRow & { displayName: string })[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.kind) {
      where.push('kind = ?');
      params.push(opts.kind);
    }
    if (opts.unreadOnly) where.push('unread > 0');
    if (!opts.includeArchived) where.push('archived = 0');
    const rows = this.db.prepare(`SELECT * FROM wa_chats ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY pinned DESC, last_ts DESC`).all(...params) as Parameters<MessageStore['chatFromRow']>[0][];
    return rows.map((r) => {
      const c = this.chatFromRow(r);
      return { ...c, displayName: this.chatName(c.jid) };
    });
  }

  /**
   * Finds a chat from what Claude was told: a jid, a phone number, or (part of) its name.
   * Exact names win over partial ones; several partial matches are returned for Claude to choose from.
   */
  findChats(query: string): (ChatRow & { displayName: string })[] {
    const q = query.trim();
    if (/@(s\.whatsapp\.net|g\.us|lid|broadcast|newsletter)$/.test(q)) {
      const c = this.chat(q);
      return c ? [{ ...c, displayName: this.chatName(c.jid) }] : [];
    }
    const digits = q.replace(/[\s().-]/g, '');
    if (/^\+?\d{6,15}$/.test(digits)) {
      const jid = `${digits.replace(/^\+/, '')}@s.whatsapp.net`;
      const c = this.chat(jid);
      if (c) return [{ ...c, displayName: this.chatName(c.jid) }];
    }
    const f = fold(q);
    if (!f) return [];
    const all = this.chats({ includeArchived: true });
    const exact = all.filter((c) => fold(c.displayName) === f || fold(c.displayName.replace(/^~/, '')) === f);
    if (exact.length) return exact;
    const words = f.split(' ');
    return all.filter((c) => {
      const hay = fold(c.displayName);
      return words.every((w) => hay.includes(w));
    });
  }

  // ---- groups ----

  upsertGroup(g: { id: string; subject?: string | null; desc?: string | null; owner?: string | null; creation?: number | null; participants?: { id: string; phoneNumber?: string | null; admin?: string | null }[] }): void {
    const jid = jidNormalizedUser(g.id);
    const participants = g.participants?.map((p) => ({ jid: this.canonical(p.id, p.phoneNumber), admin: p.admin ?? null }));
    this.db
      .prepare(`INSERT INTO wa_groups (jid, subject, description, owner, created, participants_json) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(jid) DO UPDATE SET subject = COALESCE(excluded.subject, wa_groups.subject), description = COALESCE(excluded.description, wa_groups.description),
          owner = COALESCE(excluded.owner, wa_groups.owner), created = COALESCE(excluded.created, wa_groups.created),
          participants_json = CASE WHEN excluded.participants_json = 'null' THEN wa_groups.participants_json ELSE excluded.participants_json END`)
      .run(jid, g.subject ?? null, g.desc ?? null, g.owner ? this.canonical(g.owner) : null, g.creation ?? null, participants ? JSON.stringify(participants) : 'null');
    this.db.prepare(`INSERT INTO wa_chats (jid, kind, name) VALUES (?, 'group', ?) ON CONFLICT(jid) DO UPDATE SET name = COALESCE(excluded.name, wa_chats.name)`).run(jid, g.subject ?? null);
  }

  group(jid: string): GroupInfo | undefined {
    const r = this.db.prepare('SELECT * FROM wa_groups WHERE jid = ?').get(jidNormalizedUser(jid)) as { jid: string; subject: string | null; description: string | null; owner: string | null; created: number | null; participants_json: string } | undefined;
    if (!r) return undefined;
    return { jid: r.jid, subject: r.subject, description: r.description, owner: r.owner, created: r.created, participants: JSON.parse(r.participants_json) as GroupInfo['participants'] };
  }

  // ---- messages ----

  /**
   * Adds messages (history sync, or live). Reactions, edits and deletions are applied to the
   * messages they target. Returns how many messages were stored.
   */
  ingest(messages: WAMessage[], opts: { live: boolean }): number {
    let stored = 0;
    this.db.exec('BEGIN');
    try {
      for (const msg of messages) if (this.ingestOne(msg, opts.live)) stored++;
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return stored;
  }

  private ingestOne(msg: WAMessage, live: boolean): boolean {
    const key = msg.key;
    if (!key?.remoteJid || !key.id) return false;
    if (key.remoteJid === 'status@broadcast') return false;
    const chatJid = this.canonical(key.remoteJid, (key as { remoteJidAlt?: string }).remoteJidAlt);
    const fromMe = Boolean(key.fromMe);
    const senderRaw = fromMe ? (this.me ?? 'me') : chatKind(chatJid) === 'group' ? (key.participant ?? msg.participant ?? '') : chatJid;
    const sender = fromMe ? (this.me ?? 'me') : senderRaw ? this.canonical(senderRaw, (key as { participantAlt?: string }).participantAlt) : chatJid;
    if (!fromMe && msg.pushName && sender.includes('@')) this.upsertContact({ id: sender, notify: msg.pushName });
    const parsed = parseMessage(msg);
    if (parsed.kind === 'system' && parsed.text) parsed.text = parsed.text.replace(/\b[\d]{6,20}@(?:s\.whatsapp\.net|lid)\b/g, (jid) => this.personName(jid));
    const ts = toNumber(msg.messageTimestamp ?? 0) || Math.floor(Date.now() / 1000);

    if (parsed.reaction) {
      if (!parsed.reaction.targetId) return false;
      if (parsed.reaction.emoji) this.db.prepare('INSERT INTO wa_reactions (chat_jid, msg_id, sender, emoji) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET emoji = excluded.emoji').run(chatJid, parsed.reaction.targetId, sender, parsed.reaction.emoji);
      else this.db.prepare('DELETE FROM wa_reactions WHERE chat_jid = ? AND msg_id = ? AND sender = ?').run(chatJid, parsed.reaction.targetId, sender);
      return false;
    }
    if (parsed.revokes) {
      this.markDeleted(chatJid, parsed.revokes);
      return false;
    }
    if (parsed.edit) {
      this.applyEdit(chatJid, parsed.edit.targetId, parsed.edit.text);
      return false;
    }
    if (isControl(parsed)) return false;

    this.db.prepare(`INSERT INTO wa_chats (jid, kind) VALUES (?, ?) ON CONFLICT(jid) DO NOTHING`).run(chatJid, chatKind(chatJid));
    this.db.prepare('UPDATE wa_chats SET last_ts = MAX(last_ts, ?) WHERE jid = ?').run(ts, chatJid);
    const existing = this.db.prepare('SELECT 1 FROM wa_messages WHERE chat_jid = ? AND id = ?').get(chatJid, key.id);
    const body: Body = { text: parsed.text, media: parsed.media, quotedId: parsed.quotedId, quotedText: parsed.quotedText, forwarded: parsed.forwarded };
    const rawBytes = MEDIA_KINDS.includes(parsed.kind) || live ? encodeRaw(msg) : undefined;
    this.db
      .prepare(`INSERT INTO wa_messages (chat_jid, id, from_me, sender, ts, kind, mimetype, size, body_enc, raw_enc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_jid, id) DO UPDATE SET body_enc = excluded.body_enc, raw_enc = COALESCE(excluded.raw_enc, wa_messages.raw_enc), kind = excluded.kind, mimetype = excluded.mimetype, size = excluded.size`)
      .run(
        chatJid,
        key.id,
        fromMe ? 1 : 0,
        sender,
        ts,
        parsed.kind,
        parsed.media?.mimetype ?? null,
        parsed.media?.size ?? null,
        this.seal(Buffer.from(JSON.stringify(body)), `body:${key.id}`),
        rawBytes ? this.seal(rawBytes, `raw:${key.id}`) : null,
      );
    return !existing;
  }

  markDeleted(chatJid: string, id: string): void {
    this.db.prepare('UPDATE wa_messages SET deleted = 1, body_enc = NULL, raw_enc = NULL WHERE chat_jid = ? AND id = ?').run(this.canonical(chatJid), id);
  }

  private applyEdit(chatJid: string, id: string, text: string): void {
    const row = this.db.prepare(`SELECT ${MSG_COLUMNS} FROM wa_messages WHERE chat_jid = ? AND id = ?`).get(chatJid, id) as MessageDbRow | undefined;
    if (!row) return;
    const body = this.body(row);
    body.text = text;
    this.db.prepare('UPDATE wa_messages SET body_enc = ?, edited = 1 WHERE chat_jid = ? AND id = ?').run(this.seal(Buffer.from(JSON.stringify(body)), `body:${id}`), chatJid, id);
  }

  private body(row: MessageDbRow): Body {
    const plain = this.open(row.body_enc, `body:${row.id}`);
    if (!plain) return {};
    try {
      return JSON.parse(plain.toString('utf8')) as Body;
    } catch {
      return {};
    }
  }

  private toMessage(row: MessageDbRow): StoredMessage {
    const b = this.body(row);
    return {
      chatJid: row.chat_jid,
      id: row.id,
      fromMe: Boolean(row.from_me),
      sender: row.sender,
      ts: row.ts,
      kind: row.kind as MessageKind,
      text: b.text,
      media: b.media,
      quotedId: b.quotedId,
      quotedText: b.quotedText,
      forwarded: b.forwarded,
      edited: Boolean(row.edited),
      deleted: Boolean(row.deleted),
    };
  }

  reactions(chatJid: string, ids: string[]): Map<string, { sender: string; emoji: string }[]> {
    const out = new Map<string, { sender: string; emoji: string }[]>();
    if (!ids.length) return out;
    const rows = this.db.prepare(`SELECT msg_id, sender, emoji FROM wa_reactions WHERE chat_jid = ? AND msg_id IN (${ids.map(() => '?').join(',')})`).all(chatJid, ...ids) as { msg_id: string; sender: string; emoji: string }[];
    for (const r of rows) {
      const list = out.get(r.msg_id) ?? [];
      list.push({ sender: r.sender, emoji: r.emoji });
      out.set(r.msg_id, list);
    }
    return out;
  }

  /** Messages of a chat in a time window, oldest first; `limit` newest ones of the window unless `fromStart`. */
  messages(chatJid: string, opts: { limit: number; before?: number; after?: number; fromStart?: boolean }): { messages: StoredMessage[]; more: boolean } {
    const where = ['chat_jid = ?'];
    const params: (string | number)[] = [this.canonical(chatJid)];
    if (opts.before !== undefined) {
      where.push('ts < ?');
      params.push(opts.before);
    }
    if (opts.after !== undefined) {
      where.push('ts > ?');
      params.push(opts.after);
    }
    const order = opts.fromStart ? 'ASC' : 'DESC';
    const rows = this.db.prepare(`SELECT ${MSG_COLUMNS} FROM wa_messages WHERE ${where.join(' AND ')} ORDER BY ts ${order}, rowid ${order} LIMIT ?`).all(...params, opts.limit + 1) as unknown as MessageDbRow[];
    const more = rows.length > opts.limit;
    const kept = rows.slice(0, opts.limit).map((r) => this.toMessage(r));
    return { messages: opts.fromStart ? kept : kept.reverse(), more };
  }

  /** The last message of a chat (for previews). */
  lastMessage(chatJid: string): StoredMessage | undefined {
    const r = this.db.prepare(`SELECT ${MSG_COLUMNS} FROM wa_messages WHERE chat_jid = ? ORDER BY ts DESC, rowid DESC LIMIT 1`).get(chatJid) as MessageDbRow | undefined;
    return r ? this.toMessage(r) : undefined;
  }

  /**
   * Messages matching a text, newest first. Text is encrypted, so the newest `scanLimit` messages of
   * the window are opened and searched here (a few hundred thousand per second).
   */
  search(opts: { query?: string; chatJid?: string; sender?: string; since?: number; until?: number; kinds?: readonly MessageKind[]; limit: number; offset?: number; scanLimit?: number }): { messages: StoredMessage[]; scanned: number; capped: boolean; more: boolean } {
    const where: string[] = ['deleted = 0'];
    const params: (string | number)[] = [];
    if (opts.chatJid) {
      where.push('chat_jid = ?');
      params.push(this.canonical(opts.chatJid));
    }
    if (opts.sender) {
      where.push('sender = ?');
      params.push(this.canonical(opts.sender));
    }
    if (opts.since !== undefined) {
      where.push('ts >= ?');
      params.push(opts.since);
    }
    if (opts.until !== undefined) {
      where.push('ts <= ?');
      params.push(opts.until);
    }
    if (opts.kinds?.length) {
      where.push(`kind IN (${opts.kinds.map(() => '?').join(',')})`);
      params.push(...opts.kinds);
    }
    const scanLimit = opts.scanLimit ?? 200_000;
    const terms = opts.query ? fold(opts.query).split(' ').filter(Boolean) : [];
    const rows = this.db.prepare(`SELECT ${MSG_COLUMNS} FROM wa_messages WHERE ${where.join(' AND ')} ORDER BY ts DESC, rowid DESC LIMIT ?`).all(...params, scanLimit) as unknown as MessageDbRow[];
    const offset = opts.offset ?? 0;
    const out: StoredMessage[] = [];
    let matched = 0;
    let more = false;
    for (const row of rows) {
      const m = this.toMessage(row);
      if (terms.length) {
        const hay = fold([m.text, m.media?.filename].filter(Boolean).join(' '));
        if (!terms.every((t) => hay.includes(t))) continue;
      }
      matched++;
      if (matched <= offset) continue;
      if (out.length >= opts.limit) {
        more = true;
        break;
      }
      out.push(m);
    }
    return { messages: out, scanned: rows.length, capped: rows.length >= scanLimit, more };
  }

  /** One message by id (and chat, when the same id exists in two chats). */
  findMessage(id: string, chatJid?: string): StoredMessage[] {
    const rows = (chatJid
      ? this.db.prepare(`SELECT ${MSG_COLUMNS} FROM wa_messages WHERE id = ? AND chat_jid = ?`).all(id, this.canonical(chatJid))
      : this.db.prepare(`SELECT ${MSG_COLUMNS} FROM wa_messages WHERE id = ?`).all(id)) as unknown as MessageDbRow[];
    return rows.map((r) => this.toMessage(r));
  }

  /** The full WhatsApp message as received (to download its file, quote it or forward it). */
  rawMessage(chatJid: string, id: string): WAMessage | undefined {
    const r = this.db.prepare('SELECT raw_enc FROM wa_messages WHERE chat_jid = ? AND id = ?').get(chatJid, id) as { raw_enc: Uint8Array | null } | undefined;
    const bytes = this.open(r?.raw_enc, `raw:${id}`);
    return bytes ? (proto.WebMessageInfo.decode(bytes) as WAMessage) : undefined;
  }

  /** The content of a message by key, for Baileys' retry logic (getMessage). */
  messageContent(remoteJid: string, id: string): proto.IMessage | undefined {
    return this.rawMessage(this.canonical(remoteJid), id)?.message ?? undefined;
  }

  /** Keys of the latest messages received in a chat, to mark them read. */
  lastIncomingKeys(chatJid: string, n: number): { remoteJid: string; id: string; participant?: string; fromMe: false }[] {
    const j = this.canonical(chatJid);
    const rows = this.db.prepare('SELECT id, sender FROM wa_messages WHERE chat_jid = ? AND from_me = 0 ORDER BY ts DESC LIMIT ?').all(j, n) as { id: string; sender: string }[];
    const group = chatKind(j) === 'group';
    return rows.map((r) => ({ remoteJid: j, id: r.id, fromMe: false as const, ...(group ? { participant: r.sender } : {}) }));
  }

  /** The oldest message stored for a chat (to ask the phone for what came before it). */
  oldest(chatJid: string): { id: string; ts: number; fromMe: boolean } | undefined {
    const r = this.db.prepare('SELECT id, ts, from_me FROM wa_messages WHERE chat_jid = ? ORDER BY ts ASC LIMIT 1').get(this.canonical(chatJid)) as { id: string; ts: number; from_me: number } | undefined;
    return r ? { id: r.id, ts: r.ts, fromMe: Boolean(r.from_me) } : undefined;
  }

  count(chatJid?: string): number {
    const r = (chatJid ? this.db.prepare('SELECT COUNT(*) AS n FROM wa_messages WHERE chat_jid = ?').get(this.canonical(chatJid)) : this.db.prepare('SELECT COUNT(*) AS n FROM wa_messages').get()) as { n: number };
    return Number(r.n);
  }

  stats(): { chats: number; groups: number; contacts: number; messages: number; oldest?: number; newest?: number } {
    const one = (sql: string) => Number(Object.values(this.db.prepare(sql).get() as Record<string, number>)[0] ?? 0);
    return {
      chats: one("SELECT COUNT(*) FROM wa_chats WHERE kind = 'direct'"),
      groups: one("SELECT COUNT(*) FROM wa_chats WHERE kind = 'group'"),
      contacts: one('SELECT COUNT(*) FROM wa_contacts'),
      messages: one('SELECT COUNT(*) FROM wa_messages'),
      oldest: one('SELECT MIN(ts) FROM wa_messages') || undefined,
      newest: one('SELECT MAX(ts) FROM wa_messages') || undefined,
    };
  }

  /** Removes the technical notices earlier versions stored as system lines. Returns how many went. */
  purgeNoise(): number {
    const rows = this.db.prepare(`SELECT ${MSG_COLUMNS} FROM wa_messages WHERE kind = 'system'`).all() as unknown as MessageDbRow[];
    let removed = 0;
    for (const r of rows) {
      if (!isNoiseSystemText(this.body(r).text)) continue;
      this.db.prepare('DELETE FROM wa_messages WHERE chat_jid = ? AND id = ?').run(r.chat_jid, r.id);
      removed++;
    }
    if (removed) {
      // Chats whose last line was a notice keep the time of their last real message.
      this.db.exec('UPDATE wa_chats SET last_ts = COALESCE((SELECT MAX(ts) FROM wa_messages WHERE wa_messages.chat_jid = wa_chats.jid), last_ts)');
    }
    return removed;
  }

  /** Forgets messages older than the retention period. */
  purgeBefore(ts: number): number {
    return Number(this.db.prepare('DELETE FROM wa_messages WHERE ts < ?').run(ts).changes);
  }

  /** Forgets everything (when WhatsApp is unlinked). */
  clear(): void {
    for (const t of ['wa_chats', 'wa_contacts', 'wa_lid', 'wa_groups', 'wa_messages', 'wa_reactions', 'wa_meta']) this.db.exec(`DELETE FROM ${t}`);
    // Transcripts and photo text of those messages (MediaTextCache), when that table exists.
    try {
      this.db.exec('DELETE FROM media_text');
    } catch {
      /* no such table yet */
    }
    this.me = undefined;
  }
}

/** The message as WhatsApp's own protobuf, without the preview thumbnails (they are only for display). */
export function encodeRaw(msg: WAMessage): Buffer {
  const copy = proto.WebMessageInfo.fromObject(proto.WebMessageInfo.toObject(proto.WebMessageInfo.create(msg as proto.IWebMessageInfo)));
  const content = normalizeForStorage(copy.message);
  if (content) {
    for (const value of Object.values(content)) {
      const v = value as { jpegThumbnail?: unknown; contextInfo?: { quotedMessage?: unknown } } | null;
      if (v && typeof v === 'object') {
        if ('jpegThumbnail' in v) v.jpegThumbnail = undefined;
        if (v.contextInfo?.quotedMessage) v.contextInfo.quotedMessage = undefined;
      }
    }
  }
  return Buffer.from(proto.WebMessageInfo.encode(copy).finish());
}

function normalizeForStorage(m: proto.IMessage | null | undefined): proto.IMessage | undefined {
  if (!m) return undefined;
  return m.ephemeralMessage?.message ?? m.viewOnceMessage?.message ?? m.viewOnceMessageV2?.message ?? m.documentWithCaptionMessage?.message ?? m;
}

export type { ParsedMessage };
