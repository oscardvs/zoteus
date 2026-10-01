import { describe, it, expect } from 'vitest';
import { LocalApiClient } from '../../src/api/local-client.js';
import { RateLimitedFetcher } from '../../src/api/http.js';
import { LibraryRouter } from '../../src/router/library-router.js';
import { loadConfig } from '../../src/config.js';
import searchItems from '../../src/tools/search-items.js';
import { fakeTrashDesktop, LIBRARY_VERSION, TRASHED } from '../fixtures/local-trash.js';

/**
 * The 2026-10-01 stress test: `zotero_search_items tag:"zoteus-stress-test"
 * includeTrashed:true` answered 0 on the desktop local API while 55 trashed items carried
 * that tag, and `q:"ZST" includeTrashed:true` found all 55. The desktop runs each `tag`,
 * `itemType` and `itemKey` parameter as a sub-search that never sees the trash, so the
 * client assembles that answer itself. These run against a stand-in that answers the way
 * the real desktop did (tests/fixtures/local-trash.ts), so the URLs the real client builds
 * are part of what is asserted.
 */
function wired() {
  const desktop = fakeTrashDesktop();
  const local = new LocalApiClient({
    fetcher: new RateLimitedFetcher({ fetchImpl: desktop.fetchImpl as any, maxConcurrency: 4 }),
  });
  return { local, calls: desktop.calls };
}

const keysOf = (r: { data: any[] }) => r.data.map((i: any) => i.key);
const STRESS = ['JMT2P9IT', 'SCE6JNKP', 'H2ACW4ET'];

