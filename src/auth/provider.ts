/**
 * OAuthServerProvider for the MCP SDK: the authorization server Claude talks to.
 *
 * Flow: Claude → /authorize (SDK validates client + redirect_uri + PKCE params)
 *       → provider.authorize() stores the request and sends the browser to /consent
 *       → owner signs in with Google (allow-listed email) and approves
 *       → provider.approve() issues a one-time code and redirects to Claude
 *       → Claude → /token (SDK verifies PKCE) → exchangeAuthorizationCode()
 *       → later /token refresh_token → exchangeRefreshToken() with rotation.
 */
import type { Response } from 'express';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthStore } from './store.js';
import type { ClientRegistry } from './clients.js';
import { now } from '../db.js';
import type { Logger } from '../log.js';

export interface ProviderOptions {
  mcpUrl: URL;
  consentPath: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
}

export class ConnectorOAuthProvider implements OAuthServerProvider {
  readonly skipLocalPkceValidation = false;

  constructor(
    private readonly store: AuthStore,
    private readonly clients: ClientRegistry,
    private readonly opts: ProviderOptions,
    private readonly log: Logger,
  ) {}

  get clientsStore(): ClientRegistry {
    return this.clients;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.checkResource(params.resource);
    const id = this.store.createAuthorizationRequest({
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scope: (params.scopes ?? []).join(' '),
      resource: params.resource?.href,
    });
    res.redirect(302, `${this.opts.consentPath}?req=${encodeURIComponent(id)}`);
  }

  /** Owner approved the pending request: mint a code and build the redirect back to the client. */
  approve(requestId: string, subjectEmail: string): string | undefined {
    const req = this.store.getAuthorizationRequest(requestId);
    if (!req) return undefined;
    this.store.deleteAuthorizationRequest(requestId);
    const code = this.store.issueCode({
      clientId: req.clientId,
      redirectUri: req.redirectUri,
      codeChallenge: req.codeChallenge,
      scope: req.scope,
      resource: req.resource,
      subjectEmail,
    });
    const url = new URL(req.redirectUri);
    url.searchParams.set('code', code);
    if (req.state) url.searchParams.set('state', req.state);
    this.log.info('authorization approved', { client_id: req.clientId });
    return url.href;
  }

  deny(requestId: string): string | undefined {
    const req = this.store.getAuthorizationRequest(requestId);
    if (!req) return undefined;
    this.store.deleteAuthorizationRequest(requestId);
    const url = new URL(req.redirectUri);
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('error_description', 'The owner denied the request');
    if (req.state) url.searchParams.set('state', req.state);
    return url.href;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const code = this.store.getCode(authorizationCode);
    if (!code || code.usedAt || code.expiresAt < now() || code.clientId !== client.client_id) {
      throw new InvalidGrantError('Authorization code is invalid, expired or already used');
    }
    return code.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const code = this.store.consumeCode(authorizationCode);
    if (!code || code.clientId !== client.client_id) throw new InvalidGrantError('Authorization code is invalid, expired or already used');
    if (redirectUri !== undefined && redirectUri !== code.redirectUri) throw new InvalidGrantError('redirect_uri does not match the authorization request');
    this.checkResource(resource);
    return this.issue(client.client_id, code.subjectEmail, code.scope, code.resource, undefined);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const t = this.store.getToken(refreshToken);
    if (!t || t.kind !== 'refresh' || t.clientId !== client.client_id) throw new InvalidGrantError('Refresh token is invalid');
    if (t.revokedAt) throw new InvalidGrantError('Refresh token has been revoked');
    if (t.rotatedAt) {
      // A rotated token being presented again means it leaked or the client is confused. Kill the whole family.
      this.store.revokeFamily(t.familyId);
      this.log.warn('refresh token reuse detected; family revoked', { client_id: client.client_id });
      throw new InvalidGrantError('Refresh token has already been used');
    }
    if (t.expiresAt < now()) throw new InvalidGrantError('Refresh token has expired');
    const granted = t.scope ? t.scope.split(' ') : [];
    if (scopes?.some((s) => !granted.includes(s))) throw new InvalidScopeError('Requested scope exceeds the original grant');
    this.checkResource(resource);
    if (!this.store.rotateRefreshToken(refreshToken)) throw new InvalidGrantError('Refresh token has already been used');
    return this.issue(client.client_id, t.subjectEmail, t.scope, t.resource, t.familyId);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const t = this.store.getToken(token);
    if (!t || t.kind !== 'access' || t.revokedAt) throw new InvalidTokenError('Invalid access token');
    if (t.expiresAt < now()) throw new InvalidTokenError('Access token has expired');
    return {
      token,
      clientId: t.clientId,
      scopes: t.scope ? t.scope.split(' ') : [],
      expiresAt: t.expiresAt,
      resource: this.opts.mcpUrl,
      extra: { email: t.subjectEmail },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const t = this.store.getToken(request.token);
    if (!t || t.clientId !== client.client_id) return;
    this.store.revokeFamily(t.familyId);
  }

  private issue(clientId: string, subjectEmail: string, scope: string, resource: string | undefined, familyId: string | undefined): OAuthTokens {
    const pair = this.store.issueTokenPair({
      clientId,
      subjectEmail,
      scope,
      resource,
      familyId,
      accessTtlSeconds: this.opts.accessTokenTtlSeconds,
      refreshTtlSeconds: this.opts.refreshTokenTtlSeconds,
    });
    const tokens: OAuthTokens = {
      access_token: pair.accessToken,
      token_type: 'Bearer',
      expires_in: this.opts.accessTokenTtlSeconds,
      refresh_token: pair.refreshToken,
    };
    if (scope) tokens.scope = scope;
    return tokens;
  }

  /** RFC 8707: if the client names a resource, it must be this MCP server. */
  private checkResource(resource: URL | undefined): void {
    if (!resource) return;
    if (stripHash(resource) !== stripHash(this.opts.mcpUrl)) {
      throw new InvalidTargetError(`This authorization server only issues tokens for ${this.opts.mcpUrl.href}`);
    }
  }
}

function stripHash(u: URL): string {
  const c = new URL(u.href);
  c.hash = '';
  return c.href.replace(/\/+$/, '');
}
