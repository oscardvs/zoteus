import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pdfImages, {
  DEFAULT_MAX_PAGES,
  HARD_MAX_PAGES,
  INLINE_BUDGET_BASE64,
} from '../../src/tools/pdf-images.js';
import getFulltext from '../../src/tools/get-fulltext.js';
import { LIBRARY_CONTENT_PROVENANCE } from '../../src/registry/registry.js';
import { figurePdf, textPagePdf } from '../fixtures/pdf.js';
import { buildEpub } from '../fixtures/epub.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'zoteus-pdf-images-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

/** A context whose only source of bytes is a cloud download answering with `bytes`. */
function ctx(bytes: Uint8Array, over: any = {}) {
  return {
    config: { dataDir },
    remoteCaller: false,
    capabilities: { cloud: { userID: 1 }, localApi: false },
    router: {
      defaultLibrary: () => ({ type: 'user', id: 1 }),
      getItem: vi.fn(async () => ({
        key: 'PARENT01',
        data: { itemType: 'journalArticle', title: 'A paper' },
      })),
      getItemChildren: vi.fn(async () => ({
        data: [
          {
            key: 'ATT01',
            data: { itemType: 'attachment', contentType: 'application/pdf', filename: 'paper.pdf' },
          },
        ],
        totalResults: 1,
        lastModifiedVersion: 1,
      })),
    },
    web: { downloadFileBytes: vi.fn(async () => ({ bytes, contentType: 'application/pdf' })) },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...over,
  } as any;
}

const texts = (res: any): string[] =>
  res.content.filter((c: any) => c.type === 'text').map((c: any) => c.text);
const imageBlocks = (res: any): any[] => res.content.filter((c: any) => c.type === 'image');
const decode = (b64: string) => new Uint8Array(Buffer.from(b64, 'base64'));
const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8;
const isPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50;

/** True when pdfjs cannot draw here at all, in which case the drawing tests stand down. */
function unavailable(res: any): boolean {
  return Boolean(res.isError) && /pdfjs-dist|napi-rs\/canvas/.test(texts(res).join(' '));
}

