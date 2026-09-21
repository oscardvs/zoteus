import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import getFulltext from '../../src/tools/get-fulltext.js';
import { renderPdfPages } from '../../src/features/fulltext/pdf-images.js';
import { textPagePdf } from '../fixtures/pdf.js';
import { mixedBookPdf, scannedBookPdf } from '../fixtures/scanned-book.js';
import type { OcrEngine, OcrPageImage } from '../../src/features/ocr/engine.js';

/**
 * The engine is mocked; nothing else is. The PDF is a real one, it is really rendered, the
 * text really goes through the chunker and `locatePage`, and only the step that would need
 * a wasm engine and a language pack is replaced. `installed` decides whether the engine is
 * there at all, which is the other half of what these tests are about: what a user is told
 * when it is not.
 */
const h = vi.hoisted(() => ({
  installed: true,
  seen: [] as OcrPageImage[],
  read: (image: OcrPageImage) => `page ${image.page}`,
}));

vi.mock('../../src/features/ocr/engine.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/features/ocr/engine.js')>();
  const engine: OcrEngine = {
    name: 'fake-ocr (eng)',
    async readPage(image) {
      h.seen.push(image);
      return h.read(image);
    },
    async close() {},
  };
  return {
    ...actual,
    resolveOcrModule: (_path?: string) => (h.installed ? 'file:///fake/tesseract.js/index.js' : null),
    loadOcrEngine: async () => {
      if (!h.installed) throw new actual.OcrEngineUnavailable(actual.missingOcrHint({}));
      return engine;
    },
  };
});

const DATA = mkdtempSync(join(tmpdir(), 'zoteus-ocr-tool-'));

/** A page of OCR output with one term that occurs nowhere else in the book. */
const MARKERS = [
  'mitochondria',
  'thylakoid',
  'ribosome',
  'cytoskeleton',
  'lysosome',
  'centriole',
  'flagellum',
  'peroxisome',
  'vacuole',
];
/**
 * Every page is exactly 2400 characters, which is three times the chunker's 700-character
 * stride, so a chunk lands wholly inside each page and the exact-page assertions below are
 * about the page mapping rather than about where a chunk boundary happened to fall.
 */
const pageText = (n: number): string => {
  const body =
    `Page ${n} of the scanned monograph. ` +
    `The ${MARKERS[n - 1] ?? 'organelle'} is discussed at length on page ${n}. `.repeat(40);
  return body.padEnd(2400, `Filler for page ${n}. `).slice(0, 2400);
};

/**
 * The scanned fixtures, built once from a real rendered page, or null when pdfjs (an
 * optional dependency) or its canvas cannot render one here.
 *
 * Resolved at module level, not inside each test, so that an install without pdfjs SKIPS
 * these suites out loud instead of running them to a `return` and reporting a pass: a test
 * that asserts nothing must not be counted as one that asserted something.
 */
const SCANS = await (async (): Promise<{
  three: Uint8Array;
  nine: Uint8Array;
  forty: Uint8Array;
  /** A scan whose image dictionary declares more pixels than a shared server will decode. */
  overDecodeLimit: Uint8Array;
  /** Five pages, a text layer on 1 and 3 only: a scan whose cover and one stamp were OCR'd. */
  mixed: Uint8Array;
  /** Twelve pages, a text layer on page 1 only: more empty pages than one call may OCR. */
  mixedLong: Uint8Array;
} | null> => {
  const rendered = await renderPdfPages(textPagePdf(), { pages: [1], dpi: 72, format: 'jpeg' });
  if ('error' in rendered) return null;
  const page = rendered.rendered[0]!;
  return {
    three: scannedBookPdf(page.bytes, page.width, page.height, 3),
    nine: scannedBookPdf(page.bytes, page.width, page.height, 9),
    forty: scannedBookPdf(page.bytes, page.width, page.height, 40),
    // 5100 x 6600 is a 600 dpi US Letter page: 33.7 megapixels, twice what the shared
    // decode ceiling allows. pdfjs drops such an image and paints the page white.
    overDecodeLimit: scannedBookPdf(page.bytes, 5100, 6600, 1),
    mixed: mixedBookPdf(page.bytes, page.width, page.height, 5, [1, 3]),
    mixedLong: mixedBookPdf(page.bytes, page.width, page.height, 12, [1]),
  };
})();

