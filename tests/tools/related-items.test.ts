import { describe, it, expect, vi } from 'vitest';
import suggestRelated from '../../src/tools/suggest-related.js';
import relateItems from '../../src/tools/relate-items.js';
import { relatedKeys, libraryUriBase } from '../../src/features/related/relations.js';
import { citationPairs, type ScopeItem } from '../../src/features/related/suggest.js';
import { OpenAlexClient } from '../../src/features/scholar/openalex.js';
import { ZoteroApiError } from '../../src/api/errors.js';

const ME = { type: 'user', id: 0 };
const USER = 'http://zotero.org/users/19552201';

/** Shaped like a record the Zotero 10 local API returns (read 2026-11-10): relations as arrays. */
const rec = (key: string, data: Record<string, unknown> = {}, library: any = { type: 'user', id: 19552201 }) => ({
  key,
  version: 10,
  library,
  data: { key, itemType: 'journalArticle', title: `T ${key}`, date: '2020', relations: {}, ...data },
});

function ctxWith(items: Record<string, any>, opts: { cloud?: boolean; desktop?: boolean; links?: Map<string, any> } = {}): any {
  const desktop = opts.desktop ?? true;
  const lookup = async (key: string) => {
    const item = items[key];
    if (!item) throw Object.assign(new Error(`Local API 404 for /users/0/items/${key}`), { status: 404 });
    return structuredClone(item);
  };
  return {
    config: {},
    capabilities: { cloud: opts.cloud ? { userID: 19552201, access: { user: { write: true }, groups: { all: { library: true, write: true } } } } : null, localApi: desktop, localGroupIds: [] },
    router: {
      defaultLibrary: () => ME,
      getItem: vi.fn(lookup),
      searchItems: vi.fn(async () => ({ data: Object.values(items), totalResults: Object.keys(items).length })),
    },
    local: { ping: vi.fn(async () => desktop), getItem: vi.fn(lookup) },
    localWrites: { patchItem: vi.fn(async () => 11) },
    web: { getItem: vi.fn(async (_l: unknown, k: string) => lookup(k)), patchItem: vi.fn(async () => 7) },
    scholar: {
      referenceLinks: vi.fn(async (dois: string[]) => ({ found: opts.links ?? new Map(), checked: dois, failures: [] })),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

describe('relations helpers', () => {
  it('reads both the array form (local API) and the string form (Web API)', () => {
    expect([...relatedKeys({ 'dc:relation': [`${USER}/items/B9IKRX2J`] }, USER)]).toEqual(['B9IKRX2J']);
    expect([...relatedKeys({ 'dc:relation': `${USER}/items/B9IKRX2J`, 'dc:replaces': `${USER}/items/OLDOLD11` }, USER)]).toEqual(['B9IKRX2J']);
    expect([...relatedKeys({ 'dc:relation': 'http://zotero.org/groups/9/items/B9IKRX2J' }, USER)]).toEqual([]);
  });
  it('builds the library URI from a real id only', () => {
    expect(libraryUriBase({ type: 'group', id: 5234875 })).toBe('http://zotero.org/groups/5234875');
    expect(libraryUriBase({ type: 'user', id: 0 }, 19552201)).toBe(USER);
    expect(libraryUriBase({ type: 'user', id: 0 })).toBeUndefined();
  });
});

describe('citationPairs', () => {
  const item = (key: string, doi?: string, related: string[] = []): ScopeItem => ({ key, ...(doi ? { doi } : {}), related: new Set(related) });
  it('pairs items whose OpenAlex reference list names another library item', () => {
    const items = [item('AAAAAAAA', '10.1/a'), item('BBBBBBBB', '10.1/b', ['AAAAAAAA']), item('CCCCCCCC', '10.1/c'), item('DDDDDDDD')];
    const links = new Map([
      ['10.1/a', { id: 'W1', references: ['W2', 'W3', 'W99'] }],
      ['10.1/b', { id: 'W2', references: ['W1'] }],
      ['10.1/c', { id: 'W3', references: [] }],
    ]);
    const pairs = citationPairs(items, links);
    expect(pairs.map((p) => [p.citing.key, p.cited.key, p.mutual, p.alreadyRelated])).toEqual([
      ['AAAAAAAA', 'BBBBBBBB', true, true],
      ['AAAAAAAA', 'CCCCCCCC', false, false],
    ]);
  });
});

describe('OpenAlexClient.referenceLinks', () => {
  it('asks for ids and reference lists in one batched filter and maps them by DOI', async () => {
    const fetch = vi.fn(async (_url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: [{ id: 'https://openalex.org/W4312749288', doi: 'https://doi.org/10.1109/iros47612.2022.9981507', referenced_works: ['https://openalex.org/W1965603550'] }],
      }),
    }));
    const client = new OpenAlexClient({ fetch } as any);
    const out = await client.referenceLinks(['10.1109/IROS47612.2022.9981507', '10.1/x|y']);
    expect(fetch.mock.calls[0]![0]).toBe(
      'https://api.openalex.org/works?filter=doi:10.1109/iros47612.2022.9981507&select=id,doi,referenced_works&per-page=1',
    );
    expect(out.found.get('10.1109/iros47612.2022.9981507')).toEqual({ id: 'W4312749288', references: ['W1965603550'] });
    expect(out.checked).toEqual(['10.1109/iros47612.2022.9981507']);
  });
});

