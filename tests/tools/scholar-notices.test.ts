import { describe, it, expect, vi } from 'vitest';
import scholar from '../../src/tools/scholar.js';
import { ScholarGraph } from '../../src/features/scholar/graph.js';
import { RateLimitedFetcher } from '../../src/api/http.js';

/*
 * The wording rules ARE the requirement here, so these tests assert on the text a client
 * actually sees, not only on the structured mirror. The rule they exist to hold:
 *
 *   silence from a provider must never be rendered in the voice of "nothing was found".
 */

const WAKEFIELD = '10.1016/s0140-6736(97)11096-0';
const NOTICE = '10.1016/s0140-6736(10)60175-4';
const CLEAN = '10.1038/nature14539';
const LANCET_COMMISSION = '10.1016/s0140-6736(20)30367-6';

/** Phrasings that would read as a clean bill of health if a provider had not answered. */
const CLEAN_BILL = /no update record is deposited|crossref lists no update record|no update record was found/i;
/** Any sentence that would assert the paper itself is retracted. */
const VERDICT = /\bthis (paper|work|article) (is|was|has been) retracted|\bis retracted\b/i;

const RETRACTION = {
  DOI: NOTICE,
  type: 'retraction',
  label: 'Retraction',
  source: 'retraction-watch',
  updated: { 'date-parts': [[2010, 2, 6]] },
  'record-id': '4036',
};
const CORRECTION = {
  DOI: '10.1016/s0140-6736(04)15715-2',
  type: 'correction',
  label: 'Correction',
  source: 'retraction-watch',
  updated: { 'date-parts': [[2004, 3, 6]] },
  'record-id': '17269',
};

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

const crossrefWork = (message: Record<string, unknown>) => json({ 'message-type': 'work', message });
const openalexWork = (doi: string, extra: Record<string, unknown> = {}) =>
  json({ id: 'https://openalex.org/W1', doi: `https://doi.org/${doi}`, display_name: 'A work', type: 'article', ...extra });

/**
 * A context whose `scholar` is a REAL ScholarGraph over a faked fetcher, so these tests run
 * the actual two-provider orchestration and the actual wording, not a stub of either.
 */
function ctx(opts: {
  crossref?: () => Response;
  openalex?: () => Response;
  items?: Array<Record<string, unknown>>;
  totalResults?: number;
  cloud?: boolean;
} = {}) {
  const fetchImpl = vi.fn(async (url: string) =>
    url.includes('crossref.org')
      ? (opts.crossref ?? (() => new Response('no fixture', { status: 500 })))()
      : (opts.openalex ?? (() => new Response('no fixture', { status: 500 })))(),
  );
  const rows = opts.items ?? [];
  const searchItems = vi.fn(async ({ start = 0, limit = 100 }: any) => ({
    data: rows.slice(start, start + limit),
    totalResults: opts.totalResults ?? rows.length,
    lastModifiedVersion: 0,
  }));
  return {
    scholar: new ScholarGraph({ fetcher: new RateLimitedFetcher({ fetchImpl, maxConcurrency: 4 }) }),
    capabilities: opts.cloud === false ? { cloud: null, localApi: false } : { cloud: { userID: 1 }, localApi: false },
    router: { searchItems, defaultLibrary: () => ({ type: 'user', id: 1 }) },
    fetchImpl,
  } as any;
}

/** The summary line a client that only reads text would see. */
function summaryOf(res: any): string {
  return (res.content?.[0] as any)?.text as string;
}

const libItem = (key: string, title: string, DOI: string) => ({ key, data: { key, title, DOI, itemType: 'journalArticle' } });

