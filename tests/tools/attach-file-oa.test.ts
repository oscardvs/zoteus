import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import attachFile from '../../src/tools/attach-file.js';
import { OpenAlexError, type OaPdf } from '../../src/features/scholar/openalex.js';
import { setOaHostLookup } from '../../src/features/oa/fetch.js';
import { textPagePdf } from '../fixtures/pdf.js';

/**
 * zotero_attach_file with find_oa, in the hosted shape (a cloud key, no route to the user's
 * desktop) that tests/tools/attach-file.test.ts established.
 *
 * Nothing here touches a real library or the network: the DNS seam is stubbed, ctx.fetcher
 * and ctx.web are vi.fn()s, and every refusal asserts that NO write was attempted, because a
 * refusal that still creates an empty attachment is the failure worth testing for.
 */

const PDF = textPagePdf();
const SIGNIN_PAGE = new TextEncoder().encode(
  '<!doctype html><html><body><h1>Sign in to read this article</h1></body></html>',
);

const OA: OaPdf = {
  url: 'https://arxiv.org/pdf/2501.12345v1',
  source: 'arXiv',
  version: 'submitted',
  licence: 'cc-by',
  landingPage: 'https://arxiv.org/abs/2501.12345v1',
};

beforeEach(() => setOaHostLookup(async () => ['93.184.216.34']));
afterAll(() => setOaHostLookup(null));

function fakeWeb(over: any = {}) {
  return {
    writeItems: vi.fn(async () => ({
      successful: [{ index: 0, key: 'ATT1', version: 1 }],
      unchanged: [],
      failed: [],
      newLibraryVersion: 1,
    })),
    requestUpload: vi.fn(async () => ({
      url: 'https://s3.example/upload',
      contentType: 'multipart/form-data',
      prefix: 'PRE',
      suffix: 'SUF',
      uploadKey: 'UP1',
    })),
    uploadBytes: vi.fn(async () => undefined),
    registerUpload: vi.fn(async () => undefined),
    ...over,
  };
}

function served(bytes: Uint8Array, contentType?: string) {
  return vi.fn(async () => new Response(bytes, { status: 200, headers: contentType ? { 'content-type': contentType } : {} }));
}

function makeCtx(over: any = {}): any {
  const {
    item = { data: { itemType: 'journalArticle', title: 'Deep Learning', DOI: '10.1038/nature14539' } },
    children = { data: [] },
    oa = OA,
    fetch = served(PDF, 'application/pdf'),
    ...rest
  } = over;
  return {
    config: { local: 'off', oaFetch: true },
    capabilities: { cloud: { userID: 19552201, username: 'oscardvs', access: {} }, localApi: false },
    web: fakeWeb(),
    fetcher: { fetch },
    localWrites: undefined,
    local: undefined,
    scholar: { oaPdf: vi.fn(async () => (oa instanceof Error ? Promise.reject(oa) : oa)) },
    router: {
      defaultLibrary: () => ({ type: 'user', id: 19552201 }),
      getItem: vi.fn(async () => item),
      getItemChildren: vi.fn(async () => children),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...rest,
  };
}

function text(res: any): string {
  return (res.content ?? []).map((c: { text: string }) => c.text).join('\n');
}

describe('zotero_attach_file find_oa: the happy path carries provenance', () => {
  it('attaches the discovered PDF and records where it came from and which version it is', async () => {
    const ctx = makeCtx();
    const res = await attachFile.handler({ parent: 'ITEM1', find_oa: true }, ctx);

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    expect(sc).toMatchObject({
      attachment: 'ATT1',
      parent: 'ITEM1',
      target: 'cloud',
      contentType: 'application/pdf',
      bytes: PDF.length,
      filename: '2501.12345v1.pdf',
    });
    // The block a caller reads: source, version, licence, and why the version matters.
    expect(sc.oa).toMatchObject({ url: OA.url, source: 'arXiv', version: 'submitted', licence: 'cc-by' });
    expect(sc.oa.versionCaveat).toMatch(/preprint/);
    expect(text(res)).toMatch(/arXiv, submitted manuscript, cc-by/);

    // The provenance Zotero itself keeps: the source URL, and a title that says what this is.
    const written = ctx.web.writeItems.mock.calls[0][1][0];
    expect(written).toMatchObject({
      itemType: 'attachment',
      parentItem: 'ITEM1',
      linkMode: 'imported_url',
      contentType: 'application/pdf',
      url: OA.url,
      title: 'Open-access PDF (arXiv, submitted manuscript, cc-by)',
    });
    // The bytes that went up are the ones that came down (the upload wraps them in the
    // multipart prefix/suffix the authorization step handed back).
    const body = ctx.web.uploadBytes.mock.calls[0][2] as Uint8Array;
    expect(body.length).toBe('PRE'.length + PDF.length + 'SUF'.length);
    expect(new TextDecoder().decode(body.subarray(3, 8))).toBe('%PDF-');
    expect(ctx.scholar.oaPdf).toHaveBeenCalledWith('10.1038/nature14539');
  });

  it('keeps an explicit title and filename when the caller gave them', async () => {
    const ctx = makeCtx();
    const res = await attachFile.handler({ parent: 'ITEM1', find_oa: true, title: 'Full Text PDF', filename: 'lecun2015' }, ctx);
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as any).filename).toBe('lecun2015.pdf');
    expect(ctx.web.writeItems.mock.calls[0][1][0].title).toBe('Full Text PDF');
  });

  it('reads the DOI out of Extra for an item type with no DOI field', async () => {
    const ctx = makeCtx({
      item: { data: { itemType: 'bookSection', title: 'A chapter', extra: 'DOI: 10.1007/978-3-030-12345-6_7' } },
    });
    const res = await attachFile.handler({ parent: 'ITEM1', find_oa: true }, ctx);
    expect(res.isError).toBeFalsy();
    expect(ctx.scholar.oaPdf).toHaveBeenCalledWith('10.1007/978-3-030-12345-6_7');
  });

  // arXiv and many repositories serve a PDF as application/octet-stream. The bytes are what
  // matter, and these bytes are a PDF.
  it('accepts real PDF bytes served as application/octet-stream', async () => {
    const ctx = makeCtx({ fetch: served(PDF, 'application/octet-stream') });
    const res = await attachFile.handler({ parent: 'ITEM1', find_oa: true }, ctx);
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as any).contentType).toBe('application/pdf');
  });

  it('attaches through the desktop app when one is reachable, with the same provenance', async () => {
    // Declared with a rest parameter so the assertion on `mock.calls[0][0][0]` below
    // typechecks: a `vi.fn(async () => ...)` has a zero-length call tuple.
    const writeItems = vi.fn(async (..._args: any[]) => ({
      successful: [{ index: 0, key: 'LOCALATT', version: 7 }],
      unchanged: [],
      failed: [],
      newLibraryVersion: 7,
    }));
    const uploadFile = vi.fn(async () => {});
    const ctx = makeCtx({
      capabilities: { cloud: { userID: 19552201, access: {} }, localApi: true },
      localWrites: { hasStoredKey: () => true, writeItems, uploadFile },
    });
    const res = await attachFile.handler({ parent: 'ITEM1', find_oa: true }, ctx);
    expect((res.structuredContent as any).target).toBe('local');
    expect(writeItems.mock.calls[0][0][0]).toMatchObject({
      url: OA.url,
      title: 'Open-access PDF (arXiv, submitted manuscript, cc-by)',
    });
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
  });
});

