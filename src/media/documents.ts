/**
 * Documents read once, then paged: the text of a file (PDF, Word, Excel, PowerPoint, text) is
 * extracted on the first read and remembered, encrypted, so reading on (the next pages, another
 * section) costs neither a new download nor a new extraction. PDFs are read by page number, and
 * the pages of a scan (no text layer) are read by OCR on this server, a few at a time.
 * Shared, file for file, by the WhatsApp and Telegram connectors.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { extractPdfText, PdfError } from '../mcp/extract/pdf.js';
import { readFileContent } from '../mcp/extract/readable.js';
import { clip } from '../mcp/registry.js';
import { ocr, type MediaTextCache, type OcrConfig } from './media-text.js';

/** Pages read by OCR in one call: about 5 seconds each on a small server. */
export const MAX_OCR_PAGES_PER_CALL = 8;
/** Pages returned in one call when they are asked for by number. */
export const MAX_PAGES_PER_CALL = 30;
/** Bigger extracted texts are not remembered (read again from the file instead). */
const MAX_CACHED_CHARS = 3_000_000;

interface Stored {
  /** Extracted text; PDFs with "## Page N" headings. Empty for a scan. */
  text: string;
  note?: string;
  /** PDF page count. */
  pages?: number;
  /** A PDF without a text layer: its pages are read by OCR when asked for. */
  scanned?: boolean;
}

export type DocumentResult =
  | { kind: 'text'; text: string }
  | { kind: 'image'; data: Buffer; mimeType: string }
  | { kind: 'none'; note: string };

export interface DocumentRequest {
  /** Stable id of the file, e.g. "chat:message". */
  ref: string;
  mimeType?: string;
  filename: string;
  /** Downloads the file; only called when it is not remembered yet (or for OCR). */
  load: () => Promise<Buffer>;
  /** "12", "3-5", "1,4,7-9": PDF pages to return. */
  pages?: string;
  maxChars: number;
  offset: number;
  cache?: MediaTextCache;
  ocr?: OcrConfig;
}

const isPdf = (data: Buffer | undefined, mimeType?: string, filename?: string) =>
  (data ? data.subarray(0, 5).toString('latin1') === '%PDF-' : false) || mimeType === 'application/pdf' || /\.pdf$/i.test(filename ?? '');

/** The text of a document, the pages asked for, or what can be said about it. */
export async function readDocument(r: DocumentRequest): Promise<DocumentResult> {
  const ref = `doc:${r.ref}`;
  let data: Buffer | undefined;
  const load = async () => (data ??= await r.load());

  let stored = remembered(r.cache, ref);
  if (!stored) {
    const file = await load();
    if (isPdf(file, r.mimeType, r.filename)) {
      try {
        const pdf = await extractPdfText(file);
        stored = pdf.text ? { text: pdf.text, pages: pdf.pages, ...(pdf.note ? { note: pdf.note } : {}) } : { text: '', pages: pdf.pages, scanned: true };
      } catch (err) {
        if (err instanceof PdfError) return { kind: 'none', note: err.message };
        throw err;
      }
    } else {
      const content = await readFileContent(file, { mimeType: r.mimeType, filename: r.filename });
      if (content.kind === 'image') return { kind: 'image', data: content.data, mimeType: content.mimeType };
      if (content.kind === 'none') return { kind: 'none', note: content.note };
      stored = { text: content.text, ...(content.note ? { note: content.note } : {}) };
    }
    if (stored.text.length <= MAX_CACHED_CHARS) r.cache?.put(ref, JSON.stringify(stored));
  }

  if (stored.scanned) return scanned(r, stored.pages ?? 0, load);

  const total = stored.pages;
  if (r.pages && total) {
    const wanted = parsePages(r.pages, total);
    if (typeof wanted === 'string') return { kind: 'none', note: wanted };
    const byPage = splitPages(stored.text);
    const text = wanted.map((n) => `## Page ${n}\n${byPage.get(n) ?? '[no text on this page]'}`).join('\n\n');
    return { kind: 'text', text: fit(text, r, total) };
  }
  return { kind: 'text', text: fit(stored.text, r, total, stored.note) };
}

function remembered(cache: MediaTextCache | undefined, ref: string): Stored | undefined {
  const raw = cache?.get(ref);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as Stored;
  } catch {
    return undefined;
  }
}

/** Clips the text and says how to read on: by offset, and by page for a long PDF. */
function fit(text: string, r: DocumentRequest, pages?: number, note?: string): string {
  const c = clip(text, r.maxChars, r.offset);
  const notes = [note];
  if (c.text.length < text.length || r.offset > 0) {
    const end = r.offset + c.text.length;
    notes.push(`[Showing characters ${r.offset}–${end} of ${text.length}.${end < text.length ? ` Read on with offset=${end}` : ''}${pages ? `${end < text.length ? ', or' : ''} ask for pages by number (pages: "12-14") among the ${pages}` : ''}.]`);
  }
  const tail = notes.filter(Boolean).join('\n');
  return tail ? `${c.text}\n\n${tail}` : c.text;
}

