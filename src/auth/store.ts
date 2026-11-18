/**
 * Persistence for the Claude → server OAuth layer and for browser sessions.
 *
 * Every secret handed to a browser or to Claude (codes, access/refresh tokens,
 * session ids, invite links) is random and stored only as a SHA-256 hash.
 */
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Db } from '../db.js';
import { now } from '../db.js';
import { randomToken, sha256Hex } from '../crypto.js';
import type { Service } from '../config.js';

export interface AuthorizationRequest {
  id: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | undefined;
  scope: string;
  resource: string | undefined;
  expiresAt: number;
}

export interface StoredCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string | undefined;
  subjectEmail: string;
  expiresAt: number;
  usedAt: number | null;
}

export type TokenKind = 'access' | 'refresh';

export interface TokenRow {
  tokenHash: string;
  kind: TokenKind;
  clientId: string;
  familyId: string;
  subjectEmail: string;
  scope: string;
  resource: string | undefined;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  rotatedAt: number | null;
}

export interface TokenFamilySummary {
  familyId: string;
  clientId: string;
  subjectEmail: string;
  createdAt: number;
  refreshExpiresAt: number;
}

export interface LinkRequest {
  alias: string;
  services: Service[];
  label: string | null;
  expectedEmail: string | null;
  mode: 'owner' | 'invite';
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
}

export type GoogleStatePurpose = 'login' | 'link';

export const AUTHORIZATION_REQUEST_TTL = 10 * 60;
export const AUTHORIZATION_CODE_TTL = 5 * 60;
export const GOOGLE_STATE_TTL = 15 * 60;
export const SESSION_TTL = 12 * 60 * 60;
export const INVITE_TTL = 7 * 24 * 60 * 60;

export class AuthStore {
  constructor(private readonly db: Db) {}