describe('zotero_scholar action:"notices" reports records, never a verdict', () => {
  it('lists each notice with its type, date, source and DOI, and adds no retraction claim', async () => {
    const c = ctx({
      crossref: () => crossrefWork({ DOI: WAKEFIELD, title: ['RETRACTED: Ileal-lymphoid...'], 'updated-by': [CORRECTION, RETRACTION] }),
      openalex: () => openalexWork(WAKEFIELD, { is_retracted: true }),
    });
    const res = await scholar.handler({ action: 'notices', doi: WAKEFIELD }, c);
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;

    // No top-level boolean a downstream model could render as a claim about the paper.
    expect(sc).not.toHaveProperty('retracted');
    expect(sc).not.toHaveProperty('isRetracted');
    expect(sc.notices).toHaveLength(2);
    expect(sc.notices[1]).toMatchObject({
      type: 'retraction',
      label: 'Retraction',
      doi: NOTICE,
      date: '2010-02-06',
      source: 'retraction-watch',
      recordId: '4036',
    });
    // OpenAlex's flag is reported as OpenAlex's, under a key that says so.
    expect(sc.openalex).toEqual({ isRetracted: true, workType: 'article' });

    const text = summaryOf(res);
    expect(text).toMatch(/Crossref lists 2 update records/);
    expect(text).toContain('2010-02-06');
    expect(text).toContain('source retraction-watch');
    expect(text).toContain(NOTICE);
    expect(text).toMatch(/OpenAlex sets is_retracted: true/);
    expect(text).toMatch(/Zoteus does not judge the paper/);
    expect(text).not.toMatch(VERDICT);
  });

  it('carries the coverage sentence in the answer itself, not only in the docs', async () => {
    const c = ctx({
      crossref: () => crossrefWork({ DOI: CLEAN, title: ['Deep learning'] }),
      openalex: () => openalexWork(CLEAN, { is_retracted: false }),
    });
    const res = await scholar.handler({ action: 'notices', doi: CLEAN }, c);
    const sc = res.structuredContent as any;
    expect(sc.coverage).toMatch(/Retraction Watch/);
    expect(sc.coverage).toMatch(/not evidence that a paper is sound/);
    expect(summaryOf(res)).toContain(sc.coverage);
  });

  it('states a clean work as the absence of a deposited record, with both sources reached', async () => {
    const c = ctx({
      crossref: () => crossrefWork({ DOI: CLEAN, title: ['Deep learning'] }),
      openalex: () => openalexWork(CLEAN, { is_retracted: false }),
    });
    const res = await scholar.handler({ action: 'notices', doi: CLEAN }, c);
    const sc = res.structuredContent as any;
    expect(sc.notices).toEqual([]);
    expect(sc.sources).toEqual([
      { name: 'crossref', reached: true, found: true },
      { name: 'openalex', reached: true, found: true },
    ]);
    const text = summaryOf(res);
    expect(text).toMatch(/No update record is deposited for this DOI at either source/);
    expect(text).toMatch(/Absence here is the absence of a deposited record/);
    // No "not retracted", no all-clear.
    expect(text).not.toMatch(/not retracted|clean|sound paper/i);
  });
});

