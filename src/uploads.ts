/**
 * Staging area for files that come from the Claude chat: a PDF the user
 * uploaded, a chart Claude drew. claude.ai cannot hand such files to a
 * connector, so they arrive here first, either from Claude's code sandbox
 * through a one-time upload link (POST /upload/:token) or as base64 chunks
 * through the upload_file tool, and are then attached or saved by upload_id,
 * as often as needed (one upload can go into several drafts).
 *
 * Files are kept for 24 hours after their last change. In production they sit
 * in the SQLite database on the volume, encrypted with AES-256-GCM under a key
 * derived from TOKEN_ENCRYPTION_KEY (name and type included), so a deploy in
 * the middle of a task does not lose them; tests keep them in memory. Upload
 * links last 30 minutes and are stored only as hashes of their tokens, in the
 * database too, so a link the user has open survives a deploy.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from './db.js';
import { bytesKeyId, decryptBytes, DecryptError, deriveKey, encryptBytes, keyId } from './crypto.js';

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadError';
  }
}

export interface StagedFile {
  id: string;
  filename?: string;
  mimeType?: string;
  /** The upload link the file came through (see UploadLink.linkId), when it came through one. */
  linkId?: string;
  data: Buffer;
  createdAt: number;
  expiresAt: number;
}

export interface UploadLink {
  token: string;
  expiresAt: number;
  /** A public name for the link (not the token): list_uploads finds the files that came through it. */
  linkId: string;
}

/** A staged file without its bytes. */
export type StagedFileInfo = Omit<StagedFile, 'data'> & { size: number };

/** One file of an upload, before it is staged. */
export interface IncomingFile {
  data: Buffer;
  filename?: string;
  mimeType?: string;
}

export interface UploadLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  fileTtlMs: number;
  linkTtlMs: number;
  maxLinks: number;
  /** Largest body one link accepts (several files picked at once in a browser). */
  maxRequestBytes: number;
  /** Most files one link accepts, over all its uploads. */
  maxFilesPerLink: number;
  /** Most files staged at once, whatever their size. */
  maxFiles: number;
}

const MiB = 1024 * 1024;

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxFileBytes: 25 * MiB,
  maxTotalBytes: 250 * MiB,
  fileTtlMs: 24 * 60 * 60 * 1000,
  linkTtlMs: 30 * 60 * 1000,
  maxLinks: 50,
  maxRequestBytes: 60 * MiB,
  maxFilesPerLink: 50,
  maxFiles: 500,
};

interface PendingLink {
  expiresAt: number;
  filename?: string;
  /**
   * The upload receiving its body right now. The newest request wins: a second tap on Upload or a
   * resent form aborts the older one, so one link never buffers two bodies. An upload that started
   * before the link expired may finish after; no new one starts once it has.
   */
  reservation?: { id: number; abort: () => void };
  /** Every file that came through so far: a link takes several uploads (on a phone, photos and documents come from different pickers). */
  received: StagedFileInfo[];
}

/** What a link can do now. */
export type LinkState = 'open' | 'gone';

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** The public name of a link: a prefix of the token's hash, which says nothing about the token. */
function linkIdOf(token: string): string {
  return linkIdOfHash(hash(token));
}

function linkIdOfHash(tokenHash: string): string {
  return `ln_${tokenHash.slice(0, 16)}`;
}

