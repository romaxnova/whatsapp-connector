import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { openDatabase } from '../db.js';
import { makePdf, makeScanPdf } from '../test-fixtures.js';
import { parsePages, readDocument, splitPages } from './documents.js';
import { MediaTextCache } from './media-text.js';

const canOcr = spawnSync('tesseract', ['--version']).status === 0 && spawnSync('pdftoppm', ['-v']).status === 0;
const cache = () => new MediaTextCache(openDatabase(':memory:'), [Buffer.alloc(32, 5)]);

test('page lists', () => {
  assert.deepEqual(parsePages('12', 55), [12]);
  assert.deepEqual(parsePages('3-5, 1,9', 55), [1, 3, 4, 5, 9]);
  assert.deepEqual(parsePages('50-60', 55), [50, 51, 52, 53, 54, 55]);
  assert.match(parsePages('70', 55) as string, /55 pages/);
  assert.match(parsePages('abc', 55) as string, /not a page list/);
  assert.match(parsePages('1-40', 55) as string, /At most 30/);
  assert.deepEqual([...splitPages('## Page 1\nA\n\n## Page 2\nB\nC').entries()], [[1, 'A'], [2, 'B\nC']]);
});

test('a PDF is downloaded and read once, then served by page from the cache', async () => {
  const pdf = makePdf([['Summary', 'Value 210 000 EUR'], ['Terms of engagement'], ['Comparables', 'Flat 1505']]);
  let loads = 0;
  const req = { ref: 'chat:1', mimeType: 'application/pdf', filename: 'report.pdf', load: async () => (loads++, pdf), maxChars: 40_000, offset: 0, cache: cache() };
  const all = await readDocument(req);
  assert.equal(all.kind, 'text');
  assert.match((all as { text: string }).text, /## Page 3\nComparables/);
  const page3 = await readDocument({ ...req, pages: '3' });
  assert.equal((page3 as { text: string }).text, '## Page 3\nComparables\nFlat 1505');
  const clipped = await readDocument({ ...req, maxChars: 30 });
  assert.match((clipped as { text: string }).text, /Read on with offset=30, or ask for pages by number \(pages: "12-14"\) among the 3/);
  assert.equal(loads, 1, 'later reads come from the remembered text');
});

test('a scanned PDF is read by OCR, page by page, and remembered', { skip: !canOcr && 'tesseract or pdftoppm is not installed here' }, async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="400"><rect width="100%" height="100%" fill="white"/><text x="60" y="160" font-family="DejaVu Sans, sans-serif" font-size="56">Market value 210000 EUR</text></svg>`;
  const jpeg = await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
  const pdf = makeScanPdf(jpeg, 1240, 400);
  let loads = 0;
  const req = { ref: 'chat:2', mimeType: 'application/pdf', filename: 'scan.pdf', load: async () => (loads++, pdf), maxChars: 40_000, offset: 0, cache: cache(), ocr: { languages: 'eng+fra+rus' } };
  const first = await readDocument(req);
  assert.match((first as { text: string }).text, /scan of 1 pages[\s\S]*## Page 1\n.*Market value 210000 EUR/);
  await readDocument(req);
  assert.equal(loads, 1, 'the OCR of a page is remembered');
  const off = await readDocument({ ...req, ref: 'chat:3', ocr: undefined });
  assert.match((off as { note: string }).note, /scan/);
});
