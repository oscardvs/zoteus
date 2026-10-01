import { describe, it, expect, vi } from 'vitest';
import { LibraryRouter } from '../../src/router/library-router.js';
import { LocalApiClient } from '../../src/api/local-client.js';
import { RateLimitedFetcher } from '../../src/api/http.js';
import { loadConfig } from '../../src/config.js';

const cloudInfo = { userID: 19552201, username: 'oscardvs', access: {} };

/**
 * A library shaped like the one #79 was reported against, plus the one thing that library
 * happened not to contain: a standalone attachment. Three top-level items, two attachments
 * that hang off two of them, and one attachment that hangs off nothing.
 */
const ITEMS: Record<string, any> = {
  BOOK1AAA: { key: 'BOOK1AAA', data: { key: 'BOOK1AAA', itemType: 'book' } },
  ART1AAAA: { key: 'ART1AAAA', data: { key: 'ART1AAAA', itemType: 'journalArticle' } },
  STANDALO: { key: 'STANDALO', data: { key: 'STANDALO', itemType: 'attachment' } },
  CHILD1AA: {
    key: 'CHILD1AA',
    data: { key: 'CHILD1AA', itemType: 'attachment', parentItem: 'BOOK1AAA' },
  },
  CHILD2AA: {
    key: 'CHILD2AA',
    data: { key: 'CHILD2AA', itemType: 'attachment', parentItem: 'ART1AAAA' },
  },
};

const TOP_KEYS = ['BOOK1AAA', 'ART1AAAA', 'STANDALO'];
/**
 * What BOTH APIs hand back for `itemType=attachment`, whether or not `/top` was asked for:
 * the desktop ignores the top-level restriction once an itemType filter is present, so the
 * two child attachments are in there. Measured against Zotero 10 on 2026-09-12.
 */
const ATTACHMENT_KEYS = ['CHILD1AA', 'CHILD2AA', 'STANDALO'];

const KEY_SETS: Record<string, string[]> = {
  attachment: ATTACHMENT_KEYS,
  book: ['BOOK1AAA'],
};

/** Any filter the table does not name matches everything, child items included. */
const EVERYTHING = 'attachment || book || journalArticle';

/**
 * The two clients take their arguments the other way round (the cloud is addressed
 * `(lib, query)`, the desktop `(query, lib?)`), so the fakes have to as well: getting that
 * backwards is exactly the kind of mistake these tests are here to catch.
 */
type Style = 'web' | 'local';
const queryOf = (style: Style, args: any[]) => (style === 'web' ? args[1] : args[0]) ?? {};

function keyReader(style: Style) {
  return vi.fn(async (...args: any[]) => {
    const query = queryOf(style, args);
    const keys = query.top ? TOP_KEYS : (KEY_SETS[query.itemType] ?? Object.keys(ITEMS));
    return { keys, totalResults: keys.length, lastModifiedVersion: 4242 };
  });
}

function itemReader(style: Style) {
  return vi.fn(async (...args: any[]) => {
    const asked = String(queryOf(style, args).itemKey ?? '')
      .split(',')
      .filter(Boolean);
    // Deliberately answered in an order of its own: neither API promises to respect the
    // order of an `itemKey` list, so the router must put the page back in sort order.
    const data = asked
      .slice()
      .reverse()
      .map((k) => ITEMS[k])
      .filter(Boolean);
    return { data, totalResults: data.length, lastModifiedVersion: 4242 };
  });
}

function makeRouter(opts: { localApi: boolean }) {
  const web = {
    listItems: itemReader('web'),
    // The cloud's own spelling of the bug: `/items/top?itemType=attachment` answers with
    // the PARENTS of matching attachments, so a caller asking for attachments is handed
    // books and journal articles instead. Never reached once the router resolves `top`.
    listItemKeys: keyReader('web'),
  };
  const local = {
    listItems: itemReader('local'),
    listItemKeys: keyReader('local'),
  };
  const router = new LibraryRouter({
    config: loadConfig({ ZOTEUS_LOCAL: opts.localApi ? 'on' : 'off' } as any),
    capabilities: { cloud: cloudInfo, localApi: opts.localApi, localGroupIds: [] } as any,
    web: web as any,
    local: local as any,
  });
  return { router, web, local };
}

