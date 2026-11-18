/**
 * /upload/:token: receives files for the connector through a one-time link
 * issued by the create_upload_link tool. The token in the path is the only
 * credential (a capability URL): several uploads within 30 minutes, redacted from the
 * connector's logs (see loggablePath). Nothing is written to disk here (the store encrypts what it keeps).
 *
 * Two ways to use a link:
 * - From Claude's code sandbox, POST the file itself (curl --data-binary @file)
 *   or a multipart form (curl -F file=@file); the reply is JSON.
 * - In a browser (the user's phone or computer), open the link: GET shows a
 *   small page to pick one or more files, which it POSTs as a form, then
 *   redirects back to the page, which lists what came through and offers to
 *   upload more. This works when the sandbox may not reach this server, and
 *   sends photos at full size.
 */
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { errorSummary, type Logger } from '../log.js';
import { baseMime, extensionForMime, extensionOf, mimeFromFilename, sniffMime } from '../mcp/file-types.js';
import { sha256Hex, UploadError, type IncomingFile, type StagedFile, type StagedFileInfo, type UploadStore } from '../uploads.js';
import { esc, page } from './html.js';

/** Types curl and browsers put on bodies that say nothing about the file itself. */
const MEANINGLESS_TYPES = new Set(['', 'application/x-www-form-urlencoded', 'application/octet-stream', 'binary/octet-stream']);

/** What a person is told when a link is unknown or expired, and what code is told. */
const GONE_PAGE = 'This upload link has expired or was never valid. Ask Claude for a new one.';
const GONE_JSON = 'This upload link is unknown or expired. Ask for a new one with create_upload_link.';

/** A person with a browser (who gets pages), rather than code in a sandbox (which gets JSON). */
function wantsPage(req: Request): boolean {
  return /\btext\/html\b/i.test(String(req.headers['accept'] ?? ''));
}

