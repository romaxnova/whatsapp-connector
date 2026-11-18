/**
 * Turns downloaded file bytes into something Claude can read: text (plain and
 * data files, HTML, the text layer of PDFs, Word/Excel/PowerPoint documents),
 * an image it can look at, or a note saying why neither is possible.
 */
import { baseMime, extensionOf, mimeFromFilename, sniffMime, VIEWABLE_IMAGE_TYPES } from '../file-types.js';
import { cleanText, normalizeNewlines, trimCsv } from '../text.js';
import { decodeBytes, htmlToText } from '../decode.js';
import { extractOfficeText, officeKind, OfficeError } from './office.js';
import { extractPdfText, PdfError } from './pdf.js';
import { ZipError } from './zip.js';

/**
 * Largest image returned inline. claude.ai takes tool results of up to about
 * 150,000 characters and an image travels as base64, a third larger: 96 KB is
 * 131,072 characters, which leaves room for the text beside it. Larger images
 * are shown through Drive's preview, fetched at a size that fits.
 */
export const MAX_IMAGE_BYTES = 96 * 1024;

export type ReadableContent =
  | {
      kind: 'text';
      text: string;
      /** text/plain, text/markdown or text/csv (or the file's own text type). */
      format: string;
      /** What the text was extracted from, when it was not already text: pdf, docx, xlsx, pptx, html. */
      extractedFrom?: string;
      /** Character set a text file was decoded with, when it was not UTF-8 (declared or guessed). */
      charset?: string;
      note?: string;
    }
  | { kind: 'image'; data: Buffer; mimeType: string; note?: string }
  | { kind: 'none'; note: string; type: string };

export interface ReadOptions {
  mimeType?: string;
  filename?: string;
  /** Charset of a text file, when declared. */
  charset?: string;
  maxPdfPages?: number;
}

const GENERIC_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/binary', 'application/x-download', 'application/force-download', 'application/unknown']);

/** Types some mailers put on files that are not Office documents at all (Outlook labels .csv files application/vnd.ms-excel). */
const LEGACY_OFFICE_TYPES = new Set(['application/vnd.ms-excel', 'application/msword', 'application/vnd.ms-powerpoint']);

/** The legacy .doc/.xls/.ppt container (OLE compound file), also used for encrypted Office files. */
function isOleFile(data: Uint8Array): boolean {
  const magic = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return data.length >= 8 && magic.every((b, i) => data[i] === b);
}

const TEXT_TYPES = new Set(['application/json', 'application/xml', 'application/csv', 'application/javascript', 'application/x-yaml', 'application/yaml', 'application/sql', 'application/x-sh', 'application/x-python', 'message/rfc822']);

/** Whether a MIME type is text that can be shown as-is (after charset decoding). */
export function isTextType(mime: string): boolean {
  const m = baseMime(mime);
  return m.startsWith('text/') || TEXT_TYPES.has(m) || /\+(xml|json)$/.test(m);
}

export function looksLikeUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * The type to treat the bytes as. Senders often label files
 * application/octet-stream and Office files are ZIPs underneath, so the declared
 * type is refined by the file name and the leading bytes.
 */
export function effectiveType(data: Uint8Array, mimeType: string | undefined, filename: string | undefined): string {
  const declared = baseMime(mimeType);
  const byName = mimeFromFilename(filename);
  const sniffed = sniffMime(data);
  // Word, Excel and PowerPoint files are ZIP packages; the name tells which, whatever the label says.
  if (sniffed === 'application/zip') {
    if (officeKind(declared, undefined)) return declared;
    if (byName && officeKind(byName, filename)) return byName;
  }
  if (GENERIC_TYPES.has(declared) || declared === 'application/zip' || declared === 'application/x-zip-compressed') {
    return sniffed ?? byName ?? (declared || 'application/octet-stream');
  }
  // A PDF or image mislabelled as something else is still what its bytes say.
  if (sniffed && sniffed !== 'application/zip' && sniffed !== declared && (sniffed === 'application/pdf' || sniffed.startsWith('image/'))) return sniffed;
  // A legacy Office label on something that is no Office file (Outlook's .csv): read it by its name, or as text.
  if (LEGACY_OFFICE_TYPES.has(declared) && !sniffed && !isOleFile(data)) {
    if (byName && isTextType(byName)) return byName;
    if (looksLikeUtf8Text(data)) return 'text/plain';
  }
  return declared;
}

/**
 * Charset for text that is not valid UTF-8 and declares none: Windows-1251 when
 * most letters are in the upper half of the byte range (Cyrillic), otherwise
 * Windows-1252 (Western European, a superset of ISO-8859-1).
 */
export function guessLegacyCharset(bytes: Uint8Array): string {
  let high = 0;
  let letters = 0;
  for (const b of bytes) {
    if (b >= 0xc0) {
      high++;
      letters++;
    } else if ((b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)) letters++;
  }
  return letters > 0 && high / letters > 0.4 ? 'windows-1251' : 'windows-1252';
}

