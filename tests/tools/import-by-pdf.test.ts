import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import importTool from '../../src/tools/import.js';
import {
  arxivStampPdf,
  doiTitlePagePdf,
  DOI_PDF_DOI,
  noIdentifierPdf,
  noTextLayerPdf,
} from '../fixtures/pdf-identifiers.js';

const LIB = { type: 'user' as const, id: 19552201 };

let dataDir: string;
const paths: Record<string, string> = {};

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'zoteus-import-pdf-'));
  // Inside the caller's own subtree: a remote caller with no identity of its own is held
  // to tenants/shared, not to the bare data directory.
  const root = join(dataDir, 'tenants', 'shared');
  mkdirSync(root, { recursive: true });
  const write = (name: string, bytes: Uint8Array) => {
    const path = join(root, name);
    writeFileSync(path, bytes);
    paths[name] = path;
  };
  write('with-doi.pdf', doiTitlePagePdf());
  write('no-identifier.pdf', noIdentifierPdf());
  write('arxiv.pdf', arxivStampPdf());
  write('scanned.pdf', noTextLayerPdf());
  const notAPdf = join(root, 'notes.txt');
  writeFileSync(notAPdf, 'This is plain text, not a PDF.', 'utf8');
  paths['notes.txt'] = notAPdf;
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function makeCtx(overrides: any = {}): any {
  return {
    config: {
      translationServerUrl: 'http://127.0.0.1:1969',
      dataDir,
      importMaxEntries: 200,
      confirmBulkWrites: 0,
    },
    capabilities: { cloud: { userID: LIB.id, username: 'oscardvs', access: {} }, localApi: false },
    remoteCaller: false,
    translation: { isUp: vi.fn(async () => false) },
    schema: { getSchema: vi.fn(async () => ({ version: 1, itemTypes: [] })) },
    scholar: {
      lookup: vi.fn(async () => ({
        title: 'An Undulatory Theory of the Mechanics of Atoms',
        authors: ['Erwin Schrodinger'],
        year: 1926,
        venue: 'Physical Review',
        type: 'article',
      })),
    },
    fetcher: { fetch: vi.fn() },
    router: {
      defaultLibrary: () => LIB,
      searchItems: vi.fn(async () => ({ data: [], totalResults: 0, lastModifiedVersion: 1 })),
    },
    web: {
      writeItems: vi.fn(async (_lib: any, items: any[]) => ({
        successful: items.map((_it, index) => ({ index, key: `NEW${index}`, version: 1 })),
        unchanged: [],
        failed: [],
        newLibraryVersion: 1,
      })),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...overrides,
  };
}

const call = (args: Record<string, unknown>, ctx: any) =>
  importTool.handler({ action: 'by_pdf', ...args }, ctx) as Promise<any>;

describe('zotero_import action:"by_pdf"', () => {
  it('finds the DOI on the title page, says where it was and resolves it', async () => {
    const ctx = makeCtx();
    const res = await call({ path: paths['with-doi.pdf'] }, ctx);

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent;
    expect(sc.identifierFound).toMatchObject({
      type: 'doi',
      value: DOI_PDF_DOI,
      page: 1,
      confidence: 'high',
    });
    expect(sc.identifierFound.label.toLowerCase()).toContain('doi.org');
    expect(sc.identifierFound.context).toContain('Published online 12 December 1926');
    expect(sc.pagesScanned).toBe(2);
    expect(sc.textLayer).toBe(true);
    expect(sc.pdfSource).toBe('path');
    expect(ctx.scholar.lookup).toHaveBeenCalledWith(DOI_PDF_DOI);
    expect(sc.items[0]).toMatchObject({ itemType: 'journalArticle', DOI: DOI_PDF_DOI });
  });

  it('writes nothing unless asked, and stamps the PDF origin when it does', async () => {
    const preview = makeCtx();
    const first = await call({ path: paths['with-doi.pdf'] }, preview);
    expect(first.structuredContent.saved).toBe(false);
    expect(preview.web.writeItems).not.toHaveBeenCalled();

    const saving = makeCtx();
    const second = await call({ path: paths['with-doi.pdf'], save_to_library: true }, saving);
    expect(second.isError).toBeFalsy();
    expect(saving.web.writeItems).toHaveBeenCalledTimes(1);
    expect(String(saving.web.writeItems.mock.calls[0][1][0].extra)).toMatch(/resolved:pdf:doi:scholar/);
    expect(second.structuredContent.source).toBe('pdf:doi:scholar');
    expect(second.structuredContent.identifierFound.value).toBe(DOI_PDF_DOI);
  });

  it('says plainly that it found nothing, without erroring and without inventing metadata', async () => {
    const ctx = makeCtx();
    const res = await call({ path: paths['no-identifier.pdf'] }, ctx);

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent;
    expect(sc.identifierFound).toBeUndefined();
    expect(sc.identifierCandidates).toEqual([]);
    expect(sc.items).toBeUndefined();
    expect(sc.textLayer).toBe(true);
    expect(sc.note).toMatch(/none carried a DOI or an arXiv id/);
    expect(res.content[0].text).toMatch(/zotero_pdf_images/);
    expect(ctx.scholar.lookup).not.toHaveBeenCalled();
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
  });

  it('distinguishes a scan with no text layer from a page that simply has no DOI', async () => {
    const res = await call({ path: paths['scanned.pdf'] }, makeCtx());
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.textLayer).toBe(false);
    expect(res.structuredContent.note).toMatch(/no text at all, so this file is a scan/);
    expect(res.structuredContent.note).toMatch(/Metadata recovery does not run OCR/);
    expect(res.structuredContent.note).toContain('ocr:true');
  });

  it('honours scan_pages, which is what decides whether a later stamp is seen', async () => {
    const onePage = await call({ path: paths['arxiv.pdf'], scan_pages: 1 }, makeCtx());
    expect(onePage.structuredContent.identifierFound).toBeUndefined();
    expect(onePage.structuredContent.pagesScanned).toBe(1);

    const ctx = makeCtx({
      fetcher: {
        fetch: vi.fn(async () =>
          new Response(
            `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
               <id>http://arxiv.org/abs/2201.00001</id>
               <published>2022-01-03T00:00:00Z</published>
               <title>A Preprint About Something</title>
               <author><name>Ada Lovelace</name></author>
             </entry></feed>`,
            { status: 200 },
          ),
        ),
      },
    });
    const twoPages = await call({ path: paths['arxiv.pdf'], scan_pages: 2 }, ctx);
    expect(twoPages.structuredContent.identifierFound).toMatchObject({
      type: 'arxiv',
      value: '2201.00001v1',
      page: 2,
    });
    expect(twoPages.structuredContent.items[0]).toMatchObject({ title: 'A Preprint About Something' });
  });

  it('refuses a file that is not a PDF, saying what the bytes look like', async () => {
    const res = await call({ path: paths['notes.txt'] }, makeCtx());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/is not a PDF/);
  });

  it('reports a resolution failure with the identifier it found, and saves nothing', async () => {
    const ctx = makeCtx({ scholar: { lookup: vi.fn(async () => null) } });
    const res = await call({ path: paths['with-doi.pdf'], save_to_library: true }, ctx);

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(new RegExp(`DOI ${DOI_PDF_DOI.replace(/[.]/g, '\\.')} on page 1`));
    expect(res.content[0].text).toMatch(/No scholarly record found/);
    expect(res.content[0].text).toMatch(/no metadata was invented/);
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
  });

  it('refuses when neither path nor attachment_key was given, and when both were', async () => {
    const neither = await call({}, makeCtx());
    expect(neither.isError).toBe(true);
    expect(neither.content[0].text).toMatch(/needs a PDF/);

    const both = await call({ path: paths['with-doi.pdf'], attachment_key: 'ABCD1234' }, makeCtx());
    expect(both.isError).toBe(true);
    expect(both.content[0].text).toMatch(/not both/);
  });
});