describe('zotero_attach_file find_oa: every refusal is a different fact', () => {
  it('names find_oa as a third way when nothing at all was given', async () => {
    const res = await attachFile.handler({ parent: 'ITEM1' }, makeCtx());
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/find_oa/);
  });

  it('refuses find_oa alongside an explicit url instead of silently picking one', async () => {
    const ctx = makeCtx();
    const res = await attachFile.handler({ parent: 'ITEM1', find_oa: true, url: 'https://example.com/a.pdf' }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/not both/);
    expect(ctx.fetcher.fetch).not.toHaveBeenCalled();
  });

  it('refuses an item with no DOI, naming url and path as the way round it', async () => {
    const ctx = makeCtx({ item: { data: { itemType: 'book', title: 'No identifiers here' } } });
    const res = await attachFile.handler({ parent: 'ITEM1', find_oa: true }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/records no DOI/);
    expect(text(res)).toMatch(/`url` or `path`/);
    expect(ctx.scholar.oaPdf).not.toHaveBeenCalled();
    expect(ctx.fetcher.fetch).not.toHaveBeenCalled();
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
  });

  it('refuses an item that already has a PDF, before asking OpenAlex anything', async () => {
    const ctx = makeCtx({
      children: { data: [{ key: 'PDFKEY', data: { itemType: 'attachment', contentType: 'application/pdf', filename: 'x.pdf' } }] },
    });
    const res = await attachFile.handler({ parent: 'ITEM1', find_oa: true }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/already has a PDF attached \(PDFKEY\)/);
    expect(ctx.scholar.oaPdf).not.toHaveBeenCalled();
    expect(ctx.fetcher.fetch).not.toHaveBeenCalled();
  });

  it('still looks when the only child is a note or a snapshot', async () => {
    const ctx = makeCtx({
      children: {
        data: [
          { key: 'NOTE1', data: { itemType: 'note' } },
          { key: 'SNAP1', data: { itemType: 'attachment', contentType: 'text/html', filename: 'page.html' } },
        ],
      },
    });
    const res = await attachFile.handler({ parent: 'ITEM1', find_oa: true }, ctx);
    expect(res.isError).toBeFalsy();
    expect(ctx.scholar.oaPdf).toHaveBeenCalled();
  });

  it('reports "no open-access copy" only when OpenAlex actually said so', async () => {
    const ctx = makeCtx({ oa: null });
    const res = await attachFile.handler({ parent: 'ITEM1', find_oa: true }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/reports no open-access copy/);
    expect(ctx.fetcher.fetch).not.toHaveBeenCalled();
  });

  it('separates "OpenAlex has no such record" from "no free copy"', async () => {
    const ctx = makeCtx({ oa: new OpenAlexError(404, 'OpenAlex 404 for https://api.openalex.org/works/doi:10.1/x') });
    const res = await attachFile.handler({ parent: 'ITEM1', find_oa: true }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/has no record of DOI/);
    expect(text(res)).not.toMatch(/no open-access copy/);
    // The provider's own message quotes the URL; the sentence the caller gets does not.
    expect(text(res)).not.toContain('api.openalex.org');
  });

  it('never reports a provider outage as evidence that no free copy exists', async () => {
    const ctx = makeCtx({ oa: new OpenAlexError(503, 'OpenAlex 503 for https://api.openalex.org/works/doi:10.1/x') });
    const res = await attachFile.handler({ parent: 'ITEM1', find_oa: true }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/HTTP 503/);
    expect(text(res)).toMatch(/provider failing, not evidence/);
    expect(ctx.fetcher.fetch).not.toHaveBeenCalled();
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
  });

  it('lets an error that is not an OpenAlex status through unchanged', async () => {
    const ctx = makeCtx({ oa: new Error('Zotero took longer than the 25s budget') });
    await expect(attachFile.handler({ parent: 'ITEM1', find_oa: true }, ctx)).rejects.toThrow(/budget/);
  });
});

