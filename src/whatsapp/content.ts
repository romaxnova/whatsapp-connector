/**
 * What a WhatsApp message says, in one flat shape: its kind, its text (or
 * caption), the file it carries, the message it quotes, and the changes it
 * makes to other messages (a reaction, an edit, a deletion). Pure functions,
 * so every kind of message can be tested without a connection.
 */
import { getContentType, normalizeMessageContent, proto, toNumber, type WAMessage } from 'baileys';

export type MessageKind =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'voice'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'
  | 'poll'
  | 'event'
  | 'call'
  | 'system'
  | 'other';

/** Kinds that carry a file which can be downloaded. */
export const MEDIA_KINDS: readonly MessageKind[] = ['image', 'video', 'audio', 'voice', 'document', 'sticker'];

export interface MediaInfo {
  mimetype?: string;
  filename?: string;
  size?: number;
  seconds?: number;
  pages?: number;
  width?: number;
  height?: number;
}

export interface ParsedMessage {
  kind: MessageKind;
  text?: string;
  media?: MediaInfo;
  /** Id of the message this one replies to, with the start of its text. */
  quotedId?: string;
  quotedText?: string;
  forwarded?: boolean;
  /** A reaction (empty emoji: a reaction removed) to another message. */
  reaction?: { targetId: string; emoji: string };
  /** This message deletes another one for everybody. */
  revokes?: string;
  /** This message replaces the text of another one. */
  edit?: { targetId: string; text: string };
}

const QUOTE_CHARS = 140;

function num(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = toNumber(v as number);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The text of a message content (body or caption), whatever its kind. */
export function textOf(content: proto.IMessage | null | undefined): string | undefined {
  const m = normalizeMessageContent(content);
  if (!m) return undefined;
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    m.documentWithCaptionMessage?.message?.documentMessage?.caption ??
    m.buttonsResponseMessage?.selectedDisplayText ??
    m.listResponseMessage?.title ??
    m.templateButtonReplyMessage?.selectedDisplayText ??
    undefined
  ) || undefined;
}

function contextOf(m: proto.IMessage): proto.IContextInfo | undefined {
  for (const value of Object.values(m)) {
    const ctx = (value as { contextInfo?: proto.IContextInfo } | null)?.contextInfo;
    if (ctx) return ctx;
  }
  return undefined;
}

export function parseMessage(msg: Pick<WAMessage, 'message' | 'messageStubType' | 'messageStubParameters'>): ParsedMessage {
  const m = normalizeMessageContent(msg.message);
  if (!m) {
    if (msg.messageStubType) return { kind: 'system', text: systemText(msg.messageStubType, msg.messageStubParameters ?? []) };
    return { kind: 'other' };
  }
  const type = getContentType(m);
  const ctx = contextOf(m);
  const base: ParsedMessage = { kind: 'other' };
  if (ctx?.stanzaId) {
    base.quotedId = ctx.stanzaId;
    const quoted = textOf(ctx.quotedMessage);
    if (quoted) base.quotedText = quoted.length > QUOTE_CHARS ? `${quoted.slice(0, QUOTE_CHARS)}…` : quoted;
  }
  if (ctx?.isForwarded) base.forwarded = true;

  switch (type) {
    case 'conversation':
    case 'extendedTextMessage':
      return { ...base, kind: 'text', text: textOf(m) };
    case 'imageMessage': {
      const i = m.imageMessage!;
      return { ...base, kind: 'image', text: i.caption || undefined, media: { mimetype: i.mimetype ?? 'image/jpeg', size: num(i.fileLength), width: i.width ?? undefined, height: i.height ?? undefined } };
    }
    case 'videoMessage':
    case 'ptvMessage': {
      const v = (m.videoMessage ?? m.ptvMessage)!;
      return { ...base, kind: 'video', text: v.caption || undefined, media: { mimetype: v.mimetype ?? 'video/mp4', size: num(v.fileLength), seconds: v.seconds ?? undefined } };
    }
    case 'audioMessage': {
      const a = m.audioMessage!;
      return { ...base, kind: a.ptt ? 'voice' : 'audio', media: { mimetype: a.mimetype ?? 'audio/ogg', size: num(a.fileLength), seconds: a.seconds ?? undefined } };
    }
    case 'documentMessage':
    case 'documentWithCaptionMessage': {
      const d = (m.documentMessage ?? m.documentWithCaptionMessage?.message?.documentMessage)!;
      return {
        ...base,
        kind: 'document',
        text: d.caption || undefined,
        media: { mimetype: d.mimetype ?? 'application/octet-stream', filename: d.fileName || d.title || undefined, size: num(d.fileLength), pages: d.pageCount ?? undefined },
      };
    }
    case 'stickerMessage': {
      const s = m.stickerMessage!;
      return { ...base, kind: 'sticker', media: { mimetype: s.mimetype ?? 'image/webp', size: num(s.fileLength) } };
    }
    case 'locationMessage':
    case 'liveLocationMessage': {
      const l = (m.locationMessage ?? m.liveLocationMessage)! as proto.Message.ILocationMessage;
      const where = [l.name, l.address].filter(Boolean).join(', ');
      const coords = l.degreesLatitude != null && l.degreesLongitude != null ? `https://maps.google.com/?q=${l.degreesLatitude},${l.degreesLongitude}` : '';
      return { ...base, kind: 'location', text: [where, coords, l.comment ?? (m.liveLocationMessage?.caption || '')].filter(Boolean).join(' ') || undefined };
    }
    case 'contactMessage':
    case 'contactsArrayMessage': {
      const list = m.contactMessage ? [m.contactMessage] : (m.contactsArrayMessage?.contacts ?? []);
      return { ...base, kind: 'contact', text: list.map((c) => `${c.displayName ?? ''} ${phonesInVcard(c.vcard)}`.trim()).join('; ') || undefined };
    }
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
    case 'pollCreationMessageV5': {
      const p = (m.pollCreationMessage ?? m.pollCreationMessageV2 ?? m.pollCreationMessageV3 ?? m.pollCreationMessageV5)!;
      const options = (p.options ?? []).map((o) => o.optionName).filter(Boolean);
      return { ...base, kind: 'poll', text: `${p.name ?? 'Poll'}${options.length ? ` [${options.join(' | ')}]` : ''}` };
    }
    case 'eventMessage': {
      const e = m.eventMessage!;
      const start = num(e.startTime);
      return { ...base, kind: 'event', text: [e.name, e.description, start ? new Date(start * 1000).toISOString() : '', e.location?.name].filter(Boolean).join(' · ') || undefined };
    }
    case 'reactionMessage': {
      const r = m.reactionMessage!;
      return { kind: 'other', reaction: { targetId: r.key?.id ?? '', emoji: r.text ?? '' } };
    }
    case 'protocolMessage': {
      const p = m.protocolMessage!;
      if (p.type === proto.Message.ProtocolMessage.Type.REVOKE && p.key?.id) return { kind: 'other', revokes: p.key.id };
      if (p.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT && p.key?.id) return { kind: 'other', edit: { targetId: p.key.id, text: textOf(p.editedMessage) ?? '' } };
      return { kind: 'other' };
    }
    case 'editedMessage': {
      const p = m.editedMessage?.message?.protocolMessage;
      if (p?.key?.id) return { kind: 'other', edit: { targetId: p.key.id, text: textOf(p.editedMessage) ?? '' } };
      return { kind: 'other' };
    }
    case 'call':
      return { kind: 'call', text: 'Call' };
    default: {
      const text = textOf(m);
      return text ? { ...base, kind: 'text', text } : { ...base, kind: 'other' };
    }
  }
}