  // ---- OAuth clients (dynamic client registration) ----

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db.prepare('SELECT client_json FROM oauth_clients WHERE client_id = ?').get(clientId) as { client_json: string } | undefined;
    if (!row) return undefined;
    this.db.prepare('UPDATE oauth_clients SET last_used_at = ? WHERE client_id = ?').run(now(), clientId);
    return JSON.parse(row.client_json) as OAuthClientInformationFull;
  }

  putClient(client: OAuthClientInformationFull): void {
    this.db
      .prepare('INSERT OR REPLACE INTO oauth_clients (client_id, client_json, created_at, last_used_at) VALUES (?, ?, ?, NULL)')
      .run(client.client_id, JSON.stringify(client), now());
  }

  countClients(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get() as { n: number }).n);
  }

  /** Removes registered clients that are old and hold no live tokens. */
  pruneClients(maxAgeSeconds: number): number {
    const cutoff = now() - maxAgeSeconds;
    return Number(
      this.db
        .prepare(
          `DELETE FROM oauth_clients
           WHERE COALESCE(last_used_at, created_at) < ?
             AND client_id NOT IN (SELECT DISTINCT client_id FROM tokens WHERE revoked_at IS NULL AND expires_at > ?)`,
        )
        .run(cutoff, now()).changes,
    );
  }

  // ---- Pending authorization requests (between /authorize and consent) ----

  createAuthorizationRequest(input: Omit<AuthorizationRequest, 'id' | 'expiresAt'>): string {
    const id = randomToken(24);
    const t = now();
    this.db
      .prepare(
        `INSERT INTO authorization_requests (id, client_id, redirect_uri, code_challenge, state, scope, resource, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.clientId, input.redirectUri, input.codeChallenge, input.state ?? null, input.scope, input.resource ?? null, t, t + AUTHORIZATION_REQUEST_TTL);
    return id;
  }

  getAuthorizationRequest(id: string): AuthorizationRequest | undefined {
    const r = this.db.prepare('SELECT * FROM authorization_requests WHERE id = ? AND expires_at > ?').get(id, now()) as
      | {
          id: string;
          client_id: string;
          redirect_uri: string;
          code_challenge: string;
          state: string | null;
          scope: string;
          resource: string | null;
          expires_at: number;
        }
      | undefined;
    if (!r) return undefined;
    return {
      id: r.id,
      clientId: r.client_id,
      redirectUri: r.redirect_uri,
      codeChallenge: r.code_challenge,
      state: r.state ?? undefined,
      scope: r.scope,
      resource: r.resource ?? undefined,
      expiresAt: Number(r.expires_at),
    };
  }

  deleteAuthorizationRequest(id: string): void {
    this.db.prepare('DELETE FROM authorization_requests WHERE id = ?').run(id);
  }

  // ---- Authorization codes ----

  issueCode(input: Omit<StoredCode, 'expiresAt' | 'usedAt'>): string {
    const code = randomToken(32);
    const t = now();
    this.db
      .prepare(
        `INSERT INTO authorization_codes (code_hash, client_id, redirect_uri, code_challenge, scope, resource, subject_email, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sha256Hex(code), input.clientId, input.redirectUri, input.codeChallenge, input.scope, input.resource ?? null, input.subjectEmail, t, t + AUTHORIZATION_CODE_TTL);
    return code;
  }

  getCode(code: string): StoredCode | undefined {
    const r = this.db.prepare('SELECT * FROM authorization_codes WHERE code_hash = ?').get(sha256Hex(code)) as
      | {
          client_id: string;
          redirect_uri: string;
          code_challenge: string;
          scope: string;
          resource: string | null;
          subject_email: string;
          expires_at: number;
          used_at: number | null;
        }
      | undefined;
    if (!r) return undefined;
    return {
      clientId: r.client_id,
      redirectUri: r.redirect_uri,
      codeChallenge: r.code_challenge,
      scope: r.scope,
      resource: r.resource ?? undefined,
      subjectEmail: r.subject_email,
      expiresAt: Number(r.expires_at),
      usedAt: r.used_at === null ? null : Number(r.used_at),
    };
  }

  /** Marks a code used exactly once; returns undefined if it is missing, expired or already used. */
  consumeCode(code: string): StoredCode | undefined {
    const t = now();
    const changes = Number(
      this.db.prepare('UPDATE authorization_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?').run(t, sha256Hex(code), t).changes,
    );
    if (changes !== 1) return undefined;
    return this.getCode(code);
  }

  // ---- Access / refresh tokens ----

  issueTokenPair(input: {
    clientId: string;
    subjectEmail: string;
    scope: string;
    resource: string | undefined;
    familyId?: string;
    accessTtlSeconds: number;
    refreshTtlSeconds: number;
  }): { accessToken: string; refreshToken: string; familyId: string; accessExpiresAt: number; refreshExpiresAt: number } {
    const familyId = input.familyId ?? randomToken(16);
    const accessToken = 'gc_at_' + randomToken(32);
    const refreshToken = 'gc_rt_' + randomToken(32);
    const t = now();
    const insert = this.db.prepare(
      `INSERT INTO tokens (token_hash, kind, client_id, family_id, subject_email, scope, resource, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const accessExpiresAt = t + input.accessTtlSeconds;
    const refreshExpiresAt = t + input.refreshTtlSeconds;
    insert.run(sha256Hex(accessToken), 'access', input.clientId, familyId, input.subjectEmail, input.scope, input.resource ?? null, t, accessExpiresAt);
    insert.run(sha256Hex(refreshToken), 'refresh', input.clientId, familyId, input.subjectEmail, input.scope, input.resource ?? null, t, refreshExpiresAt);
    return { accessToken, refreshToken, familyId, accessExpiresAt, refreshExpiresAt };
  }

  getToken(token: string): TokenRow | undefined {
    const r = this.db.prepare('SELECT * FROM tokens WHERE token_hash = ?').get(sha256Hex(token)) as
      | {
          token_hash: string;
          kind: string;
          client_id: string;
          family_id: string;
          subject_email: string;
          scope: string;
          resource: string | null;
          created_at: number;
          expires_at: number;
          revoked_at: number | null;
          rotated_at: number | null;
        }
      | undefined;
    if (!r) return undefined;
    return {
      tokenHash: r.token_hash,
      kind: r.kind === 'refresh' ? 'refresh' : 'access',
      clientId: r.client_id,
      familyId: r.family_id,
      subjectEmail: r.subject_email,
      scope: r.scope,
      resource: r.resource ?? undefined,
      createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at),
      revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
      rotatedAt: r.rotated_at === null ? null : Number(r.rotated_at),
    };
  }

  /** Marks a refresh token as rotated (superseded). Returns false if it was already rotated or revoked. */
  rotateRefreshToken(token: string): boolean {
    const changes = Number(
      this.db.prepare('UPDATE tokens SET rotated_at = ? WHERE token_hash = ? AND rotated_at IS NULL AND revoked_at IS NULL').run(now(), sha256Hex(token)).changes,
    );
    return changes === 1;
  }

  /** Revokes every access and refresh token in a family (one Claude connection). */
  revokeFamily(familyId: string): void {
    this.db.prepare('UPDATE tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL').run(now(), familyId);
  }

  /** Revokes all tokens issued to every client. Claude will have to authorize again. */
  revokeAllTokens(): number {
    return Number(this.db.prepare('UPDATE tokens SET revoked_at = ? WHERE revoked_at IS NULL').run(now()).changes);
  }

  /** Live Claude connections, one row per token family. */
  listTokenFamilies(): TokenFamilySummary[] {
    const rows = this.db
      .prepare(
        `SELECT family_id, client_id, subject_email, MIN(created_at) AS created_at, MAX(expires_at) AS refresh_expires_at
         FROM tokens WHERE kind = 'refresh' AND revoked_at IS NULL AND rotated_at IS NULL AND expires_at > ?
         GROUP BY family_id ORDER BY created_at DESC`,
      )
      .all(now()) as unknown as { family_id: string; client_id: string; subject_email: string; created_at: number; refresh_expires_at: number }[];
    return rows.map((r) => ({
      familyId: r.family_id,
      clientId: r.client_id,
      subjectEmail: r.subject_email,
      createdAt: Number(r.created_at),
      refreshExpiresAt: Number(r.refresh_expires_at),
    }));
  }

  // ---- Browser sessions (owner sign-in) ----

  createSession(email: string): string {
    const id = randomToken(32);
    const t = now();
    this.db.prepare('INSERT INTO sessions (id_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256Hex(id), email, t, t + SESSION_TTL);
    return id;
  }

  getSession(id: string): { email: string; expiresAt: number } | undefined {
    const r = this.db.prepare('SELECT email, expires_at FROM sessions WHERE id_hash = ? AND revoked_at IS NULL AND expires_at > ?').get(sha256Hex(id), now()) as
      | { email: string; expires_at: number }
      | undefined;
    return r ? { email: r.email, expiresAt: Number(r.expires_at) } : undefined;
  }

  revokeSession(id: string): void {
    this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE id_hash = ?').run(now(), sha256Hex(id));
  }

  // ---- Account link requests (owner flow or invite link) ----

  createLinkRequest(input: Omit<LinkRequest, 'createdAt' | 'expiresAt' | 'usedAt'>, ttlSeconds: number): string {
    const token = randomToken(32);
    const t = now();
    this.db
      .prepare(
        `INSERT INTO link_requests (id_hash, alias, services, label, expected_email, mode, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(sha256Hex(token), input.alias, input.services.join(','), input.label, input.expectedEmail, input.mode, input.createdBy, t, t + ttlSeconds);
    return token;
  }

  getLinkRequest(token: string): LinkRequest | undefined {
    const r = this.db.prepare('SELECT * FROM link_requests WHERE id_hash = ? AND expires_at > ?').get(sha256Hex(token), now()) as
      | {
          alias: string;
          services: string;
          label: string | null;
          expected_email: string | null;
          mode: string;
          created_by: string;
          created_at: number;
          expires_at: number;
          used_at: number | null;
        }
      | undefined;
    if (!r) return undefined;
    return {
      alias: r.alias,
      services: r.services.split(',').filter(Boolean) as Service[],
      label: r.label,
      expectedEmail: r.expected_email,
      mode: r.mode === 'invite' ? 'invite' : 'owner',
      createdBy: r.created_by,
      createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at),
      usedAt: r.used_at === null ? null : Number(r.used_at),
    };
  }

  markLinkRequestUsed(token: string): void {
    this.db.prepare('UPDATE link_requests SET used_at = ? WHERE id_hash = ?').run(now(), sha256Hex(token));
  }

  deleteLinkRequest(token: string): void {
    this.db.prepare('DELETE FROM link_requests WHERE id_hash = ?').run(sha256Hex(token));
  }

  listPendingLinkRequests(): (Omit<LinkRequest, "usedAt"> & { usedAt: null })[] {
    const rows = this.db
      .prepare("SELECT * FROM link_requests WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC")
      .all(now()) as unknown as { alias: string; services: string; label: string | null; expected_email: string | null; mode: string; created_by: string; created_at: number; expires_at: number }[];
    return rows.map((r) => ({
      alias: r.alias,
      services: r.services.split(",").filter(Boolean) as Service[],
      label: r.label,
      expectedEmail: r.expected_email,
      mode: r.mode === "invite" ? ("invite" as const) : ("owner" as const),
      createdBy: r.created_by,
      createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at),
      usedAt: null,
    }));
  }

  deleteLinkRequestsForAlias(alias: string): number {
    return Number(this.db.prepare("DELETE FROM link_requests WHERE alias = ? AND used_at IS NULL").run(alias).changes);
  }

  // ---- Pending Google redirects (CSRF state for login and link flows) ----

  createGoogleState(purpose: GoogleStatePurpose, payload: Record<string, unknown>): string {
    const state = randomToken(24);
    const t = now();
    this.db
      .prepare('INSERT INTO google_states (state, purpose, payload_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(state, purpose, JSON.stringify(payload), t, t + GOOGLE_STATE_TTL);
    return state;
  }

  /** Returns and deletes the state in one step so it can only be used once. */
  consumeGoogleState(state: string): { purpose: GoogleStatePurpose; payload: Record<string, unknown> } | undefined {
    const r = this.db.prepare('SELECT purpose, payload_json FROM google_states WHERE state = ? AND expires_at > ?').get(state, now()) as
      | { purpose: string; payload_json: string }
      | undefined;
    if (!r) return undefined;
    this.db.prepare('DELETE FROM google_states WHERE state = ?').run(state);
    return { purpose: r.purpose as GoogleStatePurpose, payload: JSON.parse(r.payload_json) as Record<string, unknown> };
  }
}
