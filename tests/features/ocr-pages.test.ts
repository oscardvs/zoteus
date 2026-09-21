import { describe, it, expect } from 'vitest';
import {
  ocrPdfPages,
  ocrPageCap,
  ocrCapNotice,
  ELECTRON_OCR_MAX_PAGES,
} from '../../src/features/ocr/ocr-pages.js';
import type { OcrEngine, OcrPageImage } from '../../src/features/ocr/engine.js';
import { renderPdfPages } from '../../src/features/fulltext/pdf-images.js';
import { textPagePdf } from '../fixtures/pdf.js';
import { scannedBookPdf } from '../fixtures/scanned-book.js';

/**
 * A stand-in for tesseract.js. Every test here injects one, which is how the whole page
 * pipeline (render, page mapping, cap, teardown) is exercised with no wasm, no language
 * download and no network, exactly as EmbeddingProvider.loadExtractor does for the
 * embedder. What the real engine does to a picture is tesseract's business, not Zoteus's;
 * what Zoteus does with the answers is what these tests are about.
 */
function fakeEngine(
  read: (image: OcrPageImage) => string = (i) => `Text recognised on page ${i.page}.`,
): OcrEngine & { seen: OcrPageImage[]; closed: number } {
  const seen: OcrPageImage[] = [];
  const engine = {
    name: 'fake-ocr (eng)',
    seen,
    closed: 0,
    async readPage(image: OcrPageImage) {
      seen.push(image);
      return read(image);
    },
    async close() {
      engine.closed++;
    },
  };
  return engine;
}

/**
 * One really rendered page, or null when pdfjs (an optional dependency) or its canvas is
 * absent. Resolved once at module level so the suites below can be SKIPPED out loud on
 * such an install: a test that returns before asserting anything must not be counted as a
 * passing test.
 */
const PAGE = await (async () => {
  const rendered = await renderPdfPages(textPagePdf(), { pages: [1], dpi: 72, format: 'jpeg' });
  return 'error' in rendered ? null : rendered.rendered[0]!;
})();

const describeRendered = describe.skipIf(!PAGE);
const itRendered = it.skipIf(!PAGE);

/** A scanned book of `pages` pages, built from that rendered page. */
function book(pages: number): Uint8Array {
  return scannedBookPdf(PAGE!.bytes, PAGE!.width, PAGE!.height, pages);
}

const opts = { langs: 'eng', maxPages: 8, dpi: 36, versions: {} as Record<string, string> };