describe('zotero_suggest_related', () => {
  it('suggests citation pairs and leaves out pairs already linked', async () => {
    const items = {
      AAAAAAAA: rec('AAAAAAAA', { DOI: '10.1/A' }),
      BBBBBBBB: rec('BBBBBBBB', { extra: 'DOI: 10.1/b' }),
      CCCCCCCC: rec('CCCCCCCC', { DOI: '10.1/c', relations: { 'dc:relation': [`${USER}/items/AAAAAAAA`] } }),
      NOTE0001: rec('NOTE0001', { itemType: 'note' }),
    };
    const links = new Map([
      ['10.1/a', { id: 'W1', references: ['W2', 'W3'] }],
      ['10.1/b', { id: 'W2', references: [] }],
      ['10.1/c', { id: 'W3', references: [] }],
    ]);
    const ctx = ctxWith(items, { links });
    const res: any = await suggestRelated.handler({ collection_key: 'COLL0001' }, ctx);
    expect(ctx.router.searchItems.mock.calls[0][0]).toMatchObject({ top: true, collectionKey: 'COLL0001', library: ME });
    expect(ctx.scholar.referenceLinks).toHaveBeenCalledWith(['10.1/a', '10.1/b', '10.1/c']);
    const s = res.structuredContent;
    expect(s.suggestions).toEqual([
      { citing: { item_key: 'AAAAAAAA', title: 'T AAAAAAAA', year: '2020', doi: '10.1/a' }, cited: { item_key: 'BBBBBBBB', title: 'T BBBBBBBB', year: '2020', doi: '10.1/b' }, mutual: false, alreadyRelated: false },
    ]);
    expect(s.counts).toEqual({ scanned: 3, withDoi: 3, foundInOpenAlex: 3, unchecked: 0, alreadyRelated: 1 });
    const all: any = await suggestRelated.handler({ collection_key: 'COLL0001', include_existing: true }, ctxWith(items, { links }));
    expect(all.structuredContent.suggestions).toHaveLength(2);
  });
});

