import { describe, it, expect, vi } from 'vitest';
import listCollections from '../../src/tools/list-collections.js';
import manageCollections from '../../src/tools/manage-collections.js';
import { LibraryRouter } from '../../src/router/library-router.js';
import { loadConfig } from '../../src/config.js';

function ctx(listImpl: any) {
  return {
    router: {
      listAllCollections: async () => {
        const r = await listImpl();
        return { data: r.data, totalResults: r.totalResults, complete: true };
      },
      defaultLibrary: () => ({ type: 'user', id: 19552201 }),
    },
  } as any;
}

describe('zotero_list_collections', () => {
  it('lists collections with key/name/parent/numItems, visible in text content', async () => {
    const impl = vi.fn(async () => ({
      data: [{ key: 'C1', data: { name: 'Reading', parentCollection: false }, meta: { numItems: 4 } }],
      totalResults: 1,
      lastModifiedVersion: 1,
    }));
    const res = await listCollections.handler({}, ctx(impl));
    const cols = res.structuredContent?.collections as any[];
    expect(cols[0]).toEqual({ key: 'C1', name: 'Reading', parentCollection: false, numItems: 4 });
    const text = (res.content ?? []).map((c: { text: string }) => c.text).join('\n');
    expect(text).toContain('Reading');
  });

  it('is annotated read-only', () => {
    expect(listCollections.annotations?.readOnlyHint).toBe(true);
  });
});

/**
 * A cloud library of `count` collections, served the way api.zotero.org serves them: 25 to a
 * page by default, never more than 100, with Total-Results counting them all. The order is
 * Zotero's, not alphabetical, and one collection named "Backups" sits far down it.
 */
function cloudLibrary(count: number, opts: { totalHeader?: boolean } = {}) {
  const all = Array.from({ length: count }, (_, i) => {
    const key = `K${String(i).padStart(7, '0')}`;
    const name = i === 1300 ? 'Backups' : `Topic ${String(count - i).padStart(4, '0')}`;
    return { key, version: 1, data: { key, name, parentCollection: false }, meta: { numItems: i % 7 } };
  });
  const web = {
    listCollections: vi.fn(async (_lib: unknown, q: { limit?: number; start?: number } = {}) => {
      const limit = Math.min(q.limit ?? 25, 100);
      const start = q.start ?? 0;
      const data = all.slice(start, start + limit);
      // Without the header, the client falls back to the page's own length.
      return { data, totalResults: opts.totalHeader === false ? data.length : count, lastModifiedVersion: 7 };
    }),
    getCollection: vi.fn(async (_lib: unknown, key: string) => all.find((c) => c.key === key) ?? null),
  };
  const capabilities = { cloud: { userID: 19552201, username: 'u', access: {} }, localApi: false, localGroupIds: [] };
  const router = new LibraryRouter({
    config: loadConfig({ ZOTEUS_LOCAL: 'off' } as any),
    capabilities: capabilities as any,
    web: web as any,
  });
  const context: any = { config: { libraryType: 'user' }, capabilities, router, web };
  return { ctx: context, web, router };
}

const textOf = (res: any) => (res.content ?? []).map((c: { text: string }) => c.text).join('\n');

describe('a library with more collections than one page (#90)', () => {
  it('reads every page and says how many there are, instead of the first 25', async () => {
    const { ctx: c, web } = cloudLibrary(1460);
    const res: any = await listCollections.handler({}, c);
    expect(res.structuredContent.totalResults).toBe(1460);
    expect(res.structuredContent.complete).toBe(true);
    expect(res.structuredContent.collections).toHaveLength(200);
    // 15 pages of at most 100, and no page past the end.
    expect(web.listCollections).toHaveBeenCalledTimes(15);
    for (const call of web.listCollections.mock.calls) expect(call[1]!.limit).toBe(100);
    expect(res.content[0].text).toContain('Showing 1-200 of 1460 collection(s)');
    expect(res.content[0].text).toContain('start=200');
  });

  it('finds a collection by name that sits past the first page', async () => {
    const { ctx: c } = cloudLibrary(1460);
    const res: any = await listCollections.handler({ q: 'backup' }, c);
    expect(res.structuredContent.collections).toEqual([
      { key: 'K0001300', name: 'Backups', parentCollection: false, numItems: 1300 % 7 },
    ]);
    expect(res.structuredContent.totalResults).toBe(1);
    expect(textOf(res)).toContain('1 collection(s) named like "backup"');
  });

  it('pages in name order, so the pages meet with nothing skipped or repeated', async () => {
    const { ctx: c } = cloudLibrary(1460);
    const seen: string[] = [];
    for (let start = 0; start < 1460; start += 500) {
      const res: any = await listCollections.handler({ start, limit: 500 }, c);
      seen.push(...res.structuredContent.collections.map((x: any) => x.name));
    }
    expect(seen).toHaveLength(1460);
    expect(new Set(seen).size).toBe(1460);
    expect([...seen].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))).toEqual(seen);
    const last: any = await listCollections.handler({ start: 1400, limit: 100 }, c);
    expect(last.structuredContent.collections).toHaveLength(60);
    expect(last.content[0].text).toContain('Showing 1401-1460 of 1460');
    expect(last.content[0].text).not.toContain('Page with');
  });

  it('does not stop at the first page when Zotero sends no Total-Results', async () => {
    const { router } = cloudLibrary(250, { totalHeader: false });
    const all = await router.listAllCollections();
    expect(all.data).toHaveLength(250);
    expect(all.complete).toBe(true);
  });

  it('stops on a backend that ignores start instead of looping', async () => {
    const { router, web } = cloudLibrary(300);
    web.listCollections.mockImplementation(async (_lib: unknown, q: { limit?: number } = {}) => ({
      data: Array.from({ length: q.limit ?? 25 }, (_, i) => ({ key: `SAME${i}`, data: { name: `n${i}` } })) as any,
      totalResults: 300,
      lastModifiedVersion: 7,
    }));
    const all = await router.listAllCollections();
    expect(web.listCollections).toHaveBeenCalledTimes(2);
    expect(all.data).toHaveLength(100);
    expect(all.complete).toBe(false);
  });

  it('says so when the crawl stops at its cap', async () => {
    const { router } = cloudLibrary(1460);
    const all = await router.listAllCollections({}, 300);
    expect(all.data).toHaveLength(300);
    expect(all.totalResults).toBe(1460);
    expect(all.complete).toBe(false);
  });

  it('gives zotero_manage_collections list the same whole-library listing', async () => {
    const { ctx: c } = cloudLibrary(1460);
    const res: any = await manageCollections.handler({ action: 'list', q: 'Backups' }, c);
    expect(res.structuredContent.collections.map((x: any) => x.key)).toEqual(['K0001300']);
    const page: any = await manageCollections.handler({ action: 'list' }, c);
    expect(page.structuredContent.totalResults).toBe(1460);
  });

  it('renames a collection that is not on the first page', async () => {
    const { ctx: c, web } = cloudLibrary(1460);
    (web as any).writeCollections = vi.fn(async () => ({ successful: [], unchanged: [], failed: [], newLibraryVersion: 8 }));
    const res: any = await manageCollections.handler(
      { action: 'rename', collection_key: 'K0001300', name: 'Backups (old)' },
      c,
    );
    expect(res.isError).toBeFalsy();
    expect((web as any).writeCollections.mock.calls[0][1][0]).toMatchObject({
      key: 'K0001300',
      name: 'Backups (old)',
      version: 1,
    });
  });
});
