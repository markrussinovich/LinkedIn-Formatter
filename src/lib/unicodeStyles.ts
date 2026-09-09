export interface UnicodeStyleOptions {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  underline?: boolean;
}

type UnicodeVariant = 'bold' | 'italic' | 'boldItalic' | 'monospace';

// Bare URL matcher, shared with the X/Mastodon character-weighting logic (each
// URL counts as a fixed 23 characters there) and link-preview extraction.
//
// - The protocol is spelled with character classes ([hH]…) instead of an `i`
//   flag because consumers rebuild the regex from `.source` with their own
//   flags, which would silently drop case-insensitivity.
// - The URL stops before common trailing sentence punctuation so exported
//   links like `Label (https://url)` and prose like `see https://a.co, ok`
//   count the punctuation as ordinary text, matching how X/Mastodon extract
//   URLs. One level of balanced parentheses is allowed inside the URL (like
//   twitter-text), so `https://en.wikipedia.org/wiki/A_(B)` matches whole
//   while an unbalanced `(`/`)` ends the URL. Tradeoff: a URL that genuinely
//   ends in stripped punctuation is slightly over-counted (its tail counts as
//   text) — never under-counted, which would let a post exceed the platform
//   limit and be rejected.
//
// Kept in sync with the URL arm of LINKEDIN_TOKEN_PATTERN below.
const URL_PATTERN_SOURCE = String.raw`[hH][tT][tT][pP][sS]?://(?:\([^\s()]*\)|[^\s()])*(?:\([^\s()]*\)|[^\s.,!?;:)\]}'"»›])`;
export const URL_PATTERN = new RegExp(URL_PATTERN_SOURCE, 'gu');

const LINKEDIN_TOKEN_PATTERN = new RegExp(`(${URL_PATTERN_SOURCE}|[#@][A-Za-z0-9_][A-Za-z0-9_.-]*)`, 'gu');
const EMOJI_PATTERN = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/u;
const COMBINING_MARK_PATTERN = /\p{Mark}/u;
// A grapheme cluster renders as emoji when it contains a pictographic or
// emoji-presentation code point, or emoji plumbing (ZWJ, VS16, combining
// keycap, regional indicators, skin-tone modifiers). Such clusters must not
// receive combining marks anywhere inside — inserting one between a ZWJ or a
// keycap base and its VS16/U+20E3 shatters the sequence into parts.
const EMOJI_CLUSTER_PATTERN =
  /\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u{200D}\u{FE0F}\u{20E3}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}]/u;

const markSegmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

const VARIANT_RANGES = {
  bold: {
    upper: 0x1d5d4,
    lower: 0x1d5ee,
    digit: 0x1d7ec,
  },
  italic: {
    upper: 0x1d608,
    lower: 0x1d622,
  },
  boldItalic: {
    upper: 0x1d63c,
    lower: 0x1d656,
    digit: 0x1d7ec,
  },
  monospace: {
    upper: 0x1d670,
    lower: 0x1d68a,
    digit: 0x1d7f6,
  },
} as const;

export function styleText(text: string, options: UnicodeStyleOptions = {}): string {
  if (!text) {
    return '';
  }

  // Code spans render verbatim as monospace. A URL, @handle, or #tag inside code
  // is a literal code sample (npm scope, CSS id, decorator, sample link), not a
  // real LinkedIn link/mention/hashtag, so the whole span is styled. For the
  // other styles we leave those tokens ASCII below so LinkedIn keeps them
  // clickable/searchable.
  if (options.code) {
    return styleSegment(text, options);
  }

  let result = '';
  let lastIndex = 0;

  for (const match of text.matchAll(LINKEDIN_TOKEN_PATTERN)) {
    const index = match.index ?? 0;
    result += styleSegment(text.slice(lastIndex, index), options);
    result += match[0];
    lastIndex = index + match[0].length;
  }

  result += styleSegment(text.slice(lastIndex), options);
  return result;
}

export function applyStrikethrough(text: string): string {
  return applyCombiningMark(text, '\u0336');
}

export function applyUnderline(text: string): string {
  return applyCombiningMark(text, '\u0332');
}

function styleSegment(text: string, options: UnicodeStyleOptions): string {
  const variant = getVariant(options);
  let mapped = variant ? mapVariant(text, variant) : text;

  if (options.underline) {
    mapped = applyUnderline(mapped);
  }

  return options.strike ? applyStrikethrough(mapped) : mapped;
}

// Maps ASCII letters/digits to the styled variant per grapheme cluster, so an
// emoji cluster's components are never restyled — mapping the base digit of a
// keycap like 1(VS16)(U+20E3) to a mathematical bold digit shatters the emoji.
function mapVariant(text: string, variant: UnicodeVariant): string {
  const clusters = markSegmenter ? Array.from(markSegmenter.segment(text), (segment) => segment.segment) : Array.from(text);

  return clusters
    .map((cluster) => {
      if (EMOJI_CLUSTER_PATTERN.test(cluster)) {
        return cluster;
      }

      return Array.from(cluster).map((character) => mapAsciiCharacter(character, variant)).join('');
    })
    .join('');
}

// Works per grapheme cluster: emoji clusters (ZWJ families, keycaps, flags,
// skin tones) pass through untouched; within any other cluster the mark is
// appended per code point as before, so stacking strike + underline keeps its
// existing order (base, U+0336, U+0332).
function applyCombiningMark(text: string, mark: string): string {
  const clusters = markSegmenter ? Array.from(markSegmenter.segment(text), (segment) => segment.segment) : Array.from(text);

  return clusters
    .map((cluster) => {
      if (EMOJI_CLUSTER_PATTERN.test(cluster)) {
        return cluster;
      }

      return Array.from(cluster)
        .map((character) => (character.trim() && !EMOJI_PATTERN.test(character) && !COMBINING_MARK_PATTERN.test(character) ? `${character}${mark}` : character))
        .join('');
    })
    .join('');
}

function getVariant(options: UnicodeStyleOptions): UnicodeVariant | null {
  if (options.code) {
    return 'monospace';
  }

  if (options.bold && options.italic) {
    return 'boldItalic';
  }

  if (options.bold) {
    return 'bold';
  }

  if (options.italic) {
    return 'italic';
  }

  return null;
}

function mapAsciiCharacter(character: string, variant: UnicodeVariant): string {
  const codePoint = character.codePointAt(0);

  if (codePoint === undefined) {
    return character;
  }

  const ranges = VARIANT_RANGES[variant];

  if (codePoint >= 65 && codePoint <= 90) {
    return String.fromCodePoint(ranges.upper + codePoint - 65);
  }

  if (codePoint >= 97 && codePoint <= 122) {
    return String.fromCodePoint(ranges.lower + codePoint - 97);
  }

  if (codePoint >= 48 && codePoint <= 57 && 'digit' in ranges) {
    return String.fromCodePoint(ranges.digit + codePoint - 48);
  }

  return character;
}