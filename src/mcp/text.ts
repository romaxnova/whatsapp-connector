/**
 * Text normalisation shared by the tools. Google returns text the way senders
 * wrote it: CRLF line endings, invisible "preheader" padding in marketing mail,
 * analytics parameters on every link. None of it helps Claude read, and all of
 * it costs context in claude.ai.
 */

/**
 * Characters that render as nothing: soft hyphen, combining grapheme joiner,
 * Mongolian vowel separator, zero-width space, word joiner and invisible
 * operators, byte-order mark.
 */
const INVISIBLE = /[­͏᠎​⁠-⁤﻿]/g;

/**
 * Zero-width (non-)joiners repeated with only spaces between them: e-mail
 * preheader padding. A single joiner inside a word or an emoji sequence is kept.
 */
const JOINER_PADDING = /(?:[‌‍][ \t   ]*){2,}/g;

const TRAILING_SPACE = /[ \t   ]+$/gm;

/** Line endings to \n and a leading byte-order mark removed. Safe for data formats (CSV, JSON, ICS). */
export function normalizeNewlines(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/**
 * For prose (mail bodies, documents, event descriptions): invisible characters
 * and padding removed, trailing spaces trimmed, runs of blank lines collapsed
 * to one. Indentation and spacing inside lines are kept.
 */
export function cleanText(text: string): string {
  return normalizeNewlines(text)
    .replace(INVISIBLE, '')
    .replace(JOINER_PADDING, ' ')
    .replace(TRAILING_SPACE, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}

/** cleanText squeezed onto a single line (snippets, previews). */
export function oneLine(text: string): string {
  return cleanText(text).replace(/\s+/g, ' ').trim();
}

const TRACKING_PARAM = /^(?:utm_[a-z0-9_]+|fbclid|gclid|dclid|gbraid|wbraid|yclid|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok|igshid)$/i;
const URL_IN_TEXT = /https?:\/\/[^\s<>()"'\]]+/g;

/**
 * Removes analytics parameters (utm_*, fbclid, gclid, ...) from links in text.
 * They never change where a link leads, and in notification mail they often
 * double a link's length. Links without such parameters are left untouched.
 */
export function stripTrackingParams(text: string): string {
  return text.replace(URL_IN_TEXT, (match) => {
    // Punctuation that ends the sentence is not part of the link.
    const m = /^(.*?)([.,;:!?]*)$/s.exec(match);
    const url = m?.[1] ?? match;
    const tail = m?.[2] ?? '';
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return match;
    }
    const tracking = [...new Set(parsed.searchParams.keys())].filter((k) => TRACKING_PARAM.test(k));
    if (tracking.length === 0) return match;
    for (const k of tracking) parsed.searchParams.delete(k);
    return parsed.href + tail;
  });
}

/**
 * Drops trailing empty cells (commas outside quotes) from each CSV record and
 * empty records at the end. Leading and inner empty cells, and empty records
 * in the middle, are kept so column and row positions stay the same.
 */
export function trimCsv(csv: string): string {
  const records: string[] = [];
  let start = 0;
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv.charCodeAt(i);
    if (ch === 34) inQuotes = !inQuotes; // '"'; an escaped "" toggles twice
    else if (ch === 10 && !inQuotes) {
      records.push(csv.slice(start, i).replace(/,+$/, ''));
      start = i + 1;
    }
  }
  records.push(csv.slice(start).replace(/,+$/, ''));
  while (records.length > 0 && records[records.length - 1] === '') records.pop();
  return records.join('\n');
}
