/**
 * The WhatsApp session (the linked-device credentials and Signal keys) kept in
 * SQLite, every value encrypted with a key derived from TOKEN_ENCRYPTION_KEY.
 * Whoever holds these values can read and send as the linked WhatsApp account,
 * so they never touch the disk in clear (Baileys' own multi-file store would).
 */
import { BufferJSON, initAuthCreds, proto, type AuthenticationCreds, type AuthenticationState, type SignalDataTypeMap } from 'baileys';
import type { Db } from '../db.js';
import { decrypt, deriveKey, encrypt } from '../crypto.js';

const CREDS = 'creds';

export function isPaired(creds: Pick<AuthenticationCreds, 'account' | 'registered'> | undefined): boolean {
  return Boolean(creds?.account || creds?.registered);
}

/**
 * Credentials left by a pairing that never finished (a code was requested, the phone never confirmed)
 * name an account (`me`) the device is not linked to. Baileys then logs in instead of registering, and
 * WhatsApp closes the connection at once, again and again. Such credentials go back to unlinked.
 */
export function withoutUnfinishedPairing(creds: AuthenticationCreds): boolean {
  if (isPaired(creds) || (!creds.me && !creds.pairingCode)) return false;
  creds.me = undefined;
  creds.pairingCode = undefined;
  return true;
}

export class SqliteAuthState {
  private readonly key: Buffer;
  private readonly keys: Buffer[];

  constructor(
    private readonly db: Db,
    masterKeys: (Buffer | undefined)[],
  ) {
    const present = masterKeys.filter((k): k is Buffer => Boolean(k));
    this.keys = present.map((k) => deriveKey(k, 'whatsapp-auth'));
    this.key = this.keys[0]!;
    db.exec(`CREATE TABLE IF NOT EXISTS wa_auth (
      type TEXT NOT NULL,
      id TEXT NOT NULL,
      value_enc TEXT NOT NULL,
      PRIMARY KEY (type, id)
    )`);
  }

  private read(type: string, id: string): unknown {
    const row = this.db.prepare('SELECT value_enc FROM wa_auth WHERE type = ? AND id = ?').get(type, id) as { value_enc: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(decrypt(row.value_enc, this.keys), BufferJSON.reviver);
  }

  private write(type: string, id: string, value: unknown): void {
    this.db.prepare('INSERT INTO wa_auth (type, id, value_enc) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET value_enc = excluded.value_enc').run(type, id, encrypt(JSON.stringify(value, BufferJSON.replacer), this.key));
  }

  private remove(type: string, id: string): void {
    this.db.prepare('DELETE FROM wa_auth WHERE type = ? AND id = ?').run(type, id);
  }

  /**
   * Whether a linked session is stored: the phone approved this server as a device (pair-success
   * writes `account`). A pairing code request already writes `me`, so `me` alone proves nothing.
   */
  isRegistered(): boolean {
    return isPaired(this.read(CREDS, '') as AuthenticationCreds | undefined);
  }

  /** Forgets the session: the server is no longer a linked device and must be linked again. */
  clear(): void {
    this.db.exec('DELETE FROM wa_auth');
  }

  /** Re-encrypts every value with the current key (after a key rotation). Returns how many were rewritten. */
  reencrypt(): number {
    const rows = this.db.prepare('SELECT type, id, value_enc FROM wa_auth').all() as { type: string; id: string; value_enc: string }[];
    for (const r of rows) this.db.prepare('UPDATE wa_auth SET value_enc = ? WHERE type = ? AND id = ?').run(encrypt(decrypt(r.value_enc, this.keys), this.key), r.type, r.id);
    return rows.length;
  }

  /** The state Baileys reads and writes, and saveCreds to call on every creds.update. */
  load(): { state: AuthenticationState; saveCreds: () => void } {
    const creds = (this.read(CREDS, '') as AuthenticationCreds | undefined) ?? initAuthCreds();
    const state: AuthenticationState = {
      creds,
      keys: {
        get: <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const out: { [id: string]: SignalDataTypeMap[T] } = {};
          for (const id of ids) {
            let value = this.read(type, id);
            if (value === undefined) continue;
            if (type === 'app-state-sync-key') value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
            out[id] = value as SignalDataTypeMap[T];
          }
          return out;
        },
        set: (data) => {
          this.db.exec('BEGIN');
          try {
            for (const [type, values] of Object.entries(data)) {
              for (const [id, value] of Object.entries(values ?? {})) {
                if (value === null || value === undefined) this.remove(type, id);
                else this.write(type, id, value);
              }
            }
            this.db.exec('COMMIT');
          } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
          }
        },
        clear: () => {
          this.db.prepare('DELETE FROM wa_auth WHERE type != ?').run(CREDS);
        },
      },
    };
    return { state, saveCreds: () => this.write(CREDS, '', state.creds) };
  }
}
