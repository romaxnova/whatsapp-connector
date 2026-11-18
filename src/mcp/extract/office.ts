/**
 * Text extraction from Office Open XML files (.docx, .xlsx, .pptx), so Claude can read Word, Excel
 * and PowerPoint files found in mail attachments or Google Drive. No dependencies.
 *
 * Output:
 *   docx  Markdown: one line per paragraph, headings as "#", list items as "- ", tables as pipe tables.
 *   xlsx  CSV per sheet, each introduced by a "## Sheet: <name>" line; dates as ISO 8601.
 *   pptx  Markdown: "## Slide N", one line per paragraph, then "Notes: …" for the speaker notes.
 *
 * An OOXML file is a ZIP "package" of XML "parts". Relationship parts (_rels/<part>.rels) say how
 * the parts refer to each other; the main part is found through _rels/.rels.
 *
 * There is no XML library. Parts are read with a small tokenizer for nested structures (scanXml)
 * and an element matcher for flat ones (elements); both are lenient and run in linear time, since
 * the files are untrusted. Namespace prefixes are ignored, so w:p, a:p and a default-namespace <p>
 * all read as "p": Word writes <w:t>, while Excel usually writes <t> without a prefix.
 */
import { openZip, type ZipArchive } from './zip.js';

export type OfficeKind = 'docx' | 'xlsx' | 'pptx';

export interface OfficeText {
  text: string;
  format: 'text/markdown' | 'text/csv';
  /** Says what was left out, when something was (the rest of a very large workbook, for example). */
  note?: string;
}

/** The file is not the Office document it was expected to be, or cannot be read as one. */
export class OfficeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficeError';
  }
}

const KIND_BY_MIME = new Map<string, OfficeKind>([
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.ms-word.document.macroenabled.12', 'docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.ms-excel.sheet.macroenabled.12', 'xlsx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
  ['application/vnd.ms-powerpoint.presentation.macroenabled.12', 'pptx'],
  // Templates and slideshows are the same packages under another name.
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.template', 'docx'],
  ['application/vnd.ms-word.template.macroenabled.12', 'docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.template', 'xlsx'],
  ['application/vnd.ms-excel.template.macroenabled.12', 'xlsx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.template', 'pptx'],
  ['application/vnd.ms-powerpoint.template.macroenabled.12', 'pptx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.slideshow', 'pptx'],
  ['application/vnd.ms-powerpoint.slideshow.macroenabled.12', 'pptx'],
]);

const KIND_BY_EXTENSION = new Map<string, OfficeKind>([
  ['docx', 'docx'],
  ['docm', 'docx'],
  ['xlsx', 'xlsx'],
  ['xlsm', 'xlsx'],
  ['pptx', 'pptx'],
  ['pptm', 'pptx'],
  ['dotx', 'docx'],
  ['dotm', 'docx'],
  ['xltx', 'xlsx'],
  ['xltm', 'xlsx'],
  ['potx', 'pptx'],
  ['potm', 'pptx'],
  ['ppsx', 'pptx'],
  ['ppsm', 'pptx'],
]);

/** Detects the kind from MIME type or file name (.docx/.docm, .xlsx/.xlsm, .pptx/.pptm, their templates, .ppsx/.ppsm slideshows and their OOXML MIME types); undefined for anything else. */
export function officeKind(mimeType: string | undefined, filename: string | undefined): OfficeKind | undefined {
  const mime = mimeType?.split(';')[0]?.trim().toLowerCase();
  const byMime = mime === undefined ? undefined : KIND_BY_MIME.get(mime);
  if (byMime) return byMime;
  const extension = filename === undefined ? undefined : /\.([a-z]+)\s*$/i.exec(filename)?.[1];
  return extension === undefined ? undefined : KIND_BY_EXTENSION.get(extension.toLowerCase());
}

/** Throws ZipError / OfficeError on unreadable files. Accepts any Uint8Array (a Buffer is one). */
export function extractOfficeText(data: Uint8Array, kind: OfficeKind): OfficeText {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  // Password-protected OOXML files and the older binary formats are OLE compound files, not ZIPs.
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0xd0cf11e0 && bytes.readUInt32BE(4) === 0xa1b11ae1) {
    throw new OfficeError(
      bytes.includes(Buffer.from('EncryptedPackage', 'utf16le'))
        ? 'The file is password-protected, so its text cannot be read.'
        : 'The file is in the older binary Office format (.doc, .xls or .ppt), whose text cannot be read.',
    );
  }
  const pkg = new Package(openZip(bytes));
  switch (kind) {
    case 'docx':
      return { text: wordText(pkg), format: 'text/markdown' };
    case 'xlsx':
      return workbookText(pkg);
    case 'pptx':
      return { text: presentationText(pkg), format: 'text/markdown' };
  }
}

// ---------------------------------------------------------------------------
// Package: parts and relationships
// ---------------------------------------------------------------------------

