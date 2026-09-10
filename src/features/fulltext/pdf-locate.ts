/**
 * Anchor a quoted passage to its coordinates on the PDF page.
 *
 * Zotero stores a highlight as `{"pageIndex":N,"rects":[[x1,y1,x2,y2],...]}` in native
 * PDF points: the geometry the reader captures when a human drags over the text. A model
 * reading extracted text has the words but not the geometry, so without this module the
 * only honest thing it can write is a page-anchored note. This recovers the geometry from
 * the PDF itself, so a passage the model can quote is a passage it can highlight.
 *
 * The rect shape mirrors what Zotero's reader produces, verified against 465 highlights
 * drawn by hand in the reader:
 *   x: the text run's own x, advanced per character
 *   y: `[baseline + descent * fontSize, baseline + ascent * fontSize]`, with ascent and
 *      descent taken from the font (pdfjs reports both in `textContent.styles`)
 * On that corpus the reconstructed rects sit within ~1pt of the reader's own (median),
 * and the vertical extent is exact wherever the font carries metrics.
 */

import { DEFAULT_PRECISE_MAX_BYTES } from './pdf-pages.js';
import { loadPdfjs } from './pdfjs-loader.js';

/** One place a passage occurs, in Zotero's stored coordinate form. */
export interface PassageAnchor {
  /** 0-based page, as `annotationPosition.pageIndex`. */
  pageIndex: number;
  /** One rect per visual line, `[x1, y1, x2, y2]` in points, bottom-left origin. */
  rects: number[][];
  /** Character offset of the match within the page's reading order (refines the sort index). */
  charOffset: number;
  /** Page height in points (refines the sort index). */
  pageHeight: number;
  /** The passage with its surrounding words, so an ambiguous match can be told apart. */
  context: string;
}

/** A passage to anchor, optionally restricted to one page. */
export interface PassageQuery {
  text: string;
  /** 0-based page to search; omitted searches every page. */
  pageIndex?: number;
}

interface CharBox {
  ch: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Line breaks and inter-run gaps: they position a match but are never drawn. */
  virtual?: boolean;
}

/**
 * Relative glyph advances (Times-Roman's, the metric most academic PDFs are set in).
 * pdfjs measures a whole text run, not its characters, so a match starting mid-run has to
 * be placed by splitting that width. Splitting it evenly puts the left edge up to a full
 * character off in proportional type; weighting by these and renormalising to the run's
 * measured width cuts that to well under one character. Absolute values do not matter,
 * only their ratios.
 */
const GLYPH_WIDTH: Record<string, number> = {
  ' ': 250, '!': 333, '"': 408, '#': 500, '$': 500, '%': 833, '&': 778, "'": 180, '(': 333, ')': 333,
  '*': 500, '+': 564, ',': 250, '-': 333, '.': 250, '/': 278, '0': 500, '1': 500, '2': 500, '3': 500,
  '4': 500, '5': 500, '6': 500, '7': 500, '8': 500, '9': 500, ':': 278, ';': 278, '<': 564, '=': 564,
  '>': 564, '?': 444, '@': 921, A: 722, B: 667, C: 667, D: 722, E: 611, F: 556, G: 722, H: 722, I: 333,
  J: 389, K: 722, L: 611, M: 889, N: 722, O: 722, P: 556, Q: 722, R: 667, S: 556, T: 611, U: 722,
  V: 722, W: 944, X: 722, Y: 722, Z: 611, '[': 333, '\\': 278, ']': 333, '^': 469, '_': 500, '`': 333,
  a: 444, b: 500, c: 444, d: 500, e: 444, f: 333, g: 500, h: 500, i: 278, j: 278, k: 500, l: 278,
  m: 778, n: 500, o: 500, p: 500, q: 500, r: 333, s: 389, t: 278, u: 500, v: 500, w: 722, x: 500,
  y: 500, z: 444, '{': 480, '|': 200, '}': 480, '~': 541,
};
const glyphWidth = (c: string): number => GLYPH_WIDTH[c] ?? 500;

/** Used where a font reports no metrics, matching what the reader falls back to. */
const FALLBACK_ASCENT = 0.75;
const FALLBACK_DESCENT = -0.25;

/**
 * Characters a PDF renders one way and a quoting model reproduces another. Folded on both
 * sides so a passage copied out of extracted text still matches the page it came from.
 * Ligatures expand to several characters, which the offset map below is built to carry.
 */
const FOLD: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"',
  '–': '-', '—': '-', '―': '-', '−': '-', '­': '-',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
  'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st',
  'Œ': 'OE', 'œ': 'oe', 'Æ': 'AE', 'æ': 'ae',
};

/**
 * Reduce text to what two renderings of the same passage agree on: no case, no whitespace,
 * no hyphens. Dropping whitespace absorbs the column breaks, line wraps and run gaps that
 * make extracted text disagree with itself; dropping hyphens absorbs words split across
 * lines, which is otherwise the single commonest reason a real quote fails to match.
 */
function foldChar(ch: string): string {
  return FOLD[ch] ?? ch;
}