const describeRendered = describe.skipIf(!SCANS);

function ctx(over: any = {}, bytes?: Uint8Array) {
  const c = {
    config: { dataDir: DATA, ocr: 'auto', ocrMaxPages: 8, ocrLangs: 'eng' },
    remoteCaller: false,
    router: {
      defaultLibrary: () => ({ type: 'user', id: 19552201 }),
      getItem: vi.fn(async () => ({ key: 'PARENT01', data: { itemType: 'book', title: 'A scanned monograph' } })),
      getItemChildren: vi.fn(async () => ({
        data: [{ key: 'ATT01', data: { itemType: 'attachment', contentType: 'application/pdf', filename: 'scan.pdf' } }],
        totalResults: 1,
        lastModifiedVersion: 1,
      })),
    },
    web: {
      getFullText: vi.fn(async () => null),
      downloadFileBytes: vi.fn(async () => ({ bytes: bytes ?? new Uint8Array([1]), contentType: 'application/pdf' })),
    },
    search: { hasEmbedder: false, embed: async () => [] },
    ...over,
  } as any;
  c.router.getFullText ??= (key: string, opts: any = {}) =>
    c.web.getFullText(opts.library ?? c.router.defaultLibrary(), key);
  return c;
}

const textOf = (res: any): string => (res.content ?? []).map((x: { text: string }) => x.text).join('\n');

beforeEach(() => {
  h.installed = true;
  h.seen = [];
  h.read = (image) => pageText(image.page);
});

describeRendered('a PDF with no text layer, without OCR', () => {
  it('says it is a scan, how many pages, and what would read it', async () => {
    const pdfs = SCANS!;
    const res = await getFulltext.handler({ item_key: 'PARENT01', query: 'anything' }, ctx({}, pdfs.three));
    expect(res.isError).toBe(true);
    const text = textOf(res);
    // Which: a scan, not a corrupt file.
    expect(text).toContain('scan, not a corrupt file');
    expect(text).not.toMatch(/scanned or corrupt/);
    // How many pages, and what the file holds instead of text.
    expect(text).toContain('3 pages');
    expect(text).toContain('JPEG');
    // What would read it: OCR here (the engine is installed in this test), and the two
    // remedies that need no engine at all.
    expect(text).toContain('ocr:true');
    expect(text).toContain('zotero_pdf_images');
    expect(text).toContain('OCR tool outside Zotero');
    // Nothing was recognised: the answer costs no OCR at all.
    expect(h.seen).toHaveLength(0);
  });

  it('tells a local user what to install when the engine is missing', async () => {
    const pdfs = SCANS!;
    h.installed = false;
    const res = await getFulltext.handler(
      { item_key: 'PARENT01' },
      ctx({ config: { dataDir: DATA, ocr: 'off', ocrMaxPages: 8, ocrLangs: 'eng' } }, pdfs.three),
    );
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain('npm i tesseract.js');
    expect(text).toContain('ZOTEUS_OCR=auto');
    expect(text).toContain('scan, not a corrupt file');
  });

  it('does not tell a caller on a shared server to install anything on it', async () => {
    const pdfs = SCANS!;
    const res = await getFulltext.handler(
      { item_key: 'PARENT01' },
      ctx({ remoteCaller: true, config: { dataDir: DATA, ocr: 'off', ocrMaxPages: 8, ocrLangs: 'eng' } }, pdfs.three),
    );
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain('only its operator can turn it on');
    expect(text).not.toContain('npm i');
    // The remedy a shared caller CAN act on is still offered.
    expect(text).toContain('zotero_pdf_images');
  });
});

