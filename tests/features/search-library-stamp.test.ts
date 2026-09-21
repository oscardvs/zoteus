import { describe, it, expect, vi } from 'vitest';
import indexTool from '../../src/tools/index-tool.js';
import semanticSearch from '../../src/tools/semantic-search.js';
import { PAGE_SIZE } from '../../src/features/search/build.js';
import { MemorySearchIndex } from '../../src/features/search/index-manager.js';
import { LibraryRouter } from '../../src/router/library-router.js';
import { loadConfig } from '../../src/config.js';

/**
 * The stamp has to name the library the crawl actually visited.
 *
 * `tests/features/search-library-guard.test.ts` proves the guard refuses a build for
 * another library, but every tool-path case there builds its config from ZOTEUS_LOCAL
 * alone, so the default library is always the personal one and the stamp is always right
 * by accident. On an install whose default library is a GROUP
 * (ZOTERO_LIBRARY_TYPE=group + ZOTERO_LIBRARY_ID), zotero_index used to resolve the
 * library with `optionalLibrary(args)`, which is undefined when the caller names none:
 * the router then followed the configured group while the stamp said "user". Both
 * consequences are reproduced below, the second of them a silent erase of the group's
 * rows by a correctly-formed tool call.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const cloudInfo = { userID: 19552201, username: 'oscardvs', access: {} };

function makeItems(n: number, prefix: string): any[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `${prefix}${i}`,
    data: { itemType: 'journalArticle', title: `${prefix} item ${i}`, abstractNote: `abstract body ${i}` },
  }));
}

/** One-page fetcher over a fixed item list, the shape buildIncremental crawls. */
function pageFetcher(items: any[], version = 42) {
  return async (start: number) => ({
    items: items.slice(start, start + PAGE_SIZE),
    totalResults: items.length,
    lastModifiedVersion: version,
  });
}

/**
 * A tool-path context whose CONFIGURED default library is whatever `env` says, over a real
 * LibraryRouter and a real config. ZOTEUS_LOCAL is off so every read goes to the cloud
 * double and the library it was addressed with can be asserted on directly.
 */
function makeCtx(env: Record<string, string> = {}, items = 5, prefix = 'G') {
  const library = makeItems(items, prefix);
  const web = {
    listItems: vi.fn(async (_lib: any, q: { limit?: number; start?: number }) => ({
      data: library.slice(q.start ?? 0, (q.start ?? 0) + (q.limit ?? PAGE_SIZE)),
      totalResults: library.length,
      lastModifiedVersion: 2114,
    })),
  };
  const config = loadConfig({ ZOTEUS_LOCAL: 'off', ...env } as any);
  const capabilities = { cloud: cloudInfo as any, localApi: false, localGroupIds: [] };
  const router = new LibraryRouter({ config, capabilities, web: web as any });
  const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
  // Empty path = no persistence: nothing here writes to a real data dir.
  const ctx: any = { config, capabilities, router, web, search, searchIndexPath: '', logger: silentLogger };
  return { ctx, web, search };
}