describeRendered('ocrPdfPages', () => {
  it('returns one string per page of the document, in page order', async () => {
    const pdf = book(3);
    const engine = fakeEngine();
    const res = await ocrPdfPages(pdf, { ...opts, pages: [1, 2, 3], engine });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pages).toEqual([
      'Text recognised on page 1.',
      'Text recognised on page 2.',
      'Text recognised on page 3.',
    ]);
    expect(res.numPages).toBe(3);
    expect(res.read).toEqual([1, 2, 3]);
    expect(res.deferred).toEqual([]);
    expect(res.engine).toBe('fake-ocr (eng)');
    // The engine is handed a real picture of the page, sized and typed.
    expect(engine.seen).toHaveLength(3);
    expect(engine.seen[0]!.mimeType).toBe('image/png');
    expect(engine.seen[0]!.width).toBeGreaterThan(0);
    // An injected engine belongs to the test, so the pass must not close it.
    expect(engine.closed).toBe(0);
  });

  it('keeps unread pages as empty strings so the array stays indexed by page', async () => {
    const pdf = book(4);
    const res = await ocrPdfPages(pdf, { ...opts, pages: [3], engine: fakeEngine() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pages).toEqual(['', '', 'Text recognised on page 3.', '']);
    expect(res.read).toEqual([3]);
  });

  it('stops at the page cap and reports exactly what it left for the next call', async () => {
    const pdf = book(9);
    const engine = fakeEngine();
    const res = await ocrPdfPages(pdf, { ...opts, pages: [1, 2, 3, 4, 5, 6, 7, 8, 9], engine });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.read).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(res.deferred).toEqual([9]);
    expect(res.pages).toHaveLength(9);
    expect(res.pages[8]).toBe('');
    // The cap is a cap on WORK, not just on the answer: page 9 was never rendered.
    expect(engine.seen.map((i) => i.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('reports pages beyond the document instead of inventing them', async () => {
    const pdf = book(2);
    const res = await ocrPdfPages(pdf, { ...opts, pages: [2, 3, 4], engine: fakeEngine() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.read).toEqual([2]);
    expect(res.missing).toEqual([3, 4]);
  });

  it('refuses a request whose every page is past the end, with a message that says so', async () => {
    const pdf = book(2);
    const res = await ocrPdfPages(pdf, { ...opts, pages: [7, 8], engine: fakeEngine() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('no-pages');
    expect(res.message).toContain('beyond the document');
    expect(res.message).toContain('2');
  });

  it('lists pages that came back with no text at all rather than pretending they read', async () => {
    const pdf = book(2);
    const res = await ocrPdfPages(pdf, {
      ...opts,
      pages: [1, 2],
      engine: fakeEngine((i) => (i.page === 2 ? '   \n\n ' : 'words on page one')),
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.unreadable).toEqual([2]);
    expect(res.pages[1]).toBe('');
  });

  it('refuses a file over the parse limit before rendering anything', async () => {
    const pdf = book(1);
    const engine = fakeEngine();
    const res = await ocrPdfPages(pdf, { ...opts, pages: [1], engine, maxBytes: 10 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('too-large');
    expect(res.message).toContain('MB limit');
    expect(engine.seen).toHaveLength(0);
  });

  it('says exactly what to install when no engine is present, and does not throw', async () => {
    const pdf = book(1);
    // No engine injected and tesseract.js is not a dependency of this package, so this is
    // the real absence path, not a simulated one.
    const res = await ocrPdfPages(pdf, { ...opts, pages: [1] });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('unavailable');
    expect(res.message).toContain('tesseract.js is not installed');
    expect(res.message).toContain('npm i tesseract.js');
  });

  it('runs one job at a time, so two callers cannot peak together', async () => {
    const pdf = book(1);
    let inFlight = 0;
    let peak = 0;
    const slow = (): OcrEngine => ({
      name: 'slow',
      async readPage() {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return 'text';
      },
      async close() {},
    });
    await Promise.all([
      ocrPdfPages(pdf, { ...opts, pages: [1], engine: slow() }),
      ocrPdfPages(pdf, { ...opts, pages: [1], engine: slow() }),
      ocrPdfPages(pdf, { ...opts, pages: [1], engine: slow() }),
    ]);
    expect(peak).toBe(1);
  });
});

describe('the Electron page cap', () => {
  const electron = { electron: '44.2.0' } as Record<string, string>;

  it('lowers the cap under Electron and leaves it alone everywhere else', () => {
    expect(ocrPageCap(8, {})).toBe(8);
    expect(ocrPageCap(8, electron)).toBe(ELECTRON_OCR_MAX_PAGES);
    // A cap already below the Electron one is the user's, and is kept.
    expect(ocrPageCap(1, electron)).toBe(1);
  });

  it('says out loud that it changed a number the operator set, and only then', () => {
    expect(ocrCapNotice(8, {})).toBeUndefined();
    expect(ocrCapNotice(1, electron)).toBeUndefined();
    const notice = ocrCapNotice(8, electron)!;
    expect(notice).toContain('Electron 44.2.0');
    expect(notice).toContain(String(ELECTRON_OCR_MAX_PAGES));
  });

  itRendered('applies the Electron cap to a real pass', async () => {
    const pdf = book(4);
    const res = await ocrPdfPages(pdf, { ...opts, pages: [1, 2, 3, 4], engine: fakeEngine(), versions: electron });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.read).toEqual([1, 2]);
    expect(res.deferred).toEqual([3, 4]);
    expect(res.capNotice).toContain('Electron');
  });
});