/** The charset to decode text with: the declared one, else UTF-8 when the bytes are valid UTF-8, else a guess. */
export function textCharset(bytes: Uint8Array, declared: string | undefined): string | undefined {
  if (declared?.trim()) return declared.trim();
  return looksLikeUtf8Text(bytes) || bytes.includes(0) ? undefined : guessLegacyCharset(bytes);
}

function textFormat(mime: string, filename: string | undefined): string {
  const ext = extensionOf(filename);
  if (mime === 'text/csv' || mime === 'application/csv' || ext === 'csv') return 'text/csv';
  if (mime === 'text/markdown' || ext === 'md' || ext === 'markdown') return 'text/markdown';
  return isTextType(mime) ? mime : 'text/plain';
}

/** Text of a text file, decoded with its charset; HTML is converted, CSV loses trailing empty cells, prose loses invisible padding. */
export function readText(data: Uint8Array, mime: string, opts: ReadOptions = {}): ReadableContent {
  const charset = textCharset(data, opts.charset);
  const decoded = decodeBytes(data, charset);
  // Only set when meaningful, so plain UTF-8 results stay minimal.
  const extra: { charset?: string; note?: string } = {};
  if (charset) extra.charset = charset;
  if (charset && !opts.charset?.trim()) extra.note = `No character set was declared and the text is not UTF-8; it was read as ${charset}.`;
  if (mime === 'text/html' || /\.html?$/i.test(opts.filename ?? '')) {
    return { kind: 'text', text: cleanText(htmlToText(decoded)), format: 'text/plain', extractedFrom: 'html', ...extra };
  }
  const format = textFormat(mime, opts.filename);
  // Prose loses invisible padding and blank-line runs; data formats (JSON, XML, calendars, ...) keep their exact layout.
  const text = format === 'text/csv' ? trimCsv(normalizeNewlines(decoded)) : format === 'text/plain' || format === 'text/markdown' ? cleanText(decoded) : normalizeNewlines(decoded);
  return { kind: 'text', text, format, ...extra };
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/** "85 KB" below a megabyte, "2.3 MB" above. */
export function humanSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const v = bytes / (1024 * 1024);
  return `${Number.isInteger(v) ? v : v.toFixed(1)} MB`;
}

/** Best readable form of a file's bytes. Never throws for bad content: unreadable files come back as kind "none" with the reason. */
export async function readFileContent(data: Uint8Array, opts: ReadOptions = {}): Promise<ReadableContent> {
  const type = effectiveType(data, opts.mimeType, opts.filename);

  if (type === 'application/pdf') {
    try {
      const pdf = await extractPdfText(data, { maxPages: opts.maxPdfPages });
      if (!pdf.text) return { kind: 'none', type, note: pdf.note ?? 'This PDF contains no text.' };
      return { kind: 'text', text: pdf.text, format: 'text/markdown', extractedFrom: 'pdf', note: pdf.note };
    } catch (err) {
      if (err instanceof PdfError) return { kind: 'none', type, note: err.message };
      throw err;
    }
  }

  const office = officeKind(type, opts.filename);
  if (office) {
    try {
      const doc = extractOfficeText(data, office);
      return { kind: 'text', text: doc.text, format: doc.format, extractedFrom: office, note: doc.note };
    } catch (err) {
      if (err instanceof OfficeError) return { kind: 'none', type, note: err.message };
      // Office files are ZIP packages: a ZIP that cannot be opened is a damaged or mislabelled file.
      if (err instanceof ZipError) return { kind: 'none', type, note: `The file could not be read as a .${office} document (${err.message}).` };
      throw err;
    }
  }

  if (type.startsWith('image/') && type !== 'image/svg+xml') {
    // Claude checks that the bytes match the declared type, so only a sniffed type is ever sent.
    const sniffed = sniffMime(data);
    if (!sniffed || !VIEWABLE_IMAGE_TYPES.has(sniffed)) {
      const note = VIEWABLE_IMAGE_TYPES.has(type)
        ? `The file is labelled ${type} but its content is not a PNG, JPEG, GIF or WebP image, so it cannot be shown.`
        : `This image format (${type}) cannot be shown; only PNG, JPEG, GIF and WebP can.`;
      return { kind: 'none', type, note };
    }
    if (data.length > MAX_IMAGE_BYTES) {
      return { kind: 'none', type, note: `The image is ${humanSize(data.length)}; images are shown inline up to ${humanSize(MAX_IMAGE_BYTES)}, the most a claude.ai tool result can carry.` };
    }
    return { kind: 'image', data: Buffer.from(data), mimeType: sniffed };
  }

  if (isTextType(type) || (GENERIC_TYPES.has(type) && looksLikeUtf8Text(data))) return readText(data, type, opts);

  return { kind: 'none', type, note: `The content of this file type (${type}) cannot be read; PDF, Word, Excel, PowerPoint, text files and PNG/JPEG/GIF/WebP images can.` };
}