interface Relationship {
  /** Type URI, matched on its last segment (officeDocument, worksheet, slide…), which strict OOXML shares. */
  type: string;
  /** Path of the target part; undefined for external targets such as web links. */
  target?: string;
}

class Package {
  private lowerCaseNames: Map<string, string> | undefined;

  constructor(readonly zip: ZipArchive) {}

  /** ZIP entry of a part. Part names are case-insensitive in OPC, and producers do not always agree on case. */
  entry(path: string): string | undefined {
    if (this.zip.has(path)) return path;
    this.lowerCaseNames ??= new Map(this.zip.names().map((name): [string, string] => [name.toLowerCase(), name]));
    return this.lowerCaseNames.get(path.toLowerCase());
  }

  text(path: string): string | undefined {
    const entry = this.entry(path);
    return entry === undefined ? undefined : this.zip.readText(entry);
  }

  /** Relationships of a part ('' for the package itself) by id, with targets resolved to part paths. */
  rels(part: string): Map<string, Relationship> {
    const slash = part.lastIndexOf('/');
    const xml = this.text(`${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`) ?? '';
    const rels = new Map<string, Relationship>();
    for (const rel of elements(xml, 'Relationship')) {
      const id = attr(rel.attrs, 'Id');
      const target = attr(rel.attrs, 'Target');
      if (id === undefined || target === undefined) continue;
      const external = attr(rel.attrs, 'TargetMode') === 'External';
      rels.set(id, { type: attr(rel.attrs, 'Type') ?? '', target: external ? undefined : resolvePath(part, target) });
    }
    return rels;
  }
}

/** A relationship target, relative to the source part's folder or absolute ("/xl/…"), as a part path. */
function resolvePath(source: string, target: string): string {
  const segments = target.startsWith('/') ? [] : source.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '..') segments.pop();
    else if (segment !== '.' && segment !== '') segments.push(segment);
  }
  return segments.join('/');
}

/** Target of the first internal relationship of a type, e.g. "styles". */
function targetOfType(rels: Map<string, Relationship>, type: string): string | undefined {
  for (const rel of rels.values()) if (rel.target !== undefined && rel.type.endsWith(`/${type}`)) return rel.target;
  return undefined;
}

/**
 * The main part (word/document.xml, xl/workbook.xml, ppt/presentation.xml), found through _rels/.rels as
 * Office finds it (some producers use other names, such as word/document2.xml), else at its usual path.
 * Its root element must be the expected one, so a workbook passed as a Word document is refused.
 */
function mainPart(pkg: Package, usualPath: string, root: string, error: string): { path: string; xml: string } {
  for (const path of [targetOfType(pkg.rels(''), 'officeDocument'), usualPath]) {
    const xml = path === undefined ? undefined : pkg.text(path);
    if (path !== undefined && xml !== undefined && rootTag(xml)?.name === root) return { path, xml };
  }
  throw new OfficeError(error);
}

// ---------------------------------------------------------------------------
// XML reading
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decodes the five predefined XML entities and numeric character references (&#233; &#xE9;). */
function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (match, dec?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED_ENTITIES[name] ?? match;
    const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? '', 16);
    const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
    return valid ? String.fromCodePoint(code) : '\uFFFD';
  });
}

