/**
 * Express application: OAuth authorization server, the MCP endpoint (bearer
 * protected, stateless; serves the 2026-07-28 protocol and the 2025 revisions)
 * and the browser pages.
 */
import type { MediaTextCache } from './media/media-text.js';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { createOAuthMetadata, getOAuthProtectedResourceMetadataUrl, mcpAuthMetadataRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import type { Config } from './config.js';
import type { AuthStore } from './auth/store.js';
import type { ClientRegistry } from './auth/clients.js';
import type { ConnectorOAuthProvider } from './auth/provider.js';
import type { Logger } from './log.js';
import { errorSummary } from './log.js';
import { createMcpServer } from './mcp/server.js';
import type { ToolContext, ToolDefinition } from './mcp/registry.js';
import { UploadStore } from './uploads.js';
import type { MessageStore } from './whatsapp/store.js';
import type { WhatsAppPort } from './whatsapp/client.js';
import { createWebRouter, type LinkControl } from './web/routes.js';
import { setSourceLink } from './web/html.js';
import { uploadRouter } from './web/upload.js';

export interface AppDeps {
  config: Config;
  log: Logger;
  store: AuthStore;
  clients: ClientRegistry;
  provider: ConnectorOAuthProvider;
  tools: ToolDefinition[];
  messages: MessageStore;
  /** The WhatsApp connection: what tools use, and what the admin page drives. */
  wa: WhatsAppPort & LinkControl;
  /** Files staged for sending; created here when not given. */
  uploads?: UploadStore;
  fetchImpl?: typeof fetch;
  mediaText?: MediaTextCache;
}

export function createApp(d: AppDeps): Express {
  const { config, log } = d;
  setSourceLink(config.sourceUrl);
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use(securityHeaders(config));
  app.use(requestLogger(log));

  app.get('/healthz', (_req, res) => {
    res.type('text/plain').send('ok');
  });

  // ---- OAuth 2.1 authorization server (Claude → this server) ----
  const metadata = {
    ...createOAuthMetadata({ provider: d.provider, issuerUrl: config.baseUrl }),
    // Required by claude.ai to pick CIMD over dynamic client registration.
    client_id_metadata_document_supported: true,
  };
  app.use('/authorize', authorizationHandler({ provider: d.provider }));
  app.use('/token', tokenHandler({ provider: d.provider }));
  if (config.dcrEnabled) app.use('/register', clientRegistrationHandler({ clientsStore: d.clients }));
  app.use('/revoke', revocationHandler({ provider: d.provider }));
  app.use(mcpAuthMetadataRouter({ oauthMetadata: metadata, resourceServerUrl: config.mcpUrl, resourceName: config.serverName }));

  // ---- MCP endpoint ----
  const uploads = d.uploads ?? new UploadStore();
  const ctx: ToolContext = { config, log, uploads, store: d.messages, wa: d.wa, ...(d.fetchImpl ? { fetchImpl: d.fetchImpl } : {}), ...(d.mediaText ? { mediaText: d.mediaText } : {}) };
  const mcp = express.Router();
  mcp.use(rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }));
  if (config.anthropicIpLock) mcp.use(ipAllowlist(config.anthropicIpRanges, log));
  mcp.use(requireBearerAuth({ verifier: d.provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.mcpUrl) }));
  // Stateless server: no standalone SSE stream and no sessions, so only POST is meaningful.
  mcp.all('/', (req, res, next) => {
    if (req.method === 'POST') return next();
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  });
  mcp.use(express.json({ limit: '8mb' }));
  mcp.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    const type = (err as { type?: string })?.type;
    if (type === 'entity.parse.failed' || type === 'entity.too.large') {
      log.warn('mcp request refused', { reason: type, bytes: Number(req.headers['content-length'] ?? 0), protocol: protocolHeader(req) });
    }
    if (type === 'entity.parse.failed') return res.status(400).json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
    if (type === 'entity.too.large') return res.status(413).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Request body too large' }, id: null });
    next(err);
  });
  // One handler for both protocol eras: 2026-07-28 requests (server/discover, per-request _meta envelope)
  // on the modern path, 2025-era traffic (initialize, then requests) through the stateless legacy fallback.
  // Every request gets a fresh server from the factory.
  const handler = createMcpHandler(() => createMcpServer(ctx, d.tools), {
    // Default response mode: plain JSON, since no tool sends notifications before its result.
    legacy: 'stateless',
    onerror: (err) => log.warn('mcp request refused', { error: err.message.slice(0, 300) }),
  });
  mcp.all('/', async (req, res) => {
    // What the client asked for, never what it sent: method names and protocol version only.
    const exchange = { rpc: rpcSummary(req.body), protocol: protocolHeader(req) };
    res.on('finish', () => {
      if (res.statusCode >= 400) log.warn('mcp request failed', { ...exchange, status: res.statusCode });
      else log.debug('mcp request', { ...exchange, status: res.statusCode });
    });
    try {
      await serveWeb(handler, req, res);
    } catch (err) {
      log.error('mcp request failed', { error: errorSummary(err) });
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      else res.end();
    }
  });
  app.use(config.mcpPath, mcp);

  // ---- Upload links: files to send on WhatsApp, from the phone, Claude's sandbox or G-Spot Assistant (capability URLs) ----
  app.use('/upload', uploadRouter(uploads, log));

  // ---- Browser pages ----
  app.use(createWebRouter({ config, store: d.store, clients: d.clients, provider: d.provider, log, wa: d.wa, messages: d.messages }));

  app.use((_req, res) => {
    res.status(404).type('text/plain').send('Not found');
  });
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const status = typeof (err as { status?: number })?.status === 'number' ? (err as { status: number }).status : 500;
    if (status >= 500) log.error('unhandled error', { error: errorSummary(err) });
    res.status(status).type('text/plain').send(status >= 500 ? 'Internal server error' : errorSummary(err));
  });
  return app;
}