/** Whether a parsed message is only a change to another message, with nothing of its own to show. */
export function isControl(p: ParsedMessage): boolean {
  return Boolean(p.reaction || p.revokes || p.edit) || (p.kind === 'other' && !p.text && !p.media);
}

function phonesInVcard(vcard: string | null | undefined): string {
  if (!vcard) return '';
  const phones = [...vcard.matchAll(/^TEL[^:]*:(.+)$/gim)].map((x) => x[1]!.trim());
  return phones.join(', ');
}

/** A line for group events (someone added, subject changed) WhatsApp sends as stubs. */
function systemText(stub: number, params: string[]): string {
  const T = proto.WebMessageInfo.StubType;
  const who = params.join(', ');
  switch (stub) {
    case T.GROUP_CREATE:
      return `Group created${who ? `: ${who}` : ''}`;
    case T.GROUP_CHANGE_SUBJECT:
      return `Group name changed to ${who}`;
    case T.GROUP_CHANGE_DESCRIPTION:
      return 'Group description changed';
    case T.GROUP_PARTICIPANT_ADD:
      return `Added: ${who}`;
    case T.GROUP_PARTICIPANT_REMOVE:
      return `Removed: ${who}`;
    case T.GROUP_PARTICIPANT_LEAVE:
      return `Left: ${who}`;
    case T.GROUP_PARTICIPANT_INVITE:
      return `Joined by invite link: ${who}`;
    case T.GROUP_PARTICIPANT_PROMOTE:
      return `Made admin: ${who}`;
    case T.GROUP_PARTICIPANT_DEMOTE:
      return `No longer admin: ${who}`;
    case T.REVOKE:
      return 'This message was deleted';
    default:
      return `(${T[stub] ?? 'event'})`;
  }
}

/** File extension WhatsApp would give a file of this type, for files that come without a name. */
export function defaultFilename(kind: MessageKind, mimetype: string | undefined, id: string, ts: number): string {
  const ext: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/3gpp': '3gp',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'application/pdf': 'pdf',
  };
  const base = (mimetype ?? '').split(';')[0]!.trim().toLowerCase();
  const e = ext[base] ?? (base.split('/')[1]?.replace(/[^a-z0-9]/g, '').slice(0, 6) || 'bin');
  const date = new Date(ts * 1000).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const prefix = kind === 'voice' ? 'PTT' : kind === 'image' ? 'IMG' : kind === 'video' ? 'VID' : kind === 'audio' ? 'AUD' : kind === 'sticker' ? 'STK' : 'DOC';
  return `${prefix}-${date}-${id.slice(-6)}.${e}`;
}
