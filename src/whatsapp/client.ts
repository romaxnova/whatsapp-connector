/**
 * The connection to WhatsApp: this server is a linked device of the owner's
 * WhatsApp account (like WhatsApp Web), through Baileys. It links with a
 * pairing code or a QR code from the admin page, stays connected, reconnects
 * after network trouble, and writes what arrives into the message index.
 *
 * Tools use the WhatsAppPort interface, so they can be tested with a fake.
 */
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  proto,
  type AnyMessageContent,
  type WAMessage,
  type WASocket,
} from 'baileys';
import QRCode from 'qrcode';
import type { Logger } from '../log.js';
import type { SqliteAuthState } from './auth-state.js';
import type { MessageStore } from './store.js';

export type LinkState =
  | { state: 'unlinked' }
  | { state: 'linking'; qr?: string; qrSvg?: string; pairingCode?: string; phone?: string; startedAt: number }
  | { state: 'connecting' }
  | { state: 'open'; since: number }
  | { state: 'reconnecting'; reason: string; retryAt: number }
  | { state: 'logged_out'; at: number };

export interface OutgoingFile {
  data: Buffer;
  mimetype: string;
  filename: string;
  caption?: string;
  asDocument?: boolean;
}

/** What tools need from the connection. */
export interface WhatsAppPort {
  status(): LinkState;
  /** Sends text; returns the new message's id. */
  sendText(jid: string, text: string, quoted?: WAMessage): Promise<string>;
  sendFile(jid: string, file: OutgoingFile, quoted?: WAMessage): Promise<string>;
  download(msg: WAMessage): Promise<Buffer>;
  markRead(keys: { remoteJid: string; id: string; participant?: string; fromMe: false }[]): Promise<void>;
  /** Fresh group details from WhatsApp (also stored). */
  refreshGroup(jid: string): Promise<void>;
  /** Asks the phone for messages older than the given one; they arrive through history sync. */
  requestOlder(chatJid: string, oldest: { id: string; ts: number; fromMe: boolean }, count: number): Promise<void>;
  /** Which of these numbers are on WhatsApp, with their jids. */
  lookupNumbers(phones: string[]): Promise<{ phone: string; jid?: string }[]>;
}

/** Baileys wants a pino-style logger; this one forwards warnings and errors to ours, without message content. */
function baileysLogger(log: Logger, level: string) {
  const make = (bindings: Record<string, unknown>): ReturnType<typeof makeLogger> => makeLogger(bindings);
  function makeLogger(bindings: Record<string, unknown>) {
    const summary = (obj: unknown, msg?: string) => {
      const err = (obj as { err?: { message?: string } } | undefined)?.err?.message ?? (obj instanceof Error ? obj.message : undefined);
      return { msg: (msg ?? (typeof obj === 'string' ? obj : '')).slice(0, 200), error: err?.slice(0, 200), ...(bindings['class'] ? { component: String(bindings['class']) } : {}) };
    };
    return {
      level,
      child: (b: Record<string, unknown>) => make({ ...bindings, ...b }),
      trace: () => undefined,
      debug: (obj: unknown, msg?: string) => (level === 'debug' ? log.debug('baileys', summary(obj, msg)) : undefined),
      info: (obj: unknown, msg?: string) => (level === 'debug' ? log.debug('baileys', summary(obj, msg)) : undefined),
      warn: (obj: unknown, msg?: string) => log.debug('baileys warning', summary(obj, msg)),
      error: (obj: unknown, msg?: string) => log.warn('baileys error', summary(obj, msg)),
    };
  }
  return make({});
}

const LINK_WINDOW_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

export class WhatsAppService implements WhatsAppPort {
  private sock: WASocket | undefined;
  private link: LinkState = { state: 'unlinked' };
  private backoffMs = 2000;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private linkTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  /** Waiters for on-demand history (requestOlder). */
  private historyWaiters = new Set<() => void>();
  historySync = { chunks: 0, messages: 0, lastAt: 0, complete: false };

  constructor(
    private readonly auth: SqliteAuthState,
    private readonly store: MessageStore,
    private readonly log: Logger,
    private readonly opts: { fullHistory: boolean; logLevel: string },
  ) {}

  status(): LinkState {
    return this.link;
  }

  /** On boot: reconnects a linked session; an unlinked server waits for the owner to link it. */
  async start(): Promise<void> {
    if (this.auth.isRegistered()) await this.connect();
  }

