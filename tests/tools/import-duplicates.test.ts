import { describe, it, expect, vi } from 'vitest';
import importTool from '../../src/tools/import.js';

const LIB = { type: 'user' as const, id: 19552201 };
const DOI = '10.1234/example';

/** One library item, as a listing hands it over. */
const item = (key: string, data: Record<string, unknown>) => ({ key, version: 1, data: { key, ...data } });

function makeCtx(library: any[] = [], overrides: any = {}): any {
  return {
    config: { translationServerUrl: 'http://127.0.0.1:1969' },
    capabilities: { cloud: { userID: 19552201, username: 'oscardvs', access: {} }, localApi: false },
    translation: { isUp: vi.fn(async () => false) },
    scholar: {
      lookup: vi.fn(async () => ({ title: 'A Scholarly Work', authors: ['Ada Lovelace'], year: 2024, venue: 'Nature' })),
    },
    router: {
      defaultLibrary: () => LIB,
      searchItems: vi.fn(async ({ start = 0, limit = 100 }: any) => ({
        data: library.slice(start, start + limit),
        totalResults: library.length,
        lastModifiedVersion: 1,
      })),
    },
    web: {
      writeItems: vi.fn(async () => ({
        successful: [{ index: 0, key: 'NEW1', version: 5 }],
        unchanged: [],
        failed: [],
        newLibraryVersion: 5,
      })),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...overrides,
  };
}

const args = (extra: Record<string, unknown> = {}) => ({ action: 'by_identifier', identifier: DOI, ...extra });

describe('zotero_import duplicate check', () => {
  it('does not scan the library unless it is asked to', async () => {
    const ctx = makeCtx([item('LIB1', { itemType: 'journalArticle', title: 'A Scholarly Work', DOI })]);
    const res: any = await importTool.handler(args({ save_to_library: true }), ctx);
    expect(res.isError).toBeFalsy();
    expect(ctx.router.searchItems).not.toHaveBeenCalled();
    expect(ctx.web.writeItems).toHaveBeenCalled();
    expect(res.structuredContent.duplicates).toBeUndefined();
  });

  it('reports the matching item, by DOI, without saving anything', async () => {
    const ctx = makeCtx([item('LIB1', { itemType: 'journalArticle', title: 'Quite another title', DOI: '10.1234/EXAMPLE' })]);
    const res: any = await importTool.handler(args({ check_duplicates: true }), ctx);

    expect(res.isError).toBeFalsy();
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
    const sc = res.structuredContent;
    expect(sc.saved).toBe(false);
    expect(sc.duplicates).toHaveLength(1);
    expect(sc.duplicates[0]).toMatchObject({ item_key: 'LIB1', matchedOn: 'doi', value: DOI, candidate: 'A Scholarly Work' });
    expect(sc.duplicateScan).toMatchObject({ scanned: 1, complete: true });
    // Many clients read only the text blocks, so the report has to survive the JSON mirror.
    expect(JSON.parse(res.content[1].text).duplicates[0].item_key).toBe('LIB1');
    // And the prose block, which is all a text-only client ever shows.
    expect(res.content[0].text).toMatch(/1 library item\(s\) already match \(LIB1\); see duplicates\./);
  });

  it('matches on the normalised title when no DOI matches', async () => {
    const ctx = makeCtx([item('LIB2', { itemType: 'journalArticle', title: 'A scholarly work!', date: '2024' })]);
    const res: any = await importTool.handler(args({ check_duplicates: true }), ctx);
    expect(res.structuredContent.duplicates[0]).toMatchObject({ item_key: 'LIB2', matchedOn: 'title' });
  });

  it('reports nothing when the library holds no match', async () => {
    const ctx = makeCtx([item('LIB3', { itemType: 'book', title: 'Something else', DOI: '10.9/other' })]);
    const res: any = await importTool.handler(args({ check_duplicates: true, save_to_library: true }), ctx);
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.duplicates).toEqual([]);
    expect(ctx.web.writeItems).toHaveBeenCalled();
  });

  it('refuses a save that would create a duplicate, and names the way out', async () => {
    const ctx = makeCtx([item('LIB1', { itemType: 'journalArticle', title: 'A Scholarly Work', DOI })]);
    const res: any = await importTool.handler(args({ check_duplicates: true, save_to_library: true }), ctx);

    expect(res.isError).toBe(true);
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
    const text = res.content[0].text;
    expect(text).toMatch(/LIB1/);
    expect(text).toMatch(/allow_duplicate:true/);
    expect(text).toMatch(/zotero_merge_items/);
    // Honest about what the comparison is.
    expect(text).toMatch(/not a\s+similarity judgement|exact comparison/);
  });

  it('saves anyway when the caller allows it, and still reports the match', async () => {
    const ctx = makeCtx([item('LIB1', { itemType: 'journalArticle', title: 'A Scholarly Work', DOI })]);
    const res: any = await importTool.handler(
      args({ check_duplicates: true, save_to_library: true, allow_duplicate: true }),
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(ctx.web.writeItems).toHaveBeenCalled();
    expect(res.structuredContent.created).toEqual(['NEW1']);
    expect(res.structuredContent.duplicates[0].item_key).toBe('LIB1');
    // "Imported 1 of 1" alone would read as a clean result to a client that shows only the
    // prose, so the match and the flag that let the save through ride the summary too.
    const summary = res.content[0].text;
    expect(summary).toMatch(/Imported 1 of 1/);
    expect(summary).toMatch(/1 library item\(s\) already match \(LIB1\); saved anyway because allow_duplicate is set\./);
  });

  it('refuses the save when the check itself could not run', async () => {
    const ctx = makeCtx([]);
    ctx.router.searchItems = vi.fn(async () => {
      throw new Error('Zotero rate limit');
    });
    const res: any = await importTool.handler(args({ check_duplicates: true, save_to_library: true }), ctx);

    expect(res.isError).toBe(true);
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
    expect(res.content[0].text).toMatch(/could not be completed/);
    expect(res.content[0].text).toMatch(/Zotero rate limit/);
  });

  it('still saves when the check failed and the caller allowed it, saying the check did not run', async () => {
    const ctx = makeCtx([]);
    ctx.router.searchItems = vi.fn(async () => {
      throw new Error('Zotero rate limit');
    });
    const res: any = await importTool.handler(
      args({ check_duplicates: true, save_to_library: true, allow_duplicate: true }),
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(ctx.web.writeItems).toHaveBeenCalled();
    expect(res.structuredContent.duplicateScan.note).toMatch(/failed: Zotero rate limit/);
  });

  it('says so when the scan could not cover the whole library', async () => {
    const library = Array.from({ length: 30 }, (_, i) => item(`K${i}`, { title: `Paper ${i}` }));
    const ctx = makeCtx(library);
    // A library that reports more than the page ever returns: the crawl stops short.
    ctx.router.searchItems = vi.fn(async ({ start = 0 }: any) => ({
      data: start === 0 ? library : [],
      totalResults: 9000,
      lastModifiedVersion: 1,
    }));
    const res: any = await importTool.handler(args({ check_duplicates: true }), ctx);
    expect(res.structuredContent.duplicateScan.complete).toBe(false);
    expect(res.structuredContent.duplicateScan.note).toMatch(/may still exist further down the library/);
  });

  it('saves when the scan stopped at its cap, and says how far it looked in the SUMMARY', async () => {
    // The library holds 9000 top-level items and the crawl only ever sees 30 of them, so
    // "no match" here is an unfinished answer, not a clean one. The save still goes through
    // (refusing would make every large library unimportable without allow_duplicate, which
    // also switches off the refusal for the matches a scan DOES find), but the caveat has to
    // reach a client that renders only the prose block.
    const library = Array.from({ length: 30 }, (_, i) => item(`K${i}`, { title: `Paper ${i}` }));
    const ctx = makeCtx(library);
    ctx.router.searchItems = vi.fn(async ({ start = 0 }: any) => ({
      data: start === 0 ? library : [],
      totalResults: 9000,
      lastModifiedVersion: 1,
    }));
    const res: any = await importTool.handler(args({ check_duplicates: true, save_to_library: true }), ctx);

    expect(res.isError).toBeFalsy();
    expect(ctx.web.writeItems).toHaveBeenCalled();
    expect(res.structuredContent.duplicateScan.complete).toBe(false);
    const summary = res.content[0].text;
    expect(summary).toMatch(/Imported 1 of 1/);
    expect(summary).toMatch(/stopped after 30 of 9000 top-level items/);
    expect(summary).toMatch(/may still exist further down the library/);
    // And the mirror still carries the whole report.
    expect(JSON.parse(res.content[1].text).duplicateScan.complete).toBe(false);
  });

  it('leaves the summary alone when the scan covered the whole library', async () => {
    const ctx = makeCtx([item('LIB3', { itemType: 'book', title: 'Something else', DOI: '10.9/other' })]);
    const res: any = await importTool.handler(args({ check_duplicates: true, save_to_library: true }), ctx);
    expect(res.content[0].text).not.toMatch(/stopped after/);
  });

  it('carries the caveat of a check that could not run into the summary too', async () => {
    const ctx = makeCtx([]);
    ctx.router.searchItems = vi.fn(async () => {
      throw new Error('Zotero rate limit');
    });
    const res: any = await importTool.handler(
      args({ check_duplicates: true, save_to_library: true, allow_duplicate: true }),
      ctx,
    );
    expect(res.content[0].text).toMatch(/The duplicate check failed: Zotero rate limit/);
  });

  it('checks the library the caller named, not the default one', async () => {
    const ctx = makeCtx([]);
    await importTool.handler(args({ check_duplicates: true, library_type: 'group', library_id: 5234875 }), ctx);
    expect(ctx.router.searchItems.mock.calls[0][0].library).toEqual({ type: 'group', id: 5234875 });
  });
});
