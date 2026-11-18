/** Text decoding and HTML-to-text, taken from G-Spot Assistant's gmail-mime module. */
export function decodeBytes(bytes: Uint8Array, charset?: string): string {
  return textDecoder(charset || 'utf-8').decode(bytes);
}

function textDecoder(label: string) {
  try {
    return new TextDecoder(label);
  } catch {
    // Unknown or unsupported charset label (RangeError): UTF-8 is the best guess.
    return new TextDecoder('utf-8');
  }
}

const PARA = '\u0001';
const BLOCK_TAGS = 'p|div|li|tr|h[1-6]|blockquote|table|ul|ol|pre|section|article|header|footer|dl|dd|dt|address|figure|figcaption';
const PARAGRAPH_TAGS = 'p|h[1-6]|blockquote|table|ul|ol|pre';
const LINK_RE = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;

/** Converts HTML to compact plain text: block structure becomes newlines, links keep their target when it adds information. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    // Line breaks in HTML source are just whitespace; only tags create structure.
    .replace(/[\r\n\t]+/g, ' ')
    .replace(LINK_RE, (_m, dq: string | undefined, sq: string | undefined, bare: string | undefined, inner: string) => linkToText(dq ?? sq ?? bare ?? '', inner))
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\b[^>]*>/gi, `${PARA}---${PARA}`)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(new RegExp(`</(${PARAGRAPH_TAGS})\\s*>`, 'gi'), PARA)
    .replace(new RegExp(`</?(${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<\/(td|th)\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  return collapseWhitespace(decodeEntities(text));
}

function linkToText(href: string, inner: string): string {
  const url = decodeEntities(href).trim();
  const label = collapseWhitespace(decodeEntities(inner.replace(/<[^>]+>/g, '')));
  if (!label || !url || /^(#|javascript:)/i.test(url) || sameTarget(label, url)) return inner;
  return `${inner} (${url})`;
}

function sameTarget(label: string, url: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/^(https?:\/\/|mailto:)/, '').replace(/^www\./, '').replace(/\/+$/, '');
  return norm(label) === norm(url);
}

function collapseWhitespace(s: string): string {
  return s
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *([\n\u0001]) */g, '$1')
    .replace(/[\n\u0001]+/g, (run) => (run.includes(PARA) ? '\n\n' : '\n'))
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  euro: '€', pound: '£', yen: '¥', cent: '¢', middot: '·', bull: '•', deg: '°', times: '×',
  shy: '', zwnj: '', zwj: '',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', aacute: 'á', acirc: 'â', auml: 'ä',
  ccedil: 'ç', ntilde: 'ñ', iacute: 'í', icirc: 'î', iuml: 'ï', oacute: 'ó', ocirc: 'ô', ouml: 'ö',
  uacute: 'ú', ucirc: 'û', uuml: 'ü', szlig: 'ß', oslash: 'ø', aring: 'å', aelig: 'æ',
};

/** Decodes named (common subset) and numeric HTML entities. Gmail snippets are entity-encoded too. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const hex = entity[1] === 'x' || entity[1] === 'X';
      const cp = hex ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      const valid = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
      return valid ? String.fromCodePoint(cp) : match;
    }
    return NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

// ---------------------------------------------------------------------------
// Quoted-reply stripping
// ---------------------------------------------------------------------------

