import { loadPdfjs } from './pdfjs-loader.js';

/**
 * Default cap on PDF bytes for exact-page re-extraction. pdfjs decodes the whole document
 * (objects + images) into memory and can balloon to many× the file size — on a small host
 * (e.g. a 1 GB free-tier VM) a large PDF OOM-kills the process. Above this we degrade to
 * approximate pages; the indexed cloud full text is still returned, so grounding still works.
 */
export const DEFAULT_PRECISE_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Optional exact-page support for W1 `precise_pages`. Lazily imports the optional
 * `pdfjs-dist` dependency; if it is absent, the PDF is too large (`maxBytes`), or extraction
 * fails, returns null so the caller degrades to approximate pages. Never throws.
 */
export async function extractPdfPages(
  bytes: Uint8Array,
  opts: { maxBytes?: number } = {},
): Promise<string[] | null> {
  const maxBytes = opts.maxBytes ?? DEFAULT_PRECISE_MAX_BYTES;
  // Refuse before importing/parsing: a large PDF would OOM pdfjs on a small host.
  if (bytes.byteLength > maxBytes) return null;
  // Loaded through the shared loader: pdfjs must not be imported directly, or it breaks
  // inside Electron (Claude Desktop). See pdfjs-loader.ts.
  const pdfjs = await loadPdfjs();
  if (!pdfjs) return null; // unavailable here (degrade); pdfjsLoadError() says why
  try {
    // pdfjs transfers (detaches) the buffer it is given; hand it a copy so the
    // caller's bytes stay intact (matters when the same buffer is re-extracted).
    const data = bytes.slice();
    const loadingTask = pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false });
    const doc = await loadingTask.promise;
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push((content.items as any[]).map((it) => it.str ?? '').join(' '));
    }
    return pages;
  } catch {
    return null; // corrupt PDF / parse failure — degrade
  }
}

/** One heading in a PDF's table of contents, flattened out of the nested outline tree. */
export interface OutlineEntry {
  title: string;
  /** 1-based page the heading points at, when its destination could be resolved. */
  page?: number;
  /** Nesting depth: 0 for a top-level heading, 1 for its children, and so on. */
  level: number;
}

/**
 * The PDF's table of contents, flattened depth-first with each heading's page.
 *
 * A document's own outline is the cheapest possible map of it: the caller learns what is
 * in the file and which pages to ask for without reading a single page of body text, which
 * is what makes reading a 400-page book by page range practical at all.
 *
 * A heading's destination is either an explicit array (whose first element is a reference
 * to the page object) or the name of one, resolved through the document's named
 * destinations. Either can be missing or dangling, and one broken heading must not cost
 * the whole outline, so a heading whose page cannot be resolved is returned without one.
 *
 * Returns `[]` for a PDF that simply has no outline, and null when the document could not
 * be read at all (`pdfjs-dist` absent, over `maxBytes`, corrupt), mirroring
 * `extractPdfPages`. Never throws.
 */
export async function extractPdfOutline(
  bytes: Uint8Array,
  opts: { maxBytes?: number } = {},
): Promise<OutlineEntry[] | null> {
  const maxBytes = opts.maxBytes ?? DEFAULT_PRECISE_MAX_BYTES;
  if (bytes.byteLength > maxBytes) return null;
  // Loaded through the shared loader: pdfjs must not be imported directly, or it breaks
  // inside Electron (Claude Desktop). See pdfjs-loader.ts.
  const pdfjs = await loadPdfjs();
  if (!pdfjs) return null; // unavailable here (degrade); pdfjsLoadError() says why
  try {
    const data = bytes.slice();
    const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
    const outline = await doc.getOutline();
    if (!Array.isArray(outline) || !outline.length) return [];
    const entries: OutlineEntry[] = [];
    const walk = async (nodes: any[], level: number): Promise<void> => {
      for (const node of nodes) {
        const title = typeof node?.title === 'string' ? node.title.replace(/\s+/g, ' ').trim() : '';
        if (title) entries.push({ title, page: await destinationPage(doc, node?.dest), level });
        if (Array.isArray(node?.items) && node.items.length) await walk(node.items, level + 1);
      }
    };
    await walk(outline, 0);
    return entries;
  } catch {
    return null; // corrupt PDF / parse failure (degrade)
  }
}

/** 1-based page a PDF outline destination points at, or undefined when it cannot be resolved. */
async function destinationPage(doc: any, dest: unknown): Promise<number | undefined> {
  try {
    const resolved = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    const target = Array.isArray(resolved) ? resolved[0] : undefined;
    // An explicit destination names the page object; a remote/degenerate one names its index.
    if (typeof target === 'number') return target + 1;
    if (target && typeof target === 'object') return (await doc.getPageIndex(target)) + 1;
  } catch {
    // A dangling destination costs that heading its page, not the whole outline.
  }
  return undefined;
}