/** One attribute: name="value" or name='value'. Must follow whitespace, so it never starts inside a value. */
const ATTRIBUTE = /(?:^|\s)([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Value of an attribute in a start tag's attribute text, entity-decoded. `name` is the local name: "val"
 * finds w:val. An unprefixed attribute wins over prefixed ones, and xmlns declarations never match.
 * With `prefixed`, only a prefixed attribute matches: the r:id on <p:sldId id="256" r:id="rId2"/>.
 */
function attr(attrs: string, name: string, prefixed = false): string | undefined {
  let found: string | undefined;
  ATTRIBUTE.lastIndex = 0;
  for (let m = ATTRIBUTE.exec(attrs); m !== null; m = ATTRIBUTE.exec(attrs)) {
    const qualified = m[1] ?? '';
    const value = m[2] ?? m[3] ?? '';
    if (qualified === name && !prefixed) return decodeEntities(value);
    if (found === undefined && qualified.endsWith(`:${name}`) && !qualified.startsWith('xmlns:')) found = decodeEntities(value);
  }
  return found;
}

/** Attribute text of a start tag. Values may use either quote and may contain '>'. */
const ATTRS = String.raw`(?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*`;

/** Name (without prefix) and attribute text of the first element, i.e. the root. */
function rootTag(xml: string): { name: string; attrs: string } | undefined {
  const m = new RegExp(String.raw`<(?:[\w.-]+:)?([\w.-]+)(${ATTRS})\s*/?>`).exec(xml);
  return m ? { name: m[1] ?? '', attrs: m[2] ?? '' } : undefined;
}

interface XmlElement {
  attrs: string;
  /** Raw XML between the start and end tags; '' for a self-closing element. */
  inner: string;
  /** Offset just past the element. */
  end: number;
}

const tagPatterns = new Map<string, { open: RegExp; close: RegExp }>();

/**
 * The first element with this local name (any prefix) at or after `from`. Only for elements that never
 * contain another of the same name: rows, cells, shared strings, relationships and the like. Linear time:
 * the end tag is searched for from the start tag onwards, and an element without one ends the search.
 */
function findElement(xml: string, name: string, from = 0): XmlElement | undefined {
  let patterns = tagPatterns.get(name);
  if (!patterns) {
    patterns = {
      open: new RegExp(String.raw`<(?:[\w.-]+:)?${name}(${ATTRS})\s*(/?)>`, 'g'),
      close: new RegExp(String.raw`</(?:[\w.-]+:)?${name}\s*>`, 'g'),
    };
    tagPatterns.set(name, patterns);
  }
  // The patterns are shared, so they are positioned before each use (this function never yields).
  const { open, close } = patterns;
  open.lastIndex = from;
  const start = open.exec(xml);
  if (start === null) return undefined;
  const attrs = start[1] ?? '';
  if (start[2]) return { attrs, inner: '', end: open.lastIndex };
  close.lastIndex = open.lastIndex;
  const stop = close.exec(xml);
  if (stop === null) return undefined;
  return { attrs, inner: xml.slice(open.lastIndex, stop.index), end: close.lastIndex };
}

/** All elements with this local name, in document order (see findElement). */
function* elements(xml: string, name: string): Generator<XmlElement> {
  for (let element = findElement(xml, name); element !== undefined; element = findElement(xml, name, element.end)) {
    yield element;
  }
}

interface XmlHandler {
  /** A start tag. Self-closing elements get open() immediately followed by close(). */
  open?(name: string, attrs: string): void;
  close?(name: string): void;
  /** Character data, entity-decoded; CDATA sections arrive as they are. */
  text?(text: string): void;
}

const NOTHING: ReadonlySet<string> = new Set();

/**
 * A small, forgiving XML tokenizer: reports tags by local name and text, in document order. Comments,
 * processing instructions and DOCTYPE are skipped. Elements whose local name is in `skip` are dropped
 * with everything inside them. Stops quietly at a tag, comment or CDATA section that never ends.
 */
function scanXml(xml: string, handler: XmlHandler, skip: ReadonlySet<string> = NOTHING): void {
  let skipping = 0; // depth inside a skipped element
  let pos = 0;
  while (pos < xml.length) {
    const lt = xml.indexOf('<', pos);
    const textEnd = lt === -1 ? xml.length : lt;
    if (textEnd > pos && skipping === 0) handler.text?.(decodeEntities(xml.slice(pos, textEnd)));
    if (lt === -1) return;

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) return;
      pos = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) return;
      if (skipping === 0) handler.text?.(xml.slice(lt + 9, end));
      pos = end + 3;
      continue;
    }
    const end = tagEnd(xml, lt);
    if (end === -1) return;
    pos = end + 1;
    const first = xml[lt + 1];
    if (first === '?' || first === '!') continue; // <?xml …?>, <!DOCTYPE …>

    const closing = first === '/';
    const selfClosing = !closing && xml[end - 1] === '/';
    const body = xml.slice(closing ? lt + 2 : lt + 1, selfClosing ? end - 1 : end);
    const qualified = /^[^\s/]*/.exec(body)?.[0] ?? '';
    const name = qualified.slice(qualified.indexOf(':') + 1);
    if (closing) {
      if (skipping > 0) skipping--;
      else handler.close?.(name);
    } else if (skipping > 0 || skip.has(name)) {
      if (!selfClosing) skipping++;
    } else {
      handler.open?.(name, body.slice(qualified.length));
      if (selfClosing) handler.close?.(name);
    }
  }
}

/** Index of the '>' ending the tag that starts at `start`, ignoring any inside quoted values; -1 if none. */
function tagEnd(xml: string, start: number): number {
  let quote = 0;
  for (let i = start + 1; i < xml.length; i++) {
    const ch = xml.charCodeAt(i);
    if (quote !== 0) {
      if (ch === quote) quote = 0;
    } else if (ch === 0x22 || ch === 0x27) {
      quote = ch; // " or '
    } else if (ch === 0x3e) {
      return i; // >
    }
  }
  return -1;
}

/** Character data of an element's inner XML: entities decoded, CDATA unwrapped, child tags dropped. */
function textContent(inner: string): string {
  if (!inner.includes('<')) return decodeEntities(inner);
  let text = '';
  scanXml(inner, { text: (t) => (text += t) });
  return text;
}