describeRendered('ocr:true', () => {
  it('is refused, with the exact remedy, when OCR is switched off', async () => {
    const pdfs = SCANS!;
    const res = await getFulltext.handler(
      { item_key: 'PARENT01', ocr: true },
      ctx({ config: { dataDir: DATA, ocr: 'off', ocrMaxPages: 8, ocrLangs: 'eng' } }, pdfs.three),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('ZOTEUS_OCR=auto');
    expect(h.seen).toHaveLength(0);
  });

  it('names the package and the install line when the engine is not installed', async () => {
    const pdfs = SCANS!;
    h.installed = false;
    const res = await getFulltext.handler({ item_key: 'PARENT01', ocr: true }, ctx({}, pdfs.three));
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain('tesseract.js is not installed');
    expect(text).toContain('npm i tesseract.js');
    expect(text).toContain('does not ship an OCR engine');
  });

  it('reports an exact page for a passage that only OCR could have found', async () => {
    const pdfs = SCANS!;
    const ocr = await getFulltext.handler({ item_key: 'PARENT01', query: 'thylakoid', ocr: true }, ctx({}, pdfs.three));
    expect(ocr.isError).toBeUndefined();
    const out = ocr.structuredContent as any;
    expect(out.mode).toBe('passages');
    expect(out.fulltextSource).toBe('ocr');
    expect(out.pageSource).toBe('exact');
    expect(out.totalPages).toBe(3);
    expect(out.passages[0].page).toBe(2);
    expect(out.passages[0].text).toContain('thylakoid');
    // Provenance, and the honest limit of what this did.
    expect(out.notice).toContain('read by OCR');
    expect(out.notice).toContain('fake-ocr (eng)');
    expect(out.notice).toContain('machine reading of a picture');
    expect(out.notice).toContain('zotero_semantic_search');
    // The one way to make it persist is named, and it is the loop that already ships.
    expect(out.notice).toContain('zotero_fulltext action:"set"');
    expect(out.notice).toContain('zotero_index action:"update"');
    expect(h.seen.map((i) => i.page)).toEqual([1, 2, 3]);
  });

  it('does not offer the write-back loop on a read-only deployment, where that tool is gone', async () => {
    const pdfs = SCANS!;
    const res = await getFulltext.handler(
      { item_key: 'PARENT01', query: 'thylakoid', ocr: true },
      ctx({ config: { dataDir: DATA, ocr: 'auto', ocrMaxPages: 8, ocrLangs: 'eng', readOnly: true } }, pdfs.three),
    );
    const sc = res.structuredContent as any;
    expect(sc.fulltextSource).toBe('ocr');
    expect(sc.notice).toContain('stored nowhere');
    expect(sc.notice).not.toContain('zotero_fulltext');
  });

  it('runs on a shared server when the operator enabled it, rather than refusing by default', async () => {
    // The deliberate hosted decision: OCR is gated by ZOTEUS_OCR, which is off by default,
    // not by a refusal the operator cannot lift. An operator who installed the engine and
    // set ZOTEUS_OCR=auto gets it, bounded by the same per-call page cap.
    const pdfs = SCANS!;
    const res = await getFulltext.handler(
      { item_key: 'PARENT01', query: 'ribosome', ocr: true },
      ctx({ remoteCaller: true }, pdfs.three),
    );
    const sc = res.structuredContent as any;
    expect(sc.fulltextSource).toBe('ocr');
    expect(sc.passages[0].page).toBe(3);
  });

  it('slices page_range out of the OCR pages exactly, and reads only those pages', async () => {
    const pdfs = SCANS!;
    const res = await getFulltext.handler({ item_key: 'PARENT01', page_range: '2-3', ocr: true }, ctx({}, pdfs.three));
    const sc = res.structuredContent as any;
    expect(sc.mode).toBe('page_range');
    expect(sc.pageSource).toBe('exact');
    expect(sc.text.startsWith('Page 2 of the scanned monograph.')).toBe(true);
    expect(sc.text).toContain('ribosome');
    expect(sc.text).not.toContain('mitochondria');
    // Exactly the asked-for pages were rendered and recognised: page 1 was never touched.
    expect(h.seen.map((i) => i.page)).toEqual([2, 3]);
  });

  it('says in the sentence itself that document mode returned OCR text, not the publisher\'s', async () => {
    // The simplest way to call the feature, and the one the lead sentence used to answer
    // with "extracted from the PDF directly": the exact confusion OCR exists to prevent,
    // and byte-identical to what a real text layer is described with.
    const res = await getFulltext.handler({ item_key: 'PARENT01', ocr: true, max_chars: 600 }, ctx({}, SCANS!.three));
    const summary = textOf(res).split('\n')[0]!;
    expect(summary).not.toContain('extracted from the PDF directly');
    expect(summary).toContain('OCR');
    expect(summary).toContain("not the publisher's text");
    // The caveat itself rides the text block now, as it does in the other two modes.
    expect(textOf(res)).toContain('machine reading of a picture');
    expect((res.structuredContent as any).fulltextSource).toBe('ocr');
  });

  it('stops at the page cap and says how to ask for the rest', async () => {
    const pdfs = SCANS!;
    const res = await getFulltext.handler({ item_key: 'PARENT01', ocr: true, max_chars: 600 }, ctx({}, pdfs.nine));
    const sc = res.structuredContent as any;
    expect(sc.fulltextSource).toBe('ocr');
    expect(sc.totalPages).toBe(9);
    expect(sc.notice).toContain('Pages 9 were not read');
    expect(sc.notice).toContain('page_range:"9-9"');
    expect(sc.notice).toContain('ZOTEUS_OCR_MAX_PAGES');
    expect(h.seen.map((i) => i.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('leaves a PDF that has a text layer alone: the engine is never called', async () => {
    const res = await getFulltext.handler({ item_key: 'PARENT01', ocr: true }, ctx({}, textPagePdf()));
    const sc = res.structuredContent as any;
    expect(sc.fulltextSource).toBe('pdf');
    expect(sc.text).toContain('Hello PDF');
    expect(h.seen).toHaveLength(0);
  });
});

describeRendered('the page a cited OCR passage carries', () => {
  it('gives one page number, not an exact page beside an estimate made over the whole book', async () => {
    // 40 pages, 8 of them read. A proportional estimate over the whole document is
    // meaningless when the text is only the front of it: it used to answer page 7 and
    // pageApprox 33 in the same object, 26 pages apart.
    const res = await getFulltext.handler(
      { item_key: 'PARENT01', query: 'flagellum', ocr: true },
      ctx({}, SCANS!.forty),
    );
    const sc = res.structuredContent as any;
    expect(sc.fulltextSource).toBe('ocr');
    expect(sc.totalPages).toBe(40);
    expect(sc.passages.length).toBeGreaterThan(0);
    for (const p of sc.passages) {
      expect(p.page).toBeGreaterThanOrEqual(1);
      expect(p.page).toBeLessThanOrEqual(8); // only pages 1-8 were read; nothing else can be cited
      expect(p.pageApprox).toBeUndefined();
    }
    expect(sc.passages[0].page).toBe(7);
    expect(sc.passages[0].text).toContain('flagellum');
  });

  it('places every passage of a capped run on a page the run actually read', async () => {
    // The offset says the page outright, so a chunk whose head straddles a page join gets a
    // real page too, where matching its leading characters against a page found nothing and
    // left a proportional estimate as the only locator.
    const res = await getFulltext.handler(
      { item_key: 'PARENT01', query: 'scanned monograph', ocr: true, max_passages: 8 },
      ctx({}, SCANS!.forty),
    );
    const sc = res.structuredContent as any;
    const pages = sc.passages.map((p: any) => p.page);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((p: number) => Number.isInteger(p) && p >= 1 && p <= 8)).toBe(true);
    expect(sc.passages.every((p: any) => p.pageApprox === undefined)).toBe(true);
  });
});

describeRendered('a scan whose pages are too many pixels for this server to decode', () => {
  it('names the decode ceiling instead of blaming the language or a blank page', async () => {
    // pdfjs removes an image above `maxImageSize` and renders the page white anyway, saying
    // so on stderr and nowhere else. OCR then reads blank paper. Telling the user their
    // 600 dpi scan is blank, or in the wrong language, sends them to re-tune
    // ZOTEUS_OCR_LANGS forever.
    h.read = () => '';
    const res = await getFulltext.handler(
      { item_key: 'PARENT01', ocr: true },
      ctx({ remoteCaller: true }, SCANS!.overDecodeLimit),
    );
    const sc = res.structuredContent as any;
    expect(sc.fulltextSource).toBe('ocr');
    expect(sc.notice).toContain('recognised as no text at all');
    expect(sc.notice).toContain('33.7 megapixel image');
    expect(sc.notice).toContain('16.8');
    expect(sc.notice).toContain('blank white paper');
    expect(sc.notice).toContain('operator');
    // The two causes that are both false here are gone.
    expect(sc.notice).not.toContain('ZOTEUS_OCR_LANGS does not name');
  });

  it('still blames the language or a blank page when no image is anywhere near the ceiling', async () => {
    h.read = () => '';
    const res = await getFulltext.handler({ item_key: 'PARENT01', ocr: true }, ctx({}, SCANS!.three));
    const sc = res.structuredContent as any;
    expect(sc.notice).toContain('recognised as no text at all');
    expect(sc.notice).toContain('ZOTEUS_OCR_LANGS does not name');
    expect(sc.notice).not.toContain('megapixel');
  });
});

describeRendered('a page_range that lies past the end of the document', () => {
  it('says how long the document is, rather than that no page was asked for', async () => {
    const res = await getFulltext.handler(
      { item_key: 'PARENT01', ocr: true, page_range: '50-60' },
      ctx({}, SCANS!.three),
    );
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain('pages 50-60 are beyond the document, which has 3 pages');
    expect(text).not.toContain('no page was asked for');
    // Nothing was rendered or recognised for a span that cannot exist.
    expect(h.seen).toHaveLength(0);
  });

  it('reads the pages that do exist when only the tail of the span is past the end', async () => {
    const res = await getFulltext.handler(
      { item_key: 'PARENT01', ocr: true, page_range: '2-60' },
      ctx({}, SCANS!.three),
    );
    expect(res.isError).toBeUndefined();
    expect(h.seen.map((i) => i.page)).toEqual([2, 3]);
  });
});

/**
 * A text layer on some pages and none on the rest: a scan whose cover page was OCR'd, a
 * "Scanned by" stamp, a watermark. "Does any page have text" said yes, so the file counted
 * as a text PDF: `ocr:true` was silently ignored and N mostly-empty pages were presented
 * as "extracted directly from the PDF".
 */
describeRendered('a PDF whose text layer covers only some of its pages', () => {
  it('without ocr:true, returns the text layer and names the pages it does not cover', async () => {
    const res = await getFulltext.handler({ item_key: 'PARENT01', max_chars: 2000 }, ctx({}, SCANS!.mixed));
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as any;
    expect(sc.fulltextSource).toBe('pdf');
    expect(sc.totalPages).toBe(5);
    expect(sc.text).toContain('Text layer of page 1');
    expect(sc.text).toContain('Text layer of page 3');
    expect(sc.ocrPages).toBeUndefined();
    // The pages a locator can never point at, and what would read them.
    expect(sc.notice).toContain('Pages 2, 4-5 of 5 pages carry no text layer (only pages 1, 3 do)');
    expect(sc.notice).toContain('ocr:true');
    expect(sc.notice).toContain('JPEG');
    // It is not presented as a complete extraction, in the sentence a reader sees first.
    expect(textOf(res).split('\n')[0]).toContain('carry no text layer');
    expect(h.seen).toHaveLength(0);
  });

  it('with ocr:true, reads only the pages without a text layer and merges them with it', async () => {
    const res = await getFulltext.handler({ item_key: 'PARENT01', ocr: true, max_chars: 20000 }, ctx({}, SCANS!.mixed));
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as any;
    expect(sc.fulltextSource).toBe('pdf+ocr');
    expect(sc.totalPages).toBe(5);
    // Pages 1 and 3 have a text layer and were never rendered or recognised.
    expect(h.seen.map((i) => i.page)).toEqual([2, 4, 5]);
    expect(sc.ocrPages).toEqual([2, 4, 5]);
    // Both sources, in page order, in one document.
    expect(sc.text).toContain('Text layer of page 1');
    expect(sc.text).toContain('thylakoid');
    expect(sc.text).toContain('Text layer of page 3');
    expect(sc.text).toContain('cytoskeleton');
    expect(sc.text).toContain('lysosome');
    // Which pages are the publisher's text and which are a machine's reading of a picture.
    expect(sc.notice).toContain('Pages 2, 4-5 were read by OCR with fake-ocr (eng)');
    expect(sc.notice).toContain('Pages 1, 3 carry a text layer and were extracted directly from the PDF');
    expect(sc.notice).toContain('machine reading of a picture');
    const summary = textOf(res).split('\n')[0]!;
    expect(summary).toContain('pages 1, 3 extracted from the PDF directly');
    expect(summary).toContain('pages 2, 4-5 read off the page by OCR');
    expect(summary).not.toContain('extracted from the PDF directly)');
  });

  it('reports an exact page for a passage found on an OCR page', async () => {
    const res = await getFulltext.handler({ item_key: 'PARENT01', query: 'cytoskeleton', ocr: true }, ctx({}, SCANS!.mixed));
    const sc = res.structuredContent as any;
    expect(sc.fulltextSource).toBe('pdf+ocr');
    expect(sc.pageSource).toBe('exact');
    expect(sc.passages[0].page).toBe(4);
    expect(sc.passages[0].pageApprox).toBeUndefined();
  });

  it('narrows OCR to the pages inside page_range that lack a text layer', async () => {
    const res = await getFulltext.handler({ item_key: 'PARENT01', page_range: '3-4', ocr: true }, ctx({}, SCANS!.mixed));
    const sc = res.structuredContent as any;
    expect(sc.mode).toBe('page_range');
    expect(sc.pageSource).toBe('exact');
    // Page 3 has a text layer: it is sliced out of the extraction, never OCR'd.
    expect(h.seen.map((i) => i.page)).toEqual([4]);
    expect(sc.text.startsWith('Text layer of page 3')).toBe(true);
    expect(sc.text).toContain('cytoskeleton');
    expect(sc.text).not.toContain('thylakoid');
  });

  it('applies the per-call page cap to the OCR pages alone', async () => {
    const res = await getFulltext.handler({ item_key: 'PARENT01', ocr: true, max_chars: 600 }, ctx({}, SCANS!.mixedLong));
    const sc = res.structuredContent as any;
    expect(sc.fulltextSource).toBe('pdf+ocr');
    expect(sc.totalPages).toBe(12);
    // Eight pages a call, counted over the pages that need OCR: page 1 does not use one up.
    expect(h.seen.map((i) => i.page)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(sc.ocrPages).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(sc.notice).toContain('Pages 10-12 were not read');
    expect(sc.notice).toContain('page_range:"10-12"');
  });

  it('still returns the text layer, and says why, when ocr:true is asked for and OCR is off', async () => {
    const res = await getFulltext.handler(
      { item_key: 'PARENT01', ocr: true },
      ctx({ config: { dataDir: DATA, ocr: 'off', ocrMaxPages: 8, ocrLangs: 'eng' } }, SCANS!.mixed),
    );
    // Unlike a scan with no text at all, there is something to return, so this is not an
    // error; but "ocr:true was ignored" is exactly what the notice must not let happen.
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as any;
    expect(sc.fulltextSource).toBe('pdf');
    expect(sc.text).toContain('Text layer of page 1');
    expect(sc.notice).toContain('Pages 2, 4-5 of 5 pages carry no text layer');
    expect(sc.notice).toContain('`ocr:true` was asked for, and OCR is off');
    expect(sc.notice).toContain('ZOTEUS_OCR=auto');
    expect(h.seen).toHaveLength(0);
  });

  it('reads nothing, and says so, when every page in page_range has a text layer', async () => {
    const res = await getFulltext.handler({ item_key: 'PARENT01', page_range: '1', ocr: true }, ctx({}, SCANS!.mixed));
    const sc = res.structuredContent as any;
    expect(sc.text).toBe('Text layer of page 1');
    expect(sc.notice).toContain('`ocr:true` read nothing: every page in page_range 1-1 carries a text layer');
    expect(h.seen).toHaveLength(0);
  });

  describe('when Zotero indexed the text layer', () => {
    const indexed = { content: 'Text layer of page 1 Text layer of page 3', indexedChars: 41, totalChars: 41, indexedPages: 5, totalPages: 5 };
    const indexedCtx = (pdf: Uint8Array) =>
      ctx({ web: { getFullText: vi.fn(async () => indexed), downloadFileBytes: vi.fn(async () => ({ bytes: pdf, contentType: 'application/pdf' })) } });

    it('is re-read, text layer plus OCR, when ocr:true is passed', async () => {
      const res = await getFulltext.handler({ item_key: 'PARENT01', query: 'cytoskeleton', ocr: true }, indexedCtx(SCANS!.mixed));
      const sc = res.structuredContent as any;
      expect(sc.fulltextSource).toBe('pdf+ocr');
      expect(sc.pageSource).toBe('exact');
      expect(sc.ocrPages).toEqual([2, 4, 5]);
      expect(sc.passages[0].page).toBe(4);
      expect(sc.notice).toContain('comes from its text layer, which some pages lack');
      expect(sc.notice).toContain('Pages 2, 4-5 were read by OCR');
    });

    it('names the pages the index cannot cover when exact pages are asked for without OCR', async () => {
      const res = await getFulltext.handler({ item_key: 'PARENT01', page_range: '1-2' }, indexedCtx(SCANS!.mixed));
      const sc = res.structuredContent as any;
      expect(sc.fulltextSource).toBe('zotero');
      expect(sc.pageSource).toBe('exact');
      expect(sc.notice).toContain('Pages 2, 4-5 of 5 pages carry no text layer (only pages 1, 3 do)');
      expect(sc.notice).toContain('ocr:true');
      expect(h.seen).toHaveLength(0);
    });
  });
});

describeRendered('a scan Zotero indexed as a handful of junk characters', () => {
  const junk = { content: 'SCAN 0001', indexedChars: 9, totalChars: 9, indexedPages: 3, totalPages: 3 };

  it('still gets the no-text-layer answer, instead of exact pages that locate nothing', async () => {
    const pdfs = SCANS!;
    const res = await getFulltext.handler(
      { item_key: 'PARENT01', query: 'thylakoid', precise_pages: true },
      ctx({ web: { getFullText: vi.fn(async () => junk), downloadFileBytes: vi.fn(async () => ({ bytes: pdfs.three, contentType: 'application/pdf' })) } }),
    );
    const sc = res.structuredContent as any;
    // The old behaviour called three empty pages "exact" and then located nothing on them.
    expect(sc.pageSource).toBe('approximate');
    expect(sc.notice).toContain('scan, not a corrupt file');
    expect(sc.notice).toContain('ocr:true');
  });

  it('is read by OCR when ocr:true is passed, text and pages together', async () => {
    const pdfs = SCANS!;
    const res = await getFulltext.handler(
      { item_key: 'PARENT01', query: 'ribosome', ocr: true },
      ctx({ web: { getFullText: vi.fn(async () => junk), downloadFileBytes: vi.fn(async () => ({ bytes: pdfs.three, contentType: 'application/pdf' })) } }),
    );
    const sc = res.structuredContent as any;
    expect(sc.fulltextSource).toBe('ocr');
    expect(sc.pageSource).toBe('exact');
    expect(sc.passages[0].page).toBe(3);
    // Zotero's own junk text is gone, not mixed with the OCR pages: a passage matched
    // against pages it did not come from would report a wrong page as an exact one.
    expect(sc.passages[0].text).not.toContain('SCAN 0001');
    expect(sc.notice).toContain('read off the page by OCR');
  });
});
