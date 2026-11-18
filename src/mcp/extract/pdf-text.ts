/**
 * The pdf.js side of PDF text extraction, run inside the worker thread started
 * by pdf.ts (never on the main thread: see there why).
 *
 * Mozilla's pdf.js (pdfjs-dist, legacy build for Node) reads only the text
 * layer: nothing is rendered and no system fonts or network resources are used.
 * (pdf.js 5+ no longer compiles fonts into code at all, which removed the class
 * of bug behind CVE-2024-4367.) Character maps for Chinese, Japanese and Korean
 * fonts are read from the files pdfjs-dist ships. Scanned PDFs have no text
 * layer; the result then says so instead of pretending the file is empty.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

export interface PdfText {
  /** One "## Page N" section per page read. */
  text: string;
  pages: number;
  pagesRead: number;
  /** Set when pages were skipped or damaged, or no text layer was found. */
  note?: string;
}

/** A PDF that cannot be read; the message is meant for the user. */
export class PdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfError';
  }
}

/** pdfjs-dist's own folder: its data files (character maps, standard fonts) are read from there. */
const PDFJS_DIR = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));

let loading: Promise<PdfJs> | undefined;

/**
 * pdf.js looks for an optional native canvas package when it loads under Node and
 * warns three times (console.warn) when it is absent. We never render, so the
 * package may be missing (it is optional) and those import-time warnings are dropped.
 */
export function loadPdfJs(): Promise<PdfJs> {
  loading ??= (async () => {
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].startsWith('Warning: Cannot')) return;
      original(...args);
    };
    try {
      return await import('pdfjs-dist/legacy/build/pdf.mjs');
    } finally {
      console.warn = original;
    }
  })();
  return loading;
}

interface TextItemLike {
  str?: string;
  hasEOL?: boolean;
}

function pageText(items: readonly TextItemLike[]): string {
  let out = '';
  for (const item of items) {
    if (typeof item.str !== 'string') continue; // marked-content markers carry no text
    out += item.str;
    if (item.hasEOL) out += '\n';
  }
  return out.replace(/[ \t]+\n/g, '\n').trim();
}

/** Reads the text of up to maxPages pages. A damaged page is marked and skipped; a file that is not a readable PDF throws PdfError. */
export async function readPdf(data: Uint8Array, maxPages: number): Promise<PdfText> {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({
    data,
    cMapUrl: join(PDFJS_DIR, 'cmaps') + '/',
    cMapPacked: true,
    standardFontDataUrl: join(PDFJS_DIR, 'standard_fonts') + '/',
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });
  try {
    let doc;
    try {
      doc = await task.promise;
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'PasswordException') throw new PdfError('The PDF is password-protected; its text cannot be read.');
      throw new PdfError(`The file could not be read as a PDF (${err instanceof Error ? err.message : String(err)}).`);
    }
    const count = Math.min(doc.numPages, maxPages);
    const sections: string[] = [];
    const damaged: number[] = [];
    let chars = 0;
    for (let n = 1; n <= count; n++) {
      try {
        const page = await doc.getPage(n);
        const text = pageText((await page.getTextContent()).items as TextItemLike[]);
        page.cleanup();
        chars += text.length;
        sections.push(`## Page ${n}\n${text}`);
      } catch {
        damaged.push(n);
        sections.push(`## Page ${n}\n[this page could not be read]`);
      }
    }
    const notes: string[] = [];
    if (count < doc.numPages) notes.push(`Only the first ${count} of ${doc.numPages} pages were read.`);
    if (damaged.length) notes.push(`${damaged.length === 1 ? 'Page' : 'Pages'} ${damaged.join(', ')} could not be read (damaged).`);
    if (chars === 0 && damaged.length < count) notes.push('This PDF has no text layer (probably a scan or image-only PDF), so no text could be extracted.');
    return { text: chars === 0 ? '' : sections.join('\n\n'), pages: doc.numPages, pagesRead: count, note: notes.length ? notes.join(' ') : undefined };
  } finally {
    await task.destroy();
  }
}