/**
 * A 1-based page span as callers write it: "3" or "3-7" (an en dash is accepted too, since
 * that is what a copied citation carries). Undefined when the text is not one, or the span
 * runs backwards. Shared by every tool that addresses PDF pages, so they all read the same
 * syntax.
 */
export function parsePageRange(range: string): { from: number; to: number } | undefined {
  const m = range.match(/^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/);
  if (!m) return undefined;
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  return from > 0 && to >= from ? { from, to } : undefined;
}

/** What `pdfPagesToText` puts between two pages, and what `pageAtOffset` counts. */
const PAGE_SEPARATOR = '\n\n';

/** Join extracted page texts into one document text (pages separated by a blank line). */
export function pdfPagesToText(pages: string[]): string {
  return pages.join(PAGE_SEPARATOR);
}

/**
 * The 1-based page holding character `charStart` of `pdfPagesToText(pages)`.
 *
 * Exact by construction, and free: the joined text is the pages, so the page is a pure
 * function of the offsets the chunker already returns. Every caller whose text came from
 * these very pages should use this rather than `locatePage`, which has to search and can
 * be defeated by a repeated running head.
 *
 * A page with no characters is never the answer (an OCR pass leaves the pages it did not
 * read empty, and an unread page must not be citable), and an offset that lands in the
 * `\n\n` between two pages belongs to the page that follows it, which is where the text
 * after that join is. Undefined when the offset is past the end of the joined text.
 */
export function pageAtOffset(pages: string[], charStart: number): number | undefined {
  if (!Number.isFinite(charStart) || charStart < 0) return undefined;
  let start = 0;
  for (let i = 0; i < pages.length; i++) {
    const end = start + pages[i]!.length;
    if (end > start && charStart < end) return i + 1;
    start = end + PAGE_SEPARATOR.length;
  }
  return undefined;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Normalized page texts, memoised per array: `locatePage` is called once per passage over
 * the same pages, and normalising a whole book per passage is the one cost this adds. Keyed
 * by the array's identity, so a caller that rewrites a page in place must pass a new array;
 * every caller here builds one per extraction and never mutates it.
 */
const NORMALIZED = new WeakMap<string[], string[]>();
function normalizedPages(pages: string[]): string[] {
  let cached = NORMALIZED.get(pages);
  if (!cached) {
    cached = pages.map(normalize);
    NORMALIZED.set(pages, cached);
  }
  return cached;
}

export interface LocateOptions {
  /** Characters of the passage's head to match on; widened automatically when ambiguous. */
  headChars?: number;
  /** The page the caller independently expects (a proportional estimate): breaks a tie. */
  near?: number;
}

/**
 * The 1-based page whose text contains the passage's leading window, or undefined.
 *
 * First match wins is not good enough. A running head, a repeated reference-list fragment
 * or a duplicated appendix template puts the same 60 characters on many pages, and the
 * first of them was then reported as an exact page for a passage cut from somewhere else
 * (measured over this machine's own library: about 2% of real passages, the worst of them
 * 30 pages out, every one of them labelled "exact"). So: collect every page that contains
 * the window, widen the window when more than one does, and break a surviving tie with the
 * caller's own estimate, which at least keeps the answer on a page that really does carry
 * the text. With nothing left to separate them, return undefined and let the caller
 * degrade to an estimate rather than publish a page number that is confidently wrong.
 *
 * A caller whose text IS these pages joined should use `pageAtOffset` instead: it is exact,
 * and it cannot be confused by repetition at all.
 */
export function locatePage(pages: string[], passage: string, opts: LocateOptions = {}): number | undefined {
  const normalized = normalize(passage);
  if (!normalized) return undefined;
  const head = Math.max(1, opts.headChars ?? 60);
  const texts = normalizedPages(pages);
  let matches: number[] = [];
  for (const width of [head, head * 3, head * 8]) {
    const needle = normalized.slice(0, width);
    const found: number[] = [];
    for (let i = 0; i < texts.length; i++) if (texts[i]!.includes(needle)) found.push(i + 1);
    // A wider window can only ever match fewer pages, so nothing at this width means
    // nothing at any greater one.
    if (!found.length) break;
    matches = found;
    if (found.length === 1) return found[0];
    if (needle.length === normalized.length) break; // the whole passage is already the needle
  }
  if (matches.length < 2) return undefined;
  const near = opts.near;
  if (!near) return undefined;
  let best: number | undefined;
  let bestGap = Infinity;
  for (const page of matches) {
    const gap = Math.abs(page - near);
    if (gap < bestGap) {
      bestGap = gap;
      best = page;
    }
  }
  return best;
}