describe('zotero_relate_items', () => {
  it('links both items, keeping every relation already there, with the account id in the URI', async () => {
    const items = {
      AAAAAAAA: rec('AAAAAAAA', { relations: { 'dc:relation': [`${USER}/items/ZZZZZZZZ`], 'dc:replaces': [`${USER}/items/OLDOLD11`] } }),
      BBBBBBBB: rec('BBBBBBBB'),
    };
    const ctx = ctxWith(items);
    const res: any = await relateItems.handler({ pairs: [{ item_key: 'AAAAAAAA', related_key: 'BBBBBBBB' }] }, ctx);
    expect(res.isError).toBeUndefined();
    const calls = ctx.localWrites.patchItem.mock.calls;
    expect(calls.map((c: any[]) => [c[0], c[1], c[2]])).toEqual([
      ['AAAAAAAA', { relations: { 'dc:relation': [`${USER}/items/ZZZZZZZZ`, `${USER}/items/BBBBBBBB`], 'dc:replaces': `${USER}/items/OLDOLD11` } }, 10],
      ['BBBBBBBB', { relations: { 'dc:relation': `${USER}/items/AAAAAAAA` } }, 10],
    ]);
    expect(res.structuredContent).toMatchObject({ linked: 2, failed: 0, target: 'local' });
  });

  it('writes nothing for a pair already linked on both sides', async () => {
    const items = {
      AAAAAAAA: rec('AAAAAAAA', { relations: { 'dc:relation': `${USER}/items/BBBBBBBB` } }),
      BBBBBBBB: rec('BBBBBBBB', { relations: { 'dc:relation': [`${USER}/items/AAAAAAAA`] } }),
    };
    const ctx = ctxWith(items);
    const res: any = await relateItems.handler({ pairs: [{ item_key: 'BBBBBBBB', related_key: 'AAAAAAAA' }] }, ctx);
    expect(ctx.localWrites.patchItem).not.toHaveBeenCalled();
    expect(res.structuredContent.items.map((o: any) => o.status)).toEqual(['unchanged', 'unchanged']);
  });

  it('re-reads after a version conflict and keeps the link added meanwhile', async () => {
    const items: Record<string, any> = { AAAAAAAA: rec('AAAAAAAA'), BBBBBBBB: rec('BBBBBBBB') };
    const ctx = ctxWith(items);
    ctx.localWrites.patchItem.mockImplementationOnce(async () => {
      items.AAAAAAAA = { ...rec('AAAAAAAA', { relations: { 'dc:relation': [`${USER}/items/YYYYYYYY`] } }), version: 12 };
      throw new ZoteroApiError({ status: 412, message: 'Precondition Failed' });
    });
    await relateItems.handler({ pairs: [{ item_key: 'AAAAAAAA', related_key: 'BBBBBBBB' }] }, ctx);
    expect(ctx.localWrites.patchItem.mock.calls[1]).toEqual([
      'AAAAAAAA',
      { relations: { 'dc:relation': [`${USER}/items/YYYYYYYY`, `${USER}/items/BBBBBBBB`] } },
      12,
      ME,
    ]);
  });

  it('refuses an unknown key before writing anything', async () => {
    const ctx = ctxWith({ AAAAAAAA: rec('AAAAAAAA') });
    const res: any = await relateItems.handler({ pairs: [{ item_key: 'AAAAAAAA', related_key: 'NOPE0001' }] }, ctx);
    expect(res.isError).toBe(true);
    expect(ctx.localWrites.patchItem).not.toHaveBeenCalled();
  });

  it('refuses a personal library with no account id rather than write a dangling URI', async () => {
    const lib0 = { type: 'user', id: 0 };
    const ctx = ctxWith({ AAAAAAAA: rec('AAAAAAAA', {}, lib0), BBBBBBBB: rec('BBBBBBBB', {}, lib0) });
    const res: any = await relateItems.handler({ pairs: [{ item_key: 'AAAAAAAA', related_key: 'BBBBBBBB' }] }, ctx);
    expect(res.isError).toBe(true);
    expect(ctx.localWrites.patchItem).not.toHaveBeenCalled();
  });

  it('uses the group URI in a group library, through the cloud when the desktop lacks it', async () => {
    const g = { type: 'group', id: 5234875 };
    const ctx = ctxWith({ AAAAAAAA: rec('AAAAAAAA', {}, g), BBBBBBBB: rec('BBBBBBBB', {}, g) }, { cloud: true });
    await relateItems.handler({ pairs: [{ item_key: 'AAAAAAAA', related_key: 'BBBBBBBB' }], library_type: 'group', library_id: 5234875 }, ctx);
    expect(ctx.localWrites.patchItem).not.toHaveBeenCalled();
    expect(ctx.web.patchItem.mock.calls[0]).toEqual([g, 'AAAAAAAA', { relations: { 'dc:relation': 'http://zotero.org/groups/5234875/items/BBBBBBBB' } }, 10]);
  });
});