/**
 * Ignored on both sides of the comparison. Whitespace and hyphens absorb wraps and column
 * breaks; combining marks and the spacing modifiers absorb the other systematic
 * disagreement, where a PDF sets an accent as its own glyph and the extractor emits it
 * beside the letter rather than on it (`hˆi` for `ĥi`, `σ ̄` for `σ̄`). Two extractors of
 * the same page disagree about those constantly, and they carry no information a passage
 * match needs.
 */
function isSkippable(c: string): boolean {
  // U+02B0..U+02FF is the spacing-modifier block: it holds the standalone `ˆ` and `˜`
  // (categories Lm and Sk both) that a PDF sets beside a letter instead of over it.
  return /[\s-]/.test(c) || /[\p{M}\p{Sk}\u02B0-\u02FF]/u.test(c);
}

/** Compact a page's characters, keeping an index back to the character each one came from. */
function compactChars(chars: CharBox[]): { text: string; source: number[] } {
  let text = '';
  const source: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    for (const c of foldChar(chars[i]!.ch).normalize('NFD').toLowerCase()) {
      if (isSkippable(c)) continue;
      text += c;
      source.push(i);
    }
  }
  return { text, source };
}

/** The same reduction for a caller-supplied passage. */
export function compactPassage(passage: string): string {
  let out = '';
  for (const raw of passage.normalize('NFD')) {
    for (const c of foldChar(raw).toLowerCase()) {
      if (isSkippable(c)) continue;
      out += c;
    }
  }
  return out;
}

/**
 * Collapse a run of matched characters into one rect per visual line, the shape the
 * reader stores for a multi-line highlight.
 *
 * A new rect is started when the text moves to another line: either the vertical bands
 * stop overlapping, or x jumps backwards (the wrap to the next line, or the next column).
 * Superscripts and inline math sit on a shifted baseline but still overlap their line's
 * band, so they widen the line's rect instead of fragmenting it, again as the reader does.
 */
export function charsToRects(chars: CharBox[], from: number, to: number): number[][] {
  const lines: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  let cur: { x0: number; y0: number; x1: number; y1: number } | null = null;
  for (let i = from; i <= to; i++) {
    const c = chars[i];
    if (!c || c.virtual) continue;
    const overlap = cur ? Math.min(cur.y1, c.y1) - Math.max(cur.y0, c.y0) : 0;
    const shorter = cur ? Math.min(cur.y1 - cur.y0, c.y1 - c.y0) : 0;
    const sameLine = cur !== null && overlap > 0.4 * shorter && c.x0 >= cur.x1 - 3;
    if (sameLine && cur) {
      cur.x1 = Math.max(cur.x1, c.x1);
      cur.y0 = Math.min(cur.y0, c.y0);
      cur.y1 = Math.max(cur.y1, c.y1);
    } else {
      if (cur) lines.push(cur);
      cur = { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 };
    }
  }
  if (cur) lines.push(cur);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return lines.map((l) => [round(l.x0), round(l.y0), round(l.x1), round(l.y1)]);
}

/** Character boxes for one page, in reading order, in PDF user space. */
async function pageCharBoxes(page: any): Promise<CharBox[]> {
  const content = await page.getTextContent();
  const styles = content.styles ?? {};
  const chars: CharBox[] = [];
  for (const item of content.items as any[]) {
    const transform = item?.transform;
    if (!transform) continue; // marked-content markers carry no geometry
    const str: string = item.str ?? '';
    const x = transform[4];
    const baseline = transform[5];
    const size = item.height || Math.hypot(transform[2], transform[3]) || Math.hypot(transform[0], transform[1]);
    const style = styles[item.fontName];
    const ascent = typeof style?.ascent === 'number' && style.ascent ? style.ascent : FALLBACK_ASCENT;
    const descent = typeof style?.descent === 'number' && style.descent ? style.descent : FALLBACK_DESCENT;
    const y0 = baseline + descent * size;
    const y1 = baseline + ascent * size;
    const width = typeof item.width === 'number' ? item.width : 0;
    if (!str.length) {
      if (item.hasEOL) chars.push({ ch: '\n', x0: x, x1: x, y0, y1, virtual: true });
      continue;
    }
    const units = [...str].map(glyphWidth);
    const total = units.reduce((a, b) => a + b, 0) || str.length;
    let cx = x;
    for (const ch of str) {
      const advance = (glyphWidth(ch) / total) * width;
      chars.push({ ch, x0: cx, x1: cx + advance, y0, y1 });
      cx += advance;
    }
    if (item.hasEOL) chars.push({ ch: '\n', x0: x + width, x1: x + width, y0, y1, virtual: true });
  }
  return chars;
}

/** Plain text around a match, for telling two occurrences of the same words apart. */
function contextAround(chars: CharBox[], from: number, to: number, pad = 25): string {
  const slice = chars
    .slice(Math.max(0, from - pad), Math.min(chars.length, to + pad + 1))
    .map((c) => (c.virtual ? ' ' : c.ch))
    .join('');
  return slice.replace(/\s+/g, ' ').trim();
}

