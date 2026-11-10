/**
 * Finding a quotation in a source's full text, deterministically.
 *
 * Both sides are normalised the same way before anything is compared: Unicode
 * compatibility forms (so the "fi" ligature is "fi"), case, every quote mark to one
 * apostrophe, every dash to a hyphen, a word hyphenated across a line break joined again,
 * soft hyphens dropped, and every run of whitespace to one space. The normalised text keeps
 * a map back to the original offsets, so a hit can be reported as the source's own words
 * and placed on a page.
 */

export interface NormalizedText {
  text: string;
  /** For each character of `text`, the offset in the original it came from. */
  map: number[];
}

const QUOTES = /[\u2018\u2019\u201a\u201b\u201c\u201d\u201e\u201f\u00ab\u00bb\u2039\u203a"`\u00b4\u2032\u2033]/;
const DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\u2e3a\u2e3b]/;
const HYPHENS = new Set(['-', '\u2010', '\u2011']);

export function normalizeForMatch(raw: string): NormalizedText {
  let text = '';
  const map: number[] = [];
  let space = true; // drop leading whitespace
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === '\u00ad') continue; // soft hyphen
    // A word broken across a line: "decom-\n  position" is "decomposition".
    if (HYPHENS.has(c) && i > 0 && /\p{L}/u.test(raw[i - 1]!)) {
      const m = /^[ \t]*\r?\n[ \t]*(?=\p{Ll})/u.exec(raw.slice(i + 1, i + 40));
      if (m) {
        i += m[0].length;
        continue;
      }
    }
    if (/\s/.test(c)) {
      if (!space) {
        text += ' ';
        map.push(i);
        space = true;
      }
      continue;
    }
    space = false;
    let out: string;
    if (QUOTES.test(c)) out = "'";
    else if (DASHES.test(c)) out = '-';
    else if (c === '\u2026') out = '...';
    else out = c.normalize('NFKC').toLowerCase();
    for (const ch of out) {
      text += ch;
      map.push(i);
    }
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    map.pop();
  }
  return { text, map };
}

/** The quotation's segments: an ellipsis ("...", "\u2026", "[...]") marks words left out. */
export function quoteSegments(quote: string): string[] {
  return quote
    .split(/\s*(?:\[\s*(?:\.\s*){3}\]|\[\s*\u2026\s*\]|\.\s?\.\s?\.|\u2026)\s*/)
    .map((s) => normalizeForMatch(s).text.replace(/^[\s,.;:'-]+|[\s,.;:'-]+$/g, ''))
    .filter((s) => s.split(' ').length >= 2 || s.length >= 12);
}

/** Levenshtein similarity in [0, 1]. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ac = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ac === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[b.length]! / Math.max(a.length, b.length);
}

export type QuoteMatch =
  | { status: 'found'; start: number; end: number }
  | { status: 'close_match'; start: number; end: number; similarity: number }
  | { status: 'not_found'; bestSimilarity?: number };

/** Similarity at or above this is reported as a close match rather than "not found". */
export const CLOSE_MATCH_THRESHOLD = 0.85;

/** Longest normalised quotation compared character by character; longer ones are cut. */
const MAX_FUZZY_CHARS = 1500;

/**
 * Look for the quotation in the source. Every segment must be present, in order, for
 * "found"; otherwise the best-aligned window of the same length is scored, and reported as a
 * close match when it reaches the threshold. Offsets are into the ORIGINAL source text.
 */
export function matchQuote(quote: string, source: NormalizedText): QuoteMatch {
  const segments = quoteSegments(quote);
  if (!segments.length) return { status: 'not_found' };
  let from = 0;
  let first = -1;
  let last = -1;
  for (const seg of segments) {
    const at = source.text.indexOf(seg, from);
    if (at === -1) {
      first = -1;
      break;
    }
    if (first === -1) first = at;
    last = at + seg.length;
    from = last;
  }
  if (first !== -1) return { status: 'found', start: source.map[first]!, end: source.map[last - 1]! + 1 };
  const whole = segments.join(' ').slice(0, MAX_FUZZY_CHARS);
  const best = bestWindow(whole, source.text);
  if (!best) return { status: 'not_found' };
  if (best.score >= CLOSE_MATCH_THRESHOLD) {
    return {
      status: 'close_match',
      start: source.map[best.start]!,
      end: source.map[best.end - 1]! + 1,
      similarity: Math.round(best.score * 100) / 100,
    };
  }
  return { status: 'not_found', bestSimilarity: Math.round(best.score * 100) / 100 };
}

/**
 * The window of `text` that aligns best with `needle`. Each word of the needle that occurs
 * in the text votes for the start position that would align it; the ten best-supported
 * starts are scored by edit distance (window widths of the needle's length and a little
 * either side, to absorb inserted or dropped words).
 */
function bestWindow(needle: string, text: string): { start: number; end: number; score: number } | null {
  const qWords = needle.split(' ');
  // Word starts in the text.
  const starts: number[] = [];
  const words: string[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    starts.push(m.index!);
    words.push(m[0]);
  }
  if (!words.length) return null;
  const positions = new Map<string, number[]>();
  const wanted = new Set(qWords);
  words.forEach((w, i) => {
    if (!wanted.has(w)) return;
    const list = positions.get(w) ?? [];
    if (list.length < 2000) list.push(i);
    positions.set(w, list);
  });
  const votes = new Map<number, number>();
  qWords.forEach((w, qi) => {
    for (const p of positions.get(w) ?? []) {
      const s = p - qi;
      if (s >= 0) votes.set(s, (votes.get(s) ?? 0) + 1);
    }
  });
  const top = [...votes.entries()]
    .filter(([, v]) => v >= Math.max(2, Math.floor(qWords.length * 0.3)))
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 10);
  let best: { start: number; end: number; score: number } | null = null;
  for (const [s] of top) {
    for (const delta of [0, -2, -1, 1, 2]) {
      const n = qWords.length + delta;
      if (n < 1 || s + n > words.length) continue;
      const start = starts[s]!;
      const end = starts[s + n - 1]! + words[s + n - 1]!.length;
      const score = similarity(needle, text.slice(start, end));
      if (!best || score > best.score) best = { start, end, score };
    }
  }
  return best;
}