/** An open link as the vault keeps it: the hash of its token, never the token. */
export interface StoredLink {
  tokenHash: string;
  expiresAt: number;
  filename?: string;
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Where staged files are kept. */
export interface UploadVault {
  load(id: string): StagedFile | undefined;
  save(file: StagedFile): void;
  /** Saves several files, all or none. */
  saveAll(files: StagedFile[]): void;
  delete(id: string): boolean;
  /** Removes files whose expiresAt is at or before `now`. */
  deleteExpired(now: number): void;
  /** Bytes held by files that have not expired. */
  totalBytes(now: number): number;
  /** Files that have not expired, newest first, without their bytes. */
  list(now: number): StagedFileInfo[];
  /** Records a link or its new expiry, so a restart keeps it. */
  saveLink(link: StoredLink): void;
  /** Links that have not expired. */
  loadLinks(now: number): StoredLink[];
  /** Removes links whose expiresAt is at or before `now`. */
  deleteExpiredLinks(now: number): void;
}

/** Files in memory, lost on restart (tests, and the default when no database is given). */
export class MemoryUploadVault implements UploadVault {
  private readonly files = new Map<string, StagedFile>();
  private readonly links = new Map<string, StoredLink>();
  load(id: string): StagedFile | undefined {
    const f = this.files.get(id);
    return f ? { ...f } : undefined;
  }
  save(file: StagedFile): void {
    this.files.set(file.id, { ...file });
  }
  saveAll(files: StagedFile[]): void {
    for (const f of files) this.save(f);
  }
  delete(id: string): boolean {
    return this.files.delete(id);
  }
  deleteExpired(now: number): void {
    for (const [id, f] of this.files) if (f.expiresAt <= now) this.files.delete(id);
  }
  totalBytes(now: number): number {
    let total = 0;
    for (const f of this.files.values()) if (f.expiresAt > now) total += f.data.length;
    return total;
  }
  list(now: number): StagedFileInfo[] {
    // Newest first; files staged in the same millisecond (one upload of several files) newest-saved first.
    return [...this.files.values()]
      .reverse()
      .filter((f) => f.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ data, ...info }) => ({ ...info, size: data.length }));
  }
  saveLink(link: StoredLink): void {
    this.links.set(link.tokenHash, { ...link });
  }
  loadLinks(now: number): StoredLink[] {
    return [...this.links.values()].filter((l) => l.expiresAt > now).map((l) => ({ ...l }));
  }
  deleteExpiredLinks(now: number): void {
    for (const [h, l] of this.links) if (l.expiresAt <= now) this.links.delete(h);
  }
}

/**
 * Files in SQLite, encrypted: the name and type (meta_enc) and the bytes
 * (data_enc) each under AES-256-GCM with a key derived for this purpose only,
 * bound to the upload id and the field (associated data). The previous
 * TOKEN_ENCRYPTION_KEY still decrypts after a rotation; a file no configured
 * key opens is deleted and reads as missing.
 */
export class SqliteUploadVault implements UploadVault {
  private readonly keys: Buffer[];