describe('searchItems with top and an itemType filter (#79)', () => {
  it('returns no item carrying a parentItem, on the desktop local API', async () => {
    const { router } = makeRouter({ localApi: true });
    const res = await router.searchItems({ itemType: 'attachment', top: true, limit: 10 });
    expect(res.data.map((i: any) => i.key)).toEqual(['STANDALO']);
    expect(res.data.filter((i: any) => i.data.parentItem)).toEqual([]);
  });

  it('returns no item carrying a parentItem, on the cloud Web API', async () => {
    const { router } = makeRouter({ localApi: false });
    const res = await router.searchItems({ itemType: 'attachment', top: true, limit: 10 });
    expect(res.data.map((i: any) => i.key)).toEqual(['STANDALO']);
    expect(res.data.filter((i: any) => i.data.parentItem)).toEqual([]);
  });

  it('counts only the top-level matches in totalResults', async () => {
    const { router } = makeRouter({ localApi: true });
    const res = await router.searchItems({ itemType: 'attachment', top: true, limit: 10 });
    // Not the 3 the API reports for that filter: one of them is top-level.
    expect(res.totalResults).toBe(1);
    expect(res.lastModifiedVersion).toBe(4242);
  });

  it('asks for the top-level key set without carrying the itemType filter into it', async () => {
    const { router, local } = makeRouter({ localApi: true });
    await router.searchItems({ itemType: 'attachment', top: true, includeTrashed: true });
    const topRead = local.listItemKeys.mock.calls.find((c: any[]) => c[0].top);
    expect(topRead?.[0].itemType).toBeUndefined();
    // includeTrashed still has to reach it, or trashed top-level items drop out of the set.
    expect(topRead?.[0].includeTrashed).toBe(true);
  });

  it('carries includeTrashed into the keyed page read, on both APIs', async () => {
    // Both APIs leave a trashed item out of a keyed read that does not ask for the trash
    // (the cloud answered 1 of 2 keys for a trashed and a live one in the 2026-10-01 stress
    // test), so a trashed match the key sets counted would vanish from its own page.
    for (const localApi of [true, false]) {
      const { router, web, local } = makeRouter({ localApi });
      await router.searchItems({ itemType: 'attachment', top: true, includeTrashed: true, limit: 10 });
      const reads = localApi ? local.listItems.mock.calls : web.listItems.mock.calls;
      expect(reads.length).toBeGreaterThan(0);
      for (const call of reads) expect(queryOf(localApi ? 'local' : 'web', call).includeTrashed).toBe(true);
    }
  });

  it('pages coherently: every page disjoint, together the whole filtered set', async () => {
    const { router } = makeRouter({ localApi: true });
    const seen: string[] = [];
    let total = 0;
    for (let start = 0; ; start += 2) {
      const page = await router.searchItems({ itemType: EVERYTHING, top: true, limit: 2, start });
      total = page.totalResults;
      seen.push(...page.data.map((i: any) => i.key));
      if (start + 2 >= page.totalResults) break;
    }
    expect(total).toBe(3);
    expect(seen).toEqual(TOP_KEYS);
    expect(new Set(seen).size).toBe(3);
  });

  it('restores the key order the filter returned, not the order the API answered in', async () => {
    const { router } = makeRouter({ localApi: true });
    const res = await router.searchItems({ itemType: EVERYTHING, top: true, limit: 10 });
    expect(res.data.map((i: any) => i.key)).toEqual(TOP_KEYS);
  });

  it('splits the page into itemKey batches of 50, which is the cap both APIs impose', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `KEY${String(i).padStart(5, '0')}`);
    const { router, local } = makeRouter({ localApi: true });
    local.listItemKeys.mockImplementation(async () => ({
      keys: many,
      totalResults: many.length,
      lastModifiedVersion: 7,
    }));
    await router.searchItems({ itemType: 'attachment', top: true, limit: 60 });
    expect(local.listItems).toHaveBeenCalledTimes(2);
    expect(local.listItems.mock.calls[0][0].itemKey.split(',')).toHaveLength(50);
    expect(local.listItems.mock.calls[1][0].itemKey.split(',')).toHaveLength(10);
  });

  it('reads the page from /items/top, which is the only keyed read the desktop answers exactly', async () => {
    const { router, local } = makeRouter({ localApi: true });
    await router.searchItems({ itemType: 'attachment', top: true, limit: 10 });
    // Plain /items?itemKey= on the desktop answers with the named items AND every
    // descendant they have, which would put child attachments straight back in.
    expect(local.listItems.mock.calls[0][0].top).toBe(true);
  });

  it('leaves a top search with no itemType filter on the ordinary listing path', async () => {
    const { router, local } = makeRouter({ localApi: true });
    await router.searchItems({ top: true, limit: 10 });
    expect(local.listItemKeys).not.toHaveBeenCalled();
    expect(local.listItems).toHaveBeenCalledTimes(1);
    expect(local.listItems.mock.calls[0][0].top).toBe(true);
  });

  it('leaves an itemType search with no top filter on the ordinary listing path', async () => {
    const { router, local } = makeRouter({ localApi: true });
    await router.searchItems({ itemType: 'attachment', limit: 10 });
    expect(local.listItemKeys).not.toHaveBeenCalled();
    expect(local.listItems).toHaveBeenCalledTimes(1);
  });
});