describe('zotero_import action:"by_pdf" path confinement', () => {
  it("refuses a path outside the data directory for a remote caller, and names the route that works there", async () => {
    const outside = join(tmpdir(), 'zoteus-outside-the-data-dir.pdf');
    writeFileSync(outside, doiTitlePagePdf());
    try {
      const ctx = makeCtx({ remoteCaller: true });
      const res = await call({ path: outside }, ctx);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/must be inside this server's data directory/);
      expect(res.content[0].text).toMatch(/attachment_key/);
      expect(ctx.scholar.lookup).not.toHaveBeenCalled();
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('allows a path inside the data directory for a remote caller', async () => {
    const res = await call({ path: paths['with-doi.pdf'] }, makeCtx({ remoteCaller: true }));
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.identifierFound.value).toBe(DOI_PDF_DOI);
  });
});

describe('zotero_import action:"by_pdf" from an existing attachment', () => {
  function attachmentCtx(overrides: any = {}) {
    const bytes = doiTitlePagePdf();
    return makeCtx({
      // Hosted shape: no desktop app, no local storage folder, only the cloud.
      router: {
        defaultLibrary: () => LIB,
        searchItems: vi.fn(async () => ({ data: [], totalResults: 0, lastModifiedVersion: 1 })),
        getItem: vi.fn(async () => ({
          key: 'ATT12345',
          data: { key: 'ATT12345', itemType: 'attachment', filename: 'paper.pdf', contentType: 'application/pdf' },
        })),
      },
      web: {
        downloadFileBytes: vi.fn(async () => ({ bytes })),
        writeItems: vi.fn(async (_lib: any, items: any[]) => ({
          successful: items.map((_it, index) => ({ index, key: `NEW${index}`, version: 1 })),
          unchanged: [],
          failed: [],
          newLibraryVersion: 1,
        })),
      },
      ...overrides,
    });
  }

  it('reads the PDF out of the library, which is the only route a hosted server has', async () => {
    const ctx = attachmentCtx();
    const res = await call({ attachment_key: 'ATT12345' }, ctx);

    expect(res.isError).toBeFalsy();
    expect(ctx.web.downloadFileBytes).toHaveBeenCalled();
    expect(res.structuredContent.identifierFound.value).toBe(DOI_PDF_DOI);
    expect(res.structuredContent.pdfSource).toBe('Zotero cloud storage');
  });

  it('works for a remote caller, where a path would have been refused', async () => {
    const ctx = attachmentCtx({ remoteCaller: true });
    const res = await call({ attachment_key: 'ATT12345' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.identifierFound.value).toBe(DOI_PDF_DOI);
  });

  it('says which doors were tried when the bytes cannot be reached at all', async () => {
    const ctx = attachmentCtx({
      web: {
        downloadFileBytes: vi.fn(async () => {
          throw new Error('404 Not Found');
        }),
        writeItems: vi.fn(),
      },
    });
    const res = await call({ attachment_key: 'ATT12345' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/could not be read/);
    expect(res.content[0].text).toMatch(/404 Not Found/);
  });
});