describe('LocalApiClient: a tag or itemType filter that includes the trash', () => {
  it('starts from the defect: the stand-in, like the desktop, finds nothing trashed through a filter', async () => {
    const { fetchImpl } = fakeTrashDesktop();
    const base = 'http://127.0.0.1:23119/api/users/0';
    const tagged = await fetchImpl(`${base}/items?tag=zoteus-stress-test&includeTrashed=1`);
    expect(await tagged.json()).toEqual([]);
    const fromTrash = await fetchImpl(`${base}/items/trash?tag=zoteus-stress-test`);
    expect(await fromTrash.json()).toEqual([]);
    const byTitle = await fetchImpl(`${base}/items?q=ZST&includeTrashed=1`);
    expect(((await byTitle.json()) as any[]).map((i) => i.key)).toEqual(STRESS);
  });

  it('finds the trashed items a tag filter matches', async () => {
    const { local } = wired();
    const res = await local.listItems({ tag: 'zoteus-stress-test', includeTrashed: true });
    expect(keysOf(res)).toEqual(STRESS);
    expect(res.totalResults).toBe(3);
    expect(res.lastModifiedVersion).toBe(LIBRARY_VERSION);
    // The page carries the desktop's own JSON for them, deleted flag and all.
    expect(res.data.every((i: any) => i.data.deleted === true)).toBe(true);
  });

  it('matches a tag exactly, non-ASCII included, and is case-sensitive as Zotero is', async () => {
    const { local } = wired();
    expect(keysOf(await local.listItems({ tag: 'zst-日本語', includeTrashed: true }))).toEqual([
      'SCE6JNKP',
      'H2ACW4ET',
    ]);
    expect((await local.listItems({ tag: 'ZOTEUS-STRESS-TEST', includeTrashed: true })).totalResults).toBe(0);
  });

  it('merges live and trashed matches into one list in the order the desktop sorts them', async () => {
    const { local } = wired();
    const res = await local.listItems({ tag: 'VLA || zoteus-stress-test', includeTrashed: true });
    // dateModified descending, the desktop's default: the stress items are the newest.
    expect(keysOf(res)).toEqual([...STRESS, 'ZINCUGAP', 'KMBR5HXX']);
    const asc = await local.listItems({ tag: 'VLA || zoteus-stress-test', includeTrashed: true, sort: 'title', direction: 'asc' });
    expect(keysOf(asc)).toEqual(['KMBR5HXX', 'ZINCUGAP', 'H2ACW4ET', 'SCE6JNKP', 'JMT2P9IT']);
  });

  it('requires every repeated tag parameter to match', async () => {
    const { local } = wired();
    const res = await local.listItems({ tag: ['zoteus-stress-test', 'zst/α-β'], includeTrashed: true });
    expect(keysOf(res)).toEqual(['SCE6JNKP', 'H2ACW4ET']);
  });

  it('reads a negated tag as the desktop does: every alternative negated, annotations never matched', async () => {
    const { local } = wired();
    const res = await local.listItems({ tag: '-zoteus-stress-test', includeTrashed: true });
    const keys = keysOf(res);
    // Trashed, untagged, and not annotations: in. The trashed annotations (one tagged
    // otherwise, one untagged) are out, exactly as `tag=-X` leaves out live annotations.
    expect(keys).toEqual(expect.arrayContaining(['CG4253NT', 'FSQF48MS', 'CNFVGR6X']));
    expect(keys).not.toContain('PLDMINXM');
    expect(keys).not.toContain('BAEJPE8T');
    expect(keys.filter((k) => STRESS.includes(k))).toEqual([]);
  });

  it('applies an itemType filter across the trash too, children of trashed parents included', async () => {
    const { local } = wired();
    expect(keysOf(await local.listItems({ itemType: 'document', includeTrashed: true }))).toEqual(STRESS);
    // CNFVGR6X carries no `deleted` of its own: it is in the trash because its parent is.
    expect(keysOf(await local.listItems({ itemType: 'attachment', includeTrashed: true }))).toEqual([
      'CNFVGR6X',
      '2I2V3PHQ',
    ]);
  });

  it('keeps `top` to top-level items, trashed ones included', async () => {
    const { local } = wired();
    const res = await local.listItems({ itemType: 'attachment || journalArticle', top: true, includeTrashed: true });
    expect(keysOf(res)).toEqual(['FSQF48MS']);
  });

  it('pages one list: exact total, disjoint pages that together are the whole answer', async () => {
    const { local } = wired();
    const seen: string[] = [];
    for (let start = 0; ; start += 2) {
      const page = await local.listItems({ tag: 'VLA || zoteus-stress-test', includeTrashed: true, limit: 2, start });
      expect(page.totalResults).toBe(5);
      seen.push(...keysOf(page));
      if (start + 2 >= page.totalResults) break;
    }
    expect(seen).toEqual([...STRESS, 'ZINCUGAP', 'KMBR5HXX']);
  });

  it('answers a keys-only read the same way', async () => {
    const { local } = wired();
    const res = await local.listItemKeys({ tag: 'zoteus-stress-test', includeTrashed: true, limit: 2 });
    expect(res.keys).toEqual(STRESS.slice(0, 2));
    expect(res.totalResults).toBe(3);
  });

  it('finds a trashed item named by key, which a keyed read with the trash in leaves out', async () => {
    const { local } = wired();
    const res = await local.listItems({ itemKey: 'JMT2P9IT,ZINCUGAP', top: true, includeTrashed: true });
    expect(keysOf(res)).toEqual(['JMT2P9IT', 'ZINCUGAP']);
  });

  it('reads the trash as JSON only when a trashed item falls inside the query', async () => {
    const { local, calls } = wired();
    await local.listItems({ tag: 'VLA', q: 'FAST', includeTrashed: true });
    expect(calls.some((u) => u.includes('/items/trash?') && !u.includes('format=keys'))).toBe(false);
  });

  it('leaves every other listing as the single request it always was', async () => {
    const { local, calls } = wired();
    await local.listItems({ tag: 'zoteus-stress-test' });
    await local.listItems({ q: 'ZST', includeTrashed: true });
    expect(calls).toHaveLength(2);
    expect(calls.every((u) => !u.includes('/trash'))).toBe(true);
    // And without the trash, a trashed match stays out, which is what was asked for.
    expect((await local.listItems({ tag: 'zoteus-stress-test' })).totalResults).toBe(0);
  });

  it('reaches the same answer through zotero_search_items, as the stress test asked it', async () => {
    const { local } = wired();
    const router = new LibraryRouter({
      config: loadConfig({ ZOTEUS_LOCAL: 'on' } as any),
      capabilities: { cloud: null, localApi: true, localGroupIds: [] } as any,
      web: {} as any,
      local,
    });
    const res = await searchItems.handler({ tag: 'zoteus-stress-test', includeTrashed: true }, { router } as any);
    expect(res.structuredContent?.totalResults).toBe(3);
    expect((res.structuredContent?.items as any[]).map((i) => i.title)).toEqual(
      STRESS.map((k) => TRASHED[k].data.title),
    );
  });

  it('keeps trashed matches on the page of a top-level itemType search (#79 path)', async () => {
    const { local } = wired();
    const router = new LibraryRouter({
      config: loadConfig({ ZOTEUS_LOCAL: 'on' } as any),
      capabilities: { cloud: null, localApi: true, localGroupIds: [] } as any,
      web: {} as any,
      local,
    });
    const res = await router.searchItems({ itemType: 'document || preprint', top: true, includeTrashed: true, limit: 10 });
    expect(keysOf(res)).toEqual([...STRESS, 'ZINCUGAP', 'KMBR5HXX', 'CG4253NT']);
    expect(res.totalResults).toBe(6);
  });
});
