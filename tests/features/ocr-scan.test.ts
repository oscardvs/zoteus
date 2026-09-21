import { describe, it, expect } from 'vitest';
import { inspectScan, describeScan } from '../../src/features/ocr/scan.js';
import { locatePage } from '../../src/features/fulltext/pdf-pages.js';
import { renderPdfPages } from '../../src/features/fulltext/pdf-images.js';
import { bitmapTextPdf, scannedPagePdf, textPagePdf, figurePdf } from '../fixtures/pdf.js';

/**
 * A real JPEG of a real page, which is what a scanner's software wraps into a PDF, or null
 * when pdfjs (an optional dependency) or its canvas cannot render one here. Resolved once,
 * at module level, so the one test that needs it is SKIPPED out loud rather than returning
 * before it asserts anything and being counted as a pass.
 */
const SCAN = await (async (): Promise<{ jpeg: Uint8Array; width: number; height: number } | null> => {
  const rendered = await renderPdfPages(textPagePdf(), { pages: [1], dpi: 72, format: 'jpeg' });
  if ('error' in rendered) return null;
  const page = rendered.rendered[0]!;
  return { jpeg: page.bytes, width: page.width, height: page.height };
})();

describe('inspectScan', () => {
  it.skipIf(!SCAN)('calls a page stored as a JPEG a scan, and names the codec', async () => {
    const scan = SCAN!;
    const pdf = scannedPagePdf(scan.jpeg, scan.width, scan.height, { width: 200, height: 200 });
    const report = inspectScan(pdf, ['']);
    expect(report.verdict).toBe('scanned');
    expect(report.noTextLayer).toBe(true);
    expect(report.pages).toBe(1);
    expect(report.codecs).toEqual(['DCTDecode']);
    expect(report.imageObjects).toBe(1);

    const said = describeScan(report);
    expect(said).toContain('JPEG');
    expect(said).toContain('1 page');
    expect(said).toContain('scan, not a corrupt file');
    // The whole point of the change: never again "scanned OR corrupt".
    expect(said).not.toMatch(/scanned or corrupt/);
  });

  it('calls text painted as stencil glyphs a scan stored letter by letter', () => {
    const report = inspectScan(bitmapTextPdf(250), ['']);
    expect(report.verdict).toBe('glyph-bitmaps');
    expect(report.maskObjects).toBeGreaterThan(0);
    expect(report.codecs).toEqual([]);
    const said = describeScan(report);
    expect(said).toContain('letter by letter');
    expect(said).toContain('scan, not a corrupt file');
  });

  it('does not call a PDF with no images a scan: it may be text drawn as outlines', () => {
    // textPagePdf holds real text, but the same shape with the text converted to vector
    // outlines is what this branch is for: no text, no images.
    const report = inspectScan(textPagePdf(), ['']);
    expect(report.verdict).toBe('empty');
    expect(report.imageObjects).toBe(0);
    const said = describeScan(report);
    expect(said).toContain('vector');
    expect(said).not.toContain('scanner');
  });

  it('counts embedded images without a scanner codec as images, not as a scan', () => {
    // figurePdf's images are raw DeviceRGB samples: images, but nothing a scanner writes.
    const report = inspectScan(figurePdf(), ['', '']);
    expect(report.verdict).toBe('images');
    expect(report.imageObjects).toBe(2);
    expect(report.pages).toBe(2);
    expect(describeScan(report)).toContain('embedded image');
  });

  it('names the pages that lack a text layer when only some of them do, and claims no verdict', () => {
    const report = inspectScan(bitmapTextPdf(250), ['', 'a real page', '']);
    expect(report.noTextLayer).toBe(false);
    expect(report.pagesWithText).toEqual([2]);
    expect(report.pagesWithoutText).toEqual([1, 3]);
    const said = describeScan(report);
    expect(said).toContain('Pages 1, 3 of 3 pages carry no text layer (only page 2 does)');
    expect(said).toContain('letter by letter');
    // A file that holds real text on one page is not called "a scan, not a corrupt file":
    // that verdict rests on the whole file holding nothing but images.
    expect(said).not.toContain('no text to extract');
    expect(said).not.toContain('not a corrupt file');
  });

  it.skipIf(!SCAN)('names the pages without a text layer as spans, in a file that holds JPEGs', () => {
    const scan = SCAN!;
    const pdf = scannedPagePdf(scan.jpeg, scan.width, scan.height, { width: 200, height: 200 });
    const report = inspectScan(pdf, ['cover', '', '', '', 'index']);
    expect(report.pagesWithoutText).toEqual([2, 3, 4]);
    const said = describeScan(report);
    expect(said).toContain('Pages 2-4 of 5 pages carry no text layer (only pages 1, 5 do)');
    expect(said).toContain('JPEG');
    expect(said).toContain('pictures of text, or blank');
  });
});