// The single most important behaviour in this feature.
describe('zotero_scholar action:"notices" never renders an outage as a clean result', () => {
  it('reports Crossref down as not reached, with its status, and refuses the clean phrasing', async () => {
    const c = ctx({
      crossref: () => new Response('busy', { status: 503 }),
      openalex: () => openalexWork(CLEAN, { is_retracted: false }),
    });
    const res = await scholar.handler({ action: 'notices', doi: CLEAN }, c);
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    const cr = sc.sources.find((s: any) => s.name === 'crossref');
    expect(cr).toMatchObject({ reached: false, status: 503 });
    expect(cr.found).toBeUndefined();

    const text = summaryOf(res);
    expect(text).toMatch(/Crossref did not answer \(HTTP 503\)/);
    expect(text).toMatch(/were NOT checked/);
    expect(text).toMatch(/This is NOT a "no notices found" answer: crossref was not reached/);
    expect(text).not.toMatch(CLEAN_BILL);
  });

  it('reports OpenAlex down the same way, and still returns what Crossref said', async () => {
    const c = ctx({
      crossref: () => crossrefWork({ DOI: WAKEFIELD, 'updated-by': [RETRACTION] }),
      openalex: () => new Response('server error', { status: 500 }),
    });
    const res = await scholar.handler({ action: 'notices', doi: WAKEFIELD }, c);
    const sc = res.structuredContent as any;
    expect(sc.notices).toHaveLength(1);
    expect(sc.sources.find((s: any) => s.name === 'openalex')).toMatchObject({ reached: false, status: 500 });
    const text = summaryOf(res);
    expect(text).toMatch(/OpenAlex did not answer \(HTTP 500\)\. Its retraction flag was NOT checked/);
    expect(text).toMatch(/openalex was not reached/);
  });

  it('errors rather than answering when neither source was reached', async () => {
    const c = ctx({
      crossref: () => new Response('busy', { status: 503 }),
      openalex: () => new Response('busy', { status: 500 }),
    });
    const res = await scholar.handler({ action: 'notices', doi: CLEAN }, c);
    // An empty `notices` array in a successful result reads as "clean" however the sources
    // block is worded, so nothing-was-learned is an error instead of a result.
    expect(res.isError).toBe(true);
    const text = summaryOf(res);
    expect(text).toMatch(/Neither source answered/);
    expect(text).toContain('crossref HTTP 503');
    expect(text).toContain('openalex HTTP 500');
    expect(text).toMatch(/nothing is known either way/);
    expect(text).not.toMatch(CLEAN_BILL);
  });

  it('separates "no such DOI" from "did not answer", and errors when neither source has it', async () => {
    const c = ctx({
      crossref: () => new Response('not found', { status: 404 }),
      openalex: () => new Response('not found', { status: 404 }),
    });
    const res = await scholar.handler({ action: 'notices', doi: '10.9999/nope' }, c);
    expect(res.isError).toBe(true);
    expect(summaryOf(res)).toMatch(/No scholarly record found for DOI 10.9999\/nope at Crossref or OpenAlex/);
    expect(summaryOf(res)).toMatch(/not evidence about the paper either way/);
  });

  it('answers when one source has the DOI and the other simply does not', async () => {
    const c = ctx({
      crossref: () => crossrefWork({ DOI: WAKEFIELD, 'updated-by': [RETRACTION] }),
      openalex: () => new Response('not found', { status: 404 }),
    });
    const res = await scholar.handler({ action: 'notices', doi: WAKEFIELD }, c);
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    expect(sc.sources.find((s: any) => s.name === 'openalex')).toMatchObject({ reached: true, found: false, status: 404 });
    expect(summaryOf(res)).toMatch(/OpenAlex has no record for this DOI/);
    // Not reached is a different sentence from not found, and only one of them is here.
    expect(summaryOf(res)).not.toMatch(/was not reached/);
  });
});

describe('zotero_scholar action:"notices" says when the two sources disagree', () => {
  it('sets disagreement and says so, without preferring either source', async () => {
    const c = ctx({
      crossref: () =>
        crossrefWork({
          DOI: LANCET_COMMISSION,
          title: ['Dementia prevention, intervention, and care'],
          'updated-by': [{ DOI: '10.1016/s2468-2667(23)00083-x', type: 'correction', label: 'Correction', source: 'publisher' }],
        }),
      openalex: () => openalexWork(LANCET_COMMISSION, { is_retracted: true }),
    });
    const res = await scholar.handler({ action: 'notices', doi: LANCET_COMMISSION }, c);
    const sc = res.structuredContent as any;
    expect(sc.disagreement).toBe(true);
    const text = summaryOf(res);
    expect(text).toMatch(/The two sources DISAGREE about this DOI/);
    expect(text).toMatch(/Neither is treated as correct here/);
    expect(text).not.toMatch(VERDICT);
    // The deposited record keeps its provenance, which is what makes the disagreement legible.
    expect(sc.notices[0]).toMatchObject({ type: 'correction', source: 'publisher' });
  });

  it('treats a retraction notice as a notice, not as a retracted paper', async () => {
    const c = ctx({
      crossref: () => crossrefWork({ DOI: NOTICE, title: ['Retraction: ...'], 'update-to': [{ ...RETRACTION, DOI: WAKEFIELD }] }),
      openalex: () => openalexWork(NOTICE, { is_retracted: true, type: 'retraction' }),
    });
    const res = await scholar.handler({ action: 'notices', doi: NOTICE }, c);
    const sc = res.structuredContent as any;
    expect(sc.notices).toEqual([]);
    expect(sc.isNoticeFor).toHaveLength(1);
    expect(sc.disagreement).toBe(false);
    const text = summaryOf(res);
    expect(text).toMatch(/This DOI is itself an update notice/);
    expect(text).toMatch(/describes the notice, not a retracted paper/);
    expect(text).toMatch(/work type "retraction"/);
  });
});

