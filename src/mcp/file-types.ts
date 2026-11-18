/**
 * File-type helpers: MIME type from a file name, a file name extension for a
 * MIME type, and recognition of common formats from their first bytes (senders
 * often label attachments application/octet-stream).
 */

const BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  xml: 'application/xml',
  ics: 'text/calendar',
  vcf: 'text/vcard',
  eml: 'message/rfc822',
  rtf: 'application/rtf',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  dotx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  xltx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
  potx: 'application/vnd.openxmlformats-officedocument.presentationml.template',
  ppsx: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  epub: 'application/epub+zip',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};

const EXTENSION_BY_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(BY_EXTENSION)
    // First extension listed wins for each MIME type (jpg over jpeg, txt over text, ...).
    .reverse()
    .map(([ext, mime]) => [mime, ext]),
);

/** Lower-cased MIME type without parameters ("text/csv; charset=x" → "text/csv"). */
export function baseMime(mime: string | undefined): string {
  return (mime ?? '').split(';')[0]!.trim().toLowerCase();
}

export function extensionOf(filename: string | undefined): string | undefined {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(filename ?? '');
  return m ? m[1]!.toLowerCase() : undefined;
}

export function mimeFromFilename(filename: string | undefined): string | undefined {
  const ext = extensionOf(filename);
  return ext ? BY_EXTENSION[ext] : undefined;
}

export function extensionForMime(mime: string | undefined): string | undefined {
  return EXTENSION_BY_MIME[baseMime(mime)];
}

/** Recognises formats by their magic bytes. Office files are ZIPs and are reported as application/zip. */
export function sniffMime(data: Uint8Array): string | undefined {
  const starts = (...bytes: number[]) => bytes.every((b, i) => data[i] === b);
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf'; // %PDF-
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif'; // GIF8
  if (starts(0x52, 0x49, 0x46, 0x46) && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'; // RIFF....WEBP
  if (starts(0x50, 0x4b, 0x03, 0x04)) return 'application/zip'; // PK
  return undefined;
}

/** Image formats Claude can look at directly. */
export const VIEWABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Appends ".ext" for the MIME type unless the name already ends with it. */
export function withExtension(name: string, mime: string): string {
  const ext = extensionForMime(mime);
  if (!ext || extensionOf(name) === ext) return name;
  return `${name}.${ext}`;
}
