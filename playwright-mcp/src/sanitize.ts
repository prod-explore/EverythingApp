/**
 * Deterministic text cleaning for everything that comes out of a web page (Observation v2).
 *
 * No LLM is involved: page text and element labels are normalised and stripped of characters
 * that are invisible to a human but readable by a model — the classic carriers of hidden prompt
 * injection ("ASCII smuggling" via Unicode tag characters, zero-width payloads, bidi tricks that
 * make text read differently than it renders). Counts of what was stripped are returned so the
 * injection heuristic can use them as a signal.
 */

export interface SanitizeStats {
  /** Unicode "tag" characters U+E0000–U+E007F (invisible ASCII mirror — used for smuggling). */
  tagChars: number;
  /** Zero-width / invisible formatting characters (ZWSP, ZWJ, word joiner, BOM, soft hyphen, variation selectors…). */
  zeroWidth: number;
  /** Bidirectional control characters (LRE/RLE/PDF/LRO/RLO, isolates, LRM/RLM/ALM). */
  bidi: number;
  /** Other C0/C1 control characters (everything except \n and \t). */
  control: number;
}

export interface SanitizeResult {
  text: string;
  stats: SanitizeStats;
  truncated: boolean;
  /** Length of the cleaned text before the length cap was applied. */
  fullLength: number;
}

export function emptyStats(): SanitizeStats {
  return { tagChars: 0, zeroWidth: 0, bidi: 0, control: 0 };
}

export function addStats(a: SanitizeStats, b: SanitizeStats): SanitizeStats {
  return {
    tagChars: a.tagChars + b.tagChars,
    zeroWidth: a.zeroWidth + b.zeroWidth,
    bidi: a.bidi + b.bidi,
    control: a.control + b.control,
  };
}

const TAG_RE = /[\u{E0000}-\u{E007F}]/gu;
// ZWSP, ZWNJ, ZWJ, word joiner + invisible operators, BOM/ZWNBSP, Mongolian vowel separator, soft hyphen,
// combining grapheme joiner, Hangul fillers, variation selectors (both blocks — "sneaky bits" encodings).
const ZERO_WIDTH_RE =
  /[\u200B-\u200D\u2060-\u2064\uFEFF\u180E\u00AD\u034F\u115F\u1160\u3164\uFFA0\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;
// LRM, RLM, ALM, LRE/RLE/PDF/LRO/RLO, LRI/RLI/FSI/PDI.
const BIDI_RE = /[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g;
// C0 (minus \t \n \r) + DEL + C1, plus the Unicode line/paragraph separators (normalised to \n later).
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

function countAndStrip(input: string, re: RegExp): [string, number] {
  let n = 0;
  const out = input.replace(re, () => {
    n++;
    return '';
  });
  return [out, n];
}

/** Strips invisible/control characters and applies NFKC, without touching whitespace layout. */
export function stripInvisible(input: string): { text: string; stats: SanitizeStats } {
  const stats = emptyStats();
  let s = input;
  // Tag chars first: they are astral and NFKC leaves them alone.
  [s, stats.tagChars] = countAndStrip(s, TAG_RE);
  let n: number;
  [s, n] = countAndStrip(s, ZERO_WIDTH_RE);
  stats.zeroWidth += n;
  [s, n] = countAndStrip(s, BIDI_RE);
  stats.bidi += n;
  s = s.replace(/\r\n?/g, '\n').replace(/[\u2028\u2029\u0085]/g, '\n');
  [s, n] = countAndStrip(s, CONTROL_RE);
  stats.control += n;
  // NFKC folds full-width / stylised / compatibility forms ("ｉｇｎｏｒｅ", "𝐢𝐠𝐧𝐨𝐫𝐞") onto plain letters, so
  // they read the same to the injection heuristic as they do to a model.
  s = s.normalize('NFKC');
  // NFKC can't introduce new invisibles in practice, but a second pass is cheap insurance.
  [s, n] = countAndStrip(s, ZERO_WIDTH_RE);
  stats.zeroWidth += n;
  [s, n] = countAndStrip(s, BIDI_RE);
  stats.bidi += n;
  return { text: s, stats };
}

/** Cuts to at most `max` UTF-16 units without splitting a surrogate pair. */
export function capLength(s: string, max: number): { text: string; truncated: boolean } {
  if (max <= 0) return { text: '', truncated: s.length > 0 };
  if (s.length <= max) return { text: s, truncated: false };
  let cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { text: cut, truncated: true };
}

/**
 * Multi-line page text: strip invisibles, NFKC, collapse horizontal whitespace, trim each line, collapse
 * runs of blank lines, then cap length.
 */
export function sanitizeText(input: string, maxLength = Number.POSITIVE_INFINITY): SanitizeResult {
  const { text: stripped, stats } = stripInvisible(input ?? '');
  const cleaned = stripped
    .replace(/[^\S\n]+/g, ' ')
    .split('\n')
    .map(l => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const capped = capLength(cleaned, maxLength);
  return { text: capped.text, stats, truncated: capped.truncated, fullLength: cleaned.length };
}

export const DEFAULT_LABEL_MAX = 100;

/** Single-line label: like sanitizeText but all whitespace collapses to one space; overlong labels end in "…". */
export function sanitizeLabel(input: string, maxLength = DEFAULT_LABEL_MAX): { text: string; stats: SanitizeStats } {
  const { text: stripped, stats } = stripInvisible(input ?? '');
  const oneLine = stripped.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLength) return { text: oneLine, stats };
  const capped = capLength(oneLine, Math.max(0, maxLength - 1));
  return { text: capped.text.trimEnd() + '…', stats };
}
