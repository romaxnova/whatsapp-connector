/**
 * Test helpers: in-memory database, a fake WhatsApp connection that records
 * what it was asked to do, and a ready-made ToolContext.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { WAMessage } from 'baileys';
import { openDatabase } from './db.js';
import { loadConfig, type Config } from './config.js';
import { silentLogger } from './log.js';
import type { ToolContext, ToolDefinition } from './mcp/registry.js';
import { runTool } from './mcp/server.js';
import { UploadStore } from './uploads.js';
import { MessageStore } from './whatsapp/store.js';
import type { LinkState, OutgoingFile, WhatsAppPort } from './whatsapp/client.js';

export const TEST_KEY = Buffer.alloc(32, 7);
export const ME = '33600000000@s.whatsapp.net';

export function testEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    BASE_URL: 'https://wa.test',
    ADMIN_PASSWORD: 'correct horse battery staple',
    TOKEN_ENCRYPTION_KEY: TEST_KEY.toString('base64'),
    DB_PATH: ':memory:',
    DEFAULT_TIMEZONE: 'Europe/Paris',
    LOG_LEVEL: 'error',
    OCR: 'off',
    PEER_UPLOAD_HOSTS: 'gspot.test',
    ...overrides,
  };
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig(testEnv(overrides));
}

export class FakeWhatsApp implements WhatsAppPort {
  state: LinkState = { state: 'open', since: Date.now() };
  sent: { jid: string; text?: string; file?: OutgoingFile; voice?: { ogg: Buffer; seconds: number; waveform: Uint8Array }; quoted?: WAMessage }[] = [];
  read: { remoteJid: string; id: string }[] = [];
  files = new Map<string, Buffer>();
  onWhatsApp = new Set<string>();
  historySync = { chunks: 0, messages: 0, lastAt: 0, complete: false };
  private n = 0;
  status(): LinkState {
    return this.state;
  }
  async sendText(jid: string, text: string, quoted?: WAMessage): Promise<string> {
    this.sent.push({ jid, text, quoted });
    return `SENT${++this.n}`;
  }
  async sendFile(jid: string, file: OutgoingFile, quoted?: WAMessage): Promise<string> {
    this.sent.push({ jid, file, quoted });
    return `SENT${++this.n}`;
  }
  async sendVoice(jid: string, note: { ogg: Buffer; seconds: number; waveform: Uint8Array }, quoted?: WAMessage): Promise<string> {
    this.sent.push({ jid, voice: note, quoted });
    return `SENT${++this.n}`;
  }
  async download(msg: WAMessage): Promise<Buffer> {
    const data = this.files.get(msg.key.id ?? '');
    if (!data) throw new Error('media not found');
    return data;
  }
  async markRead(keys: { remoteJid: string; id: string }[]): Promise<void> {
    this.read.push(...keys);
  }
  async refreshGroup(): Promise<void> {
    throw new Error('offline');
  }
  async requestOlder(): Promise<void> {}
  async lookupNumbers(phones: string[]): Promise<{ phone: string; jid?: string }[]> {
    return phones.map((p) => ({ phone: p, ...(this.onWhatsApp.has(p) ? { jid: `${p}@s.whatsapp.net` } : {}) }));
  }
  async beginLink(): Promise<void> {}
  cancelLink(): void {}
  async unlink(): Promise<void> {}
}

export function testContext(overrides: Partial<ToolContext> = {}): ToolContext & { wa: FakeWhatsApp } {
  const store = new MessageStore(openDatabase(':memory:'), [TEST_KEY]);
  store.setMe(ME);
  return { config: testConfig(), log: silentLogger, uploads: new UploadStore(), store, wa: new FakeWhatsApp(), ...overrides } as ToolContext & { wa: FakeWhatsApp };
}

/** Runs a tool as the MCP server would, and returns its text. */
export async function call(def: ToolDefinition<any>, args: Record<string, unknown>, ctx: ToolContext): Promise<{ text: string; isError: boolean; result: CallToolResult }> {
  const result = await runTool(def as ToolDefinition, args, ctx);
  const text = result.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return { text, isError: Boolean(result.isError), result };
}

let seq = 0;
/** A WhatsApp message as Baileys delivers it. */
export function waMsg(o: { chat: string; id?: string; fromMe?: boolean; participant?: string; participantAlt?: string; remoteJidAlt?: string; ts?: number; pushName?: string; message: Record<string, unknown> }): WAMessage {
  return {
    key: { remoteJid: o.chat, id: o.id ?? `MSG${++seq}`, fromMe: Boolean(o.fromMe), ...(o.participant ? { participant: o.participant } : {}), ...(o.participantAlt ? { participantAlt: o.participantAlt } : {}), ...(o.remoteJidAlt ? { remoteJidAlt: o.remoteJidAlt } : {}) },
    message: o.message,
    messageTimestamp: o.ts ?? 1_763_000_000 + seq,
    ...(o.pushName ? { pushName: o.pushName } : {}),
  } as WAMessage;
}