/**
 * The whole stack against a stand-in for the desktop that answers the way Zotero 10 really
 * does: `/items/top` keeps the top-level restriction until an `itemType` filter turns up,
 * and then quietly drops it. Nothing here is mocked above the HTTP call, so the URLs the
 * real LocalApiClient builds are part of what is being asserted.
 */
describe('searchItems against a desktop that ignores /items/top when filtering by type', () => {
  function fakeDesktop() {
    return vi.fn(async (rawUrl: string) => {
      const url = new URL(rawUrl);
      const isTop = url.pathname.endsWith('/items/top');
      const itemType = url.searchParams.get('itemType');
      const itemKey = url.searchParams.get('itemKey');
      const keysOnly = url.searchParams.get('format') === 'keys';

      let keys: string[];
      if (itemKey) {
        keys = itemKey.split(',');
        // The desktop applies the top-level restriction to a keyed read correctly.
        if (isTop) keys = keys.filter((k) => TOP_KEYS.includes(k));
      } else if (itemType === 'attachment') {
        // The bug: `top` buys the caller nothing once itemType is in the query.
        keys = ATTACHMENT_KEYS;
      } else {
        keys = isTop ? TOP_KEYS : Object.keys(ITEMS);
      }

      const headers = { 'Total-Results': String(keys.length), 'Last-Modified-Version': '681' };
      if (keysOnly) return new Response(keys.join('\n'), { status: 200, headers });
      return new Response(JSON.stringify(keys.map((k) => ITEMS[k])), { status: 200, headers });
    });
  }

  function wired() {
    const fetchImpl = fakeDesktop();
    const local = new LocalApiClient({
      fetcher: new RateLimitedFetcher({ fetchImpl, maxConcurrency: 4 }),
    });
    const router = new LibraryRouter({
      config: loadConfig({ ZOTEUS_LOCAL: 'on' } as any),
      capabilities: { cloud: cloudInfo, localApi: true, localGroupIds: [] } as any,
      web: {} as any,
      local,
    });
    return { router, fetchImpl };
  }

  it('would have returned child attachments before the fix, and returns none now', async () => {
    const { router, fetchImpl } = wired();

    // What the desktop itself still says, and what #79 saw: three attachments, two of them
    // children, from the endpoint documented as top-level only.
    const raw = await new LocalApiClient({
      fetcher: new RateLimitedFetcher({ fetchImpl, maxConcurrency: 4 }),
    }).listItems({ itemType: 'attachment', top: true });
    expect(raw.data.filter((i: any) => i.data.parentItem)).toHaveLength(2);

    const res = await router.searchItems({ itemType: 'attachment', top: true, limit: 10 });
    expect(res.data.map((i: any) => i.key)).toEqual(['STANDALO']);
    expect(res.totalResults).toBe(1);
  });

  it('reports zero, not the count the filter itself gives, when nothing matching is top-level', async () => {
    const { router } = wired();
    const res = await router.searchItems({ itemType: 'attachment', top: true, limit: 10 });
    // Take the standalone attachment away and the honest answer is none at all.
    delete (ITEMS as any).STANDALO;
    const empty = await router.searchItems({ itemType: 'attachment', top: true, limit: 10 });
    ITEMS.STANDALO = { key: 'STANDALO', data: { key: 'STANDALO', itemType: 'attachment' } };
    expect(res.totalResults).toBe(1);
    expect(empty.data).toEqual([]);
  });
});

