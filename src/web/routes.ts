/**
 * Browser routes: the landing page, owner sign-in (ADMIN_PASSWORD), the
 * consent screen for Claude, and the admin page where WhatsApp is linked
 * (pairing code or QR code) and unlinked, and Claude's access is reviewed.
 */
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Config } from '../config.js';
import type { AuthStore } from '../auth/store.js';
import type { ConnectorOAuthProvider } from '../auth/provider.js';
import type { ClientRegistry } from '../auth/clients.js';
import { attachSession, clearSessionCookie, requireSameOrigin, setSessionCookie } from '../auth/session.js';
import { constantTimeEqual, sha256Hex } from '../crypto.js';
import type { Logger } from '../log.js';
import type { LinkState } from '../whatsapp/client.js';
import type { MessageStore } from '../whatsapp/store.js';
import { phoneOf } from '../whatsapp/store.js';
import { esc, fmtTime, page } from './html.js';
import { memoryReport } from '../memory.js';

/** What the admin page drives on the WhatsApp connection. */
export interface LinkControl {
  status(): LinkState;
  beginLink(phone?: string): Promise<void>;
  cancelLink(): void;
  unlink(): Promise<void>;
  historySync: { chunks: number; messages: number; chats: number; lastAt: number; complete: boolean; progress?: number };
}

export interface WebDeps {
  config: Config;
  store: AuthStore;
  clients: ClientRegistry;
  provider: ConnectorOAuthProvider;
  log: Logger;
  wa: LinkControl;
  messages: MessageStore;
}

/** Who approved Claude: there is one owner, signed in with the admin password. */
export const OWNER = 'owner';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Only relative paths on this site may be used as a post-login destination. */
export function safeNext(v: unknown): string {
  const s = str(v);
  return /^\/(?!\/)[\w\-./?=&%+]*$/.test(s) && s.length < 512 ? s : '/admin';
}

export function passwordMatches(given: string, expected: string): boolean {
  // Hashing first keeps the comparison constant-time whatever the lengths.
  return constantTimeEqual(sha256Hex(given), sha256Hex(expected));
}