describe('the largest image a file declares', () => {
  /**
   * An image XObject written out by hand: a stream object's dictionary is never packed into
   * a compressed object stream, which is exactly why this can be read off the raw bytes
   * without opening the document or decoding anything. No pdfjs, no canvas, no rendering.
   */
  const withImages = (...sizes: Array<{ w: number; h: number }>): Uint8Array =>
    new TextEncoder().encode(
      `%PDF-1.4\n` +
        sizes
          .map(
            (s, i) =>
              `${i + 7} 0 obj << /Type /XObject /Subtype /Image /Width ${s.w} /Height ${s.h} ` +
              `/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Length 2 >> stream\nxx\nendstream endobj\n`,
          )
          .join('') +
        `trailer << /Root 1 0 R >>\n%%EOF`,
    );

  it('reads the pixel count of a 600 dpi page, which is what exceeds a decode ceiling', () => {
    // 5100 x 6600 is 600 dpi US Letter: 33.7 megapixels, twice the 16.8 a shared server
    // decodes. pdfjs drops such an image and renders the page white, which is the one thing
    // that makes an OCR pass come back empty without any fault of the language or the page.
    const report = inspectScan(withImages({ w: 5100, h: 6600 }), ['']);
    expect(report.largestImagePixels).toBe(33_660_000);
    expect(report.verdict).toBe('scanned');
  });

  it('reports the largest of several images, not the first or the sum', () => {
    const report = inspectScan(withImages({ w: 100, h: 100 }, { w: 4000, h: 3000 }, { w: 50, h: 50 }), ['']);
    expect(report.largestImagePixels).toBe(12_000_000);
  });

  it('is 0 for a file with no images at all, so nothing can be blamed on a decode limit', () => {
    expect(inspectScan(textPagePdf(), ['']).largestImagePixels).toBe(0);
  });

  it('does not invent a size it cannot read: an indirect /Width stays small', () => {
    // `/Width 9 0 R` is a reference, not a number. Misreading one must never manufacture a
    // picture big enough to accuse a server's decode ceiling of dropping it.
    const bytes = new TextEncoder().encode(
      `%PDF-1.4\n7 0 obj << /Type /XObject /Subtype /Image /Width 9 0 R /Height 10 0 R ` +
        `/Filter /DCTDecode /Length 2 >> stream\nxx\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF`,
    );
    expect(inspectScan(bytes, ['']).largestImagePixels).toBeLessThan(1_000_000);
  });
});

describe('locatePage over OCR text', () => {
  // The exact-page promise rests entirely on this: a passage chunked out of OCR output is
  // matched back against the OCR pages it was chunked from, so recognition mistakes are in
  // both halves and cancel out. These two tests pin that, and pin the case where it fails.
  const ocrPages = [
    'Chapter one. The enêrgy of the systern is conserved under the given constraints.',
    'Chapter two. The Hessian is decornposed into a Gauss-Newton term plus a remainder.',
    'Chapter three. Convergence follows frorn the bounded curvature assumption.',
  ];

  it('finds the exact page for a passage cut from the same OCR output, mistakes and all', () => {
    expect(locatePage(ocrPages, 'The Hessian is decornposed into a Gauss-Newton term')).toBe(2);
    expect(locatePage(ocrPages, 'the ENÊRGY of   the systern')).toBe(1);
  });

  it('finds nothing when the passage came from somewhere else, rather than guessing', () => {
    // The publisher's spelling of the same sentence. Reporting page 2 here would be a wrong
    // number labelled "exact", which is why the tool replaces the text whenever it replaces
    // the pages instead of mixing the two sources.
    expect(locatePage(ocrPages, 'The Hessian is decomposed into a Gauss-Newton term')).toBeUndefined();
  });

  it('never matches a page the OCR pass did not read, because it is empty', () => {
    expect(locatePage(['', '', 'read page'], 'read page')).toBe(3);
    expect(locatePage(['', '', ''], 'anything at all')).toBeUndefined();
  });
});
