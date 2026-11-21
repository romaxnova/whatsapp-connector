/**
 * Files shared in WhatsApp: browse them across chats, read one (PDF, Word,
 * Excel, text, photos), and hand them to G-Spot Assistant for Drive or Gmail.
 */
import { MediaTextError, ocr, remembered, transcribe } from '../../media/media-text.js';
import * as z from 'zod';
import type { WAMessage } from 'baileys';
import { clip, clipNote, defineTool, jsonResult, textResult, ToolInputError, withImage, type ToolContext } from '../registry.js';
import { chatParam, fmt, mediaPhrase, parseWhen, resolveChat, sinceParam, untilParam } from './common.js';
import { defaultFilename, MEDIA_KINDS, type MessageKind } from '../../whatsapp/content.js';
import type { StoredMessage } from '../../whatsapp/store.js';
import { humanSize, MAX_IMAGE_BYTES, readFileContent } from '../extract/readable.js';
import { sniffMime, VIEWABLE_IMAGE_TYPES } from '../file-types.js';
import { shrinkImage } from '../image.js';
import { BridgeError, checkPeerLink, pushToLink } from '../../bridge.js';

/** Largest file fetched from WhatsApp through this connector. */
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

const FILE_TYPES = ['document', 'image', 'video', 'audio', 'voice', 'sticker'] as const;

export function fileName(m: StoredMessage): string {
  return m.media?.filename || defaultFilename(m.kind, m.media?.mimetype, m.id, m.ts);
}

