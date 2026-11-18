/**
 * OAuth client lookup for the Claude → server layer.
 *
 * Two kinds of client are accepted:
 *  - CIMD (Client ID Metadata Document): the client_id is an https URL on an
 *    allow-listed host (claude.ai by default). The document is fetched, validated
 *    and cached. This is what claude.ai and Claude Code use.
 *  - DCR (Dynamic Client Registration): a fallback where the client registers
 *    itself at /register. Rows are stored in SQLite and pruned when stale.
 *
 * In both cases every redirect URI must match the allow-list (the callbacks of
 * claude.ai and ChatGPT, and loopback URLs), so a code can never be sent anywhere else.
 */
import { OAuthClientInformationFullSchema, type OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthStore } from './store.js';
import type { Logger } from '../log.js';
import { errorSummary } from '../log.js';
import { randomToken } from '../crypto.js';
type FetchLike = typeof fetch;

export interface ClientRegistryOptions {
  allowedRedirectUris: string[];
  cimdAllowedHosts: string[];
  dcrEnabled: boolean;
  fetchImpl?: FetchLike;
  /** Cache lifetime for fetched metadata documents, in ms. */
  cimdCacheMs?: number;
}

const CIMD_MAX_BYTES = 64 * 1024;
const CIMD_TIMEOUT_MS = 5_000;

/**
 * Whether a redirect URI is on the allow-list. Loopback entries match any port; an entry ending in "/*"
 * matches any one last path segment made of unreserved characters (ChatGPT's per-connector callback).
 */
export function redirectUriAllowed(uri: string, allowed: readonly string[]): boolean {
  return allowed.some((a) => (a.endsWith('/*') ? lastSegmentMatches(uri, a.slice(0, -1)) : redirectUriMatches(uri, a)));
}

function lastSegmentMatches(uri: string, prefix: string): boolean {
  if (!uri.startsWith(prefix)) return false;
  const segment = uri.slice(prefix.length);
  return /^[A-Za-z0-9_~-][A-Za-z0-9._~-]{0,199}$/.test(segment);
}

export function isCimdClientId(clientId: string): boolean {
  return clientId.startsWith('https://');
}

interface CachedDoc {
  client: OAuthClientInformationFull;
  fetchedAt: number;
}

export class ClientRegistry implements OAuthRegisteredClientsStore {
  private readonly cache = new Map<string, CachedDoc>();
  private readonly fetchImpl: FetchLike;
  private readonly cacheMs: number;
  /** Present only when DCR is enabled; the SDK checks for the method's existence. */
  registerClient?: (client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) => OAuthClientInformationFull;

  constructor(
    private readonly store: AuthStore,
    private readonly opts: ClientRegistryOptions,
    private readonly log: Logger,
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.cacheMs = opts.cimdCacheMs ?? 60 * 60 * 1000;
    if (opts.dcrEnabled) this.registerClient = (client) => this.register(client);
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    if (isCimdClientId(clientId)) return this.getCimdClient(clientId);
    return this.store.getClient(clientId);
  }

  private register(input: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'> & { client_id?: string }): OAuthClientInformationFull {
    const bad = input.redirect_uris.find((u) => !redirectUriAllowed(u, this.opts.allowedRedirectUris));
    if (bad) throw new InvalidClientMetadataError(`redirect_uri is not allowed by this server: ${bad}`);
    const client: OAuthClientInformationFull = {
      ...input,
      client_id: input.client_id ?? randomToken(24),
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    this.store.putClient(client);
    this.log.info('registered oauth client via DCR', { client_id: client.client_id, client_name: client.client_name ?? null });
    return client;
  }

  private async getCimdClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      return undefined;
    }
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash) return undefined;
    if (!this.opts.cimdAllowedHosts.includes(url.hostname.toLowerCase())) {
      this.log.warn('refused CIMD client from non-allow-listed host', { host: url.hostname });
      return undefined;
    }
    const cached = this.cache.get(clientId);
    if (cached && Date.now() - cached.fetchedAt < this.cacheMs) return cached.client;
    try {
      const client = await this.fetchDocument(url);
      this.cache.set(clientId, { client, fetchedAt: Date.now() });
      return client;
    } catch (err) {
      this.log.warn('could not fetch or validate CIMD document', { client_id: clientId, error: errorSummary(err) });
      // A stale cached copy is better than breaking sign-in because claude.ai hiccupped.
      return cached?.client;
    }
  }

  private async fetchDocument(url: URL): Promise<OAuthClientInformationFull> {
    const res = await this.fetchImpl(url.href, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await readLimited(res, CIMD_MAX_BYTES);
    const parsed = OAuthClientInformationFullSchema.parse(JSON.parse(text));
    if (parsed.client_id !== url.href) throw new Error('client_id in document does not match its URL');
    if (parsed.client_secret) throw new Error('metadata document must describe a public client');
    if (parsed.token_endpoint_auth_method && parsed.token_endpoint_auth_method !== 'none') {
      throw new Error(`unsupported token_endpoint_auth_method ${parsed.token_endpoint_auth_method}`);
    }
    // Keep only the redirect URIs this server allows. Anything else in the document is ignored rather
    // than fatal, so an extra callback added by the client vendor later cannot break sign-in.
    const allowed = parsed.redirect_uris.filter((u) => redirectUriAllowed(u, this.opts.allowedRedirectUris));
    if (allowed.length === 0) throw new Error('document lists no allowed redirect_uris');
    if (allowed.length !== parsed.redirect_uris.length) {
      this.log.info('ignoring redirect_uris outside the allow-list in CIMD document', { client_id: url.href, ignored: parsed.redirect_uris.length - allowed.length });
    }
    return { ...parsed, redirect_uris: allowed, token_endpoint_auth_method: 'none' };
  }
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new Error('document too large');
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('document too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