  /** Starts linking: shows a QR code, or a pairing code for this phone number when one is given. */
  async beginLink(phone?: string): Promise<void> {
    if (this.link.state === 'open') throw new Error('WhatsApp is already linked. Unlink it first to link another account.');
    const digits = phone?.replace(/\D/g, '');
    if (phone !== undefined && (!digits || digits.length < 8 || digits.length > 15)) throw new Error('Enter the phone number with its country code, for example +33 6 12 34 56 78.');
    this.auth.clear();
    this.link = { state: 'linking', startedAt: Date.now(), ...(digits ? { phone: digits } : {}) };
    await this.connect();
    clearTimeout(this.linkTimer);
    this.linkTimer = setTimeout(() => {
      if (this.link.state === 'linking') {
        this.log.info('whatsapp linking window closed');
        this.teardown();
        this.link = { state: 'unlinked' };
      }
    }, LINK_WINDOW_MS);
    this.linkTimer.unref();
  }

  /** Stops linking (the owner pressed Cancel). */
  cancelLink(): void {
    if (this.link.state !== 'linking') return;
    clearTimeout(this.linkTimer);
    this.teardown();
    this.link = { state: 'unlinked' };
  }

  /** Logs this device out of WhatsApp and forgets the session and the message index. */
  async unlink(): Promise<void> {
    clearTimeout(this.reconnectTimer);
    try {
      await this.sock?.logout('Unlinked from the admin page');
    } catch {
      // Already gone on WhatsApp's side: forgetting it here is enough.
    }
    this.teardown();
    this.auth.clear();
    this.store.clear();
    this.link = { state: 'unlinked' };
    this.log.info('whatsapp unlinked');
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.linkTimer);
    this.teardown();
  }

  private teardown(): void {
    const s = this.sock;
    this.sock = undefined;
    if (!s) return;
    s.ev.removeAllListeners('connection.update');
    try {
      s.end(undefined);
    } catch {
      /* already closed */
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.teardown();
    if (this.link.state !== 'linking') this.link = { state: 'connecting' };
    const { state, saveCreds } = this.auth.load();
    const logger = baileysLogger(this.log, this.opts.logLevel === 'debug' ? 'debug' : 'warn');
    let version: [number, number, number] | undefined;
    try {
      const latest = await fetchLatestWaWebVersion({ signal: AbortSignal.timeout(8000) });
      if (latest.isLatest) version = latest.version as [number, number, number];
    } catch {
      // Baileys' built-in version is used.
    }
    const sock = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      logger,
      ...(version ? { version } : {}),
      // A desktop browser gets the longest history from the phone when linking.
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: this.opts.fullHistory,
      markOnlineOnConnect: false,
      shouldSyncHistoryMessage: () => true,
      generateHighQualityLinkPreview: false,
      getMessage: async (key) => (key.remoteJid && key.id ? this.store.messageContent(key.remoteJid, key.id) : undefined),
    });
    this.sock = sock;
    let pairingRequested = false;

    sock.ev.on('creds.update', () => {
      try {
        saveCreds();
      } catch (err) {
        this.log.error('could not save the whatsapp session', { error: err instanceof Error ? err.message : String(err) });
      }
    });

    sock.ev.on('connection.update', (u) => {
      if (this.sock !== sock) return;
      if (u.qr && this.link.state === 'linking') {
        const linking = this.link;
        if (linking.phone && !pairingRequested) {
          pairingRequested = true;
          sock
            .requestPairingCode(linking.phone)
            .then((code) => {
              if (this.link.state === 'linking') this.link = { ...this.link, pairingCode: code.match(/.{1,4}/g)?.join('-') ?? code };
              this.log.info('whatsapp pairing code issued');
            })
            .catch((err: unknown) => this.log.warn('whatsapp pairing code refused', { error: err instanceof Error ? err.message : String(err) }));
        }
        QRCode.toString(u.qr, { type: 'svg', margin: 1, width: 280 })
          .then((svg) => {
            if (this.link.state === 'linking') this.link = { ...this.link, qr: u.qr, qrSvg: svg };
          })
          .catch(() => undefined);
      }
      if (u.connection === 'open') {
        clearTimeout(this.linkTimer);
        this.backoffMs = 2000;
        this.link = { state: 'open', since: Date.now() };
        const me = sock.user?.id;
        if (me) this.store.setMe(me);
        if (sock.user?.lid && me) this.store.mapLid(sock.user.lid, me);
        this.log.info('whatsapp connected');
        void this.loadGroups(sock);
      }
      if (u.connection === 'close') {
        const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        const reason = DisconnectReason[code ?? -1] ?? `code ${code ?? 'unknown'}`;
        if (code === DisconnectReason.loggedOut) {
          this.log.warn('whatsapp logged this device out: link it again from the admin page');
          this.teardown();
          this.auth.clear();
          this.link = { state: 'logged_out', at: Date.now() };
          return;
        }
        if (this.link.state === 'linking' && code !== DisconnectReason.restartRequired) {
          // QR codes ran out, or the pairing failed: start over within the linking window.
          this.log.info('whatsapp linking restarted', { reason });
          setTimeout(() => void this.connect(), 3000).unref();
          return;
        }
        if (code === DisconnectReason.restartRequired) {
          // Normal right after linking: WhatsApp asks for a fresh connection with the new credentials.
          void this.connect();
          return;
        }
        const wait = this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
        this.link = { state: 'reconnecting', reason, retryAt: Date.now() + wait };
        this.log.warn('whatsapp connection closed; reconnecting', { reason, inSeconds: Math.round(wait / 1000) });
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => void this.connect(), wait);
        this.reconnectTimer.unref();
      }
    });

    sock.ev.on('messaging-history.set', ({ chats, contacts, messages, lidPnMappings, isLatest, progress }) => {
      try {
        for (const m of lidPnMappings ?? []) this.store.mapLid(m.lid, m.pn);
        for (const c of contacts) this.store.upsertContact(c);
        for (const c of chats) this.store.upsertChat(c, true);
        const n = this.store.ingest(messages, { live: false });
        this.historySync.chunks++;
        this.historySync.messages += n;
        this.historySync.lastAt = Date.now();
        if (isLatest || progress === 100) this.historySync.complete = true;
        this.log.info('whatsapp history received', { chats: chats.length, messages: messages.length, stored: n, progress: progress ?? null });
      } catch (err) {
        this.log.error('whatsapp history could not be stored', { error: err instanceof Error ? err.message : String(err) });
      }
      for (const w of this.historyWaiters) w();
    });
    sock.ev.on('messaging-history.status', ({ status }) => {
      if (status === 'complete') this.historySync.complete = true;
    });
    sock.ev.on('lid-mapping.update', (m) => this.safely('lid mapping', () => this.store.mapLid(m.lid, m.pn)));
    sock.ev.on('contacts.upsert', (list) => this.safely('contacts', () => list.forEach((c) => this.store.upsertContact(c))));
    sock.ev.on('contacts.update', (list) => this.safely('contacts', () => list.forEach((c) => c.id && this.store.upsertContact(c as { id: string }))));
    sock.ev.on('chats.upsert', (list) => this.safely('chats', () => list.forEach((c) => this.store.upsertChat(c, true))));
    sock.ev.on('chats.update', (list) => this.safely('chats', () => list.forEach((c) => this.store.upsertChat(c, false))));
    sock.ev.on('chats.delete', (ids) => this.safely('chats', () => ids.forEach((id) => this.store.deleteChat(id))));
    sock.ev.on('messages.upsert', ({ messages, type }) => this.safely('messages', () => this.store.ingest(messages, { live: type === 'notify' || type === 'append' })));
    sock.ev.on('messages.update', (updates) =>
      this.safely('message updates', () => {
        for (const u of updates) {
          if (u.update.message && u.key.remoteJid && u.key.id) this.store.ingest([{ key: u.key, message: u.update.message, messageTimestamp: Math.floor(Date.now() / 1000) } as WAMessage], { live: true });
          if (u.update.messageStubType === proto.WebMessageInfo.StubType.REVOKE && u.key.remoteJid && u.key.id) this.store.markDeleted(u.key.remoteJid, u.key.id);
        }
      }),
    );
    sock.ev.on('messages.delete', (d) =>
      this.safely('message deletions', () => {
        if ('keys' in d) d.keys.forEach((k) => k.remoteJid && k.id && this.store.markDeleted(k.remoteJid, k.id));
        else this.store.deleteChat(d.jid);
      }),
    );
    sock.ev.on('groups.upsert', (list) => this.safely('groups', () => list.forEach((g) => this.store.upsertGroup(g))));
    sock.ev.on('groups.update', (list) => this.safely('groups', () => list.forEach((g) => g.id && this.store.upsertGroup(g as { id: string }))));
    sock.ev.on('group-participants.update', ({ id }) => void this.refreshGroup(id).catch(() => undefined));
  }

  private safely(what: string, fn: () => unknown): void {
    try {
      fn();
    } catch (err) {
      this.log.error(`whatsapp ${what} could not be stored`, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async loadGroups(sock: WASocket): Promise<void> {
    try {
      const groups = await sock.groupFetchAllParticipating();
      for (const g of Object.values(groups)) this.store.upsertGroup(g);
      this.log.info('whatsapp groups loaded', { count: Object.keys(groups).length });
    } catch (err) {
      this.log.warn('whatsapp groups could not be loaded', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private open(): WASocket {
    if (!this.sock || this.link.state !== 'open') {
      const s = this.link.state;
      throw new WhatsAppUnavailable(
        s === 'unlinked' || s === 'logged_out'
          ? 'WhatsApp is not linked to this connector. The owner links it on the admin page (Link WhatsApp).'
          : s === 'linking'
            ? 'WhatsApp is being linked right now: finish linking on the admin page, then try again.'
            : 'WhatsApp is reconnecting. Try again in a minute.',
      );
    }
    return this.sock;
  }

  private async send(jid: string, content: AnyMessageContent, quoted?: WAMessage): Promise<string> {
    const sock = this.open();
    const sent = await sock.sendMessage(jid, content, quoted ? { quoted } : undefined);
    if (sent) this.store.ingest([sent], { live: true });
    return sent?.key.id ?? '';
  }

  sendText(jid: string, text: string, quoted?: WAMessage): Promise<string> {
    return this.send(jid, { text }, quoted);
  }

  sendFile(jid: string, file: OutgoingFile, quoted?: WAMessage): Promise<string> {
    const mt = file.mimetype.toLowerCase();
    let content: AnyMessageContent;
    if (!file.asDocument && /^image\/(jpeg|png|webp)$/.test(mt)) content = { image: file.data, mimetype: mt, ...(file.caption ? { caption: file.caption } : {}) };
    else if (!file.asDocument && mt === 'video/mp4') content = { video: file.data, mimetype: mt, ...(file.caption ? { caption: file.caption } : {}) };
    else if (!file.asDocument && /^audio\//.test(mt)) content = { audio: file.data, mimetype: mt };
    else content = { document: file.data, mimetype: file.mimetype, fileName: file.filename, ...(file.caption ? { caption: file.caption } : {}) };
    return this.send(jid, content, quoted);
  }

  async download(msg: WAMessage): Promise<Buffer> {
    const sock = this.open();
    return downloadMediaMessage(msg, 'buffer', {}, { logger: baileysLogger(this.log, 'warn'), reuploadRequest: sock.updateMediaMessage });
  }

  async markRead(keys: { remoteJid: string; id: string; participant?: string; fromMe: false }[]): Promise<void> {
    if (keys.length) await this.open().readMessages(keys);
  }

  async refreshGroup(jid: string): Promise<void> {
    const g = await this.open().groupMetadata(jid);
    this.store.upsertGroup(g);
  }

  async requestOlder(chatJid: string, oldest: { id: string; ts: number; fromMe: boolean }, count: number): Promise<void> {
    const sock = this.open();
    const arrived = new Promise<void>((resolve) => {
      const done = () => {
        this.historyWaiters.delete(done);
        resolve();
      };
      this.historyWaiters.add(done);
      setTimeout(done, 20_000).unref();
    });
    await sock.fetchMessageHistory(count, { remoteJid: chatJid, id: oldest.id, fromMe: oldest.fromMe }, oldest.ts);
    await arrived;
  }

  async lookupNumbers(phones: string[]): Promise<{ phone: string; jid?: string }[]> {
    const res = (await this.open().onWhatsApp(...phones)) ?? [];
    return phones.map((p) => {
      const hit = res.find((r) => r.exists && r.jid.startsWith(p.replace(/\D/g, '')));
      return { phone: p, ...(hit ? { jid: hit.jid } : {}) };
    });
  }
}

/** The connection is not usable right now; the message says what the owner should do. */
export class WhatsAppUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WhatsAppUnavailable';
  }
}
