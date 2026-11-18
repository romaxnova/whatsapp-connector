/**
 * Helpers shared by the WhatsApp tools: times in the owner's zone, finding a
 * chat from what Claude was told, and messages rendered as compact lines.
 */
import * as z from 'zod';
import { ToolInputError, type ToolContext } from '../registry.js';
import { chatKind, phoneOf, type ChatKind, type StoredMessage } from '../../whatsapp/store.js';
import { humanSize } from '../extract/readable.js';

export const chatParam = z
  .string()
  .min(1)
  .max(200)
  .describe('The chat: its chat_id (from whatsapp_list_chats), a phone number with country code, or (part of) the name of the contact or group, e.g. "Appartements Paris".');

export const sinceParam = z.string().max(40).optional().describe('Only from this time on: an ISO date or date-time (2026-11-01, 2026-11-01T18:00), read in the default timezone when it has no offset, or a number of days back such as "7d".');
export const untilParam = z.string().max(40).optional().describe('Only up to this time (same forms as since).');

/** "2026-11-18 14:05" in the configured zone. */
export function fmt(ts: number, tz: string): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ts * 1000));
}

/** Offset of a zone from UTC at an instant, in minutes. */
function offsetMinutes(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - utcMs) / 60000);
}

/** Unix seconds for a time given by Claude; undefined when none was given. */
export function parseWhen(value: string | undefined, tz: string, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const v = value.trim();
  const rel = /^(\d{1,4})\s*([dhw])$/i.exec(v);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const ms = unit === 'h' ? n * 3600e3 : unit === 'w' ? n * 7 * 86400e3 : n * 86400e3;
    return Math.floor((now - ms) / 1000);
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(v);
  if (local) {
    const [, y, mo, d, h, mi, s] = local;
    const naive = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0));
    // The zone's offset at that wall-clock time (checked twice around DST changes).
    let utc = naive - offsetMinutes(naive, tz) * 60000;
    utc = naive - offsetMinutes(utc, tz) * 60000;
    return Math.floor(utc / 1000);
  }
  const parsed = Date.parse(v);
  if (Number.isNaN(parsed)) throw new ToolInputError(`"${v.slice(0, 40)}" is not a date: use 2026-11-01, 2026-11-01T18:00, an ISO time with offset, or "7d".`);
  return Math.floor(parsed / 1000);
}

export interface ResolvedChat {
  jid: string;
  name: string;
  kind: ChatKind;
  /** False when the chat is new (a number with no conversation yet). */
  known: boolean;
}

/**
 * The chat Claude means. One match is used; several are listed back so Claude can ask the user
 * or pass a chat_id. A phone number with no chat yet is checked on WhatsApp when allowNew is set.
 */
export async function resolveChat(ctx: ToolContext, input: string, opts: { allowNew?: boolean } = {}): Promise<ResolvedChat> {
  const found = ctx.store.findChats(input);
  if (found.length === 1) {
    const c = found[0]!;
    return { jid: c.jid, name: c.displayName, kind: c.kind, known: true };
  }
  if (found.length > 1) {
    const list = found
      .slice(0, 15)
      .map((c) => `${c.displayName} (${c.kind}, chat_id ${c.jid}${c.lastTs ? `, last message ${fmt(c.lastTs, ctx.config.defaultTimezone)}` : ''})`)
      .join('; ');
    throw new ToolInputError(`Several chats match "${input}": ${list}${found.length > 15 ? `; and ${found.length - 15} more` : ''}. Ask the user which one, or pass its chat_id.`);
  }
  const digits = input.replace(/[\s().-]/g, '');
  if (/^\+?\d{6,15}$/.test(digits)) {
    const phone = digits.replace(/^\+/, '');
    if (opts.allowNew) {
      const [hit] = await ctx.wa.lookupNumbers([phone]);
      if (!hit?.jid) throw new ToolInputError(`+${phone} is not on WhatsApp (or the number is incomplete: include the country code, e.g. +33...).`);
      return { jid: hit.jid, name: ctx.store.personName(hit.jid), kind: 'direct', known: false };
    }
    throw new ToolInputError(`There is no chat with +${phone} in the index yet.`);
  }
  const contacts = ctx.store.searchContacts(input, 5);
  const hint = contacts.length ? ` Contacts with that name: ${contacts.map((c) => `${c.name}${c.phone ? ` ${c.phone}` : ''} (chat_id ${c.jid})`).join('; ')}.` : '';
  throw new ToolInputError(`No chat matches "${input}". Call whatsapp_list_chats with a shorter query to see the chats.${hint}`);
}

/** A file attached to a message, in one short phrase: "document bail.pdf, 230 KB". */
export function mediaPhrase(m: StoredMessage): string | undefined {
  if (!m.media) return undefined;
  const bits: string[] = [m.kind];
  if (m.media.filename) bits.push(`"${m.media.filename}"`);
  const extra: string[] = [];
  if (m.media.size) extra.push(humanSize(m.media.size));
  if (m.media.seconds) extra.push(`${m.media.seconds}s`);
  if (m.media.pages) extra.push(`${m.media.pages} pages`);
  return `${bits.join(' ')}${extra.length ? `, ${extra.join(', ')}` : ''}`;
}

/** One message as a line of a transcript. */
export function messageLine(ctx: ToolContext, m: StoredMessage, opts: { withChat?: boolean; reactions?: { sender: string; emoji: string }[] } = {}): string {
  const tz = ctx.config.defaultTimezone;
  const who = m.fromMe ? 'me' : ctx.store.personName(m.sender);
  const where = opts.withChat ? `${ctx.store.chatName(m.chatJid)} · ` : '';
  const parts: string[] = [`[${fmt(m.ts, tz)}] ${where}${who}:`];
  if (m.deleted) parts.push('(deleted)');
  if (m.forwarded) parts.push('(forwarded)');
  if (m.quotedId) parts.push(`(reply to ${m.quotedText ? `"${m.quotedText.replace(/\s+/g, ' ')}"` : 'a message'})`);
  const media = mediaPhrase(m);
  if (media) parts.push(`[${media}]`);
  if (m.text) parts.push(m.text);
  if (m.edited) parts.push('(edited)');
  if (opts.reactions?.length) parts.push(`{${opts.reactions.map((r) => `${r.emoji} ${r.sender === ctx.store.me ? 'me' : ctx.store.personName(r.sender)}`).join(', ')}}`);
  parts.push(`#${m.id}`);
  return parts.join(' ');
}

export function phoneOrUndefined(jid: string): string | undefined {
  return chatKind(jid) === 'direct' ? phoneOf(jid) : undefined;
}

/** The time a message belongs to, given either a message id or a time. */
export function cursorTime(ctx: ToolContext, chatJid: string, value: string | undefined): number | undefined {
  if (!value) return undefined;
  const byId = ctx.store.findMessage(value.replace(/^#/, ''), chatJid)[0];
  if (byId) return byId.ts;
  return parseWhen(value, ctx.config.defaultTimezone);
}