export function createWebRouter(d: WebDeps): Router {
  const r = Router();
  const secure = d.config.baseUrl.protocol === 'https:';
  const form = express.urlencoded({ extended: false, limit: '16kb' });
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
  // Password guesses: a handful per quarter hour from one address.
  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true });

  r.use(attachSession(d.store));
  r.use(requireSameOrigin(d.config.baseUrl.origin));
  r.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const fail = (res: Response, status: number, message: string, signedIn = false) =>
    res.status(status).send(page({ title: status >= 500 ? 'Something went wrong' : 'Cannot continue', body: `<div class="alert error">${esc(message)}</div><p><a href="/admin">Back to admin</a></p>`, ...(signedIn ? { signedInAs: OWNER } : {}) }));

  const requireOwner = (req: Request, res: Response, next: NextFunction) => {
    if (req.session) return next();
    if (req.method === 'GET') {
      res.redirect(302, `/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    fail(res, 403, 'Your session has expired. Sign in again.');
  };

  r.get('/', (req, res) => {
    res.send(
      page({
        title: d.config.serverName,
        body: `${storageBanner()}<p>Private WhatsApp connector for Claude. MCP endpoint: <code>${esc(d.config.mcpUrl.href)}</code></p><p><a class="btn" href="/admin">Open admin</a></p><p class="muted"><a href="/privacy">Privacy</a></p>`,
        ...(req.session ? { signedInAs: OWNER } : {}),
      }),
    );
  });

  r.get('/privacy', (_req, res) => {
    res.send(
      page({
        title: 'Privacy',
        body: `<p>This server belongs to one person and serves only them. It is linked to their WhatsApp account as a device, like WhatsApp Web, and keeps an index of the messages that device receives, encrypted, on the server's own disk. It talks to WhatsApp, to the AI assistant its owner connected, and to the owner's own other connectors when asked to move a file; to nothing else. Files are fetched from WhatsApp when asked for and not stored, except files staged for sending, kept encrypted for 24 hours at most. Unlinking WhatsApp from the admin page erases the session and the whole index.</p>`,
      }),
    );
  });

  // ---- Owner sign-in ----
  r.get('/admin/login', limiter, (req, res) => {
    if (req.session) return res.redirect(302, safeNext(req.query['next']));
    const next = safeNext(req.query['next']);
    res.send(
      page({
        title: 'Sign in',
        body: `<form class="card" method="post" action="/admin/login"><input type="hidden" name="next" value="${esc(next)}">
<label>Admin password<br><input type="password" name="password" autocomplete="current-password" required autofocus></label>
<div class="row"><button class="primary" type="submit">Sign in</button></div>
<p class="muted">The password is the <code>ADMIN_PASSWORD</code> variable in this server's settings (on Railway: the service, then Variables).</p></form>`,
      }),
    );
  });

  r.post('/admin/login', loginLimiter, form, (req, res) => {
    const next = safeNext(req.body?.next);
    if (!passwordMatches(str(req.body?.password), d.config.adminPassword)) {
      d.log.warn('owner sign-in refused: wrong password');
      res.status(401).send(page({ title: 'Sign in', body: `<div class="alert error">Wrong password.</div><p><a href="/admin/login?next=${encodeURIComponent(next)}">Try again</a></p>` }));
      return;
    }
    const id = d.store.createSession(OWNER);
    setSessionCookie(res, id, secure);
    d.log.info('owner signed in');
    res.redirect(302, next);
  });

  r.post('/admin/logout', (req, res) => {
    if (req.session) d.store.revokeSession(req.session.id);
    clearSessionCookie(res, secure);
    res.redirect(302, '/');
  });

  // ---- Admin ----
  r.get('/admin', limiter, requireOwner, (req, res) => {
    const s = d.wa.status();
    const linking = s.state === 'linking';
    res.send(
      page({
        title: 'WhatsApp connector',
        signedInAs: OWNER,
        ...(linking || s.state === 'connecting' ? { refreshSeconds: 4 } : {}),
        body: `${storageBanner()}${flash(str(req.query['done']))}${whatsappCard(s)}${claudeCard()}${bridgeCard()}${serverCard()}`,
      }),
    );
  });

  r.post('/admin/link', limiter, requireOwner, form, async (req, res) => {
    const method = str(req.body?.method);
    const phone = method === 'code' ? str(req.body?.phone) : undefined;
    try {
      await d.wa.beginLink(phone);
    } catch (err) {
      return fail(res, 400, err instanceof Error ? err.message : String(err), true);
    }
    res.redirect(303, '/admin');
  });

  r.post('/admin/link/cancel', limiter, requireOwner, (_req, res) => {
    d.wa.cancelLink();
    res.redirect(303, '/admin');
  });

  r.post('/admin/unlink', limiter, requireOwner, form, async (req, res) => {
    if (str(req.body?.confirm) !== 'yes') return fail(res, 400, 'Tick the box to confirm: unlinking erases the message index.', true);
    await d.wa.unlink();
    res.redirect(303, '/admin?done=unlinked');
  });

  r.post('/admin/revoke', limiter, requireOwner, form, (req, res) => {
    const family = str(req.body?.family);
    if (family) d.store.revokeFamily(family);
    res.redirect(303, '/admin?done=revoked');
  });

  // ---- Consent for Claude (OAuth) ----
  r.get('/consent', limiter, requireOwner, async (req, res) => {
    const id = str(req.query['req']);
    const ar = id ? d.store.getAuthorizationRequest(id) : undefined;
    if (!ar) return fail(res, 400, 'This authorization request has expired. Go back to Claude and connect again.', true);
    const client = await d.clients.getClient(ar.clientId);
    const redirect = new URL(ar.redirectUri);
    const loopback = LOOPBACK_HOSTS.has(redirect.hostname);
    res.send(
      page({
        title: 'Authorize Claude',
        signedInAs: OWNER,
        body: `<div class="card"><p><strong>${esc(client?.client_name ?? 'An OAuth client')}</strong> wants to read your WhatsApp chats and send messages and files as you, through ${esc(d.config.serverName)}.</p>
<p>After approval the browser is sent to <code>${esc(redirect.origin + redirect.pathname)}</code>.</p>
${loopback ? '<div class="alert warn">The redirect goes to a program on this computer (loopback address). Only approve if you just started this from Claude Code or another local MCP client.</div>' : ''}
<p class="muted">Client id: <code>${esc(ar.clientId)}</code></p>
<form method="post" action="/consent"><input type="hidden" name="req" value="${esc(ar.id)}">
<button class="primary" type="submit" name="decision" value="approve">Approve</button> <button type="submit" name="decision" value="deny">Deny</button></form></div>`,
      }),
    );
  });

  r.post('/consent', limiter, requireOwner, form, (req, res) => {
    const id = str(req.body?.req);
    const decision = str(req.body?.decision);
    const url = decision === 'approve' ? d.provider.approve(id, OWNER) : d.provider.deny(id);
    if (!url) return fail(res, 400, 'This authorization request has expired. Go back to Claude and connect again.', true);
    res.redirect(302, url);
  });

  // ---- page parts ----

  function flash(done: string): string {
    if (done === 'unlinked') return '<div class="alert">WhatsApp is unlinked and the index erased. On the phone, the device has disappeared from Linked devices.</div>';
    if (done === 'revoked') return '<div class="alert">Access revoked: that client must connect again.</div>';
    return '';
  }

  function whatsappCard(s: LinkState): string {
    const stats = d.messages.stats();
    const me = d.messages.me ? phoneOf(d.messages.me) : undefined;
    const linkForms = `<form method="post" action="/admin/link" class="card"><h2>Link with a QR code (recommended)</h2><input type="hidden" name="method" value="qr">
<p>Open this page on a computer (or another screen), then:</p>
<div class="row"><button class="primary" type="submit">Show a QR code</button></div>
<p class="muted">On the phone: WhatsApp → Settings → <strong>Linked devices</strong> → <strong>Link a device</strong>, and scan the code.</p></form>
<form method="post" action="/admin/link" class="card"><h2>Or link with a code (phone only)</h2>
<input type="hidden" name="method" value="code">
<div class="alert warn">WhatsApp currently refuses most pairing codes from linked-device apps ("Couldn't link device"). Use the QR code if you can.</div>
<label>Your WhatsApp number, with country code<br><input type="tel" name="phone" placeholder="+33 6 12 34 56 78" required></label>
<div class="row"><button type="submit">Get a pairing code</button></div>
<p class="muted">Then on the phone: WhatsApp → Settings → Linked devices → Link a device → <strong>Link with phone number instead</strong>, and type the code shown here.</p></form>`;
    switch (s.state) {
      case 'unlinked':
      case 'logged_out':
        return `<div class="card"><h2>WhatsApp <span class="badge warn">not linked</span></h2>
${s.state === 'logged_out' ? '<div class="alert warn">WhatsApp logged this connector out (removed from Linked devices on the phone, or inactive for too long). Link it again below; the index is kept.</div>' : ''}
<p>This connector joins your WhatsApp as a linked device, like WhatsApp Web. Your phone keeps working as usual. When linking, the phone sends recent history (usually the last months), which takes a few minutes; Claude can ask it for older messages of a chat later.</p>
<div class="alert warn">WhatsApp does not officially support third-party linked devices. Accounts used this way for normal personal use are rarely affected, but WhatsApp may log such a device out or, in rare cases, restrict the account. Use it for your own chats, not for bulk messaging.</div></div>${linkForms}`;
      case 'linking': {
        const code = s.pairingCode
          ? `<p>On the phone: WhatsApp → Settings → <strong>Linked devices</strong> → <strong>Link a device</strong> → <strong>Link with phone number instead</strong>, then type:</p><div class="code">${esc(s.pairingCode)}</div><p class="muted">Code for <strong>+${esc(s.phone ?? '')}</strong>: it only works on the phone with this WhatsApp number. Wrong number? Cancel and start again.</p>`
          : s.phone
            ? '<p>Asking WhatsApp for a pairing code…</p>'
            : '';
        const qr = !s.phone && s.qrSvg ? `<p>Scan with WhatsApp → Settings → Linked devices → Link a device:</p><div class="qr"><img alt="QR code" width="280" height="280" src="data:image/svg+xml;base64,${Buffer.from(s.qrSvg).toString('base64')}"></div>` : !s.phone ? '<p>Preparing a QR code…</p>' : '';
        return `<div class="card"><h2>Linking WhatsApp…</h2>${code}${qr}<p class="muted">This page refreshes by itself; once the phone confirms, it shows "connected". The codes stay valid for about five minutes.</p>
<div class="alert warn">After scanning, keep WhatsApp <strong>open on the phone</strong>, unlocked and online, until this page says the history is complete: usually 5 to 15 minutes, longer with many groups. The phone sends your chats in parts; closing WhatsApp too early leaves some out.</div>
<form method="post" action="/admin/link/cancel"><button type="submit">Cancel</button></form></div>`;
      }
      case 'connecting':
        return `<div class="card"><h2>WhatsApp <span class="badge warn">connecting</span></h2><p>Connecting to WhatsApp…</p></div>`;
      case 'reconnecting':
        return `<div class="card"><h2>WhatsApp <span class="badge warn">reconnecting</span></h2><p>The connection dropped (${esc(s.reason)}); trying again at ${esc(fmtTime(Math.floor(s.retryAt / 1000)))}. Claude can still read the index meanwhile.</p>${unlinkForm()}</div>`;
      case 'open': {
        const h = d.wa.historySync;
        const arriving = h.chunks > 0 && !h.complete;
        const history = h.chunks
          ? `<div>History from the phone: ${h.messages.toLocaleString('en')} messages, ${h.chats.toLocaleString('en')} chats, in ${h.chunks} parts${h.complete ? ' <span class="badge">complete</span>' : `, still arriving${typeof h.progress === 'number' ? ` (${h.progress}%)` : ''}`}.</div>` +
            (arriving ? '<div class="alert warn">Keep WhatsApp open on the phone, unlocked and online, until this says complete. This page refreshes by itself.</div>' : '')
          : '';
        const missing = d.messages.withoutHistory(15);
        const gaps = missing.groups
          ? `<details><summary>${missing.groups} group${missing.groups > 1 ? 's' : ''} without history yet${missing.direct ? ` (and ${missing.direct} direct chats)` : ''}</summary><p class="muted">The phone did not send their messages when WhatsApp was linked. Each one fills in by itself as soon as someone writes in it: the connector then asks the phone for the 50 messages before. To get one now, send any message in it from the phone.</p><ul>${missing.chats
              .filter((c) => c.kind === 'group')
              .map((c) => `<li>${esc(c.name)}</li>`)
              .join('')}</ul></details>`
          : '';
        return `<div class="card"><h2>WhatsApp <span class="badge">connected</span></h2>
<div>Account: <strong>${esc(me ?? 'linked')}</strong>, connected since ${esc(fmtTime(Math.floor(s.since / 1000)))}</div>
<div>Index: ${stats.chats} chats, ${stats.groups} groups, ${stats.messages.toLocaleString('en')} messages${stats.oldest ? ` (oldest ${esc(fmtTime(stats.oldest))})` : ''}</div>${history}${gaps}
${unlinkForm()}</div>`;
      }
    }
  }

  function unlinkForm(): string {
    return `<form method="post" action="/admin/unlink" class="row"><label><input type="checkbox" name="confirm" value="yes"> Unlink and erase the index</label><button class="danger" type="submit">Unlink WhatsApp</button></form>`;
  }

  function claudeCard(): string {
    const families = d.store.listTokenFamilies();
    const rows = families
      .map((f) => `<tr><td><code>${esc(f.clientId.slice(0, 48))}</code></td><td>${esc(fmtTime(f.createdAt))}</td><td><form method="post" action="/admin/revoke" class="inline"><input type="hidden" name="family" value="${esc(f.familyId)}"><button class="danger" type="submit">Revoke</button></form></td></tr>`)
      .join('');
    return `<div class="card"><h2>Claude</h2><p>In Claude: Settings → Connectors → <strong>Add custom connector</strong>, and paste <code>${esc(d.config.mcpUrl.href)}</code>. Claude then sends you here to approve it.</p>
<p class="muted">In the connector's tool permissions, set the sending tools (whatsapp_send_message, whatsapp_send_file) to <strong>Ask</strong>, so nothing goes out without you seeing it.</p>
${families.length ? `<table><tr><th>Connected client</th><th>Since</th><th></th></tr>${rows}</table>` : '<p class="muted">No client connected yet.</p>'}</div>`;
  }

  function bridgeCard(): string {
    const hosts = d.config.peerUploadHosts;
    return `<div class="card"><h2>Files with Google (G-Spot Assistant)</h2>${
      hosts.length
        ? `<p>WhatsApp files may go to: ${hosts.map((h) => `<code>${esc(h)}</code>`).join(', ')}.</p>`
        : '<div class="alert warn">No connector may receive files yet: set <code>PEER_UPLOAD_HOSTS</code> to the host name of your G-Spot Assistant.</div>'
    }<p class="muted">For files to come back from Drive or Gmail, G-Spot Assistant lists this server (<code>${esc(d.config.baseUrl.host)}</code>) in its own <code>PEER_UPLOAD_HOSTS</code>.</p></div>`;
  }

  function serverCard(): string {
    const m = memoryReport();
    const hours = Math.floor(process.uptime() / 3600);
    const up = hours >= 48 ? `${Math.floor(hours / 24)} days` : hours >= 1 ? `${hours} h` : `${Math.max(1, Math.round(process.uptime() / 60))} min`;
    return `<div class="card muted">Memory: ${m.rssMb} MB${m.containerMb !== undefined ? ` (container ${m.containerMb} MB)` : ''} · running for ${up}</div>`;
  }

  function storageBanner(): string {
    return d.config.storageWarning ? `<div class="alert error">${esc(d.config.storageWarning)}</div>` : '';
  }

  return r;
}