  constructor(
    private readonly db: Db,
    masterKeys: (Buffer | undefined)[],
  ) {
    this.keys = masterKeys.filter((k): k is Buffer => k !== undefined).map((k) => deriveKey(k, 'staged files v1'));
    if (this.keys.length === 0) throw new Error('SqliteUploadVault needs an encryption key');
    db.exec(`CREATE TABLE IF NOT EXISTS staged_files (
      id TEXT PRIMARY KEY,
      meta_enc BLOB NOT NULL,
      data_enc BLOB NOT NULL,
      size INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
    // A link's optional file name is personal data like a file's: encrypted, bound to the link.
    db.exec(`CREATE TABLE IF NOT EXISTS upload_links (
      token_hash TEXT PRIMARY KEY,
      meta_enc BLOB,
      expires_at INTEGER NOT NULL
    )`);
    // Files no configured key can open (the key was rotated without TOKEN_ENCRYPTION_KEY_PREVIOUS) would read as
    // missing yet still count against the staging quota: drop them.
    const ids = new Set(this.keys.map(keyId));
    const rows = db.prepare('SELECT id, data_enc FROM staged_files').all() as { id: string; data_enc: Uint8Array }[];
    for (const row of rows) if (!ids.has(bytesKeyId(row.data_enc) ?? '')) this.delete(row.id);
  }

  load(id: string): StagedFile | undefined {
    const row = this.db.prepare('SELECT meta_enc, data_enc, created_at, expires_at FROM staged_files WHERE id = ?').get(id) as
      | { meta_enc: Uint8Array; data_enc: Uint8Array; created_at: number; expires_at: number }
      | undefined;
    if (!row) return undefined;
    try {
      const meta = this.readMeta(id, row.meta_enc);
      const data = decryptBytes(row.data_enc, this.keys, `staged:${id}:data`);
      return { id, ...meta, data, createdAt: Number(row.created_at), expiresAt: Number(row.expires_at) };
    } catch (err) {
      if (!(err instanceof DecryptError || err instanceof SyntaxError)) throw err;
      this.delete(id); // unreadable: it must not keep counting against the quota
      return undefined;
    }
  }

  save(file: StagedFile): void {
    const key = this.keys[0]!;
    const meta = encryptBytes(Buffer.from(JSON.stringify({ filename: file.filename, mimeType: file.mimeType, linkId: file.linkId }), 'utf8'), key, `staged:${file.id}:meta`);
    this.db
      .prepare(
        `INSERT INTO staged_files (id, meta_enc, data_enc, size, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET meta_enc = excluded.meta_enc, data_enc = excluded.data_enc, size = excluded.size, expires_at = excluded.expires_at`,
      )
      .run(file.id, meta, encryptBytes(file.data, key, `staged:${file.id}:data`), file.data.length, file.createdAt, file.expiresAt);
  }

  saveAll(files: StagedFile[]): void {
    this.db.exec('BEGIN');
    try {
      for (const f of files) this.save(f);
      this.db.exec('COMMIT');
    } catch (err) {
      // SQLite already rolled back on some errors (SQLITE_FULL); a second ROLLBACK would hide the real error.
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw err;
    }
  }

  delete(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM staged_files WHERE id = ?').run(id).changes) > 0;
  }

  deleteExpired(now: number): void {
    this.db.prepare('DELETE FROM staged_files WHERE expires_at <= ?').run(now);
  }

  totalBytes(now: number): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM staged_files WHERE expires_at > ?').get(now) as { total: number | bigint };
    return Number(row.total);
  }

  list(now: number): StagedFileInfo[] {
    const rows = this.db.prepare('SELECT id, meta_enc, size, created_at, expires_at FROM staged_files WHERE expires_at > ? ORDER BY created_at DESC, rowid DESC').all(now) as {
      id: string;
      meta_enc: Uint8Array;
      size: number;
      created_at: number;
      expires_at: number;
    }[];
    const out: StagedFileInfo[] = [];
    for (const row of rows) {
      try {
        out.push({ id: row.id, ...this.readMeta(row.id, row.meta_enc), size: Number(row.size), createdAt: Number(row.created_at), expiresAt: Number(row.expires_at) });
      } catch (err) {
        if (!(err instanceof DecryptError || err instanceof SyntaxError)) throw err;
      }
    }
    return out;
  }

  saveLink(link: StoredLink): void {
    const meta = link.filename === undefined ? null : encryptBytes(Buffer.from(JSON.stringify({ filename: link.filename }), 'utf8'), this.keys[0]!, `link:${link.tokenHash}:meta`);
    this.db
      .prepare(
        `INSERT INTO upload_links (token_hash, meta_enc, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(token_hash) DO UPDATE SET meta_enc = excluded.meta_enc, expires_at = excluded.expires_at`,
      )
      .run(link.tokenHash, meta, link.expiresAt);
  }

  loadLinks(now: number): StoredLink[] {
    const rows = this.db.prepare('SELECT token_hash, meta_enc, expires_at FROM upload_links WHERE expires_at > ?').all(now) as {
      token_hash: string;
      meta_enc: Uint8Array | null;
      expires_at: number;
    }[];
    return rows.map((row) => {
      let filename: string | undefined;
      if (row.meta_enc) {
        try {
          filename = (JSON.parse(decryptBytes(row.meta_enc, this.keys, `link:${row.token_hash}:meta`).toString('utf8')) as { filename?: string }).filename;
        } catch (err) {
          // The name is only a default for a lone unnamed file: the link still works without it.
          if (!(err instanceof DecryptError || err instanceof SyntaxError)) throw err;
        }
      }
      return { tokenHash: row.token_hash, expiresAt: Number(row.expires_at), filename };
    });
  }

  deleteExpiredLinks(now: number): void {
    this.db.prepare('DELETE FROM upload_links WHERE expires_at <= ?').run(now);
  }

  private readMeta(id: string, blob: Uint8Array): { filename?: string; mimeType?: string; linkId?: string } {
    const meta = JSON.parse(decryptBytes(blob, this.keys, `staged:${id}:meta`).toString('utf8')) as { filename?: string; mimeType?: string; linkId?: string };
    return { filename: meta.filename, mimeType: meta.mimeType, linkId: meta.linkId };
  }
}

export class UploadStore {
  readonly limits: UploadLimits;
  private readonly links = new Map<string, PendingLink>();
  private nextReservation = 1;

  constructor(
    limits: Partial<UploadLimits> = {},
    private readonly now: () => number = Date.now,
    private readonly vault: UploadVault = new MemoryUploadVault(),
  ) {
    this.limits = { ...DEFAULT_UPLOAD_LIMITS, ...limits };
    // Links opened before a restart keep working, with the files that already came through them.
    const at = this.now();
    const stored = vault.loadLinks(at);
    const files = stored.length ? vault.list(at) : [];
    for (const l of stored) {
      const linkId = linkIdOfHash(l.tokenHash);
      const received = files.filter((f) => f.linkId === linkId).reverse();
      this.links.set(l.tokenHash, { expiresAt: l.expiresAt, filename: l.filename, received });
    }
  }

  /** A link token that takes uploads for 30 minutes; `filename` names a lone file uploaded without a name. */
  createLink(filename?: string): UploadLink {
    this.sweep();
    if (this.links.size >= this.limits.maxLinks) throw new UploadError('Too many upload links are open; use or let some expire first (they last 30 minutes).');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.limits.linkTtlMs;
    this.vault.saveLink({ tokenHash: hash(token), expiresAt, filename });
    this.links.set(hash(token), { expiresAt, filename, received: [] });
    return { token, expiresAt, linkId: linkIdOf(token) };
  }

  /** Whether a link token can still receive files (without using it up). */
  hasLink(token: string): boolean {
    return this.linkState(token) === 'open';
  }

  /** open: can take (more) files until it expires; gone: unknown or expired. */
  linkState(token: string): LinkState {
    const link = this.links.get(hash(token));
    return link && link.expiresAt > this.now() ? 'open' : 'gone';
  }

  /** The files that came through a link so far, while it is open. */
  receivedThrough(token: string): StagedFileInfo[] {
    return this.linkState(token) === 'open' ? (this.links.get(hash(token))?.received ?? []) : [];
  }

  /**
   * Claims an open link for one upload that is about to send its body. The newest claim wins: an
   * earlier upload still in progress on the same link is aborted. Returns the claim to pass to
   * consumeLinkFiles and releaseLink, or the link's state when it cannot receive files.
   */
  reserveLink(token: string, abort: () => void): number | 'gone' {
    if (this.linkState(token) !== 'open') return 'gone';
    const link = this.links.get(hash(token))!;
    const previous = link.reservation;
    const id = this.nextReservation++;
    link.reservation = { id, abort };
    previous?.abort();
    return id;
  }

  /** Gives the link back when an upload ends without its files being taken (the person went away). */
  releaseLink(token: string, reservation: number): void {
    const link = this.links.get(hash(token));
    if (link?.reservation?.id === reservation) link.reservation = undefined;
  }

  /** Stores the file posted to a link and uses the link up. Undefined when the token is unknown or expired. */
  consumeLink(token: string, data: Buffer, meta: { filename?: string; mimeType?: string }): StagedFile | undefined {
    return this.consumeLinkFiles(token, [{ data, ...meta }])?.[0];
  }

  /**
   * Stores the files of one upload through a link (a browser can send several at once; a link
   * takes several uploads until it expires). All or nothing: the count, sizes and room are checked
   * first and the files are saved in one transaction. Undefined when the link cannot take them
   * (unknown, expired, or claimed by a newer upload than `reservation`). The link's own filename
   * only names a lone file that has none.
   */
  consumeLinkFiles(token: string, files: IncomingFile[], reservation?: number): StagedFile[] | undefined {
    const link = this.links.get(hash(token));
    if (!link) return undefined;
    if (reservation !== undefined ? link.reservation?.id !== reservation : link.expiresAt <= this.now() || link.reservation) return undefined;
    if (link.received.length + files.length > this.limits.maxFilesPerLink) {
      throw new UploadError(`One link takes at most ${this.limits.maxFilesPerLink} files${link.received.length ? ` (${link.received.length} already came through it)` : ''}.`);
    }
    for (const f of files) if (f.data.length > this.limits.maxFileBytes) throw new UploadError(`${f.filename ?? 'A file'} is larger than ${this.limits.maxFileBytes / MiB} MB.`);
    this.sweep();
    this.ensureRoom(files.reduce((sum, f) => sum + f.data.length, 0), files.length);
    const now = this.now();
    const linkId = linkIdOf(token);
    const staged: StagedFile[] = files.map((f) => ({
      id: `up_${randomBytes(16).toString('base64url')}`,
      filename: f.filename ?? (files.length === 1 ? link.filename : undefined),
      mimeType: f.mimeType,
      linkId,
      data: f.data,
      createdAt: now,
      expiresAt: now + this.limits.fileTtlMs,
    }));
    this.vault.saveAll(staged);
    link.reservation = undefined;
    link.received.push(...staged.map(({ data, ...info }) => ({ ...info, size: data.length })));
    // An upload that finished just after the link expired still gets to show its confirmation page.
    const expiresAt = Math.max(link.expiresAt, now + 2 * 60 * 1000);
    if (expiresAt !== link.expiresAt) this.vault.saveLink({ tokenHash: hash(token), expiresAt, filename: link.filename });
    link.expiresAt = expiresAt;
    return staged;
  }

  /** Staged files, newest first, without their bytes; only those from one link when linkId is given. */
  list(linkId?: string): StagedFileInfo[] {
    this.sweep();
    const all = this.vault.list(this.now());
    return linkId ? all.filter((f) => f.linkId === linkId) : all;
  }

  /** Stages a complete file. */
  put(data: Buffer, meta: { filename?: string; mimeType?: string; linkId?: string } = {}): StagedFile {
    this.sweep();
    if (data.length > this.limits.maxFileBytes) throw new UploadError(`The file is larger than ${this.limits.maxFileBytes / MiB} MB.`);
    this.ensureRoom(data.length, 1);
    const now = this.now();
    const file: StagedFile = {
      id: `up_${randomBytes(16).toString('base64url')}`,
      filename: meta.filename,
      mimeType: meta.mimeType,
      linkId: meta.linkId,
      data,
      createdAt: now,
      expiresAt: now + this.limits.fileTtlMs,
    };
    this.vault.save(file);
    return file;
  }

  /** Appends a chunk to a staged file; `offset` must equal its current size, so a repeated or skipped chunk is refused instead of corrupting the file. */
  append(id: string, offset: number, chunk: Buffer): StagedFile {
    const file = this.get(id);
    if (!file) throw new UploadError(`No staged file "${id}" (it may have expired; files are kept for 24 hours after their last change).`);
    if (offset !== file.data.length) {
      throw new UploadError(`offset ${offset} does not match the ${file.data.length} bytes already staged in ${id}: send the chunk that starts at byte ${file.data.length}.`);
    }
    if (file.data.length + chunk.length > this.limits.maxFileBytes) throw new UploadError(`The file would be larger than ${this.limits.maxFileBytes / MiB} MB.`);
    this.ensureRoom(chunk.length, 0);
    file.data = Buffer.concat([file.data, chunk]);
    file.expiresAt = this.now() + this.limits.fileTtlMs;
    this.vault.save(file);
    return file;
  }

  /** Records a changed name or type of a staged file. */
  update(file: StagedFile): void {
    this.vault.save(file);
  }

  get(id: string): StagedFile | undefined {
    this.sweep();
    const file = this.vault.load(id.trim());
    return file && file.expiresAt > this.now() ? file : undefined;
  }

  delete(id: string): boolean {
    return this.vault.delete(id);
  }

  /** Bytes currently staged. */
  totalBytes(): number {
    return this.vault.totalBytes(this.now());
  }

  /** Bytes still free in the staging area. */
  spaceLeft(): number {
    return Math.max(0, this.limits.maxTotalBytes - this.totalBytes());
  }

  /** Drops expired files and links (a link with an upload in progress stays). Called on every access, so no timer is needed. */
  sweep(): void {
    const now = this.now();
    this.vault.deleteExpired(now);
    this.vault.deleteExpiredLinks(now);
    for (const [key, l] of this.links) if (l.expiresAt <= now && !l.reservation) this.links.delete(key);
  }

  private ensureRoom(extraBytes: number, extraFiles: number): void {
    if (this.totalBytes() + extraBytes > this.limits.maxTotalBytes) {
      throw new UploadError(
        `The staging area would be over its ${this.limits.maxTotalBytes / MiB} MB (${Math.round(this.spaceLeft() / MiB)} MB left). Claude can free space with delete_uploads; files also expire 24 hours after their last change.`,
      );
    }
    if (extraFiles > 0 && this.vault.list(this.now()).length + extraFiles > this.limits.maxFiles) {
      throw new UploadError(`Too many files are staged (at most ${this.limits.maxFiles}). Claude can free some with delete_uploads.`);
    }
  }
}