/** Joins a list's text lines, trims their ends and keeps at most one blank line in a row. */
function joinLines(lines: string[]): string {
  return lines
    .join('\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}

// ---------------------------------------------------------------------------
// Word (.docx)
// ---------------------------------------------------------------------------

/** Elements whose content is not part of a document's current text. */
const WORD_SKIP: ReadonlySet<string> = new Set([
  'Fallback', // mc:AlternateContent: a copy of the mc:Choice content (text boxes) for older readers
  'del', // tracked deletion
  'moveFrom', // tracked move: the old position (the text also appears at the new one)
  'delText',
  'delInstrText',
  'instrText', // field codes such as PAGE or HYPERLINK "…"; the field's displayed result is kept
  'tabs', // tab stop definitions, whose <w:tab> elements are not tab characters
  'pPrChange', // paragraph, run and cell properties before a tracked formatting change
  'rPrChange',
  'tcPrChange',
  'rt', // ruby: the phonetic guide printed above East Asian text
]);

interface Paragraph {
  text: string;
  style?: string;
  /** Own outline level (0-8 for headings, 9 for body text), overriding the style's. */
  outline?: number;
  /** Numbering instance; "0" switches off numbering that the style would add. */
  numId?: string;
  level: number;
}

interface Table {
  rows: string[][];
  row?: string[];
  cell?: { parts: string[]; span: number };
}

function wordText(pkg: Package): string {
  const doc = mainPart(pkg, 'word/document.xml', 'document', 'Not a Word document');
  const styleOf = paragraphStyles(pkg.text(targetOfType(pkg.rels(doc.path), 'styles') ?? 'word/styles.xml') ?? '');

  const lines: string[] = [];
  const paragraphs: Paragraph[] = []; // open paragraphs: a text box puts paragraphs inside a paragraph
  const tables: Table[] = []; // open tables, innermost last
  let inText = false;

  const append = (text: string) => {
    const paragraph = paragraphs.at(-1);
    if (paragraph) paragraph.text += text;
  };
  const val = (attrs: string) => {
    const n = Number.parseInt(attr(attrs, 'val') ?? '', 10);
    return Number.isNaN(n) ? undefined : n;
  };

  const endParagraph = (paragraph: Paragraph) => {
    const cell = tables.at(-1)?.cell;
    if (cell) cell.parts.push(paragraph.text);
    else lines.push(renderParagraph(paragraph, styleOf(paragraph.style)));
  };
  const endTable = (table: Table) => {
    const outer = tables.at(-1)?.cell;
    // A table inside a table cell is flattened into that cell's text.
    if (outer) outer.parts.push(table.rows.flat().join(' '));
    else lines.push(`\n${markdownTable(table.rows).join('\n')}\n`);
  };

  scanXml(
    doc.xml,
    {
      open(name, attrs) {
        const paragraph = paragraphs.at(-1);
        const table = tables.at(-1);
        switch (name) {
          case 'p':
            paragraphs.push({ text: '', level: 0 });
            break;
          case 'pStyle':
            if (paragraph) paragraph.style = attr(attrs, 'val');
            break;
          case 'outlineLvl':
            if (paragraph) paragraph.outline = val(attrs);
            break;
          case 'numId':
            if (paragraph) paragraph.numId = attr(attrs, 'val');
            break;
          case 'ilvl':
            if (paragraph) paragraph.level = Math.min(Math.max(val(attrs) ?? 0, 0), 8);
            break;
          case 't':
            inText = true;
            break;
          case 'tab':
          case 'ptab':
            append('\t');
            break;
          case 'br':
          case 'cr':
            append('\n');
            break;
          case 'noBreakHyphen':
            append('-');
            break;
          case 'tbl':
            tables.push({ rows: [] });
            break;
          case 'tr':
            if (table) table.row = [];
            break;
          case 'tc':
            if (table) table.cell = { parts: [], span: 1 };
            break;
          case 'gridSpan': // a cell merged across columns; Word allows at most 63
            if (table?.cell) table.cell.span = Math.min(Math.max(val(attrs) ?? 1, 1), 63);
            break;
        }
      },
      close(name) {
        const table = tables.at(-1);
        switch (name) {
          case 't':
            inText = false;
            break;
          case 'p': {
            const paragraph = paragraphs.pop();
            if (paragraph) endParagraph(paragraph);
            break;
          }
          case 'tc':
            if (table?.row && table.cell) {
              // Merged cells keep the columns aligned with empty cells after them.
              table.row.push(tableCell(table.cell.parts), ...new Array<string>(table.cell.span - 1).fill(''));
            }
            if (table) table.cell = undefined;
            break;
          case 'tr':
            if (table?.row) table.rows.push(table.row);
            if (table) table.row = undefined;
            break;
          case 'tbl': {
            const done = tables.pop();
            if (done) endTable(done);
            break;
          }
        }
      },
      text(text) {
        if (inText) append(text);
      },
    },
    WORD_SKIP,
  );
  return joinLines(lines);
}

function renderParagraph(paragraph: Paragraph, style: ParagraphStyle): string {
  const text = paragraph.text;
  if (!text.trim()) return '';
  const heading =
    paragraph.outline === undefined ? style.heading : paragraph.outline >= 0 && paragraph.outline < 9 ? paragraph.outline + 1 : 0;
  if (heading > 0) return `${'#'.repeat(Math.min(heading, 6))} ${oneLine(text)}`;
  const listed = paragraph.numId === undefined ? style.list : paragraph.numId !== '0';
  if (listed) return `${'  '.repeat(paragraph.level)}- ${text.trim()}`;
  return text;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A table cell's paragraphs on one line. */
function tableCell(parts: string[]): string {
  return oneLine(parts.join(' '));
}

/** Rows as a pipe table: the first row is the header, all rows get the same number of cells, pipes are escaped. */
function markdownTable(rows: string[][]): string[] {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (width === 0) return [];
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => (cells[i] ?? '').replace(/\|/g, '\\|')).join(' | ')} |`;
  const [header = [], ...body] = rows;
  return [line(header), line(new Array<string>(width).fill('---')), ...body.map(line)];
}

interface ParagraphStyle {
  /** Heading level 1-9, 0 for none. */
  heading: number;
  list: boolean;
}

/**
 * Heading level and list status of paragraph styles, by style id. Word localizes style ids ("Titre1",
 * "berschrift1"), so they are identified by their built-in English name ("heading 1"), or an outline
 * level, or numbering, each inherited through basedOn. Unknown ids fall back to the id itself ("Heading2").
 */
function paragraphStyles(xml: string): (id: string | undefined) => ParagraphStyle {
  const styles = new Map<string, { heading?: number; list?: boolean; basedOn?: string }>();
  for (const style of elements(xml, 'style')) {
    const id = attr(style.attrs, 'styleId');
    if (id === undefined || attr(style.attrs, 'type') !== 'paragraph') continue;
    const child = (name: string) => {
      const element = findElement(style.inner, name);
      return element && attr(element.attrs, 'val');
    };
    const outline = Number.parseInt(child('outlineLvl') ?? '', 10);
    const numId = child('numId');
    styles.set(id, {
      heading: headingLevel(child('name') ?? '') ?? (outline >= 0 && outline < 9 ? outline + 1 : undefined),
      list: numId === undefined ? undefined : numId !== '0',
      basedOn: child('basedOn'),
    });
  }
  return (id) => {
    let heading: number | undefined;
    let list: boolean | undefined;
    // Follow basedOn (a few steps at most, in case of a cycle) until both are known.
    for (let current = id, steps = 0; current !== undefined && steps < 10; steps++) {
      const style = styles.get(current);
      if (!style) {
        heading ??= headingLevel(current);
        break;
      }
      heading ??= style.heading;
      list ??= style.list;
      current = style.basedOn;
    }
    return { heading: heading ?? 0, list: list ?? false };
  };
}

/** Heading level of a built-in style name or id: "heading 2" and "Heading2" are 2, "Title" is 1. */
function headingLevel(name: string): number | undefined {
  if (/^title$/i.test(name)) return 1;
  const m = /^heading\s*([1-9])$/i.exec(name);
  return m ? Number(m[1]) : undefined;
}

// ---------------------------------------------------------------------------
// Excel (.xlsx)
// ---------------------------------------------------------------------------

/** Most cells (and blank lines) written for one workbook. */
const MAX_CELLS = 200_000;
/** Longest run of blank lines written for empty rows between rows with data. */
const MAX_BLANK_ROWS = 1000;

type DateKind = 'date' | 'datetime' | 'time' | 'duration';

interface Workbook {
  strings: string[];
  /** Per cell format (the index in a cell's s attribute): how a number in that format reads as a date, if it does. */
  dateKinds: (DateKind | undefined)[];
  date1904: boolean;
}

function workbookText(pkg: Package): OfficeText {
  const main = mainPart(pkg, 'xl/workbook.xml', 'workbook', 'Not an Excel workbook');
  const rels = pkg.rels(main.path);
  const strings = pkg.text(targetOfType(rels, 'sharedStrings') ?? 'xl/sharedStrings.xml') ?? '';
  const styles = pkg.text(targetOfType(rels, 'styles') ?? 'xl/styles.xml') ?? '';
  const book: Workbook = {
    strings: Array.from(elements(strings, 'si'), (si) => richText(si.inner)),
    dateKinds: cellDateKinds(styles),
    // Workbooks from old Mac Excel count days from 1904 instead of 1900.
    date1904: /^(1|true)$/i.test(attr(findElement(main.xml, 'workbookPr')?.attrs ?? '', 'date1904') ?? ''),
  };

  const blocks: string[] = [];
  const notes: string[] = [];
  const left: string[] = [];
  let budget = MAX_CELLS;
  let cut = false;
  for (const sheet of elements(findElement(main.xml, 'sheets')?.inner ?? '', 'sheet')) {
    const name = attr(sheet.attrs, 'name') ?? '';
    const rel = rels.get(attr(sheet.attrs, 'id', true) ?? '');
    // Chart sheets, dialog sheets and Excel 4 macro sheets have no cells worth reading.
    if (rel?.target === undefined || !rel.type.endsWith('/worksheet')) continue;
    if (cut) {
      left.push(`"${name}"`);
      continue;
    }
    const xml = pkg.text(rel.target);
    if (xml === undefined) continue;
    const sheetCsv = csvLines(xml, book, budget);
    budget -= sheetCsv.cells;
    const hidden = /hidden/i.test(attr(sheet.attrs, 'state') ?? ''); // hidden or veryHidden
    blocks.push([`## Sheet: ${name}${hidden ? ' (hidden)' : ''}`, ...sheetCsv.lines].join('\n'));
    if (sheetCsv.shortenedGaps) {
      notes.push(`In sheet "${name}", runs of more than ${MAX_BLANK_ROWS} empty rows were shortened, so its later lines no longer match row numbers.`);
    }
    if (sheetCsv.stoppedAtRow !== undefined) {
      notes.push(`The output stops at ${MAX_CELLS} cells: sheet "${name}" is cut before row ${sheetCsv.stoppedAtRow}.`);
      cut = true;
    }
  }
  if (left.length > 0) notes.push(`Sheets left out: ${left.join(', ')}.`);
  const text = blocks.join('\n\n');
  return notes.length > 0 ? { text, format: 'text/csv', note: notes.join(' ') } : { text, format: 'text/csv' };
}

