/**
 * Small but valid binary files for tests (PDF, PNG), built in code so the
 * repository carries no opaque fixtures. Used by unit tests only.
 */
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { crc32, createDeflate, deflateSync } from 'node:zlib';

/** Assembles numbered objects (object n is objects[n - 1]) into a PDF with a correct cross-reference table. */
function assemblePdf(objects: Buffer[], rootId: number, trailerExtra = ''): Buffer {
  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = chunks[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    chunks.push(chunk);
    offset += chunk.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${rootId} 0 R${trailerExtra} >>\nstartxref\n${offset}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}

interface PageStream {
  /** The content stream as stored in the file. */
  data: Buffer;
  /** /Filter value for it, e.g. "/FlateDecode". */
  filter?: string;
}

/** A PDF whose pages carry the given content streams, with `font` as resource F1. Pages listed in damagedPages (1-based) are not page objects at all. */
function pdfWithPages(streams: PageStream[], font: string, opts: { encrypt?: boolean; damagedPages?: number[] } = {}): Buffer {
  const objects: Buffer[] = [];
  const add = (body: Buffer | string) => objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'));
  add(font); // 1
  const pagesId = 2 + streams.length * 2;
  const pageIds: number[] = [];
  streams.forEach((stream, i) => {
    const filter = stream.filter ? ` /Filter ${stream.filter}` : '';
    add(Buffer.concat([Buffer.from(`<< /Length ${stream.data.length}${filter} >>\nstream\n`, 'latin1'), stream.data, Buffer.from('\nendstream', 'latin1')]));
    const contentId = objects.length;
    add(
      opts.damagedPages?.includes(i + 1)
        ? '(this is not a page)'
        : `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 1 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(objects.length);
  });
  add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const catalogId = objects.length;
  let encryptRef = '';
  if (opts.encrypt) {
    // A standard security handler dictionary with a user password: pdf.js then asks for the password.
    add(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${'a'.repeat(64)}> /U <${'b'.repeat(64)}> /P -4 >>`);
    encryptRef = ` /Encrypt ${objects.length} 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>]`;
  }
  return assemblePdf(objects, catalogId, encryptRef);
}

const HELVETICA = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

function textOps(lines: string[]): string {
  return `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => `(${l.replace(/[()\\]/g, (c) => `\\${c}`)}) Tj T*`).join(' ')} ET`;
}

/** Builds a small but valid PDF: compressed content streams, Helvetica with WinAnsi encoding. damagedPages (1-based) are broken page objects. */
export function makePdf(pages: string[][], opts: { encrypt?: boolean; damagedPages?: number[] } = {}): Buffer {
  const streams = pages.map((lines) => ({ data: deflateSync(Buffer.from(textOps(lines), 'latin1')), filter: '/FlateDecode' }));
  return pdfWithPages(streams, HELVETICA, opts);
}

/**
 * A one-page PDF of a few kilobytes whose content stream is compressed twice
 * and expands to `expandedBytes` of blank space after one line of text: the
 * decompression bomb pdf.js would inflate without limit.
 */
export async function makeBombPdf(expandedBytes: number): Promise<Buffer> {
  const deflate = createDeflate({ level: 9 });
  const out: Buffer[] = [];
  deflate.on('data', (chunk: Buffer) => out.push(chunk));
  const done = once(deflate, 'end');
  deflate.write(Buffer.from(`${textOps(['Invoice'])}\n`, 'latin1'));
  const blank = Buffer.alloc(1024 * 1024, 0x20);
  for (let written = 0; written < expandedBytes; written += blank.length) {
    if (!deflate.write(blank)) await once(deflate, 'drain');
  }
  deflate.end();
  await done;
  const twice = deflateSync(Buffer.concat(out), { level: 9 });
  return pdfWithPages([{ data: twice, filter: '[/FlateDecode /FlateDecode]' }], HELVETICA);
}

/** A PDF in a Japanese CID font without an embedded program: its text is only readable through Adobe's predefined character maps. */
export function makeCjkPdf(text: string): Buffer {
  const hex = Buffer.from(text, 'utf16le').swap16().toString('hex').toUpperCase();
  const font =
    '<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPro-Regular /Encoding /UniJIS-UCS2-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPro-Regular ' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 4 >> /FontDescriptor << /Type /FontDescriptor /FontName /KozMinPro-Regular /Flags 4 /FontBBox [0 -120 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 740 /StemV 80 >> >>] >>';
  const ops = `BT /F1 12 Tf 72 720 Td <${hex}> Tj ET`;
  return pdfWithPages([{ data: Buffer.from(ops, 'latin1') }], font);
}

/** A valid RGB PNG of the given size, filled with one colour. */
export function makePng(width = 2, height = 2, rgb: [number, number, number] = [200, 30, 30]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([len, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
}

/** Two seconds of a tone, loud then quiet, as MP3 (what ElevenLabs returns). */
export function toneMp3(): Buffer {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', '-af', 'volume=eval=frame:volume=1-t/2.2', '-f', 'mp3', 'pipe:1'], { maxBuffer: 10 * 1024 * 1024 });
  return r.stdout;
}


/** A one-page PDF that is only a JPEG picture (a scan): no text layer. */
export function makeScanPdf(jpeg: Buffer, width: number, height: number): Buffer {
  const objects: Buffer[] = [];
  const add = (body: Buffer | string) => objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'));
  add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, 'latin1'), jpeg, Buffer.from('\nendstream', 'latin1')])); // 1
  const ops = Buffer.from(`q 612 0 0 ${Math.round((612 * height) / width)} 0 0 cm /Im1 Do Q`, 'latin1');
  add(Buffer.concat([Buffer.from(`<< /Length ${ops.length} >>\nstream\n`, 'latin1'), ops, Buffer.from('\nendstream', 'latin1')])); // 2
  add(`<< /Type /Page /Parent 4 0 R /MediaBox [0 0 612 ${Math.round((612 * height) / width)}] /Resources << /XObject << /Im1 1 0 R >> >> /Contents 2 0 R >>`); // 3
  add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'); // 4
  add('<< /Type /Catalog /Pages 4 0 R >>'); // 5
  return assemblePdf(objects, 5, '');
}
