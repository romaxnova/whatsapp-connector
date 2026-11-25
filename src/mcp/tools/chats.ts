/**
 * Reading WhatsApp: status, chats and groups, a chat's messages, search,
 * group members, contacts, and asking the phone for older messages.
 */
import * as z from 'zod';
import { defineTool, jsonResult, textResult, ToolInputError, type ToolContext } from '../registry.js';
import { chatParam, cursorTime, fmt, messageLine, parseWhen, phoneOrUndefined, resolveChat, sinceParam, untilParam } from './common.js';
import { phoneOf } from '../../whatsapp/store.js';

function preview(ctx: ToolContext, jid: string, kind: string): string | undefined {
  const m = ctx.store.lastMessage(jid);
  if (!m) return undefined;
  const body = m.deleted ? '(deleted)' : (m.text ?? (m.media ? `[${m.kind}${m.media.filename ? ` ${m.media.filename}` : ''}]` : `[${m.kind}]`));
  const who = m.fromMe ? 'me' : kind === 'group' ? ctx.store.personName(m.sender) : '';
  const line = `${who ? `${who}: ` : ''}${body.replace(/\s+/g, ' ')}`;
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

function linkedState(ctx: ToolContext): string {
  const s = ctx.wa.status();
  return s.state;
}

export const statusTool = defineTool({
  name: 'whatsapp_status',
  title: 'WhatsApp connection status',
  description:
    'Whether WhatsApp is linked and connected, which account, how much of the history the index holds (chats, groups, messages, the oldest date) and the admin page. Call it when a tool says WhatsApp is unavailable, or when the user asks why old messages are missing.',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(_args, ctx) {
    const s = ctx.wa.status();
    const stats = ctx.store.stats();
    const tz = ctx.config.defaultTimezone;
    const admin = `${ctx.config.baseUrl.origin}/admin`;
    return jsonResult({
      state: s.state,
      account: ctx.store.me ? phoneOf(ctx.store.me) : undefined,
      connected_since: s.state === 'open' ? new Date(s.since).toISOString() : undefined,
      reconnecting: s.state === 'reconnecting' ? { reason: s.reason, retry_at: new Date(s.retryAt).toISOString() } : undefined,
      index: { direct_chats: stats.chats, groups: stats.groups, contacts: stats.contacts, messages: stats.messages, oldest_message: stats.oldest ? fmt(stats.oldest, tz) : undefined, newest_message: stats.newest ? fmt(stats.newest, tz) : undefined },
      timezone: tz,
      files_can_go_to: ctx.config.peerUploadHosts,
      admin_page: admin,
      note:
        s.state === 'open'
          ? 'The index has what the phone sent when WhatsApp was linked, then everything since. whatsapp_load_older asks the phone for older messages of one chat.'
          : s.state === 'reconnecting' || s.state === 'connecting'
            ? 'Reconnecting by itself; the index can still be read.'
            : `Not linked: the owner links WhatsApp on ${admin} (WhatsApp on the phone → Linked devices → Link a device). The index can still be read.`,
    });
  },
});

export const listChatsTool = defineTool({
  name: 'whatsapp_list_chats',
  title: 'List WhatsApp chats and groups',
  description:
    'Lists chats, most recent first (pinned ones on top): chat_id, name, direct or group, unread count, time and preview of the last message. Use query to find a chat by name (accents and case ignored, every word must match), kind to keep only groups or only direct chats, unread_only for what is waiting.',
  inputSchema: {
    query: z.string().max(100).optional().describe('Words in the contact or group name, e.g. "appart".'),
    kind: z.enum(['all', 'direct', 'group']).optional().describe('Default all.'),
    unread_only: z.boolean().optional(),
    include_archived: z.boolean().optional().describe('Include archived chats (default false, except when query is given).'),
    limit: z.number().int().min(1).max(200).optional().describe('Default 30.'),
    offset: z.number().int().min(0).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(args, ctx) {
    const tz = ctx.config.defaultTimezone;
    const kind = args.kind && args.kind !== 'all' ? args.kind : undefined;
    let chats = args.query?.trim() ? ctx.store.findChats(args.query) : ctx.store.chats({ kind, unreadOnly: args.unread_only, includeArchived: args.include_archived });
    if (args.query?.trim()) {
      if (kind) chats = chats.filter((c) => c.kind === kind);
      if (args.unread_only) chats = chats.filter((c) => c.unread > 0);
    }
    chats = chats.filter((c) => c.kind === 'direct' || c.kind === 'group');
    const limit = args.limit ?? 30;
    const offset = args.offset ?? 0;
    const page = chats.slice(offset, offset + limit);
    if (!page.length) {
      return jsonResult({
        count: 0,
        connection: linkedState(ctx),
        note: args.query ? `No chat name contains "${args.query}". Try fewer words, or whatsapp_find_contacts for a person without a chat yet.` : 'No chats in the index yet. If WhatsApp was just linked, the history is still arriving: try again in a minute.',
      });
    }
    return jsonResult({
      total: chats.length,
      chats: page.map((c) => ({
        chat_id: c.jid,
        name: c.displayName,
        kind: c.kind,
        phone: phoneOrUndefined(c.jid),
        unread: c.unread || undefined,
        last_message_at: c.lastTs ? fmt(c.lastTs, tz) : undefined,
        last_message: preview(ctx, c.jid, c.kind),
        archived: c.archived || undefined,
        pinned: c.pinned || undefined,
        muted: c.mutedUntil > Date.now() / 1000 || c.mutedUntil === -1 || undefined,
      })),
      next_offset: offset + limit < chats.length ? offset + limit : undefined,
    });
  },
});

export const readChatTool = defineTool({
  name: 'whatsapp_read_chat',
  title: 'Read a WhatsApp chat',
  description:
    'Reads the messages of one chat or group as a transcript, oldest to newest: time, sender, text, attached files ([document "bail.pdf", 230 KB]), replies, reactions, and each message\'s id after #. By default the latest `limit` messages; `before` (a message id or a time) pages back, `since`/`after` reads forward from a date (from_start: true starts at its beginning). Files: whatsapp_get_file with the message id reads one, whatsapp_files_to_link moves it to Drive/Gmail.',
  inputSchema: {
    chat: chatParam,
    limit: z.number().int().min(1).max(300).optional().describe('Messages to return (default 50).'),
    before: z.string().max(80).optional().describe('Only messages before this message id or time: pass the `older` value of the previous result to page back.'),
    since: sinceParam,
    until: untilParam,
    from_start: z.boolean().optional().describe('With since: start from the oldest message after it instead of the newest ones.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(args, ctx) {
    const chat = await resolveChat(ctx, args.chat);
    const tz = ctx.config.defaultTimezone;
    const limit = args.limit ?? 50;
    const before = cursorTime(ctx, chat.jid, args.before) ?? (args.until ? (parseWhen(args.until, tz) ?? 0) + 1 : undefined);
    const after = args.since ? (parseWhen(args.since, tz) ?? 0) - 1 : undefined;
    const { messages, more } = ctx.store.messages(chat.jid, { limit, before, after, fromStart: Boolean(args.from_start && after !== undefined) });
    const c = ctx.store.chat(chat.jid);
    const group = chat.kind === 'group' ? ctx.store.group(chat.jid) : undefined;
    const header = [
      `${chat.name} (${chat.kind}${group ? `, ${group.participants.length} members` : ''}${phoneOrUndefined(chat.jid) ? `, ${phoneOrUndefined(chat.jid)}` : ''}) · chat_id ${chat.jid}${c?.unread ? ` · ${c.unread} unread` : ''}`,
      `Times in ${tz}.`,
    ];
    if (!messages.length) {
      const total = ctx.store.count(chat.jid);
      return textResult(`${header.join('\n')}\n\n${total ? 'No messages in that window.' : 'None of its messages are here yet: this chat was not in the history the phone sent when WhatsApp was linked (the phone chooses what it sends, and stops if it goes offline during the first minutes). Its new messages arrive as they are written; once there is one, whatsapp_load_older asks the phone for the ones before it, 50 at a time. To get one now, the user can send any message in the chat from the phone.'}`);
    }
    const reactions = ctx.store.reactions(chat.jid, messages.map((m) => m.id));
    const lines = messages.map((m) => messageLine(ctx, m, { reactions: reactions.get(m.id) }));
    const first = messages[0]!;
    const last = messages[messages.length - 1]!;
    const footer: string[] = [];
    if (args.from_start) {
      if (more) footer.push(`More after this: call again with since "${new Date(last.ts * 1000).toISOString()}" and from_start: true.`);
    } else if (more) footer.push(`Older messages: call again with before "${first.id}".`);
    else if (!args.since) footer.push('This is the oldest message in the index for this chat; whatsapp_load_older asks the phone for earlier ones.');
    return textResult(`${header.join('\n')}\n\n${lines.join('\n')}${footer.length ? `\n\n${footer.join(' ')}` : ''}`);
  },
});

export const searchTool = defineTool({
  name: 'whatsapp_search_messages',
  title: 'Search WhatsApp messages',
  description:
    'Finds messages containing words (every word must appear; accents and case ignored; file names count), newest first, across every chat or in one chat, optionally from one sender and in a time window. Without query it lists the messages of the window. Each hit shows the chat, so whatsapp_read_chat with before "<message id>" shows the conversation around it.',
  inputSchema: {
    query: z.string().max(200).optional().describe('Words to look for, e.g. "loyer charges" or "T3 Bastille".'),
    chat: chatParam.optional(),
    sender: z.string().max(200).optional().describe('Only messages from this person (name or phone number; "me" for the user).'),
    since: sinceParam,
    until: untilParam,
    limit: z.number().int().min(1).max(100).optional().describe('Default 30.'),
    offset: z.number().int().min(0).optional(),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(args, ctx) {
    const tz = ctx.config.defaultTimezone;
    if (!args.query?.trim() && !args.chat && !args.sender && !args.since) throw new ToolInputError('Give a query, or narrow the search with chat, sender or since.');
    const chat = args.chat ? await resolveChat(ctx, args.chat) : undefined;
    let sender: string | undefined;
    if (args.sender) {
      if (/^(me|moi)$/i.test(args.sender.trim())) sender = ctx.store.me ?? 'me';
      else {
        const digits = args.sender.replace(/[\s().+-]/g, '');
        const people = /^\d{6,15}$/.test(digits) ? [{ jid: `${digits}@s.whatsapp.net`, name: args.sender }] : ctx.store.searchContacts(args.sender, 10);
        if (!people.length) throw new ToolInputError(`No contact matches "${args.sender}".`);
        if (people.length > 1 && !people.some((p) => p.name.toLowerCase() === args.sender!.toLowerCase())) {
          throw new ToolInputError(`Several contacts match "${args.sender}": ${people.map((p) => `${p.name} (${p.jid})`).join('; ')}. Pass the phone number.`);
        }
        sender = (people.find((p) => p.name.toLowerCase() === args.sender!.toLowerCase()) ?? people[0]!).jid;
      }
    }
    const res = ctx.store.search({ query: args.query, chatJid: chat?.jid, sender, since: parseWhen(args.since, tz), until: parseWhen(args.until, tz), limit: args.limit ?? 30, offset: args.offset });
    if (!res.messages.length) return textResult(`No messages match${args.query ? ` "${args.query}"` : ''}${chat ? ` in ${chat.name}` : ''}.${res.capped ? ' Only the newest 200,000 messages were searched: narrow with since/until.' : ''}`);
    const lines = res.messages.map((m) => messageLine(ctx, m, { withChat: !chat }));
    const next = res.more ? `\n\nMore results: offset ${(args.offset ?? 0) + res.messages.length}.` : '';
    return textResult(`Times in ${tz}.\n${lines.join('\n')}${next}`);
  },
});

export const groupInfoTool = defineTool({
  name: 'whatsapp_group_info',
  title: 'WhatsApp group details',
  description: "A group's name, description, creation date and members (name, phone number, admin), fresh from WhatsApp when connected.",
  inputSchema: { chat: chatParam },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const chat = await resolveChat(ctx, args.chat);
    if (chat.kind !== 'group') throw new ToolInputError(`${chat.name} is a direct chat, not a group.`);
    let stale = false;
    try {
      await ctx.wa.refreshGroup(chat.jid);
    } catch {
      stale = true;
    }
    const g = ctx.store.group(chat.jid);
    if (!g) return jsonResult({ chat_id: chat.jid, name: chat.name, note: 'No details stored for this group yet, and WhatsApp could not be asked.' });
    return jsonResult({
      chat_id: chat.jid,
      name: g.subject ?? chat.name,
      description: g.description ?? undefined,
      created: g.created ? fmt(g.created, ctx.config.defaultTimezone) : undefined,
      created_by: g.owner ? ctx.store.personName(g.owner) : undefined,
      member_count: g.participants.length,
      members: g.participants.map((p) => ({ name: ctx.store.personName(p.jid), phone: phoneOf(p.jid), admin: p.admin ?? undefined })),
      note: stale ? 'WhatsApp is not connected: these details may be out of date.' : undefined,
    });
  },
});

export const findContactsTool = defineTool({
  name: 'whatsapp_find_contacts',
  title: 'Find WhatsApp contacts',
  description: 'Finds people by name or phone number among the contacts WhatsApp synced and the people seen in chats: name, phone number, chat_id, and whether a chat exists. With a full phone number it also checks whether that number is on WhatsApp.',
  inputSchema: { query: z.string().min(1).max(100).describe('A name, part of one, or a phone number.') },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const hits = ctx.store.searchContacts(args.query, 25);
    const digits = args.query.replace(/[\s().+-]/g, '');
    let onWhatsApp: { phone: string; jid?: string } | undefined;
    if (/^\d{8,15}$/.test(digits) && !hits.length) {
      try {
        [onWhatsApp] = await ctx.wa.lookupNumbers([digits]);
      } catch {
        // Not connected: the index answer stands alone.
      }
    }
    return jsonResult({
      contacts: hits.map((h) => ({ name: h.name, phone: h.phone, chat_id: h.jid, has_chat: h.hasChat || undefined })),
      number_check: onWhatsApp ? { phone: `+${digits}`, on_whatsapp: Boolean(onWhatsApp.jid), chat_id: onWhatsApp.jid } : undefined,
      note: hits.length ? undefined : `Nobody named "${args.query}" in the contacts.`,
    });
  },
});

export const markReadTool = defineTool({
  name: 'whatsapp_mark_read',
  title: 'Mark a WhatsApp chat as read',
  description: 'Marks the messages received in a chat as read (blue ticks for the sender, unread badge cleared on the phone). Only when the user asks for it: reading a chat through this connector leaves it unread.',
  inputSchema: { chat: chatParam },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const chat = await resolveChat(ctx, args.chat);
    const keys = ctx.store.lastIncomingKeys(chat.jid, 30);
    await ctx.wa.markRead(keys);
    ctx.store.markChatRead(chat.jid);
    return jsonResult({ chat: chat.name, marked_read: keys.length });
  },
});

export const loadOlderTool = defineTool({
  name: 'whatsapp_load_older',
  title: 'Load older messages of a chat',
  description:
    "Asks the user's phone for up to 50 messages older than the oldest one the index has for a chat (WhatsApp keeps no history on its servers: the phone sends it, and must be online). Waits up to 20 seconds for them, then reports how many arrived; whatsapp_read_chat then shows them. Repeat to go further back.",
  inputSchema: { chat: chatParam, count: z.number().int().min(1).max(50).optional().describe('Default 50.') },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(args, ctx) {
    const chat = await resolveChat(ctx, args.chat);
    const oldest = ctx.store.oldest(chat.jid);
    if (!oldest) throw new ToolInputError(`None of the messages of ${chat.name} are here yet, and WhatsApp can only send older ones counting back from a message already here. As soon as one message is written in it (the user can send one from the phone), call this again.`);
    const before = ctx.store.count(chat.jid);
    await ctx.wa.requestOlder(chat.jid, oldest, args.count ?? 50);
    const added = ctx.store.count(chat.jid) - before;
    const nowOldest = ctx.store.oldest(chat.jid);
    return jsonResult({
      chat: chat.name,
      added,
      oldest_now: nowOldest ? fmt(nowOldest.ts, ctx.config.defaultTimezone) : undefined,
      note: added ? `Read them with whatsapp_read_chat (before "${oldest.id}").` : 'Nothing arrived within 20 seconds: the phone may be offline, or there is nothing older. Try again later.',
    });
  },
});

export const readTools = [statusTool, listChatsTool, readChatTool, searchTool, groupInfoTool, findContactsTool, markReadTool, loadOlderTool];