interface SheetCsv {
  lines: string[];
  /** Cells and blank lines written, counted against the workbook's budget. */
  cells: number;
  /** Set when the budget ran out: the first row not written. */
  stoppedAtRow?: number;
  shortenedGaps: boolean;
}

/**
 * CSV lines of a worksheet. Line N is row N: skipped row numbers become blank lines (at most
 * MAX_BLANK_ROWS in a row), skipped columns empty cells. Empty cells at the end of a row and
 * empty rows at the end of the sheet are left out.
 */
function csvLines(xml: string, book: Workbook, budget: number): SheetCsv {
  const result: SheetCsv = { lines: [], cells: 0, shortenedGaps: false };
  let rowNumber = 0;
  let blanks = 0; // empty rows since the last row with values; written only if values follow
  for (const row of elements(findElement(xml, 'sheetData')?.inner ?? '', 'row')) {
    const r = Number(attr(row.attrs, 'r'));
    const next = Number.isInteger(r) && r > rowNumber ? r : rowNumber + 1;
    blanks += next - rowNumber - 1;
    rowNumber = next;
    const values = rowValues(row.inner, book);
    if (values.length === 0) {
      blanks++;
      continue;
    }
    if (blanks > MAX_BLANK_ROWS) {
      blanks = MAX_BLANK_ROWS;
      result.shortenedGaps = true;
    }
    if (result.cells + blanks + values.length > budget) {
      result.stoppedAtRow = rowNumber;
      break;
    }
    result.cells += blanks + values.length;
    for (; blanks > 0; blanks--) result.lines.push('');
    result.lines.push(values.map(csvField).join(','));
  }
  return result;
}