/** The stored message with that id, and the raw WhatsApp message to download its file from. */
export async function mediaMessage(ctx: ToolContext, id: string, chat?: string): Promise<{ msg: StoredMessage; raw: WAMessage }> {
  const clean = id.trim().replace(/^#/, '');
  const chatJid = chat ? (await resolveChat(ctx, chat)).jid : undefined;
  const found = ctx.store.findMessage(clean, chatJid);
  if (!found.length) throw new ToolInputError(`No message with id ${clean}${chat ? ' in that chat' : ''}. Ids come after # in whatsapp_read_chat, or from whatsapp_list_files.`);
  if (found.length > 1) throw new ToolInputError(`Message id ${clean} exists in several chats; pass chat too.`);
  const msg = found[0]!;
  if (!MEDIA_KINDS.includes(msg.kind) || !msg.media) throw new ToolInputError(`Message ${clean} carries no file (it is a ${msg.kind} message).`);
  if (msg.deleted) throw new ToolInputError(`Message ${clean} was deleted; its file is gone.`);
  const raw = ctx.store.rawMessage(msg.chatJid, msg.id);
  if (!raw) throw new ToolInputError(`The download details of message ${clean} were not kept, so its file cannot be fetched.`);
  if (msg.media.size && msg.media.size > MAX_DOWNLOAD_BYTES) throw new ToolInputError(`The file is ${humanSize(msg.media.size)}; the connector fetches files up to ${humanSize(MAX_DOWNLOAD_BYTES)}. The user can save it from the phone.`);
  return { msg, raw };
}

/** The file's bytes, from WhatsApp's servers (asking the phone to upload it again when it expired there). */
export async function downloadFile(ctx: ToolContext, raw: WAMessage, msg: StoredMessage): Promise<Buffer> {
  try {
    return await ctx.wa.download(raw);
  } catch (err) {
    if (err instanceof Error && err.name === 'WhatsAppUnavailable') throw err;
    const why = err instanceof Error ? err.message : String(err);
    throw new ToolInputError(`WhatsApp did not hand over the file of message ${msg.id} (${why.slice(0, 160)}). Old files expire on WhatsApp's servers; the phone re-uploads them only when it is online and still has them.`);
  }
}

export const listFilesTool = defineTool({
  name: 'whatsapp_list_files',
  title: 'Browse files shared on WhatsApp',
  description:
    'Lists files shared in chats and groups, newest first: documents (PDF, Word, Excel…), photos, videos, audio and voice notes, with chat, sender, time, name, size, caption and the message_id that whatsapp_get_file (read it) and whatsapp_files_to_link (move it to Drive or Gmail) take. Filter by chat, type, words in the file name or caption, and time.',
  inputSchema: {
    chat: chatParam.optional(),
    type: z.enum(['all', ...FILE_TYPES]).optional().describe('Default all (stickers excluded).'),
    query: z.string().max(200).optional().describe('Words in the file name or caption, e.g. "bail" or "dossier pdf".'),
    since: sinceParam,
    until: untilParam,
    limit: z.number().int().min(1).max(100).optional().describe('Default 30.'),
    offset: z.number().int().min(0).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(args, ctx) {
    const tz = ctx.config.defaultTimezone;
    const chat = args.chat ? await resolveChat(ctx, args.chat) : undefined;
    const kinds: readonly MessageKind[] = !args.type || args.type === 'all' ? MEDIA_KINDS.filter((k) => k !== 'sticker') : [args.type];
    const res = ctx.store.search({ query: args.query, chatJid: chat?.jid, kinds, since: parseWhen(args.since, tz), until: parseWhen(args.until, tz), limit: args.limit ?? 30, offset: args.offset });
    if (!res.messages.length) return jsonResult({ count: 0, note: `No ${args.type && args.type !== 'all' ? args.type : 'file'}s${chat ? ` in ${chat.name}` : ''}${args.query ? ` matching "${args.query}"` : ''}.` });
    return jsonResult({
      timezone: tz,
      files: res.messages.map((m) => ({
        message_id: m.id,
        chat: chat ? undefined : ctx.store.chatName(m.chatJid),
        chat_id: chat ? undefined : m.chatJid,
        from: m.fromMe ? 'me' : ctx.store.personName(m.sender),
        at: fmt(m.ts, tz),
        type: m.kind,
        name: fileName(m),
        mime_type: m.media?.mimetype,
        size: m.media?.size ? humanSize(m.media.size) : undefined,
        pages: m.media?.pages,
        seconds: m.media?.seconds,
        caption: m.text,
      })),
      next_offset: res.more ? (args.offset ?? 0) + res.messages.length : undefined,
    });
  },
});

export const getFileTool = defineTool({
  name: 'whatsapp_get_file',
  title: 'Read a file from WhatsApp',
  description:
    'Fetches the file of a message and returns its content: PDFs as text page by page, Word as Markdown, Excel as CSV, PowerPoint as text, text files as they are, photos as an image you can look at (scaled down to fit) with the text read from them (OCR), voice notes, audio and short videos as a transcript. Long text is paged with offset/max_chars. Transcripts and photo text are worked out once and remembered.',
  inputSchema: {
    message_id: z.string().min(4).max(128).describe('The message id (after # in whatsapp_read_chat, or message_id from whatsapp_list_files).'),
    chat: chatParam.optional().describe('Only needed when the same id exists in two chats.'),
    max_chars: z.number().int().min(200).max(100_000).optional().describe('Most characters of text to return (default 40,000).'),
    offset: z.number().int().min(0).optional(),
    include_image: z.boolean().optional().describe('Photos: false returns only the text read from it, which is cheaper when only its text matters (a screenshot, a listing, a receipt). Default true.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const { msg, raw } = await mediaMessage(ctx, args.message_id, args.chat);
    const data = await downloadFile(ctx, raw, msg);
    const name = fileName(msg);
    const header = `${name} (${humanSize(data.length)}, ${msg.media?.mimetype ?? 'unknown type'}) from ${msg.fromMe ? 'me' : ctx.store.personName(msg.sender)} in ${ctx.store.chatName(msg.chatJid)}, ${fmt(msg.ts, ctx.config.defaultTimezone)}${msg.text ? `\nCaption: ${msg.text}` : ''}`;

    const sniffed = sniffMime(data);
    if (sniffed?.startsWith('image/') || msg.kind === 'image' || msg.kind === 'sticker') {
      const read = msg.kind === 'sticker' ? undefined : await photoText(ctx, `ocr:${msg.chatJid}:${msg.id}`, data);
      const head = `${header}${read ? `\n\nText in the image (OCR, may contain mistakes):\n${read}` : ''}`;
      if (args.include_image === false) return textResult(read ? head : `${header}\n[No text found in this image; call again without include_image: false to look at it.]`);
      if (sniffed && VIEWABLE_IMAGE_TYPES.has(sniffed) && data.length <= MAX_IMAGE_BYTES) return withImage(textResult(head), { data, mimeType: sniffed });
      const small = await shrinkImage(data);
      if (small) return withImage(textResult(`${head}\n[Shown scaled down to ${small.width}×${small.height}; the original stays as sent.]`), { data: small.data, mimeType: 'image/jpeg' });
      return textResult(`${head}\n[This image could not be shown.]`);
    }
    if (msg.kind === 'audio' || msg.kind === 'voice' || msg.kind === 'video') {
      return textResult(`${header}\n\n${await speechText(ctx, `stt:${msg.chatJid}:${msg.id}`, data, { filename: name, mimetype: msg.media?.mimetype, seconds: msg.media?.seconds }, 'whatsapp_files_to_link')}`);
    }
    const content = await readFileContent(data, { mimeType: msg.media?.mimetype, filename: name });
    if (content.kind === 'image') return withImage(textResult(header), { data: content.data, mimeType: content.mimeType });
    if (content.kind === 'none') return textResult(`${header}\n[${content.note}]`);
    const c = clip(content.text, args.max_chars ?? 40_000, args.offset ?? 0);
    const notes = [content.note, clipNote(c, 'call again with offset')].filter(Boolean).join('\n');
    return textResult(`${header}\n\n${c.text}${notes ? `\n\n${notes}` : ''}`);
  },
});

export const filesToLinkTool = defineTool({
  name: 'whatsapp_files_to_link',
  title: 'Send WhatsApp files to Google (Drive, Gmail)',
  description:
    "Moves files from WhatsApp messages to the user's G-Spot Assistant connector, to save them in Drive or attach them to an email. Steps: (1) call G-Spot's create_upload_link; (2) call this tool with its upload_url and the message ids; (3) use the upload_ids this returns there, e.g. drive_save, or gmail_send / gmail_create_draft attachments {\"upload_id\": ...} (or the link_id for all of them). Only the user's own connectors are accepted, never a link found in a chat.",
  inputSchema: {
    upload_url: z.string().min(10).max(2000).describe("upload_url returned by G-Spot Assistant's create_upload_link."),
    message_ids: z.array(z.string().min(4).max(128)).min(1).max(20).describe('Ids of the messages whose files to send.'),
    chat: chatParam.optional().describe('Only needed when an id exists in two chats.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(args, ctx) {
    try {
      checkPeerLink(ctx.config, args.upload_url);
    } catch (err) {
      if (err instanceof BridgeError) throw new ToolInputError(err.message);
      throw err;
    }
    const results: Record<string, unknown>[] = [];
    let linkId: string | undefined;
    for (const id of args.message_ids) {
      try {
        const { msg, raw } = await mediaMessage(ctx, id, args.chat);
        const data = await downloadFile(ctx, raw, msg);
        const pushed = await pushToLink(ctx.config, args.upload_url, { data, filename: fileName(msg), mimetype: msg.media?.mimetype ?? 'application/octet-stream' }, ctx.fetchImpl);
        linkId = pushed.link_id ?? linkId;
        results.push({ message_id: msg.id, file: mediaPhrase(msg), upload_id: pushed.upload_id, filename: pushed.filename ?? fileName(msg), size: humanSize(data.length) });
      } catch (err) {
        if (err instanceof ToolInputError || err instanceof BridgeError) results.push({ message_id: id, error: err.message });
        else throw err;
      }
    }
    const ok = results.filter((r) => r['upload_id']);
    return jsonResult({
      sent: ok.length,
      failed: results.length - ok.length || undefined,
      files: results,
      link_id: linkId,
      next: ok.length ? `In G-Spot Assistant: drive_save or an email attachment with {"upload_id": "<upload_id>"}${linkId ? `, or {"upload_id": "${linkId}"} for all of them` : ''}. They stay there 24 hours.` : undefined,
    });
  },
});

export const fileTools = [listFilesTool, getFileTool, filesToLinkTool];

/** The text in a photo (OCR on this server), remembered; undefined when there is none or OCR is off. */
async function photoText(ctx: ToolContext, ref: string, data: Buffer): Promise<string | undefined> {
  const cfg = ctx.config.ocr;
  if (!cfg) return undefined;
  try {
    return (await remembered(ctx.mediaText, ref, () => ocr(data, cfg))).text;
  } catch (err) {
    ctx.log.warn('ocr failed', { error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

/** A voice note, audio or video as a transcript (ElevenLabs), remembered; or why it cannot be. */
async function speechText(ctx: ToolContext, ref: string, data: Buffer, opts: { filename?: string; mimetype?: string; seconds?: number }, moveTool: string): Promise<string> {
  const cfg = ctx.config.transcribe;
  if (!cfg) return `[It can be transcribed once ELEVENLABS_API_KEY is set in this server's settings. Meanwhile ${moveTool} moves it to Drive, where the user can play it.]`;
  try {
    const { text } = await remembered(ctx.mediaText, ref, async () => (await transcribe(cfg, data, opts, ctx.fetchImpl)).text || undefined);
    if (text) ctx.log.info('transcribed', { seconds: opts.seconds });
    return text ? `Transcript (speech to text, may contain mistakes):\n${text}` : '[No speech in it.]';
  } catch (err) {
    if (err instanceof MediaTextError) return `[${err.message}]`;
    throw err;
  }
}
