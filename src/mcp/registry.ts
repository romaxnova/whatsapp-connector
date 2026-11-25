/**
 * Tool definition contract shared by every service module, plus output helpers
 * that keep results compact for claude.ai's limited context.
 */
import type { ScheduledStore } from '../schedule/scheduled.js';
import type { MediaTextCache } from '../media/media-text.js';
import * as z from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import type { UploadStore } from '../uploads.js';
import type { MessageStore } from '../whatsapp/store.js';
import type { WhatsAppPort } from '../whatsapp/client.js';

export interface ToolContext {
  config: Config;
  log: Logger;
  /** Files staged for sending (upload_id sources): from the user's phone, Claude's sandbox or another connector. */
  uploads: UploadStore;
  /** The message index. */
  store: MessageStore;
  /** The live WhatsApp connection. */
  wa: WhatsAppPort;
  /** POSTs a file to another connector's upload link (replaceable in tests). */
  fetchImpl?: typeof fetch;
  /** Transcripts and photo text already worked out, so a file costs once. */
  mediaText?: MediaTextCache;
  /** Messages waiting to be sent later (whatsapp_schedule_send). */
  scheduled?: ScheduledStore;
}

export interface ToolAnnotations {
  /** True when the tool only reads. claude.ai uses this for per-tool permissions. */
  readOnlyHint: boolean;
  /** True when the tool can delete or irreversibly change data (trash, delete, send is NOT destructive). */
  destructiveHint: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  /** snake_case, prefixed whatsapp_ */
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  /** Offered only when this returns true (e.g. a feature that needs an API key in the environment). */
  enabled?(config: Config): boolean;
  annotations: ToolAnnotations;
  /** Declared as a method (bivariant) so typed definitions can be collected into ToolDefinition[] without casts. */
  handler(args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext): Promise<CallToolResult>;
}

export function defineTool<Shape extends z.ZodRawShape>(def: ToolDefinition<Shape>): ToolDefinition<Shape> {
  return def;
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function jsonResult(value: unknown): CallToolResult {
  return textResult(compactJson(value));
}

/** An argument problem Claude can fix; runTool turns it into an error result with this message. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

/** Adds an image to a result so Claude can look at it (PNG, JPEG, GIF or WebP). */
export function withImage(result: CallToolResult, image: { data: Buffer; mimeType: string }): CallToolResult {
  return { ...result, content: [...result.content, { type: 'image', data: image.data.toString('base64'), mimeType: image.mimeType }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Largest tool result, in serialized characters. claude.ai accepts about
 * 150,000 (larger results are moved to the code sandbox or refused); the rest
 * is headroom for the JSON-RPC envelope.
 */
export const MAX_RESULT_CHARS = 140_000;

/**
 * Last line of defence for claude.ai's size limit: tools already page and clip
 * their output, but a result that still comes out too large is cut down, each
 * cut with a note saying so. Images are dropped (largest first) only while
 * they alone leave too little room for text; then the longest texts are cut
 * to the exact length that fits, measured on the serialized result.
 */
export function fitResult(result: CallToolResult, limit = MAX_RESULT_CHARS): CallToolResult {
  const size = (content: CallToolResult['content']) => JSON.stringify({ ...result, content }).length;
  if (size(result.content) <= limit) return result;
  const content = [...result.content];
  const imageChars = () => content.reduce((sum, c) => sum + (c.type === 'image' ? c.data.length : 0), 0);
  const dropLargestImage = () => {
    let largest = -1;
    content.forEach((c, idx) => {
      if (c.type === 'image' && (largest < 0 || c.data.length > (content[largest] as { data: string }).data.length)) largest = idx;
    });
    if (largest < 0) return false;
    const kb = Math.round(((content[largest] as { data: string }).data.length * 3) / 4 / 1024);
    content[largest] = { type: 'text', text: `[An image of ${kb} KB was left out: a tool result can carry about 150,000 characters.]` };
    return true;
  };
  while (imageChars() > limit - 20_000 && dropLargestImage());

  const cutNote = (kept: number, total: number) =>
    `\n[Cut after ${kept} of ${total} characters: a tool result can carry about 150,000. Ask for less: a smaller max_chars, an offset, fewer results or a smaller range.]`;
  const cut = new Set<number>();
  while (size(content) > limit) {
    let longest = -1;
    content.forEach((c, idx) => {
      if (c.type === 'text' && !cut.has(idx) && (longest < 0 || c.text.length > (content[longest] as { text: string }).text.length)) longest = idx;
    });
    if (longest < 0) break;
    cut.add(longest);
    const text = (content[longest] as { text: string }).text;
    const withKept = (n: number) => {
      // Never end on half of a surrogate pair (an emoji cut in two).
      const end = n > 0 && /[\uD800-\uDBFF]/.test(text.charAt(n - 1)) ? n - 1 : n;
      return { type: 'text' as const, text: `${text.slice(0, end)}${cutNote(end, text.length)}` };
    };
    let lo = 0;
    let hi = text.length;
    content[longest] = withKept(0);
    if (size(content) > limit) continue; // even an empty text does not fit: cut the next one too
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      content[longest] = withKept(mid);
      if (size(content) <= limit) lo = mid;
      else hi = mid - 1;
    }
    content[longest] = withKept(lo);
  }
  while (size(content) > limit && dropLargestImage());
  return { ...result, content };
}

/** Removes null, undefined, empty strings, empty arrays and empty objects, recursively. */
export function stripEmpty<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripEmpty(v)).filter((v) => !isEmpty(v)) as unknown as T;
  }
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = stripEmpty(v);
      if (!isEmpty(cleaned)) out[k] = cleaned;
    }
    return out as T;
  }
  return value;
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) return Object.keys(v as object).length === 0;
  return false;
}

/** JSON with empty values removed and light indentation: readable for Claude, cheap in tokens. */
export function compactJson(value: unknown): string {
  return JSON.stringify(stripEmpty(value), null, 1);
}

export interface Clipped {
  text: string;
  truncated: boolean;
  totalChars: number;
  /** Pass this as `offset` to read the next chunk. */
  nextOffset?: number;
}

/** Returns at most maxChars characters starting at offset, with a note the caller can surface. */
export function clip(text: string, maxChars: number, offset = 0): Clipped {
  const totalChars = text.length;
  const start = Math.max(0, Math.min(offset, totalChars));
  const end = Math.min(totalChars, start + Math.max(1, maxChars));
  const truncated = end < totalChars;
  const out: Clipped = { text: text.slice(start, end), truncated, totalChars };
  if (truncated) out.nextOffset = end;
  return out;
}

/** Human note appended to clipped bodies. */
export function clipNote(c: Clipped, hint = 'call again with offset'): string | undefined {
  return c.truncated ? `[truncated: showing chars ${c.totalChars - (c.totalChars - (c.nextOffset ?? 0)) - c.text.length}-${c.nextOffset} of ${c.totalChars}; ${hint}=${c.nextOffset} for more]` : undefined;
}

/** Shared zod pieces. */
export const maxCharsParam = (fallback: number) =>
  z.number().int().min(200).max(100_000).optional().describe(`Maximum characters of body text to return (default ${fallback}, at most 100,000). Use offset to page through the rest.`);
export const offsetParam = z.number().int().min(0).optional().describe('Character offset into the body text to start from (for long content).');
export const pageTokenParam = z.string().optional().describe('Page token from a previous call to fetch the next page.');
