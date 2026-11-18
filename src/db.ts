/**
 * SQLite storage using Node's built-in node:sqlite (no native dependency).
 * One file on the data volume holds the WhatsApp session, the message index, OAuth state and sessions.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = DatabaseSync;

/** Prepared statements kept per database; the code has far fewer distinct SQL texts. */
export const MAX_CACHED_STATEMENTS = 256;
/** The write-ahead log is cut back to this size after a checkpoint, instead of keeping its largest size for good. */
const WAL_SIZE_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * Makes db.prepare hand out one statement per SQL text. A prepared statement holds native memory that
 * is only freed once the garbage collector gets to its wrapper; preparing anew on every call (several
 * times a minute, from the timers alone) kept tens of megabytes of it around, which the allocator then
 * never gave back. Statements are reused as they are: nothing in this code iterates one or changes its options.
 */
function reuseStatements(db: DatabaseSync): void {
  const prepare = db.prepare.bind(db);
  const statements = new Map<string, StatementSync>();
  const cached = (sql: string): StatementSync => {
    const hit = statements.get(sql);
    if (hit) {
      // Most recently used last, so the oldest is evicted first.
      statements.delete(sql);
      statements.set(sql, hit);
      return hit;
    }
    const statement = prepare(sql);
    statements.set(sql, statement);
    if (statements.size > MAX_CACHED_STATEMENTS) statements.delete(statements.keys().next().value!);
    return statement;
  };
  Object.defineProperty(db, 'prepare', { value: cached, configurable: true, writable: false });
}

/**
 * Space freed in the file (expired uploads can be 25 MB each) goes back to the system: incremental
 * auto-vacuum, set up once with a VACUUM on a file created before it existed.
 */
function returnFreePages(db: DatabaseSync): void {
  const mode = Number((db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum);
  if (mode === 2) return;
  db.exec('PRAGMA auto_vacuum = INCREMENTAL');
  db.exec('VACUUM');
  // In WAL mode the rewritten pages land in the log first: fold them in and empty it now, not at the first hourly upkeep.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS authorization_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  state TEXT,
  scope TEXT NOT NULL DEFAULT '',
  resource TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS authorization_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  resource TEXT,
  subject_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  client_id TEXT NOT NULL,
  family_id TEXT NOT NULL,
  subject_email TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  resource TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  rotated_at INTEGER
);
CREATE INDEX IF NOT EXISTS tokens_family ON tokens(family_id);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS link_requests (
  id_hash TEXT PRIMARY KEY,
  alias TEXT NOT NULL,
  services TEXT NOT NULL,
  label TEXT,
  expected_email TEXT,
  mode TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS google_states (
  state TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  reuseStatements(db);
  if (path !== ':memory:') returnFreePages(db);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES}`);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/** Folds the write-ahead log back into the main file (cheap; call periodically and before shutdown). */
export function checkpoint(db: Db, mode: 'PASSIVE' | 'TRUNCATE' = 'PASSIVE'): void {
  db.exec(`PRAGMA wal_checkpoint(${mode})`);
}

/**
 * Hourly upkeep of the file: hands the pages freed since (deleted uploads, closed follow-ups) back to the
 * system, then empties the write-ahead log, so neither the file nor its cached pages keep their largest size.
 */
export function compact(db: Db): void {
  db.exec('PRAGMA incremental_vacuum');
  checkpoint(db, 'TRUNCATE');
}

/** Sizes of the file, its free pages and its write-ahead log, in bytes. */
export function fileSizes(db: Db): { pages: number; freePages: number; pageSize: number } {
  const one = (pragma: string) => Number(Object.values(db.prepare(`PRAGMA ${pragma}`).get() as Record<string, number>)[0]);
  return { pages: one('page_count'), freePages: one('freelist_count'), pageSize: one('page_size') };
}

/** Unix time in seconds. */
export function now(): number {
  return Math.floor(Date.now() / 1000);
}

/** Delete expired rows from every short-lived table. Returns the number of rows removed. */
export function cleanupExpired(db: Db, at: number = now()): number {
  let removed = 0;
  const run = (sql: string) => {
    removed += Number(db.prepare(sql).run(at).changes);
  };
  run('DELETE FROM authorization_requests WHERE expires_at < ?');
  run('DELETE FROM authorization_codes WHERE expires_at < ?');
  run('DELETE FROM google_states WHERE expires_at < ?');
  run('DELETE FROM link_requests WHERE expires_at < ?');
  run('DELETE FROM sessions WHERE expires_at < ?');
  // Keep revoked/rotated tokens for a day so refresh-token reuse can still be detected, then drop them.
  run('DELETE FROM tokens WHERE expires_at < ? - 86400');
  return removed;
}
