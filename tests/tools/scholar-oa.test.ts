import { describe, it, expect, vi } from 'vitest';
import scholar from '../../src/tools/scholar.js';

/**
 * The read-only half of open-access discovery: zotero_scholar action:"lookup" reports the
 * PDF it found without touching the library, which is also the only half that survives
 * ZOTEUS_READ_ONLY (zotero_attach_file is readOnlyHint:false and gets filtered out there).
 *
 * The three states this has to keep apart are the whole point: there is a free copy,
 * OpenAlex says there is not, and nobody looked.
 */

const WORK = {
  doi: '10.1038/nature14539',
  title: 'Deep Learning',
  citationCount: 80000,
  authors: [],
};

function ctx(lookup: any) {
  return {
    scholar: { lookup: vi.fn(async () => lookup), references: vi.fn(), citations: vi.fn(), related: vi.fn() },
    capabilities: { cloud: { userID: 19552201 }, localApi: false },
    router: {
      searchItems: vi.fn(async () => ({ data: [], totalResults: 0, lastModifiedVersion: 0 })),
      defaultLibrary: () => ({ type: 'user', id: 19552201 }),
    },
  } as any;
}

function text(res: any): string {
  return (res.content ?? []).map((c: { text: string }) => c.text).join('\n');
}

describe('zotero_scholar reports the open-access copy it found', () => {
  it('carries url, source, version, licence and the caveat that the version implies', async () => {
    const c = ctx({
      ...WORK,
      oaChecked: true,
      oa: {
        url: 'https://arxiv.org/pdf/2501.12345v1',
        source: 'arXiv',
        version: 'accepted',
        licence: 'cc-by',
        landingPage: 'https://arxiv.org/abs/2501.12345v1',
      },
    });
    const res = await scholar.handler({ action: 'lookup', doi: '10.1038/nature14539' }, c);

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    expect(sc.oa).toMatchObject({ url: 'https://arxiv.org/pdf/2501.12345v1', source: 'arXiv', version: 'accepted', licence: 'cc-by' });
    expect(sc.oa.versionCaveat).toMatch(/version of record/);
    expect(sc.oaChecked).toBe(true);
    expect(text(res)).toMatch(/Open-access PDF at https:\/\/arxiv\.org\/pdf\/2501\.12345v1 \(arXiv, accepted manuscript, cc-by\)/);
    // The documented `work` shape stays the metadata it has always been.
    expect(sc.work.oa).toBeUndefined();
    expect(sc.work.oaChecked).toBeUndefined();
    expect(sc.work).toMatchObject({ title: 'Deep Learning', citationCount: 80000 });
  });

  it('says plainly that OpenAlex reports no open-access copy', async () => {
    const c = ctx({ ...WORK, oaChecked: true });
    const res = await scholar.handler({ action: 'lookup', doi: '10.1038/nature14539' }, c);
    const sc = res.structuredContent as any;
    expect(sc.oa).toBeUndefined();
    expect(sc.oaChecked).toBe(true);
    expect(text(res)).toMatch(/OpenAlex reports no open-access copy/);
  });

  // The distinction that matters: a Crossref answer means nobody asked about open access.
  it('does not read a Crossref fallback as "no open-access copy"', async () => {
    const c = ctx({ ...WORK, oaChecked: false });
    const res = await scholar.handler({ action: 'lookup', doi: '10.1038/nature14539' }, c);
    const sc = res.structuredContent as any;
    expect(sc.oa).toBeUndefined();
    expect(sc.oaChecked).toBe(false);
    expect(text(res)).toMatch(/Open access was not checked/);
    expect(text(res)).not.toMatch(/reports no open-access copy/);
  });

  it('leaves the list actions alone', async () => {
    const c = ctx(null);
    c.scholar.references = vi.fn(async () => ({ works: [WORK], total: 1 }));
    const res = await scholar.handler({ action: 'references', doi: '10.1038/nature14539' }, c);
    const sc = res.structuredContent as any;
    expect(sc.oa).toBeUndefined();
    expect(sc.oaChecked).toBeUndefined();
    expect(sc.count).toBe(1);
  });
});