function mb(bytes: number): string {
  const v = bytes / (1024 * 1024);
  return v >= 1 ? `${v.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function sendError(req: Request, res: Response, status: number, forPerson: string, forCode = forPerson, extra: Record<string, unknown> = {}): void {
  res.setHeader('Cache-Control', 'no-store');
  if (wantsPage(req)) {
    res.status(status).type('html').send(page({ title: 'Upload failed', body: `<div class="alert error">${esc(forPerson)}</div>` }));
    return;
  }
  res.status(status).json({ error: forCode, ...extra });
}

interface Described {
  upload_id: string;
  filename?: string;
  mime_type?: string;
  size: number;
}

function describe(files: StagedFileInfo[]): Described[] {
  return files.map((f) => ({ upload_id: f.id, filename: f.filename, mime_type: f.mimeType, size: f.size }));
}

/** The files that came through a link so far, one under the other so nothing is cut off on a phone. */
function receivedList(files: Described[]): string {
  const items = files
    .map((f) => `<div class="item"><div class="item-head"><strong>${esc(f.filename ?? '(no name)')}</strong><span class="muted">${esc(mb(f.size))}</span></div><div class="muted">Reference: <code>${esc(f.upload_id)}</code></div></div>`)
    .join('');
  return `<div class="card">${items}</div>`;
}

export function uploadRouter(uploads: UploadStore, log: Logger): Router {
  const router = express.Router();
  const perFileMb = uploads.limits.maxFileBytes / (1024 * 1024);
  const perUploadMb = uploads.limits.maxRequestBytes / (1024 * 1024);
  router.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 60,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) => sendError(req, res, 429, 'Too many attempts from this connection. Wait a few minutes, then open the link again.', 'Too many requests.'),
    }),
  );
  const token = (req: Request) => String(req.params['token'] ?? '');

  // The page a person opens on their phone or computer. Plain HTML, no script: the form posts back to the same URL.
  // A link takes several uploads until it expires, so the page lists what came through so far above the form.
  router.get('/:token', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (uploads.linkState(token(req)) === 'gone') return void res.status(404).type('html').send(page({ title: 'Link expired', body: `<p>${esc(GONE_PAGE)}</p>` }));
    const received = describe(uploads.receivedThrough(token(req)));
    const form = (label: string) => `<form class="card" method="post" enctype="multipart/form-data">
<label><input type="file" name="file" multiple required></label>
<div class="row"><button class="primary" type="submit">${label}</button></div>
<p class="muted">Up to ${perFileMb} MB per file and ${perUploadMb} MB per upload. After tapping ${label}, wait for this page to come back; large photos can take a minute.</p>
</form>`;
    const footer = `<p class="muted">This link works for 30 minutes after Claude made it. The files are kept encrypted on your connector for 24 hours, for Claude to attach or save them, and then deleted.</p>`;
    if (received.length) {
      res.type('html').send(
        page({
          title: received.length === 1 ? 'File received' : `${received.length} files received`,
          body: `<div class="alert">Go back to Claude and say the files are uploaded; Claude finds them by itself.</div>${receivedList(received)}<h2>More files?</h2>${form('Upload more')}${footer}`,
        }),
      );
      return;
    }
    res.type('html').send(
      page({
        title: 'Send files to Claude',
        body: `<p>Pick the files Claude asked for: photos, PDFs, documents. They are sent at full size. You can upload several times: for example photos from the Photo Library first, then a PDF from Files.</p>${form('Upload')}${footer}`,
      }),
    );
  });

  // The link is checked and claimed before the body is read, so a stranger cannot make the server buffer
  // megabytes, and one link never buffers two bodies: a newer upload (a second tap) aborts the older one.
  router.post('/:token', (req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store');
    const claim = uploads.reserveLink(token(req), () => req.destroy());
    if (claim === 'gone') return sendError(req, res, 404, GONE_PAGE, GONE_JSON);
    res.locals['claim'] = claim;
    res.on('close', () => uploads.releaseLink(token(req), claim));
    next();
  });
  router.post('/:token', express.raw({ type: () => true, limit: uploads.limits.maxRequestBytes + 256 * 1024 }));
  router.post('/:token', (req: Request, res: Response) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const contentType = req.headers['content-type'] ?? '';
    let incoming: IncomingFile[];
    if (/^multipart\/form-data/i.test(contentType)) {
      incoming = parseFormFiles(body, contentType, uploads.limits.maxFilesPerLink + 1);
      if (!incoming.length) return sendError(req, res, 400, 'No file was picked. Go back and choose at least one file.', 'The form carried no file. Send it as -F "file=@/path/to/file" or as the raw body (--data-binary @/path/to/file).');
    } else {
      const named = typeof req.query['filename'] === 'string' ? req.query['filename'] : headerFilename(req.headers['x-filename']);
      incoming = [{ data: body, filename: named, mimeType: MEANINGLESS_TYPES.has(baseMime(contentType)) ? undefined : baseMime(contentType) }];
    }
    // A browser sends an empty part when no file was picked; such parts are not files.
    incoming = incoming.filter((f) => f.data.length > 0 || f.filename);
    if (!incoming.length || incoming.every((f) => f.data.length === 0)) return sendError(req, res, 400, 'The files were empty. Go back and pick them again.', 'The upload is empty.');
    const files = incoming.map((f) => {
      const filename = cleanFilename(f.filename);
      const mimeType = f.mimeType && !MEANINGLESS_TYPES.has(f.mimeType) ? f.mimeType : (mimeFromFilename(filename) ?? sniffMime(f.data));
      return { data: f.data, filename, mimeType };
    });
    const names = readableNames(files, uploads.receivedThrough(token(req)).map((f) => f.filename));
    files.forEach((f, i) => (f.filename = names[i]));
    let staged: StagedFile[] | undefined;
    try {
      staged = uploads.consumeLinkFiles(token(req), files, res.locals['claim'] as number);
    } catch (err) {
      if (err instanceof UploadError) return sendError(req, res, 413, `${err.message} Nothing of this upload was kept; go back and try again with fewer or smaller files.`, err.message);
      throw err;
    }
    if (!staged) return sendError(req, res, 409, 'A newer upload on this link took over. Wait for its confirmation page.', 'A newer upload on this link took over, or the link was used meanwhile.');
    log.info('files staged', { via: wantsPage(req) ? 'browser' : 'link', files: staged.length, bytes: staged.reduce((sum, f) => sum + f.data.length, 0) });
    // Post/redirect/get: the page that lists the files is a plain GET, so reloading it does not send them again.
    if (wantsPage(req)) return void res.redirect(303, req.originalUrl);
    const described = staged.map((f) => ({
      upload_id: f.id,
      filename: f.filename,
      mime_type: f.mimeType,
      size: f.data.length,
      sha256: sha256Hex(f.data),
      expires_at: new Date(f.expiresAt).toISOString(),
    }));
    const next = (ids: string[]) =>
      `Attach with ${ids.map((id) => `{"upload_id": "${id}"}`).join(', ')} in gmail_send, gmail_reply or gmail_create_draft attachments or gmail_update_draft add_attachments (as many times as needed), or save with drive_create_file source {"upload_id": ...}.`;
    if (described.length === 1) {
      res.status(201).json({ ...described[0], link_id: staged[0]!.linkId, next: next([described[0]!.upload_id]) });
      return;
    }
    res.status(201).json({ uploads: described, link_id: staged[0]!.linkId, next: next(described.map((f) => f.upload_id)) });
  });
  router.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if ((err as { type?: string })?.type === 'entity.too.large') {
      return sendError(
        req,
        res,
        413,
        `That is more than ${perUploadMb} MB at once. Nothing was kept; go back and send fewer files (the link still works).`,
        `The upload is larger than ${perUploadMb} MB (at most ${perFileMb} MB per file). Send fewer files at once.`,
      );
    }
    // The person went away or a newer upload took over (req.destroy()): nobody is left to answer.
    if ((err as { type?: string })?.type === 'request.aborted' || req.destroyed) return;
    if (res.headersSent) return void res.end();
    log.error('upload failed', { error: errorSummary(err) });
    sendError(req, res, 500, 'Something went wrong on the connector. Nothing was kept; open the link again and retry.', 'Internal error; nothing was kept.');
  });
  return router;
}

function headerFilename(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v) return undefined;
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** The last path segment, without control characters, at most 255 characters; undefined when nothing is left. */
/** Names phones give photos that say nothing: iOS's "4F9C2B1E-5D3A-4B8E-9F1A-2C3D4E5F6A7B.jpeg", older Safari's "image.jpg". */
const MEANINGLESS_NAME = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|image)(?:\.[a-z0-9]{1,8})?$/i;

/**
 * Photos and videos the phone named meaninglessly get a name a recipient can read ("photo-1.jpeg",
 * "video-1.mov"), numbered after the names that already came through the link; other names are kept.
 */
export function readableNames(files: { filename?: string; mimeType?: string }[], already: (string | undefined)[]): (string | undefined)[] {
  // Compared without extensions, so photo-1.jpeg and a later photo-1.jpg never both appear.
  const stem = (name: string) => name.replace(/\.[a-z0-9]{1,8}$/i, '').toLowerCase();
  const taken = new Set(already.filter((n): n is string => !!n).map(stem));
  const last = new Map<string, number>();
  return files.map((f) => {
    const kind = f.mimeType?.startsWith('image/') ? 'photo' : f.mimeType?.startsWith('video/') ? 'video' : undefined;
    if (!kind || !f.filename || !MEANINGLESS_NAME.test(f.filename)) return f.filename;
    const ext = extensionOf(f.filename) ?? extensionForMime(f.mimeType);
    let n = last.get(kind) ?? 0;
    while (taken.has(`${kind}-${++n}`));
    last.set(kind, n);
    taken.add(`${kind}-${n}`);
    return `${kind}-${n}${ext ? `.${ext}` : ''}`;
  });
}

export function cleanFilename(name: string | undefined): string | undefined {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 255);
  return clean && clean !== '.' && clean !== '..' ? clean : undefined;
}

interface FormPart extends IncomingFile {
  isFile: boolean;
}

/** Every part of a multipart/form-data body, with the file name and type each declares. */
function parseFormParts(body: Buffer, contentType: string, maxParts = Infinity): FormPart[] | undefined {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = m?.[1] ?? m?.[2];
  if (!boundary) return undefined;
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: { headers: string; data: Buffer }[] = [];
  let pos = body.indexOf(delimiter);
  while (pos !== -1 && parts.length < maxParts) {
    const afterDelimiter = pos + delimiter.length;
    if (body.subarray(afterDelimiter, afterDelimiter + 2).toString() === '--') break; // close delimiter
    const headersStart = body.indexOf('\r\n', afterDelimiter);
    if (headersStart === -1) break;
    const headersEnd = body.indexOf('\r\n\r\n', headersStart);
    if (headersEnd === -1) break;
    const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), delimiter]), headersEnd + 4);
    const end = next === -1 ? body.length : next;
    parts.push({ headers: body.subarray(headersStart + 2, headersEnd).toString('utf8'), data: body.subarray(headersEnd + 4, end) });
    if (next === -1) break;
    pos = next + 2;
  }
  return parts.map((p) => {
    const disposition = /^content-disposition:(.*)$/im.exec(p.headers)?.[1] ?? '';
    const star = /filename\*\s*=\s*(?:utf-8|UTF-8)''([^;\r\n]+)/.exec(disposition)?.[1];
    const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\r\n]+))/i.exec(disposition);
    let filename: string | undefined;
    if (star) {
      try {
        filename = decodeURIComponent(star.trim());
      } catch {
        filename = star.trim();
      }
    } else if (plain?.[1] !== undefined) {
      // Browsers write a quote as %22 and line breaks as %0D/%0A (HTML's form encoding) and leave
      // backslashes alone; some older clients escape the quote as \". Anything else is kept as sent.
      filename = plain[1].replace(/\\"/g, '"').replace(/%22/g, '"').replace(/%0D|%0A/gi, ' ').trim();
    } else if (plain) filename = (plain[2] ?? '').trim();
    const type = /^content-type:\s*([^\r\n;]+)/im.exec(p.headers)?.[1];
    return { data: p.data, filename, mimeType: type ? baseMime(type) : undefined, isFile: filename !== undefined };
  });
}

/** The file fields of a multipart/form-data body (or its first field when none is named as a file). */
export function parseFormFiles(body: Buffer, contentType: string, maxParts?: number): IncomingFile[] {
  const parts = parseFormParts(body, contentType, maxParts) ?? [];
  const files = parts.filter((p) => p.isFile);
  const chosen = files.length ? files : parts.slice(0, 1);
  return chosen.map(({ data, filename, mimeType }) => ({ data, filename, mimeType }));
}

/** The first file field of a multipart/form-data body (or the first field when none is named as a file). */
export function parseFormData(body: Buffer, contentType: string): IncomingFile | undefined {
  if (!parseFormParts(body, contentType)) return undefined;
  return parseFormFiles(body, contentType)[0];
}