export interface LocateOptions {
  /** Refuse above this many bytes (pdfjs decodes the whole document; see pdf-pages.ts). */
  maxBytes?: number;
  /** Stop after this many occurrences of a single passage (default 8). */
  maxHitsPerPassage?: number;
}

/**
 * Height in points of each of the given 0-based pages, for pages the document has.
 *
 * The reader's sort index measures a highlight from the BOTTOM of its page, so a rect can
 * only be turned into a sidebar position once the page height is known. `locatePassages`
 * reports it for every passage it anchors; this answers the same question for a rect the
 * caller supplied, which needs no anchoring and would otherwise sort as if it sat at the
 * very top of the page.
 *
 * Only page viewports are read, never page text, so this is a fraction of the work
 * `locatePassages` does on the same document. Returns null (never throws) when the document
 * cannot be read at all, mirroring `locatePassages`, and omits any page index the document
 * does not have.
 */
export async function pageHeights(
  bytes: Uint8Array,
  pageIndexes: number[],
  opts: { maxBytes?: number } = {},
): Promise<Map<number, number> | null> {
  const maxBytes = opts.maxBytes ?? DEFAULT_PRECISE_MAX_BYTES;
  if (bytes.byteLength > maxBytes) return null;
  const wanted = [...new Set(pageIndexes)].filter((n) => Number.isInteger(n) && n >= 0);
  if (!wanted.length) return new Map();

  // Loaded through the shared loader: pdfjs must not be imported directly, or it breaks
  // inside Electron (Claude Desktop). See pdfjs-loader.ts.
  const pdfjs = await loadPdfjs();
  if (!pdfjs) return null; // unavailable here (degrade); pdfjsLoadError() says why
  try {
    const doc = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true, isEvalSupported: false })
      .promise;
    const heights = new Map<number, number>();
    for (const pageIndex of wanted) {
      if (pageIndex >= doc.numPages) continue;
      const page = await doc.getPage(pageIndex + 1);
      const height = page.getViewport({ scale: 1 }).height;
      if (Number.isFinite(height) && height > 0) heights.set(pageIndex, height);
    }
    return heights;
  } catch {
    return null; // corrupt PDF / parse failure, degrade
  }
}

/**
 * Find every place each passage occurs, with the geometry Zotero needs to draw it.
 *
 * One pdfjs pass serves all the passages, because annotating a paper means anchoring a
 * dozen quotes in one call and re-parsing the document per quote is the slow way to do it.
 * Returns null (never throws) when the document cannot be read at all (pdfjs absent,
 * file over `maxBytes`, or a corrupt PDF), so callers degrade the way they already do for
 * page extraction. A passage that simply is not there comes back as an empty array.
 */
export async function locatePassages(
  bytes: Uint8Array,
  passages: PassageQuery[],
  opts: LocateOptions = {},
): Promise<PassageAnchor[][] | null> {
  const maxBytes = opts.maxBytes ?? DEFAULT_PRECISE_MAX_BYTES;
  if (bytes.byteLength > maxBytes) return null;
  const maxHits = opts.maxHitsPerPassage ?? 8;
  const needles = passages.map((p) => compactPassage(p.text));
  const results: PassageAnchor[][] = passages.map(() => []);
  if (!needles.some((n) => n.length)) return results;

  // Loaded through the shared loader: pdfjs must not be imported directly, or it breaks
  // inside Electron (Claude Desktop). See pdfjs-loader.ts.
  const pdfjs = await loadPdfjs();
  if (!pdfjs) return null; // unavailable here (degrade); pdfjsLoadError() says why
  try {
    // pdfjs detaches the buffer it is handed; give it a copy so the caller keeps its bytes.
    const doc = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true, isEvalSupported: false })
      .promise;
    for (let p = 1; p <= doc.numPages; p++) {
      const pageIndex = p - 1;
      // Skip a page no outstanding passage is looking for.
      const wanted = passages.some(
        (q, i) => needles[i]!.length && results[i]!.length < maxHits && (q.pageIndex == null || q.pageIndex === pageIndex),
      );
      if (!wanted) continue;
      const page = await doc.getPage(p);
      const chars = await pageCharBoxes(page);
      const { text, source } = compactChars(chars);
      const pageHeight = page.getViewport({ scale: 1 }).height;
      for (let i = 0; i < passages.length; i++) {
        const needle = needles[i]!;
        const query = passages[i]!;
        if (!needle.length || results[i]!.length >= maxHits) continue;
        if (query.pageIndex != null && query.pageIndex !== pageIndex) continue;
        let at = text.indexOf(needle);
        while (at !== -1 && results[i]!.length < maxHits) {
          const from = source[at]!;
          const to = source[at + needle.length - 1]!;
          results[i]!.push({
            pageIndex,
            rects: charsToRects(chars, from, to),
            charOffset: from,
            pageHeight,
            context: contextAround(chars, from, to),
          });
          at = text.indexOf(needle, at + 1);
        }
      }
    }
    return results;
  } catch {
    return null; // corrupt PDF / parse failure, degrade
  }
}