describe('zotero_scholar action:"notices" with library_scan', () => {
  const rows = [
    libItem('AAAA1111', 'Ileal-lymphoid-nodular hyperplasia', WAKEFIELD),
    libItem('BBBB2222', 'Deep learning', CLEAN),
    libItem('CCCC3333', 'A book with no DOI', ''),
  ];

  function sweepCtx(over: Partial<Parameters<typeof ctx>[0]> = {}) {
    return ctx({
      items: rows,
      crossref: () =>
        json({
          'message-type': 'work-list',
          message: { items: [{ DOI: WAKEFIELD, 'updated-by': [RETRACTION] }, { DOI: CLEAN }] },
        }),
      openalex: () =>
        json({
          results: [
            { id: 'https://openalex.org/W1', doi: `https://doi.org/${WAKEFIELD}`, is_retracted: true, type: 'article' },
            { id: 'https://openalex.org/W2', doi: `https://doi.org/${CLEAN}`, is_retracted: false, type: 'article' },
          ],
        }),
      ...over,
    });
  }

  it('does not run unless asked: no library page is pulled without library_scan', async () => {
    const c = sweepCtx();
    await scholar.handler({ action: 'notices', doi: CLEAN }, c);
    expect(c.router.searchItems).not.toHaveBeenCalled();
  });

  it('returns only the items a source reported something about, with the item key to act on', async () => {
    const c = sweepCtx();
    const res = await scholar.handler({ action: 'notices', library_scan: true }, c);
    expect(res.isError).toBeFalsy();
    expect(c.router.searchItems).toHaveBeenCalled();
    const sc = res.structuredContent as any;
    expect(sc.mode).toBe('library');
    expect(sc.items).toHaveLength(1);
    expect(sc.items[0]).toMatchObject({ itemKey: 'AAAA1111', doi: WAKEFIELD, openalexIsRetracted: true });
    expect(sc.items[0].notices[0]).toMatchObject({ type: 'retraction', source: 'retraction-watch' });
    // Item titles are library-authored text, so the result carries the untrusted marker.
    expect(sc.provenance).toMatchObject({ source: 'library-content', trust: 'untrusted' });
    expect(sc.scan).toMatchObject({ scanned: 3, withDoi: 2, checkedDois: 2, complete: true });
    expect(summaryOf(res)).toMatch(/1 of the 2 library DOIs asked about has an update record/);
  });

  it('reports every library copy of a flagged DOI without duplicating provider queries', async () => {
    const c = sweepCtx({ items: [...rows, libItem('DDDD4444', 'Another copy', WAKEFIELD)] });
    const res = await scholar.handler({ action: 'notices', library_scan: true }, c);
    const sc = res.structuredContent as any;
    expect(sc.items.map((item: any) => item.itemKey)).toEqual(['AAAA1111', 'DDDD4444']);
    expect(sc.scan).toMatchObject({ withDoi: 3, checkedDois: 2 });
    expect(summaryOf(res)).toMatch(/1 of the 2 library DOIs asked about/);
    expect(c.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refuses library_scan on any other action rather than silently ignoring it', async () => {
    const c = sweepCtx();
    const res = await scholar.handler({ action: 'citations', doi: CLEAN, library_scan: true }, c);
    expect(res.isError).toBe(true);
    expect(summaryOf(res)).toMatch(/library_scan only applies to action:"notices"/);
    expect(c.router.searchItems).not.toHaveBeenCalled();
  });

  it('reports a truncated library scan instead of answering over the part it saw', async () => {
    // The census reports 9000 top-level items but the crawl stops at its cap.
    const c = sweepCtx({ totalResults: 9000 });
    const res = await scholar.handler({ action: 'notices', library_scan: true }, c);
    const sc = res.structuredContent as any;
    expect(sc.scan.complete).toBe(false);
    expect(sc.scan.totalResults).toBe(9000);
    expect(summaryOf(res)).toMatch(/The library scan stopped after 3 of 9000 items/);
    expect(summaryOf(res)).toMatch(/not looked at and is not covered by this answer/);
  });

  it('reports a source outage as a coverage gap with counts, not as a clean library', async () => {
    const c = sweepCtx({ crossref: () => new Response('busy', { status: 503 }) });
    const res = await scholar.handler({ action: 'notices', library_scan: true }, c);
    const sc = res.structuredContent as any;
    expect(sc.sources.find((s: any) => s.name === 'crossref')).toMatchObject({
      reached: false,
      status: 503,
      checked: 0,
      asked: 2,
    });
    const text = summaryOf(res);
    expect(text).toMatch(/crossref answered for 0 of 2 DOIs \(HTTP 503 on the rest\)/);
    expect(text).toMatch(/Because part of the check did not run, this is not a clean result/);
    // The DOIs are "asked about", not "checked", because one source never answered.
    expect(text).toMatch(/1 of the 2 library DOIs asked about has an update record/);
    expect(text).not.toMatch(/checked against both sources/);
  });

  it('says "the part that ran" rather than "nothing found" when a source failed and nothing turned up', async () => {
    const c = sweepCtx({
      crossref: () => new Response('busy', { status: 503 }),
      openalex: () =>
        json({
          results: [
            { id: 'https://openalex.org/W1', doi: `https://doi.org/${WAKEFIELD}`, is_retracted: false, type: 'article' },
            { id: 'https://openalex.org/W2', doi: `https://doi.org/${CLEAN}`, is_retracted: false, type: 'article' },
          ],
        }),
    });
    const res = await scholar.handler({ action: 'notices', library_scan: true }, c);
    expect((res.structuredContent as any).items).toEqual([]);
    const text = summaryOf(res);
    expect(text).toMatch(/No update record was found in the part of this check that actually ran/);
    expect(text).not.toMatch(/checked against both sources/);
    expect(text).toMatch(/The other 2 were NOT checked against crossref/);
  });

  // A DOI carrying a '#' (a pasted viewer link, most often) cannot go into a batch filter
  // without cutting the URL off at that point. It is left out, and the prose has to say so:
  // the DOIs that DID go out must not be described in a sentence that covers this one too.
  it('says the DOIs it could not ask about were not checked, and does not call the rest clean', async () => {
    const c = sweepCtx({
      items: [libItem('AAAA1111', 'A pasted viewer link', '10.1234/abc#page=3'), libItem('BBBB2222', 'Deep learning', CLEAN)],
      crossref: () => json({ 'message-type': 'work-list', message: { items: [{ DOI: CLEAN }] } }),
      openalex: () =>
        json({ results: [{ id: 'https://openalex.org/W2', doi: `https://doi.org/${CLEAN}`, is_retracted: false, type: 'article' }] }),
    });
    const res = await scholar.handler({ action: 'notices', library_scan: true }, c);
    const sc = res.structuredContent as any;
    expect(sc.unqueryable).toEqual(['10.1234/abc#page=3']);
    expect(sc.scan.checkedDois).toBe(1);
    const text = summaryOf(res);
    expect(text).toMatch(/1 of the 2 DOIs carry a character that cannot go into a batch query/);
    expect(text).toMatch(/NOT checked/);
    // The headline must not say both DOIs were checked when only one was asked about.
    expect(text).not.toMatch(/checked against both sources/);
    expect(text).toMatch(/not a clean result for the DOIs it did not cover/);
  });

  // The sweep can now see `update-to`, so a notice the user deliberately saved turns up in
  // the findings. The single-DOI path says what that means; the sweep has to as well, or the
  // row reads as an accusation against a record whose whole job is to be the accusation.
  it('says a row that is itself an update notice is a notice, not a retracted paper', async () => {
    const c = sweepCtx({
      items: [libItem('NNNN1111', 'Retraction: Ileal-lymphoid-nodular hyperplasia', NOTICE)],
      crossref: () =>
        json({
          'message-type': 'work-list',
          message: { items: [{ DOI: NOTICE, 'update-to': [{ ...RETRACTION, DOI: WAKEFIELD }] }] },
        }),
      openalex: () =>
        json({ results: [{ id: 'https://openalex.org/W1', doi: `https://doi.org/${NOTICE}`, is_retracted: true, type: 'retraction' }] }),
    });
    const res = await scholar.handler({ action: 'notices', library_scan: true }, c);
    const sc = res.structuredContent as any;
    expect(sc.items[0].isNoticeFor.map((n: any) => n.doi)).toEqual([WAKEFIELD]);
    const text = summaryOf(res);
    expect(text).toMatch(/is itself an update notice about another work/);
    expect(text).toMatch(/describes the notice, not a retracted paper/);
    expect(text).not.toMatch(VERDICT);
  });

  it('says so plainly when no scanned item carries a DOI', async () => {
    const c = sweepCtx({ items: [libItem('CCCC3333', 'A book', '')] });
    const res = await scholar.handler({ action: 'notices', library_scan: true }, c);
    expect(res.isError).toBeFalsy();
    expect(summaryOf(res)).toMatch(/None of the 1 library items scanned carries a DOI/);
    expect((res.structuredContent as any).scan.withDoi).toBe(0);
  });

  it('refuses library_scan when no library is reachable', async () => {
    const c = sweepCtx({ cloud: false });
    const res = await scholar.handler({ action: 'notices', library_scan: true }, c);
    expect(res.isError).toBe(true);
    expect(summaryOf(res)).toMatch(/library_scan needs a reachable library/);
  });
});

describe('zotero_scholar hands back the library item key that makes citation context reachable', () => {
  const citing = { id: 'https://openalex.org/W9', doi: `https://doi.org/${CLEAN}`, display_name: 'Citing paper', cited_by_count: 3 };

  it('puts libraryItemKey on each citing work the library already holds', async () => {
    const c = ctx({
      items: [libItem('DDDD4444', 'Citing paper', CLEAN)],
      openalex: () => json({ id: 'https://openalex.org/W1', cited_by_count: 1, results: [citing] }),
    });
    const res = await scholar.handler({ action: 'citations', doi: WAKEFIELD, include_in_library: true }, c);
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    expect(sc.results[0]).toMatchObject({ inLibrary: true, libraryItemKey: 'DDDD4444' });
    expect(summaryOf(res)).toMatch(/Each held result carries libraryItemKey: pass one to zotero_get_fulltext/);
    expect(sc.scan).toMatchObject({ scanned: 1, complete: true });
  });

  it('leaves libraryItemKey off a work the library does not hold', async () => {
    const c = ctx({
      items: [libItem('DDDD4444', 'Something else', '10.9/other')],
      openalex: () => json({ id: 'https://openalex.org/W1', cited_by_count: 1, results: [citing] }),
    });
    const res = await scholar.handler({ action: 'citations', doi: WAKEFIELD, include_in_library: true }, c);
    const sc = res.structuredContent as any;
    expect(sc.results[0].inLibrary).toBe(false);
    expect(sc.results[0].libraryItemKey).toBeUndefined();
    expect(summaryOf(res)).not.toMatch(/libraryItemKey: pass one/);
  });

  it('says when the library scan behind an inLibrary count was cut short', async () => {
    const c = ctx({
      items: [libItem('DDDD4444', 'Citing paper', CLEAN)],
      totalResults: 9000,
      openalex: () => json({ id: 'https://openalex.org/W1', cited_by_count: 1, results: [citing] }),
    });
    const res = await scholar.handler({ action: 'citations', doi: WAKEFIELD, include_in_library: true }, c);
    expect((res.structuredContent as any).scan.complete).toBe(false);
    expect(summaryOf(res)).toMatch(/The library scan stopped after 1 of 9000 items/);
  });
});

describe("zotero_scholar surfaces OpenAlex's flag on the other actions as a pointer, not a claim", () => {
  it('names the flag and the action that checks it on lookup, without asserting a retraction', async () => {
    const c = ctx({ openalex: () => openalexWork(WAKEFIELD, { is_retracted: true, cited_by_count: 2 }) });
    const res = await scholar.handler({ action: 'lookup', doi: WAKEFIELD }, c);
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as any).work.openalexIsRetracted).toBe(true);
    const text = summaryOf(res);
    expect(text).toMatch(/OpenAlex sets is_retracted on this record/);
    expect(text).toMatch(/one source's flag/);
    expect(text).toMatch(/set on retraction notices as well as on retracted papers/);
    expect(text).toMatch(/action:"notices"/);
    expect(text).not.toMatch(VERDICT);
  });

  it('says nothing about retraction on lookup when the flag is false', async () => {
    const c = ctx({ openalex: () => openalexWork(CLEAN, { is_retracted: false, cited_by_count: 2 }) });
    const res = await scholar.handler({ action: 'lookup', doi: CLEAN }, c);
    expect((res.structuredContent as any).work.openalexIsRetracted).toBe(false);
    expect(summaryOf(res)).not.toMatch(/is_retracted/);
  });

  it('counts flagged works in a reference list and points at the check, naming none of them', async () => {
    const c = ctx({
      openalex: () =>
        json({
          id: 'https://openalex.org/W1',
          referenced_works: ['https://openalex.org/W7', 'https://openalex.org/W8'],
          results: [
            { id: 'https://openalex.org/W7', doi: `https://doi.org/${WAKEFIELD}`, display_name: 'One', is_retracted: true },
            { id: 'https://openalex.org/W8', doi: `https://doi.org/${CLEAN}`, display_name: 'Two', is_retracted: false },
          ],
        }),
    });
    const res = await scholar.handler({ action: 'references', doi: '10.1/review' }, c);
    const sc = res.structuredContent as any;
    expect(sc.openalexRetractionFlags).toBe(1);
    expect(sc.results[0].openalexIsRetracted).toBe(true);
    const text = summaryOf(res);
    expect(text).toMatch(/1 of these carries OpenAlex's is_retracted flag/);
    expect(text).toMatch(/run action:"notices" on its DOI/);
    expect(text).not.toMatch(VERDICT);
  });

  it('leaves the count off entirely when nothing is flagged', async () => {
    const c = ctx({
      openalex: () =>
        json({
          id: 'https://openalex.org/W1',
          referenced_works: ['https://openalex.org/W8'],
          results: [{ id: 'https://openalex.org/W8', doi: `https://doi.org/${CLEAN}`, display_name: 'Two', is_retracted: false }],
        }),
    });
    const res = await scholar.handler({ action: 'references', doi: '10.1/review' }, c);
    expect((res.structuredContent as any).openalexRetractionFlags).toBeUndefined();
    expect(summaryOf(res)).not.toMatch(/is_retracted/);
  });
});

describe('zotero_scholar keeps its existing contract while gaining an action', () => {
  it('still refuses an empty DOI for every action that needs one', async () => {
    const c = ctx();
    for (const action of ['lookup', 'references', 'citations', 'related', 'notices']) {
      const res = await scholar.handler({ action, doi: '  ' }, c);
      expect(res.isError, action).toBe(true);
      expect(summaryOf(res)).toMatch(/DOI is required/);
    }
    expect(c.fetchImpl).not.toHaveBeenCalled();
  });

  it('describes the notices action without turning itself into a library-search tool', () => {
    expect(scholar.description.toLowerCase()).toMatch(/does not search|not search.*library|external/);
    expect(scholar.description).toMatch(/zotero_search_items/);
    expect(scholar.description).toMatch(/zotero_semantic_search/);
    expect(scholar.inputSchema.include_in_library?.description).toMatch(/default false/);
    // The never-a-verdict promise is part of the advertised contract, not only the output.
    expect(scholar.description).toMatch(/never emits a verdict/);
    expect(scholar.description).toMatch(/not reached/);
    expect(scholar.inputSchema.library_scan?.description).toMatch(/default false/);
  });
});