/**
 * `top` with a `tag` filter: the desktop runs the tag as a sub-search that ignores `top`,
 * so a tagged child note came back as a top-level item. Measured 2026-10-01 against Zotero
 * 10: `/items/top?tag=HILDA-reviewed` answered 34, 17 of them child notes, where the cloud
 * answered the 17 top-level items carrying the tag.
 */
describe('searchItems with top and a tag filter', () => {
  const TAGGED: Record<string, any> = {
    PAPERAAA: { key: 'PAPERAAA', data: { key: 'PAPERAAA', itemType: 'journalArticle', tags: [{ tag: 'reviewed' }] } },
    PAPERBBB: { key: 'PAPERBBB', data: { key: 'PAPERBBB', itemType: 'journalArticle', tags: [] } },
    NOTEBBBB: {
      key: 'NOTEBBBB',
      data: { key: 'NOTEBBBB', itemType: 'note', parentItem: 'PAPERBBB', tags: [{ tag: 'reviewed' }] },
    },
  };
  const TOP = ['PAPERAAA', 'PAPERBBB'];

  function fakeDesktop() {
    return vi.fn(async (rawUrl: string) => {
      const url = new URL(rawUrl);
      const isTop = url.pathname.endsWith('/items/top');
      const tag = url.searchParams.get('tag');
      const itemKey = url.searchParams.get('itemKey');
      let keys: string[];
      if (itemKey) keys = itemKey.split(',').filter((k) => !isTop || TOP.includes(k));
      // The bug: with a tag in the query, /items/top answers exactly what /items does.
      else if (tag) keys = Object.keys(TAGGED).filter((k) => TAGGED[k].data.tags.some((t: any) => t.tag === tag));
      else keys = isTop ? TOP : Object.keys(TAGGED);
      const headers = { 'Total-Results': String(keys.length), 'Last-Modified-Version': '681' };
      if (url.searchParams.get('format') === 'keys') return new Response(keys.join('\n'), { status: 200, headers });
      return new Response(JSON.stringify(keys.map((k) => TAGGED[k])), { status: 200, headers });
    });
  }

  it('returns no tagged child note as a top-level item, on the desktop', async () => {
    const fetchImpl = fakeDesktop();
    const local = new LocalApiClient({ fetcher: new RateLimitedFetcher({ fetchImpl, maxConcurrency: 4 }) });
    // What the desktop itself says: the child note is in its top-level answer.
    const raw = await local.listItems({ tag: 'reviewed', top: true });
    expect(raw.data.map((i: any) => i.key)).toContain('NOTEBBBB');

    const router = new LibraryRouter({
      config: loadConfig({ ZOTEUS_LOCAL: 'on' } as any),
      capabilities: { cloud: cloudInfo, localApi: true, localGroupIds: [] } as any,
      web: {} as any,
      local,
    });
    const res = await router.searchItems({ tag: 'reviewed', top: true, limit: 10 });
    expect(res.data.map((i: any) => i.key)).toEqual(['PAPERAAA']);
    expect(res.totalResults).toBe(1);
  });

  it('leaves the cloud, which answers this correctly, on its single listing request', async () => {
    const { router, web } = makeRouter({ localApi: false });
    await router.searchItems({ tag: 'reviewed', top: true, limit: 10 });
    expect(web.listItemKeys).not.toHaveBeenCalled();
    expect(web.listItems).toHaveBeenCalledTimes(1);
  });
});