/** A row's values by column: a cell's r attribute (e.g. C12) places it, otherwise it follows the previous cell. */
function rowValues(xml: string, book: Workbook): string[] {
  const values: string[] = [];
  let column = 0;
  for (const cell of elements(xml, 'c')) {
    const ref = attr(cell.attrs, 'r');
    column = (ref === undefined ? undefined : columnIndex(ref)) ?? column;
    values[column] = cellValue(cell, book);
    column++;
  }
  let length = values.length;
  while (length > 0 && !values[length - 1]) length--;
  return Array.from({ length }, (_, i) => values[i] ?? '');
}

/** Zero-based column of a cell reference: A1 is 0, Z1 25, AA1 26. */
function columnIndex(ref: string): number | undefined {
  const letters = /^([A-Za-z]{1,3})\d+$/.exec(ref)?.[1];
  if (letters === undefined) return undefined;
  let column = 0;
  for (const letter of letters.toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64;
  return column - 1;
}

function cellValue(cell: XmlElement, book: Workbook): string {
  const type = attr(cell.attrs, 't') ?? 'n';
  if (type === 'inlineStr') {
    const inline = findElement(cell.inner, 'is');
    return inline ? richText(inline.inner) : '';
  }
  // No cached value: an empty formatted cell, or a formula its producer never calculated.
  const value = findElement(cell.inner, 'v');
  const raw = value ? textContent(value.inner) : '';
  if (raw === '') return '';
  switch (type) {
    case 's': // index into the shared strings
      return book.strings[Number(raw)] ?? '';
    case 'str': // text result of a formula
      return unescapeXstring(raw);
    case 'b':
      return /^\s*(1|true)\s*$/i.test(raw) ? 'TRUE' : 'FALSE';
    case 'e': // error such as #DIV/0!
    case 'd': // ISO 8601 date, written by some producers
      return raw;
    default:
      return numberText(raw, book.dateKinds[Number(attr(cell.attrs, 's') ?? 0)], book.date1904);
  }
}

/** Phonetic guides (furigana) inside rich text. */
const PHONETIC: ReadonlySet<string> = new Set(['rPh']);

/** Text of a shared string (<si>) or inline string (<is>): its <t> runs, without phonetic guides. */
function richText(xml: string): string {
  let text = '';
  let inText = false;
  scanXml(
    xml,
    {
      open: (name) => {
        if (name === 't') inText = true;
      },
      close: (name) => {
        if (name === 't') inText = false;
      },
      text: (t) => {
        if (inText) text += t;
      },
    },
    PHONETIC,
  );
  return unescapeXstring(text);
}

/** SpreadsheetML escapes characters XML cannot carry, and a literal "_x", as _xHHHH_: _x000D_ is a carriage return. */
function unescapeXstring(text: string): string {
  if (!text.includes('_x')) return text;
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function numberText(raw: string, kind: DateKind | undefined, date1904: boolean): string {
  const value = Number(raw);
  if (!Number.isFinite(value) || raw.trim() === '') return raw;
  const date = kind === undefined ? undefined : serialToText(value, kind, date1904);
  // Excel shows at most 15 significant digits, which also hides float noise like 0.30000000000000004.
  return date ?? String(Number(value.toPrecision(15)));
}

/** Built-in number formats that show dates or times (ECMA-376 Part 1, 18.8.30). */
function builtInDateKind(id: number): DateKind | undefined {
  if (id >= 14 && id <= 17) return 'date'; // m/d/yyyy, d-mmm-yy, d-mmm, mmm-yy
  if (id >= 18 && id <= 21) return 'time'; // h:mm AM/PM, h:mm:ss AM/PM, h:mm, h:mm:ss
  if (id === 22) return 'datetime'; // m/d/yyyy h:mm
  if (id === 45 || id === 47) return 'time'; // mm:ss, mm:ss.0
  if (id === 46) return 'duration'; // [h]:mm:ss
  // East Asian locale formats: dates, except 32 and 33, which are times.
  if (id === 32 || id === 33) return 'time';
  if ((id >= 27 && id <= 36) || (id >= 50 && id <= 58)) return 'date';
  return undefined;
}

/**
 * Whether a custom number format shows dates or times: it does when d, m, y, h or s appear outside
 * quoted text ("days"), escaped characters (\d), padding and fill characters (_x, *x) and bracketed
 * sections ([Red], [$-409], [>=100]). An elapsed-time bracket ([h], [mm], [ss]) makes it a duration.
 * m stands for minutes next to h or s, and for the month otherwise.
 */
function formatDateKind(code: string): DateKind | undefined {
  const unquoted = code.replace(/"[^"]*"|\\.|[_*]./g, '');
  if (/\[(?:h+|m+|s+)\]/i.test(unquoted)) return 'duration';
  const bare = unquoted.replace(/\[[^\]]*\]/g, '');
  const time = /[hs]/i.test(bare);
  const date = /[dy]/i.test(bare) || (/m/i.test(bare) && !time);
  return date && time ? 'datetime' : date ? 'date' : time ? 'time' : undefined;
}

/** For each cell format in styles.xml (<cellXfs>, which a cell's s attribute indexes): its date kind, if any. */
function cellDateKinds(xml: string): (DateKind | undefined)[] {
  const codes = new Map<number, string>();
  for (const format of elements(findElement(xml, 'numFmts')?.inner ?? '', 'numFmt')) {
    codes.set(Number(attr(format.attrs, 'numFmtId')), attr(format.attrs, 'formatCode') ?? '');
  }
  return Array.from(elements(findElement(xml, 'cellXfs')?.inner ?? '', 'xf'), (xf) => {
    const id = Number(attr(xf.attrs, 'numFmtId') ?? 0);
    const code = codes.get(id);
    return code === undefined ? builtInDateKind(id) : formatDateKind(code);
  });
}

const DAY_MS = 86_400_000;

/**
 * A date serial (days since the epoch, the fraction being the time of day) as ISO 8601 text:
 * YYYY-MM-DD, YYYY-MM-DDTHH:MM(:SS), HH:MM(:SS), or H:MM(:SS) for elapsed time. Undefined when
 * out of Excel's range, where it shows #### instead.
 *
 * 1900 system: serial 1 is 1900-01-01, and 60 is 1900-02-29, a day that never was, kept for
 * compatibility with Lotus 1-2-3; so from serial 61 on, dates are one day behind a plain count.
 * 1904 system: serial 0 is 1904-01-01.
 */
function serialToText(serial: number, kind: DateKind, date1904: boolean): string | undefined {
  if (kind === 'duration') {
    return `${serial < 0 ? '-' : ''}${clock(Math.round(Math.abs(serial) * 86_400), false)}`;
  }
  if (serial < 0) return undefined;
  const seconds = Math.round(serial * 86_400);
  const days = Math.floor(seconds / 86_400);
  if (days > (date1904 ? 2_957_003 : 2_958_465)) return undefined; // after 9999-12-31
  const time = clock(seconds - days * 86_400, true);
  if (kind === 'time') return time;
  let date: string;
  if (date1904) date = isoDate(Date.UTC(1904, 0, 1), days);
  else if (days === 60) date = '1900-02-29';
  else date = isoDate(days < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30), days);
  return kind === 'date' ? date : `${date}T${time}`;
}