function securityHeaders(config: Config) {
  const secure = config.baseUrl.protocol === 'https:';
  return (_req: Request, res: Response, next: NextFunction) => {
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // 'same-origin', not 'no-referrer': under no-referrer browsers send `Origin: null` on every form POST,
    // which would make the CSRF check below refuse the owner's own buttons. Cross-site requests still get no Referer.
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'");
    next();
  };
}

/**
 * Serves one Express request through the web-standard MCP handler: the body
 * express.json() already parsed goes in as parsedBody, the bearer token's
 * AuthInfo as authInfo, and the Response (JSON or an SSE stream) is written
 * back with backpressure. The request is aborted when the client goes away.
 */
async function serveWeb(handler: McpHttpHandler, req: Request, res: Response): Promise<void> {
  const abort = new AbortController();
  let finished = false;
  res.on('close', () => {
    if (!finished) abort.abort();
  });
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith(':')) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, value);
  }
  const parsed = req.method === 'POST' && req.body !== undefined;
  let body: string | undefined;
  if (parsed) {
    body = JSON.stringify(req.body);
    headers.delete('content-encoding');
    headers.delete('transfer-encoding');
    headers.set('content-length', String(Buffer.byteLength(body)));
  }
  const request = new globalThis.Request(new URL(req.originalUrl, 'http://mcp.internal'), { method: req.method, headers, body, signal: abort.signal });
  const response = await handler.fetch(request, { ...(req.auth ? { authInfo: req.auth } : {}), ...(parsed ? { parsedBody: req.body } : {}) });
  res.status(response.status);
  response.headers.forEach((value, name) => res.setHeader(name, value));
  if (!response.body) {
    finished = true;
    res.end();
    return;
  }
  // Waits for the socket to drain or the client to go away, leaving no listener behind either way.
  const writable = () =>
    new Promise<void>((resolve) => {
      const done = () => {
        res.off('drain', done);
        abort.signal.removeEventListener('abort', done);
        resolve();
      };
      res.on('drain', done);
      abort.signal.addEventListener('abort', done);
    });
  try {
    for await (const chunk of response.body) {
      if (abort.signal.aborted) break;
      if (!res.write(chunk)) await writable();
    }
  } catch {
    // The client went away mid-stream; nothing left to send.
  }
  finished = true;
  res.end();
}