describe('zotero_pdf_images', () => {
  it('is annotated read-only and cross-references the text tool both ways', () => {
    expect(pdfImages.annotations?.readOnlyHint).toBe(true);
    expect(pdfImages.description).toMatch(/zotero_get_fulltext/);
    expect(getFulltext.description).toMatch(/zotero_pdf_images/);
    expect(pdfImages.description.toLowerCase()).toMatch(/scanned/);
    expect(pdfImages.description.toLowerCase()).toMatch(/vector/);
  });

  it('caps are what the description promises', () => {
    expect(DEFAULT_MAX_PAGES).toBe(4);
    expect(HARD_MAX_PAGES).toBe(8);
    expect(INLINE_BUDGET_BASE64).toBe(5 * 1024 * 1024);
    expect(pdfImages.inputSchema.max_pages!.safeParse(HARD_MAX_PAGES + 1).success).toBe(false);
    expect(pdfImages.inputSchema.dpi!.safeParse(301).success).toBe(false);
    expect(pdfImages.inputSchema.dpi!.safeParse(35).success).toBe(false);
  });

  describe('mode:"pages"', () => {
    it('returns the page as an image block between the summary and the JSON mirror', async () => {
      const c = ctx(figurePdf());
      const res = await pdfImages.handler(
        { item_key: 'PARENT01', mode: 'pages', pages: '1', dpi: 72 },
        c,
      );
      if (unavailable(res)) return;
      expect(res.isError).toBeFalsy();
      expect(c.router.getItemChildren).toHaveBeenCalled();
      expect(res.content[0]!.type).toBe('text');
      expect(res.content[1]!.type).toBe('image');
      expect(res.content[2]!.type).toBe('text');
      const img = imageBlocks(res)[0];
      expect(img.mimeType).toBe('image/jpeg');
      expect(isJpeg(decode(img.data))).toBe(true);
      const sc = res.structuredContent as any;
      expect(sc.mode).toBe('pages');
      expect(sc.attachmentKey).toBe('ATT01');
      expect(sc.numPages).toBe(2);
      expect(sc.pages).toEqual([
        {
          page: 1,
          width: 300,
          height: 300,
          dpi: 72,
          mimeType: 'image/jpeg',
          bytes: expect.any(Number),
          inline: true,
          path: undefined,
        },
      ]);
      expect(sc.provenance).toEqual(LIBRARY_CONTENT_PROVENANCE);
      // The JSON mirror carries the marker too, for clients that drop structuredContent.
      expect(texts(res).join('\n')).toContain('"trust": "untrusted"');
      expect(texts(res)[0]).toMatch(/Rendered 1 page\(s\)/);
      expect(texts(res)[0]).toMatch(/Zotero cloud storage/);
    });

    it('does not save by default, and saves under the data dir when asked', async () => {
      const c = ctx(figurePdf());
      const quiet = await pdfImages.handler(
        { item_key: 'PARENT01', mode: 'pages', pages: '1', dpi: 72 },
        c,
      );
      if (unavailable(quiet)) return;
      await expect(stat(join(dataDir, 'pdf-images'))).rejects.toThrow();
      const res = await pdfImages.handler(
        { item_key: 'PARENT01', mode: 'pages', pages: '1-2', dpi: 72, format: 'png', save: true },
        c,
      );
      const sc = res.structuredContent as any;
      const expected = [
        join(dataDir, 'pdf-images', 'ATT01', 'page-001.png'),
        join(dataDir, 'pdf-images', 'ATT01', 'page-002.png'),
      ];
      expect(sc.pages.map((p: any) => p.path)).toEqual(expected);
      for (const p of expected) expect(isPng(new Uint8Array(await readFile(p)))).toBe(true);
      expect(sc.notice).toContain('Files saved under');
    });

    it('returns metadata only with inline:false', async () => {
      const res = await pdfImages.handler(
        { item_key: 'PARENT01', mode: 'pages', pages: '1', dpi: 72, inline: false },
        ctx(figurePdf()),
      );
      if (unavailable(res)) return;
      expect(imageBlocks(res)).toEqual([]);
      expect((res.structuredContent as any).pages[0].inline).toBe(false);
      expect(texts(res)[0]).toMatch(/none returned inline/);
    });

    it('cuts a long span at max_pages and says how to continue', async () => {
      const res = await pdfImages.handler(
        { item_key: 'PARENT01', mode: 'pages', pages: '1-9', dpi: 36, max_pages: 1 },
        ctx(figurePdf()),
      );
      if (unavailable(res)) return;
      const sc = res.structuredContent as any;
      expect(sc.pages.map((p: any) => p.page)).toEqual([1]);
      expect(sc.notice).toContain('Pages 2-9 were not processed');
      expect(sc.notice).toContain('pages:"2-9"');
    });

    it('names pages beyond the document, and errors when none exist', async () => {
      const partial = await pdfImages.handler(
        { item_key: 'PARENT01', mode: 'pages', pages: '2-3', dpi: 36 },
        ctx(figurePdf()),
      );
      if (unavailable(partial)) return;
      expect(partial.isError).toBeFalsy();
      expect((partial.structuredContent as any).notice).toMatch(
        /Pages 3 are beyond the document \(2 pages\)/,
      );
      const none = await pdfImages.handler(
        { item_key: 'PARENT01', mode: 'pages', pages: '7', dpi: 36 },
        ctx(figurePdf()),
      );
      expect(none.isError).toBe(true);
      expect(texts(none)[0]).toMatch(/it has 2 page\(s\)/);
    });

    it('rejects a malformed page spec before touching the library', async () => {
      const c = ctx(figurePdf());
      const res = await pdfImages.handler({ item_key: 'PARENT01', mode: 'pages', pages: 'iv' }, c);
      expect(res.isError).toBe(true);
      expect(c.router.getItem).not.toHaveBeenCalled();
    });
  });

  describe('mode:"figures"', () => {
    it('extracts the figure, saves it locally by default, returns it inline, and explains what it skipped', async () => {
      const res = await pdfImages.handler(
        { item_key: 'PARENT01', mode: 'figures', pages: '1-2' },
        ctx(figurePdf()),
      );
      if (unavailable(res)) return;
      expect(res.isError).toBeFalsy();
      const sc = res.structuredContent as any;
      expect(sc.mode).toBe('figures');
      expect(sc.images).toHaveLength(1);
      const path = join(dataDir, 'pdf-images', 'ATT01', 'page-001-image-001.png');
      expect(sc.images[0]).toMatchObject({
        page: 1,
        index: 1,
        width: 64,
        height: 48,
        mimeType: 'image/png',
        source: 'xobject',
        bbox: { x: 40, y: 60, width: 120, height: 90 },
        coversPage: false,
        inline: true,
        path,
      });
      expect(isPng(new Uint8Array(await readFile(path)))).toBe(true);
      const [img] = imageBlocks(res);
      expect(img.mimeType).toBe('image/png');
      expect(isPng(decode(img.data))).toBe(true);
      expect(sc.skipped).toEqual({ tiny: 1, duplicate: 2, undecodable: 0 });
      expect(sc.notice).toMatch(/Skipped 1 image\(s\) under 32 px/);
      expect(sc.notice).toMatch(/Folded 2 repeat\(s\)/);
      expect(sc.notice).toContain('Files saved under');
      expect(texts(res)[0]).toMatch(/1 embedded image\(s\) on pages 1-2/);
    });

    it('says when a page has text but no raster image, pointing at pages mode', async () => {
      const res = await pdfImages.handler(
        { item_key: 'PARENT01', mode: 'figures', pages: '1', save: false },
        ctx(textPagePdf()),
      );
      if (unavailable(res)) return;
      expect(res.isError).toBeFalsy();
      const sc = res.structuredContent as any;
      expect(sc.images).toEqual([]);
      expect(sc.pagesWithoutImages).toEqual([1]);
      expect(sc.notice).toMatch(/drawn as vectors/);
      expect(sc.notice).toMatch(/mode:"pages"/);
      expect(imageBlocks(res)).toEqual([]);
    });

    it('honours max_images and min_size', async () => {
      const res = await pdfImages.handler(
        {
          item_key: 'PARENT01',
          mode: 'figures',
          pages: '1',
          min_size: 4,
          max_images: 1,
          save: false,
        },
        ctx(figurePdf()),
      );
      if (unavailable(res)) return;
      const sc = res.structuredContent as any;
      expect(sc.images).toHaveLength(1);
      expect(sc.notice).toMatch(/Stopped at max_images \(1\)/);
    });
  });

  describe('on a shared server', () => {
    it('refuses save:true and explains whose disk it would be', async () => {
      const c = ctx(figurePdf(), { remoteCaller: true });
      const res = await pdfImages.handler(
        { item_key: 'PARENT01', mode: 'figures', pages: '1', save: true },
        c,
      );
      expect(res.isError).toBe(true);
      expect(texts(res)[0]).toMatch(/shared server/);
      expect(c.router.getItem).not.toHaveBeenCalled();
    });

    it('does not save figures by default, and still returns them inline', async () => {
      const res = await pdfImages.handler(
        { item_key: 'PARENT01', mode: 'figures', pages: '1' },
        ctx(figurePdf(), { remoteCaller: true }),
      );
      if (unavailable(res)) return;
      expect(res.isError).toBeFalsy();
      const sc = res.structuredContent as any;
      expect(sc.images[0].path).toBeUndefined();
      expect(sc.images[0].inline).toBe(true);
      await expect(stat(join(dataDir, 'pdf-images'))).rejects.toThrow();
    });
  });

  describe('files it cannot draw', () => {
    it('says an EPUB has no pages and points at the text tool', async () => {
      const epub = buildEpub();
      const res = await pdfImages.handler(
        { item_key: 'PARENT01', mode: 'pages', pages: '1' },
        ctx(epub),
      );
      expect(res.isError).toBe(true);
      expect(texts(res)[0]).toMatch(/EPUB/);
      expect(texts(res)[0]).toMatch(/zotero_get_fulltext/);
    });

    it('names a password-protected PDF as such', async () => {
      const bytes = new Uint8Array(await readFile(join(FIXTURES, 'encrypted-user-password.pdf')));
      const res = await pdfImages.handler(
        { item_key: 'PARENT01', mode: 'pages', pages: '1' },
        ctx(bytes),
      );
      if (unavailable(res)) return;
      expect(res.isError).toBe(true);
      expect(texts(res)[0]).toMatch(/password/);
    });

    it('opens an owner-password PDF like any other', async () => {
      const bytes = new Uint8Array(await readFile(join(FIXTURES, 'encrypted-owner-only.pdf')));
      const res = await pdfImages.handler(
        { item_key: 'PARENT01', mode: 'pages', pages: '1', dpi: 72 },
        ctx(bytes),
      );
      if (unavailable(res)) return;
      expect(res.isError).toBeFalsy();
      expect(imageBlocks(res)).toHaveLength(1);
    });

    it('calls garbage a non-PDF rather than crashing', async () => {
      const garbage = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 9, 9, 9, 9, 9]); // "%PDF-" then noise
      const res = await pdfImages.handler(
        { item_key: 'PARENT01', mode: 'figures', pages: '1' },
        ctx(garbage),
      );
      expect(res.isError).toBe(true);
      expect(texts(res)[0]).toMatch(/not a readable PDF|could not be drawn/);
    });

    it('skips the download entirely when Zotero says the file is above the cap', async () => {
      const c = ctx(figurePdf(), {
        router: {
          defaultLibrary: () => ({ type: 'user', id: 1 }),
          getItem: vi.fn(async () => ({
            key: 'PARENT01',
            data: { itemType: 'journalArticle', title: 'Big' },
          })),
          getItemChildren: vi.fn(async () => ({
            data: [
              {
                key: 'ATT01',
                data: {
                  itemType: 'attachment',
                  contentType: 'application/pdf',
                  filename: 'big.pdf',
                },
                links: { enclosure: { length: 50 * 1024 * 1024 } },
              },
            ],
            totalResults: 1,
            lastModifiedVersion: 1,
          })),
        },
      });
      const res = await pdfImages.handler({ item_key: 'PARENT01', mode: 'pages', pages: '1' }, c);
      expect(res.isError).toBe(true);
      expect(texts(res)[0]).toMatch(/20 MB/);
      expect(c.web.downloadFileBytes).not.toHaveBeenCalled();
    });

    it('reports when no source can produce the file', async () => {
      const c = ctx(figurePdf(), {
        web: {
          downloadFileBytes: vi.fn(async () => {
            throw new Error('404');
          }),
        },
      });
      const res = await pdfImages.handler({ item_key: 'PARENT01', mode: 'pages', pages: '1' }, c);
      expect(res.isError).toBe(true);
      expect(texts(res)[0]).toMatch(/could not be read/);
      expect(texts(res)[0]).toMatch(/404/);
    });
  });
});
