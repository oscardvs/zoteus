import { describe, it, expect } from 'vitest';
import {
  locatePage,
  pageAtOffset,
  extractPdfPages,
  extractPdfOutline,
  DEFAULT_PRECISE_MAX_BYTES,
} from '../../src/features/fulltext/pdf-pages.js';

// A tiny, valid PDF with one text-bearing page (pdfjs recovers the xref by object indexing).
const MINIMAL_PDF = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 41 >> stream
BT /F1 24 Tf 20 100 Td (Hello PDF) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R >>
%%EOF`;
const PDF_BYTES = new TextEncoder().encode(MINIMAL_PDF);

describe('locatePage', () => {
  const pages = ['title and intro', 'methods the hessian is decomposed here', 'references'];
  it('returns the 1-based page whose text contains the passage head', () => {
    expect(locatePage(pages, 'The Hessian is decomposed')).toBe(2);
  });
  it('returns undefined when no page matches', () => {
    expect(locatePage(pages, 'completely unrelated phrase xyzzy')).toBeUndefined();
  });
});

describe('locatePage when the head window is not unique', () => {
  /**
   * A real paper's running head: 69 characters, repeated at the top of every page, which is
   * longer than the 60-character window the match starts from. Every page therefore contains
   * that window, and taking the first of them reported page 1 for a passage on page 3, under
   * a label saying "exact". Measured over this machine's Zotero storage, that was about 2%
   * of real passages, the worst of them 30 pages out.
   */
  const head = 'Learning Transferable Visual Models From Natural Language Supervision';
  const withHead = [
    `${head} 1 We introduce a contrastive objective over image and caption pairs.`,
    `${head} 2 Zero-shot transfer is measured on twenty-seven classification datasets.`,
    `${head} 3 The prompt ensembling ablation is reported in table four of the appendix.`,
  ];

  it('does not report the first page carrying a repeated running head', () => {
    const passage = `${head} 3 The prompt ensembling ablation is reported in table four`;
    // The leading 60 characters are all running head and match every page; a longer window
    // separates them, and the answer is the page the passage is actually on.
    expect(locatePage(withHead, passage)).toBe(3);
  });

  it('returns undefined rather than a guess when nothing can separate the candidates', () => {
    const identical = ['boilerplate page', 'boilerplate page', 'boilerplate page'];
    expect(locatePage(identical, 'boilerplate page')).toBeUndefined();
  });

  it("breaks a tie with the caller's own estimate, and only with it", () => {
    const identical = ['boilerplate page', 'boilerplate page', 'boilerplate page'];
    expect(locatePage(identical, 'boilerplate page', { near: 3 })).toBe(3);
    expect(locatePage(identical, 'boilerplate page', { near: 2 })).toBe(2);
    // An estimate still cannot conjure a match where the text is absent.
    expect(locatePage(identical, 'nothing like it', { near: 2 })).toBeUndefined();
  });

  it('still finds a unique match, and still refuses an empty page', () => {
    expect(locatePage(withHead, 'zero-shot transfer is measured on twenty-seven')).toBe(2);
    expect(locatePage(['', '', 'read page'], 'read page')).toBe(3);
  });
});

describe('pageAtOffset', () => {
  const pages = ['first page text', 'second page text', 'third page text'];
  const joined = pages.join('\n\n');

  it('maps every character offset of the joined text to the page it came from', () => {
    expect(pageAtOffset(pages, 0)).toBe(1);
    expect(pageAtOffset(pages, joined.indexOf('second'))).toBe(2);
    expect(pageAtOffset(pages, joined.indexOf('third'))).toBe(3);
    expect(pageAtOffset(pages, joined.length - 1)).toBe(3);
  });

  it('gives an offset inside the join to the page that follows it', () => {
    // The two characters between two pages belong to whatever comes next: a chunk that
    // starts there is the top of the following page, not the tail of the previous one.
    expect(pageAtOffset(pages, pages[0]!.length)).toBe(2);
    expect(pageAtOffset(pages, pages[0]!.length + 1)).toBe(2);
  });

  it('never returns a page with no characters, which is what an unread OCR page is', () => {
    const partial = ['', '', 'the only page this call read', '', ''];
    const text = partial.join('\n\n');
    expect(pageAtOffset(partial, text.indexOf('the only page'))).toBe(3);
    expect(pageAtOffset(partial, 0)).toBe(3);
  });

  it('returns undefined past the end of the text, and for a nonsense offset', () => {
    expect(pageAtOffset(pages, joined.length)).toBeUndefined();
    expect(pageAtOffset(pages, 10_000)).toBeUndefined();
    expect(pageAtOffset(pages, -1)).toBeUndefined();
    expect(pageAtOffset([], 0)).toBeUndefined();
  });
});

describe('extractPdfPages', () => {
  it('returns null when the optional dependency is unavailable (degrade, not throw)', async () => {
    // An empty buffer + absent/failing pdfjs must resolve to null, never throw.
    const result = await extractPdfPages(new Uint8Array([1, 2, 3])).catch(() => 'THREW');
    expect(result === null || Array.isArray(result)).toBe(true);
    expect(result).not.toBe('THREW');
  });
});

describe('extractPdfPages size guard (OOM defense for small hosts)', () => {
  it('DEFAULT_PRECISE_MAX_BYTES is a sane cap (1MB..64MB)', () => {
    expect(DEFAULT_PRECISE_MAX_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
    expect(DEFAULT_PRECISE_MAX_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  it('parses a small PDF when under the byte cap', async () => {
    const pages = await extractPdfPages(PDF_BYTES, { maxBytes: 1_000_000 });
    expect(Array.isArray(pages)).toBe(true);
    expect((pages ?? []).join(' ')).toContain('Hello');
  });

  it('refuses (returns null) when bytes exceed the cap — never parses, never OOMs', async () => {
    const pages = await extractPdfPages(PDF_BYTES, { maxBytes: 50 });
    expect(pages).toBeNull();
  });
});

// Two pages plus an /Outlines tree: one chapter with a nested section, then a second
// chapter, so both the nesting level and the page each heading points at are observable.
const OUTLINED_PDF = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R 7 0 R] /Count 2 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 41 >> stream
BT /F1 24 Tf 20 100 Td (Hello PDF) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
6 0 obj << /Type /Outlines /First 8 0 R /Last 9 0 R /Count 2 >> endobj
7 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 10 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
8 0 obj << /Title (Chapter One) /Parent 6 0 R /Next 9 0 R /First 11 0 R /Last 11 0 R /Count 1 /Dest [3 0 R /XYZ 0 200 0] >> endobj
9 0 obj << /Title (Chapter Two) /Parent 6 0 R /Prev 8 0 R /Dest [7 0 R /XYZ 0 200 0] >> endobj
10 0 obj << /Length 43 >> stream
BT /F1 24 Tf 20 100 Td (Second page) Tj ET
endstream endobj
11 0 obj << /Title (Section 1.1) /Parent 8 0 R /Dest [7 0 R /XYZ 0 100 0] >> endobj
trailer << /Root 1 0 R >>
%%EOF`;
const OUTLINED_BYTES = new TextEncoder().encode(OUTLINED_PDF);

describe('extractPdfOutline', () => {
  it('returns the table of contents depth-first, with each heading on its own page', async () => {
    const outline = await extractPdfOutline(OUTLINED_BYTES);
    if (outline === null) return; // pdfjs-dist is optional; absent means degrade, not fail
    expect(outline).toEqual([
      { title: 'Chapter One', page: 1, level: 0 },
      { title: 'Section 1.1', page: 2, level: 1 },
      { title: 'Chapter Two', page: 2, level: 0 },
    ]);
  });

  it('returns an empty list for a PDF that carries no outline, not null', async () => {
    const outline = await extractPdfOutline(PDF_BYTES);
    if (outline === null) return; // pdfjs-dist absent
    expect(outline).toEqual([]);
  });

  it('returns null (degrade, never throws) when the bytes are not a parseable PDF', async () => {
    const result = await extractPdfOutline(new Uint8Array([1, 2, 3])).catch(() => 'THREW');
    expect(result).toBeNull();
  });

  it('refuses above the byte cap without parsing anything', async () => {
    expect(await extractPdfOutline(OUTLINED_BYTES, { maxBytes: 50 })).toBeNull();
  });
});