describe('ZOTEUS_OA_FETCH=false reports the link and downloads nothing', () => {
  it('names the URL it found, and the two ways to get the file anyway', async () => {
    const ctx = makeCtx({ config: { local: 'off', oaFetch: false } });
    const res = await attachFile.handler({ parent: 'ITEM1', find_oa: true }, ctx);

    expect(res.isError).toBe(true);
    const message = text(res);
    // Discovery still happened and its answer is visible.
    expect(message).toContain(OA.url);
    expect(message).toMatch(/arXiv, submitted manuscript, cc-by/);
    expect(message).toMatch(/ZOTEUS_OA_FETCH/);
    // ...but no byte left the deployment, and nothing was written.
    expect(ctx.fetcher.fetch).not.toHaveBeenCalled();
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
    expect(ctx.web.uploadBytes).not.toHaveBeenCalled();
  });
});

describe('the bytes decide what gets attached', () => {
  it('refuses an HTML sign-in page, naming what was served, and writes nothing', async () => {
    const ctx = makeCtx({ fetch: served(SIGNIN_PAGE, 'text/html') });
    const res = await attachFile.handler({ parent: 'ITEM1', find_oa: true }, ctx);

    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/is not a PDF/);
    expect(text(res)).toMatch(/text\/html/);
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
    expect(ctx.web.requestUpload).not.toHaveBeenCalled();
    expect(ctx.web.uploadBytes).not.toHaveBeenCalled();
  });

  // The nastier one: only the magic number can catch a paywall page whose server insists it
  // is a PDF. The served content type is reported and never believed.
  it('refuses HTML bytes served as application/pdf', async () => {
    const ctx = makeCtx({ fetch: served(SIGNIN_PAGE, 'application/pdf') });
    const res = await attachFile.handler({ parent: 'ITEM1', find_oa: true }, ctx);

    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/is not a PDF/);
    expect(text(res)).toMatch(/no PDF header/);
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
    expect(ctx.web.uploadBytes).not.toHaveBeenCalled();
  });

  it('refuses when the download itself fails, and says nothing about open access being absent', async () => {
    const ctx = makeCtx({ fetch: vi.fn(async () => new Response('gone', { status: 404 })) });
    const res = await attachFile.handler({ parent: 'ITEM1', find_oa: true }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/answered HTTP 404/);
    expect(text(res)).not.toMatch(/no open-access copy/);
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
  });
});


it('checks later child pages before downloading a duplicate PDF', async () => {
  const ctx = makeCtx();
  const children = Array.from({ length: 100 }, (_, i) => ({ key: `NOTE${i}`, data: { itemType: 'note' } }));
  children.push({ key: 'EXISTINGPDF', data: { itemType: 'attachment', contentType: 'application/pdf' } } as any);
  ctx.router.getItemChildren = vi.fn(async (_key: string, { start = 0, limit = 25 }: any) => ({
    data: children.slice(start, start + limit), totalResults: 101, lastModifiedVersion: 4,
  }));
  const result = await attachFile.handler({ parent: 'ITEM1', find_oa: true }, ctx);
  expect(result.isError).toBe(true);
  expect(text(result)).toContain('EXISTINGPDF');
  expect(ctx.scholar.oaPdf).not.toHaveBeenCalled();
  expect(ctx.web.writeItems).not.toHaveBeenCalled();
});
