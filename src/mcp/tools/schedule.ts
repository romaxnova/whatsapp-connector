/**
 * Messages sent later by the server itself ("send it tomorrow at 8:30"): scheduled, listed and
 * cancelled here; the queue and its sender are in schedule/scheduled.ts.
 */
import * as z from 'zod';
import { defineTool, errorResult, jsonResult, ToolInputError, type ToolContext } from '../registry.js';
import { chatParam, resolveChat } from './common.js';
import { placeholderIn } from './send.js';
import { localTime, parseSendAt, type ScheduledMessage, type ScheduledStore } from '../../schedule/scheduled.js';

function store(ctx: ToolContext): ScheduledStore {
  if (!ctx.scheduled) throw new ToolInputError('Scheduled messages are not available on this server.');
  return ctx.scheduled;
}

function view(m: ScheduledMessage, tz: string) {
  return {
    id: m.id,
    to: m.chatName,
    send_at: localTime(m.sendAt, tz),
    status: m.status,
    text: m.text,
    ...(m.lastError && m.status !== 'sent' ? { problem: m.lastError } : {}),
    ...(m.sentAt ? { sent_at: localTime(m.sentAt, tz) } : {}),
  };
}

export const scheduleSendTool = defineTool({
  name: 'whatsapp_schedule_send',
  title: 'Schedule a WhatsApp message',
  description:
    'Sends a text message later, at send_at, from the server itself: no chat needs to be open, and it survives restarts. Use it for "send it tomorrow at 8:30". ' +
    'Same rule as sending now: unless the user dictated the exact words, show them the text, the recipient and the time first, and schedule only once they agree. ' +
    "If WhatsApp is disconnected at that time the server keeps trying for 6 hours; if it cannot send, it says so in the user's own chat. whatsapp_list_scheduled shows what is waiting, whatsapp_cancel_scheduled cancels.",
  inputSchema: {
    chat: chatParam,
    text: z.string().min(1).max(20_000),
    send_at: z.string().min(10).max(40).describe('Date and time to send, e.g. "2026-11-26T08:30", read in the default timezone (or an ISO time with offset). Up to 90 days ahead.'),
    allow_placeholders: z.boolean().optional().describe('true only when the user confirmed that a [blank]-looking part of the text belongs there.'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(args, ctx) {
    const s = store(ctx);
    const blank = placeholderIn(args.text);
    if (blank && !args.allow_placeholders) return errorResult(`The text still has a blank to fill: ${blank}. Ask the user for that detail, or pass allow_placeholders: true if it belongs there.`);
    let sendAt: number;
    try {
      sendAt = parseSendAt(args.send_at, ctx.config.defaultTimezone);
    } catch (err) {
      return errorResult((err as Error).message);
    }
    const chat = await resolveChat(ctx, args.chat, { allowNew: true });
    let m: ScheduledMessage;
    try {
      m = s.add({ chatId: chat.jid, chatName: chat.name, text: args.text, sendAt });
    } catch (err) {
      return errorResult((err as Error).message);
    }
    return jsonResult({ scheduled: true, ...view(m, ctx.config.defaultTimezone), note: 'whatsapp_cancel_scheduled with this id cancels it before then.' });
  },
});

export const listScheduledTool = defineTool({
  name: 'whatsapp_list_scheduled',
  title: 'List scheduled WhatsApp messages',
  description: 'Lists the messages waiting to be sent later (whatsapp_schedule_send), with their id, recipient, time and text. include_done also shows those sent, failed or cancelled in the last 30 days.',
  inputSchema: {
    include_done: z.boolean().optional().describe('Also show sent, failed and cancelled ones (last 30 days).'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(args, ctx) {
    const list = store(ctx).list({ all: Boolean(args.include_done) });
    return jsonResult({ count: list.length, timezone: ctx.config.defaultTimezone, scheduled: list.map((m) => view(m, ctx.config.defaultTimezone)) });
  },
});

export const cancelScheduledTool = defineTool({
  name: 'whatsapp_cancel_scheduled',
  title: 'Cancel a scheduled WhatsApp message',
  description: 'Cancels a message waiting to be sent later, by its id (from whatsapp_schedule_send or whatsapp_list_scheduled). A message already sent cannot be cancelled.',
  inputSchema: {
    id: z.string().min(4).max(40).describe('The scheduled message id, e.g. "sch_Ab12Cd34".'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async handler(args, ctx) {
    const s = store(ctx);
    const done = s.cancel(args.id.trim());
    if (done) return jsonResult({ cancelled: true, ...view(done, ctx.config.defaultTimezone) });
    const m = s.get(args.id.trim());
    return errorResult(m ? `It cannot be cancelled: it is ${m.status}.` : `No scheduled message ${args.id}. whatsapp_list_scheduled shows the ids.`);
  },
});

export const scheduleTools = [scheduleSendTool, listScheduledTool, cancelScheduledTool];