/** The build starters return immediately by contract; wait for the background job. */
async function settled(search: MemorySearchIndex) {
  for (let i = 0; i < 500 && search.buildStatus().state === 'building'; i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
  return search.buildStatus();
}

const GROUP_DEFAULT = { ZOTERO_LIBRARY_TYPE: 'group', ZOTERO_LIBRARY_ID: '4523' };

describe('zotero_index on an install whose default library is a group', () => {
  it('stamps the group it actually crawled, not the personal library', async () => {
    const { ctx, web, search } = makeCtx(GROUP_DEFAULT);

    const res = await indexTool.handler({ action: 'build' }, ctx);
    expect(res.isError).toBeUndefined();
    const s = await settled(search);

    // The crawl followed the configured group ...
    expect(web.listItems.mock.calls[0]![0]).toEqual({ type: 'group', id: 4523 });
    expect(s.items).toBe(5);
    // ... and so does the stamp. Before the fix this was 'user'.
    expect(s.library).toBe('group:4523');
  });

  it('still stamps the personal library when that is the configured default', async () => {
    const { ctx, web, search } = makeCtx({}, 3, 'U');
    await indexTool.handler({ action: 'build' }, ctx);
    const s = await settled(search);

    expect(web.listItems.mock.calls[0]![0]).toEqual({ type: 'user', id: cloudInfo.userID });
    expect(s.library).toBe('user');
  });

  it('does not refuse naming that same group afterwards', async () => {
    const { ctx, search } = makeCtx(GROUP_DEFAULT);
    await indexTool.handler({ action: 'build' }, ctx);
    await settled(search);

    // Consequence A of the mis-stamp: this was refused with "This index holds the personal
    // library; building for group 4523 would erase it", against the very library the index
    // actually held.
    const named = await indexTool.handler({ action: 'build', library_type: 'group', library_id: 4523 }, ctx);
    expect(named.isError).toBeUndefined();
    const s = await settled(search);
    expect(s.library).toBe('group:4523');
    expect(s.items).toBe(5);
  });

  it('refuses an explicit personal-library build, and the group rows survive', async () => {
    const { ctx, search } = makeCtx(GROUP_DEFAULT);
    await indexTool.handler({ action: 'build' }, ctx);
    await settled(search);

    // Consequence B: this passed the guard ('user' === the wrong stamp), reached
    // clearStore() and replaced the group's rows with the personal library's. The throw is
    // synchronous inside the handler; the registry turns it into an isError result for the
    // tool caller (src/registry/registry.ts catch around def.handler).
    await expect(
      indexTool.handler({ action: 'build', library_type: 'user', library_id: cloudInfo.userID }, ctx),
    ).rejects.toThrow(/group 4523[\s\S]*personal library/);

    const s = search.buildStatus();
    expect(s.items).toBe(5);
    expect(s.library).toBe('group:4523');
    const hits = await search.query('abstract body', { mode: 'keyword', limit: 50 });
    expect(hits.length).toBeGreaterThan(0);
    // Not one personal-library row got in: every hit is still the group's.
    expect(hits.every((h: any) => String(h.itemKey).startsWith('G'))).toBe(true);
  });

  it('refuses an explicit personal-library UPDATE for the same reason', async () => {
    const { ctx, search } = makeCtx(GROUP_DEFAULT);
    await indexTool.handler({ action: 'build' }, ctx);
    await settled(search);

    await expect(
      indexTool.handler({ action: 'update', library_type: 'user', library_id: cloudInfo.userID }, ctx),
    ).rejects.toThrow(/group 4523[\s\S]*personal library/);
    expect(search.buildStatus().items).toBe(5);
  });

  it('names the library on action:"status", in the payload and in the summary', async () => {
    const { ctx, search } = makeCtx(GROUP_DEFAULT);
    await indexTool.handler({ action: 'build' }, ctx);
    await settled(search);

    const status = await indexTool.handler({ action: 'status' }, ctx);
    // Until now the only way to learn which library the index holds was to trip a refusal.
    expect((status.structuredContent as any).library).toBe('group:4523');
    expect(status.content[0]!.text).toContain('This index holds group 4523');
  });
});

describe('zotero_semantic_search is library-aware', () => {
  async function groupIndexedCtx() {
    const { ctx, search } = makeCtx(GROUP_DEFAULT);
    await indexTool.handler({ action: 'build' }, ctx);
    await settled(search);
    return { ctx, search };
  }

  it('refuses a search for a library the index does not hold, naming both', async () => {
    const { ctx } = await groupIndexedCtx();

    const res = await semanticSearch.handler(
      { q: 'abstract body', library_type: 'user', library_id: cloudInfo.userID },
      ctx,
    );

    expect(res.isError).toBe(true);
    // Both libraries named: the one asked for, and the one actually held.
    expect(res.content[0]!.text).toContain('group 4523');
    expect(res.content[0]!.text).toContain('the personal library');
    // And the remedy, which is not "rebuild here": that would be refused by the guard.
    // It is now "give that library an index of its own", because a second library gets a
    // sibling index file in the same data directory (src/features/search/index-registry.ts)
    // rather than needing a second ZOTEUS_DATA_DIR.
    expect(res.content[0]!.text).toContain('an index of its own');
    expect(res.content[0]!.text).toContain('libraries:["user"]');
    expect((res.structuredContent as any).hits).toEqual([]);
    expect((res.structuredContent as any).library).toBe('group:4523');
  });

  it('answers, and says which library it answered from, when the named library is the one held', async () => {
    const { ctx } = await groupIndexedCtx();

    const res = await semanticSearch.handler({ q: 'abstract body', library_type: 'group', library_id: 4523 }, ctx);

    expect(res.isError).toBeUndefined();
    expect(((res.structuredContent as any).hits as any[]).length).toBeGreaterThan(0);
    expect((res.structuredContent as any).library).toBe('group:4523');
    expect(res.content[0]!.text).toContain('This index holds group 4523');
  });

  it('keeps answering a query that names no library, from whatever the index holds', async () => {
    // The documented remedy for a second library: a separate ZOTEUS_DATA_DIR whose index
    // was built for a group while the server's own default library is still the personal
    // one. Resolving an omitted library to that default and then refusing would break it,
    // so an omitted library is never refused; the summary says which library answered.
    const { ctx, search } = makeCtx({}, 4, 'G');
    await search.buildIncremental(pageFetcher(makeItems(4, 'G')), { library: 'group:4523' });

    const res = await semanticSearch.handler({ q: 'abstract body' }, ctx);

    expect(res.isError).toBeUndefined();
    expect(((res.structuredContent as any).hits as any[]).length).toBeGreaterThan(0);
    expect(res.content[0]!.text).toContain('This index holds group 4523');
  });

  it('auto-builds the configured group rather than stamping the personal library over it', async () => {
    const { ctx, web, search } = makeCtx(GROUP_DEFAULT);

    // First use on an empty index: the automatic build used to crawl the group and stamp
    // 'user', which set up exactly the erase above without the user ever calling zotero_index.
    const res = await semanticSearch.handler({ q: 'anything' }, ctx);
    expect(res.isError).toBe(true);
    expect((res.structuredContent as any).autoBuild).toBe(true);

    await settled(search);
    expect(web.listItems.mock.calls[0]![0]).toEqual({ type: 'group', id: 4523 });
    expect(search.buildStatus().library).toBe('group:4523');
  });
});

describe('migration: an index with no stamp must not start refusing', () => {
  /** A stamped index, saved and reloaded with the stamp stripped: a pre-stamp index file. */
  async function legacyCtx() {
    const { ctx, search } = makeCtx({}, 3, 'U');
    await search.buildIncremental(pageFetcher(makeItems(3, 'U')), { library: 'user' });
    const snapshot: any = JSON.parse(JSON.stringify(search.toJSON()));
    delete snapshot.library;
    const legacy = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    legacy.loadFromJSON(snapshot);
    expect(legacy.buildStatus().library).toBeUndefined();
    return { ctx: { ...ctx, search: legacy } as any, legacy };
  }

  it('answers a search that names any library, rather than refusing on absent provenance', async () => {
    const { ctx } = await legacyCtx();

    const res = await semanticSearch.handler({ q: 'abstract body', library_type: 'group', library_id: 4523 }, ctx);

    // Nothing is known about whose rows these are, so a refusal would be a guess and no
    // rebuild of this library could clear it.
    expect(res.isError).toBeUndefined();
    expect(((res.structuredContent as any).hits as any[]).length).toBeGreaterThan(0);
    expect((res.structuredContent as any).library).toBeUndefined();
    // And nothing is claimed about the library either, because nothing is known.
    expect(res.content[0]!.text).not.toContain('one index file holds one library');
  });

  it('lets a build run against it, and stamps it on the way through', async () => {
    const { ctx, legacy } = await legacyCtx();

    const res = await indexTool.handler({ action: 'build' }, ctx);
    expect(res.isError).toBeUndefined();
    await settled(legacy);
    expect(legacy.buildStatus().library).toBe('user');
  });

  it('explains itself when a group-default install meets an index an older build mis-stamped', async () => {
    // The index left on disk by the shipped bug: group rows under the "user" token. With
    // the stamp now resolved properly, a plain build refuses, and the generic refusal would
    // tell a user who has never indexed a personal library that this index holds one.
    const { ctx, search } = makeCtx(GROUP_DEFAULT);
    await search.buildIncremental(pageFetcher(makeItems(5, 'G')), { library: 'user' });

    const err = await indexTool.handler({ action: 'build' }, ctx).then(
      () => null,
      (e: Error) => e,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/would erase it/);
    expect(err!.message).toContain('older Zoteus versions stamped an index built on a group-default install');
    expect(err!.message).toContain("group 4523's");
    // Refused, never bypassed: an explicit personal-library build on this same install
    // produces a genuine personal index, and the two are indistinguishable once written.
    expect(search.buildStatus().items).toBe(5);
    expect(search.buildStatus().library).toBe('user');
  });

  it('adds that note only where it can be true, not to every cross-library refusal', async () => {
    // Personal-default install: an index holding a group, refusing a personal build. The
    // mis-stamp cannot explain this one, so nothing is claimed about it.
    const { ctx, search } = makeCtx({}, 5, 'G');
    await search.buildIncremental(pageFetcher(makeItems(5, 'G')), { library: 'group:4523' });

    const err = await indexTool
      .handler({ action: 'build', library_type: 'user', library_id: cloudInfo.userID }, ctx)
      .then(
        () => null,
        (e: Error) => e,
      );

    expect(err!.message).toMatch(/group 4523[\s\S]*personal library/);
    expect(err!.message).not.toContain('older Zoteus versions');
  });

  it('a resumed build that names no library keeps the stamp its rows were committed under', async () => {
    const index = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    const items = makeItems(120, 'G');
    // Interrupt a group build, so rows AND a checkpoint are left behind.
    await index.buildIncremental(async (start: number) => {
      if (start >= PAGE_SIZE) index.requestStop();
      return { items: items.slice(start, start + PAGE_SIZE), totalResults: items.length, lastModifiedVersion: 42 };
    }, { library: 'group:4523' });
    const indexed = index.buildStatus().items;
    expect(indexed).toBeGreaterThan(0);
    expect(indexed).toBeLessThan(items.length);

    // A resume keeps the rows, so it must keep the stamp with them. Writing `undefined`
    // over it left committed group rows unguarded: the next personal-library build would
    // have been accepted and erased them.
    await index.buildIncremental(pageFetcher(items), {});
    expect(index.buildStatus().library).toBe('group:4523');
    await expect(
      index.buildIncremental(pageFetcher(makeItems(2, 'U')), { library: 'user' }),
    ).rejects.toThrow(/group 4523[\s\S]*personal library/);
  });
});