function isoDate(epoch: number, days: number): string {
  return new Date(epoch + days * DAY_MS).toISOString().slice(0, 10);
}

/** HH:MM, with :SS only when there are seconds. Hours are not wrapped at 24 (durations). */
function clock(totalSeconds: number, padHours: boolean): string {
  const hours = String(Math.floor(totalSeconds / 3600));
  const minutes = String(Math.floor(totalSeconds / 60) % 60).padStart(2, '0');
  const seconds = totalSeconds % 60;
  return `${padHours ? hours.padStart(2, '0') : hours}:${minutes}${seconds ? `:${String(seconds).padStart(2, '0')}` : ''}`;
}

/** RFC 4180: fields with a comma, quote or line break are quoted, and quotes inside doubled. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// ---------------------------------------------------------------------------
// PowerPoint (.pptx)
// ---------------------------------------------------------------------------

/** mc:AlternateContent keeps a copy of the mc:Choice content for older readers. */
const DRAWING_SKIP: ReadonlySet<string> = new Set(['Fallback']);

function presentationText(pkg: Package): string {
  const main = mainPart(pkg, 'ppt/presentation.xml', 'presentation', 'Not a PowerPoint presentation');
  const rels = pkg.rels(main.path);
  // Presentation order is the order of <p:sldIdLst>, not of the slideN.xml file names.
  const listed: string[] = [];
  for (const id of elements(findElement(main.xml, 'sldIdLst')?.inner ?? '', 'sldId')) {
    const target = rels.get(attr(id.attrs, 'id', true) ?? '')?.target;
    if (target !== undefined && pkg.entry(target) !== undefined) listed.push(target);
  }
  const slides = listed.length > 0 ? listed : slidesByName(pkg.zip.names());

  return slides
    .map((path, i) => {
      const xml = pkg.text(path) ?? '';
      const hidden = /^(0|false)$/.test(attr(rootTag(xml)?.attrs ?? '', 'show') ?? '');
      const lines = [`## Slide ${i + 1}${hidden ? ' (hidden)' : ''}`, ...slideParagraphs(xml)];
      const notesPath = targetOfType(pkg.rels(path), 'notesSlide');
      const notes = notesPath === undefined ? [] : slideParagraphs(pkg.text(notesPath) ?? '');
      if (notes.length > 0) lines.push(`Notes: ${notes.join('\n')}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

/** ppt/slides/slideN.xml in natural order (slide2 before slide10), for packages whose slide list cannot be followed. */
function slidesByName(names: string[]): string[] {
  const numbered = names.flatMap((name) => {
    const n = /^ppt\/slides\/slide(\d+)\.xml$/i.exec(name)?.[1];
    return n === undefined ? [] : [{ name, n: Number(n) }];
  });
  return numbered.sort((a, b) => a.n - b.n).map((slide) => slide.name);
}

/** Non-empty paragraphs (<a:p>) of a slide or notes page; <a:br/> breaks a line. The slide number placeholder is left out. */
function slideParagraphs(xml: string): string[] {
  const paragraphs: string[] = [];
  let paragraph: string | undefined;
  let inText = false;
  let slideNumber = false; // inside the shape of a slide number placeholder
  scanXml(
    xml,
    {
      open(name, attrs) {
        if (name === 'sp') slideNumber = false;
        else if (name === 'ph' && attr(attrs, 'type') === 'sldNum') slideNumber = true;
        else if (name === 'p') paragraph = '';
        else if (name === 't') inText = true;
        else if (name === 'br' && paragraph !== undefined) paragraph += '\n';
      },
      close(name) {
        if (name === 't') inText = false;
        else if (name === 'sp') slideNumber = false;
        else if (name === 'p' && paragraph !== undefined) {
          const text = paragraph.trim();
          if (text && !slideNumber) paragraphs.push(text);
          paragraph = undefined;
        }
      },
      text(text) {
        if (inText && paragraph !== undefined) paragraph += text;
      },
    },
    DRAWING_SKIP,
  );
  return paragraphs;
}