/** The MCP-Protocol-Version header as sent (short), or null. */
function protocolHeader(req: Request): string | null {
  const h = req.headers['mcp-protocol-version'];
  const v = Array.isArray(h) ? h.join(',') : h;
  return v ? v.slice(0, 40) : null;
}

/** JSON-RPC method names (and the tool name of a tools/call) of a request body, for logs. */
export function rpcSummary(body: unknown): string {
  const messages = Array.isArray(body) ? body : [body];
  return messages
    .slice(0, 5)
    .map((m) => {
      const msg = m as { method?: unknown; params?: { name?: unknown }; result?: unknown; error?: unknown };
      if (typeof msg?.method !== 'string') return msg && ('result' in msg || 'error' in msg) ? 'response' : 'invalid';
      const tool = msg.method === 'tools/call' && typeof msg.params?.name === 'string' ? `:${msg.params.name.slice(0, 60)}` : '';
      return `${msg.method.slice(0, 60)}${tool}`;
    })
    .join(',');
}

/**
 * Path as it should appear in logs: no query string, secrets carried in path segments replaced.
 * Express routes case-insensitively, tolerates repeated slashes and accepts absolute-form request
 * targets, so the path is taken from the target, decoded, and matched the same loose way.
 */
export function loggablePath(originalUrl: string): string {
  let path = originalUrl.split(/[?#]/)[0] ?? originalUrl;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      path = '/';
    }
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep it encoded
  }
  // Dot segments too ("/./upload/…", "/x/../upload/…"), resolved the way a URL parser would.
  const segments: string[] = [];
  for (const segment of path.replace(/\/{2,}/g, '/').split('/')) {
    if (segment === '..') segments.pop();
    else if (segment !== '.') segments.push(segment);
  }
  path = segments.join('/') || '/';
  if (!path.startsWith('/')) path = `/${path}`;
  return path.replace(/^\/+link\/+[^/]+/i, '/link/:token').replace(/^\/+upload\/+[^/]+/i, '/upload/:token').slice(0, 200);
}

function requestLogger(log: Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/healthz') return next();
    const started = Date.now();
    res.on('finish', () => {
      log.info('http', { method: req.method, path: loggablePath(req.originalUrl), status: res.statusCode, ms: Date.now() - started });
    });
    next();
  };
}

/** Optional lock: only Anthropic's egress range may reach the MCP endpoint. */
export function ipAllowlist(ranges: string[], log: Logger) {
  const parsed = ranges.map(parseCidr).filter((c): c is Cidr => c !== undefined);
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = normalizeIp(req.ip ?? '');
    if (ip !== undefined && parsed.some((c) => ipInCidr(ip, c))) return next();
    log.warn('mcp request refused by ip allowlist', { ip: req.ip ?? null });
    res.status(403).json({ error: 'forbidden' });
  };
}

interface Cidr {
  base: number;
  mask: number;
}

export function parseCidr(cidr: string): Cidr | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!m) return undefined;
  const octets = m.slice(1, 5).map(Number);
  const bits = Number(m[5]);
  if (octets.some((o) => o > 255) || bits > 32) return undefined;
  const base = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

function normalizeIp(ip: string): number | undefined {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
  if (!m) return undefined;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return undefined;
  return ((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0;
}

export function ipInCidr(ip: number, c: Cidr): boolean {
  return ((ip & c.mask) >>> 0) === c.base;
}