/** A scan: the pages asked for (the first 3 by default), read by OCR and remembered page by page. */
async function scanned(r: DocumentRequest, total: number, load: () => Promise<Buffer>): Promise<DocumentResult> {
  if (!r.ocr) return { kind: 'none', note: `This PDF is a scan (${total} pages without a text layer), and text recognition (OCR) is turned off on this server.` };
  const spec = r.pages ?? `1-${Math.min(3, total)}`;
  const wanted = parsePages(spec, total, MAX_OCR_PAGES_PER_CALL);
  if (typeof wanted === 'string') return { kind: 'none', note: wanted };
  const out: string[] = [];
  const todo: number[] = [];
  for (const n of wanted) {
    const hit = r.cache?.get(`ocrpage:${r.ref}:${n}`);
    if (hit === undefined) todo.push(n);
  }
  let fresh = new Map<number, string | undefined>();
  if (todo.length) {
    try {
      fresh = await ocrPdfPages(await load(), todo, r.ocr);
    } catch (err) {
      return { kind: 'none', note: `This PDF is a scan (${total} pages without a text layer) and its pages could not be read by OCR here: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  for (const [n, text] of fresh) r.cache?.put(`ocrpage:${r.ref}:${n}`, text ?? '');
  for (const n of wanted) {
    const text = fresh.has(n) ? fresh.get(n) : r.cache?.get(`ocrpage:${r.ref}:${n}`) || undefined;
    out.push(`## Page ${n}\n${text ?? '[no text found on this page]'}`);
  }
  const last = wanted[wanted.length - 1]!;
  const more = last < total ? ` Ask for more pages by number (pages: "${last + 1}-${Math.min(last + MAX_OCR_PAGES_PER_CALL, total)}"), up to ${MAX_OCR_PAGES_PER_CALL} per call.` : '';
  const header = `[This PDF is a scan of ${total} pages: pages ${spec} read by text recognition (OCR) on this server, which can make mistakes.${more}]`;
  return { kind: 'text', text: `${header}\n\n${clip(out.join('\n\n'), r.maxChars, 0).text}` };
}

/** "## Page N" sections of an extracted PDF. */
export function splitPages(text: string): Map<number, string> {
  const pages = new Map<number, string>();
  const re = /^## Page (\d+)\n/gm;
  const marks: { n: number; start: number; end: number }[] = [];
  for (let m; (m = re.exec(text)); ) marks.push({ n: Number(m[1]), start: m.index + m[0].length, end: m.index });
  marks.forEach((mk, i) => pages.set(mk.n, text.slice(mk.start, i + 1 < marks.length ? marks[i + 1]!.end : text.length).trim()));
  return pages;
}

/** Page numbers from "12", "3-5" or "1,4,7-9", within 1..total; or why not. */
export function parsePages(spec: string, total: number, max = MAX_PAGES_PER_CALL): number[] | string {
  const out = new Set<number>();
  for (const part of spec.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(part);
    if (!m) return `"${spec}" is not a page list: use "12", "3-5" or "1,4,7-9".`;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a || a > total) return `This document has ${total} pages; "${part}" is outside them.`;
    for (let n = a; n <= Math.min(b, total); n++) out.add(n);
  }
  const pages = [...out].sort((x, y) => x - y);
  if (!pages.length) return 'Say which pages, e.g. "12" or "3-5".';
  if (pages.length > max) return `At most ${max} pages per call: ask for "${pages[0]}-${pages[0]! + max - 1}" first.`;
  return pages;
}

/** Renders PDF pages to images (pdftoppm) and reads them (Tesseract), one page at a time. */
export async function ocrPdfPages(pdf: Buffer, pages: number[], cfg: OcrConfig): Promise<Map<number, string | undefined>> {
  const dir = await mkdtemp(join(tmpdir(), 'ocr-'));
  const out = new Map<number, string | undefined>();
  try {
    const file = join(dir, 'in.pdf');
    await writeFile(file, pdf, { mode: 0o600 });
    for (const n of pages) {
      const prefix = join(dir, `p${n}`);
      await run('pdftoppm', ['-f', String(n), '-l', String(n), '-r', '200', '-gray', '-png', '-singlefile', file, prefix], 60_000);
      out.set(n, await ocr(await readFile(`${prefix}.png`), cfg));
      await rm(`${prefix}.png`, { force: true });
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`${cmd} is not available on this server (${e.message}).`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(signal ? `${cmd} took too long.` : `${cmd} failed: ${err.slice(0, 200)}`));
    });
  });
}
