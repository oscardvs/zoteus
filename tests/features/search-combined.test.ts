import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import indexTool from '../../src/tools/index-tool.js';
import semanticSearch from '../../src/tools/semantic-search.js';
import { PAGE_SIZE } from '../../src/features/search/build.js';
import { createSearchIndex } from '../../src/features/search/factory.js';
import { SearchIndexRegistry, defaultIndexPath } from '../../src/features/search/index-registry.js';
import { LibraryRouter } from '../../src/router/library-router.js';
import { loadConfig } from '../../src/config.js';
import type { EmbeddingProvider } from '../../src/features/search/embeddings.js';
import type { SearchIndex } from '../../src/features/search/backend.js';

/**
 * Several libraries indexed side by side, and one search over more than one of them.
 *
 * The invariant underneath everything here: one store holds ONE library's rows, so a
 * combined answer fans out over N stores and merges what comes back BY RANK. Scores from
 * two indexes are not on one scale (BM25 is a function of each library's own document
 * frequencies, and the two may hold vectors from different models), so nothing in this
 * feature may present them as comparable.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const cloudInfo = { userID: 19552201, username: 'oscardvs', access: {} };

function makeItems(n: number, prefix: string, word: string): any[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `${prefix}${i}`,
    data: { itemType: 'journalArticle', title: `${prefix} ${word} ${i}`, abstractNote: `${word} in context ${i}` },
  }));
}

function pageFetcher(items: any[], version = 42) {
  return async (start: number) => ({
    items: items.slice(start, start + PAGE_SIZE),
    totalResults: items.length,
    lastModifiedVersion: version,
  });
}

async function fill(index: SearchIndex, items: any[], library: string): Promise<void> {
  await index.buildIncremental(pageFetcher(items), { library, maxItems: items.length });
  await index.save();
}

/** A provider with a stable identity and deterministic vectors: no model, no spend. */
function fakeEmbedder(model: string): EmbeddingProvider {
  return {
    name: 'openai',
    model,
    embed: async (texts: string[]) =>
      texts.map((t) => [t.length % 7, (t.length % 5) + 1, model.length]),
  };
}

/**
 * A tool-path context over a REAL registry in a temp data directory.
 *
 * The web double answers whatever library it is asked for, so a build routed to a group
 * crawls that group's items and a build routed to the personal library crawls the
 * personal ones. That is what makes "did the group's rows land in the group's file"
 * answerable rather than assumed.
 */
async function makeCtx(
  libraries: Record<string, any[]>,
  opts: { embedder?: EmbeddingProvider | null; env?: Record<string, string>; maxOpen?: number } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'zoteus-combined-'));
  const config = loadConfig({ ZOTEUS_LOCAL: 'off', ZOTEUS_DATA_DIR: dir, ...(opts.env ?? {}) } as any);
  const key = (lib: any): string => (lib?.type === 'group' ? `group:${lib.id}` : 'user');
  const web = {
    listItems: vi.fn(async (lib: any, q: { limit?: number; start?: number }) => {
      const items = libraries[key(lib)] ?? [];
      return {
        data: items.slice(q.start ?? 0, (q.start ?? 0) + (q.limit ?? PAGE_SIZE)),
        totalResults: items.length,
        lastModifiedVersion: 2114,
      };
    }),
  };
  const capabilities = { cloud: cloudInfo as any, localApi: false, localGroupIds: [] };
  const router = new LibraryRouter({ config, capabilities, web: web as any });
  const create = { embedder: opts.embedder ?? null, logger: silentLogger, backend: 'memory' as const };
  const searchIndexPath = defaultIndexPath(dir);
  const search = await createSearchIndex({ ...create, jsonPath: searchIndexPath });
  const indexes = new SearchIndexRegistry({
    create,
    primaryPath: searchIndexPath,
    primary: search,
    primaryLibrary: 'user',
    maxOpen: opts.maxOpen ?? 4,
    logger: silentLogger,
  });
  const ctx: any = { config, capabilities, router, web, search, indexes, searchIndexPath, logger: silentLogger };
  return { ctx, web, indexes, dir, search };
}

/** The build starters return immediately by contract; wait for the background job. */
async function settled(index: SearchIndex) {
  for (let i = 0; i < 500 && index.buildStatus().state === 'building'; i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
  return index.buildStatus();
}

describe('zotero_index routes to the named library\'s own index', () => {
  it('builds a group into its own store instead of refusing, and leaves the personal index alone', async () => {
    const { ctx, indexes, dir, search } = await makeCtx({
      user: makeItems(3, 'U', 'kalman'),
      'group:4523': makeItems(5, 'G', 'kalman'),
    });
    // The personal library first, so the group build meets a non-empty, stamped index.
    await indexTool.handler({ action: 'build' }, ctx);
    await settled(search);

    const res = await indexTool.handler({ action: 'build', library_type: 'group', library_id: 4523 }, ctx);
    expect(res.isError).toBeUndefined();
    const group = indexes.peek('group:4523')!;
    await settled(group);

    // Before this, the same call was refused: "this index holds the personal library".
    expect(search.buildStatus().items).toBe(3);
    expect(search.buildStatus().library).toBe('user');
    expect(group.buildStatus().items).toBe(5);
    expect(group.buildStatus().library).toBe('group:4523');
    expect(existsSync(join(dir, 'search-index-lib-group-4523.json'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports status for the named library, not for the default one', async () => {
    const { ctx, indexes, dir, search } = await makeCtx({
      user: makeItems(2, 'U', 'kalman'),
      'group:4523': makeItems(6, 'G', 'kalman'),
    });
    await indexTool.handler({ action: 'build' }, ctx);
    await settled(search);
    await indexTool.handler({ action: 'build', library_type: 'group', library_id: 4523 }, ctx);
    await settled(indexes.peek('group:4523')!);

    const mine = await indexTool.handler({ action: 'status' }, ctx);
    const theirs = await indexTool.handler({ action: 'status', library_type: 'group', library_id: 4523 }, ctx);

    expect((mine.structuredContent as any).items).toBe(2);
    expect((mine.structuredContent as any).library).toBe('user');
    expect((theirs.structuredContent as any).items).toBe(6);
    expect((theirs.structuredContent as any).library).toBe('group:4523');
    rmSync(dir, { recursive: true, force: true });
  });

  it('says a library has no index yet rather than creating an empty one to answer', async () => {
    const { ctx, dir } = await makeCtx({ user: makeItems(1, 'U', 'kalman') });

    const res = await indexTool.handler({ action: 'status', library_type: 'group', library_id: 999 }, ctx);

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('No search index exists for group 999');
    expect(res.content[0]!.text).toContain('action:"build"');
    // A read-only question must not leave a file behind.
    expect(existsSync(join(dir, 'search-index-lib-group-999.json'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists every library that has an index, with its counts and its stamp', async () => {
    const { ctx, indexes, dir, search } = await makeCtx({
      user: makeItems(2, 'U', 'kalman'),
      'group:4523': makeItems(4, 'G', 'kalman'),
    });
    await indexTool.handler({ action: 'build' }, ctx);
    await settled(search);
    await indexTool.handler({ action: 'build', library_type: 'group', library_id: 4523 }, ctx);
    await settled(indexes.peek('group:4523')!);

    const res = await indexTool.handler({ action: 'libraries' }, ctx);

    expect(res.isError).toBeUndefined();
    const rows = (res.structuredContent as any).libraries;
    expect(rows.map((r: any) => r.library)).toEqual(['user', 'group:4523']);
    expect(rows[0]).toMatchObject({ primary: true, stamp: 'user', items: 2 });
    expect(rows[1]).toMatchObject({ primary: false, stamp: 'group:4523', items: 4, label: 'group 4523' });
    expect(res.content[0]!.text).toContain('2 libraries have a search index');
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports the single index it has when the context carries no registry at all', async () => {
    // Every hand-built context (and the deferred-startup fake) supplies `search` alone.
    // The answer there is one index, not a refusal.
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-combined-'));
    const path = defaultIndexPath(dir);
    const search = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'memory', jsonPath: path });
    await fill(search, makeItems(2, 'U', 'kalman'), 'user');
    const ctx: any = { config: loadConfig({ ZOTEUS_DATA_DIR: dir } as any), search, searchIndexPath: path, logger: silentLogger };

    const res = await indexTool.handler({ action: 'libraries' }, ctx);

    expect(res.isError).toBeUndefined();
    const rows = (res.structuredContent as any).libraries;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ library: 'user', primary: true, stamp: 'user', items: 2, path });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('zotero_semantic_search across several libraries', () => {
  async function twoIndexedLibraries(embedder?: EmbeddingProvider | null) {
    const ctxBits = await makeCtx(
      {
        user: makeItems(3, 'U', 'kalman'),
        'group:4523': makeItems(3, 'G', 'kalman'),
      },
      { embedder },
    );
    await indexTool.handler({ action: 'build' }, ctxBits.ctx);
    await settled(ctxBits.search);
    await indexTool.handler({ action: 'build', library_type: 'group', library_id: 4523 }, ctxBits.ctx);
    await settled(ctxBits.indexes.peek('group:4523')!);
    return ctxBits;
  }

  it('labels every hit with the library it came from, and merges by rank not by score', async () => {
    const { ctx, dir } = await twoIndexedLibraries();

    const res = await semanticSearch.handler({ q: 'kalman', libraries: ['user', 'group:4523'], limit: 4 }, ctx);

    expect(res.isError).toBeUndefined();
    const out = res.structuredContent as any;
    const hits = out.hits as Array<{ itemKey: string; library: string; libraryRank: number }>;
    expect(hits.length).toBe(4);
    // Every hit says whose rows it is. Without this two items with the same itemKey in two
    // libraries would be indistinguishable.
    expect(hits.every((h) => h.library === 'user' || h.library === 'group:4523')).toBe(true);
    for (const h of hits) {
      expect(h.library).toBe(h.itemKey.startsWith('U') ? 'user' : 'group:4523');
    }
    // Interleaved by rank: rank 1 from each library, then rank 2 from each.
    expect(hits.map((h) => h.libraryRank)).toEqual([1, 1, 2, 2]);
    expect(out.merge).toBe('rank');
    expect(out.libraries.map((l: any) => l.library)).toEqual(['user', 'group:4523']);
    expect(out.libraries.every((l: any) => l.hits > 0)).toBe(true);
    // The summary must say what it did, and must not claim the scores are comparable.
    expect(res.content[0]!.text).toContain('MERGED BY RANK, not by score');
    expect(res.content[0]!.text).toContain('only comparable with others from the SAME library');
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports per-library counts that are the merged rows, and says what was left out', async () => {
    // Every index is queried with the FULL limit, so N libraries can return N*limit rows
    // behind a limit-row answer. Reporting those lengths as `hits` made the per-library
    // numbers sum above the total printed in the same sentence: "Top 4 match(es) ... (the
    // personal library: 3, group 4523: 3)".
    const { ctx, dir } = await twoIndexedLibraries();

    const res = await semanticSearch.handler({ q: 'kalman', libraries: ['user', 'group:4523'], limit: 4 }, ctx);

    const out = res.structuredContent as any;
    const rows = out.libraries as Array<{ library: string; hits: number; matched?: number }>;
    expect(out.hits).toHaveLength(4);
    expect(rows.reduce((n, l) => n + l.hits, 0)).toBe(out.hits.length);
    for (const l of rows) {
      expect(l.hits).toBe((out.hits as any[]).filter((h) => h.library === l.library).length);
      // The pre-merge number is kept, under a name that says what it is.
      expect(l.matched).toBe(3);
    }
    // And the summary prints the contribution, not the index's own answer size.
    expect(res.content[0]!.text).toContain('Top 4 match(es)');
    expect(res.content[0]!.text).toContain('the personal library: 2 of 3');
    expect(res.content[0]!.text).toContain('group 4523: 2 of 3');
    rmSync(dir, { recursive: true, force: true });
  });

  it('searches every indexed library with libraries:"all"', async () => {
    const { ctx, dir } = await twoIndexedLibraries();

    const res = await semanticSearch.handler({ q: 'kalman', libraries: 'all', limit: 6 }, ctx);

    const out = res.structuredContent as any;
    expect(out.libraries.map((l: any) => l.library).sort()).toEqual(['group:4523', 'user']);
    expect(new Set((out.hits as any[]).map((h) => h.library))).toEqual(new Set(['user', 'group:4523']));
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a named library with no index instead of building one behind the question', async () => {
    const { ctx, dir } = await twoIndexedLibraries();

    const res = await semanticSearch.handler({ q: 'kalman', libraries: ['user', 'group:999'] }, ctx);

    expect(res.isError).toBeUndefined();
    const out = res.structuredContent as any;
    const missing = out.libraries.find((l: any) => l.library === 'group:999');
    expect(missing).toMatchObject({ indexed: false, hits: 0 });
    expect(missing.note).toContain('zotero_index action:"build" library_type:"group" library_id:999');
    expect(res.content[0]!.text).toContain('Not searched: group 999');
    // Nothing was built and nothing was written.
    expect(existsSync(join(dir, 'search-index-lib-group-999.json'))).toBe(false);
    expect((out.hits as any[]).every((h) => h.library === 'user')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses when every named library is unsearchable, rather than answering empty', async () => {
    const { ctx, dir } = await makeCtx({ user: [] });

    const res = await semanticSearch.handler({ q: 'kalman', libraries: ['group:1', 'group:2'] }, ctx);

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('Nothing was searched');
    expect((res.structuredContent as any).libraries).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('says so when two indexes hold vectors from different embedding models', async () => {
    // Reachable exactly as written: each index was built by a different model, and the
    // server now runs with embeddings off, so nothing reconciles the stored provenance
    // away. The point is that the mismatch is REPORTED rather than silently fused.
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-combined-'));
    const primaryPath = defaultIndexPath(dir);
    const groupPath = join(dir, 'search-index-lib-group-4523.json');
    const a = await createSearchIndex({ embedder: fakeEmbedder('model-a'), logger: silentLogger, backend: 'memory', jsonPath: primaryPath });
    await fill(a, makeItems(3, 'U', 'kalman'), 'user');
    await a.close();
    const b = await createSearchIndex({ embedder: fakeEmbedder('model-b'), logger: silentLogger, backend: 'memory', jsonPath: groupPath });
    await fill(b, makeItems(3, 'G', 'kalman'), 'group:4523');
    await b.close();

    const create = { embedder: null, logger: silentLogger, backend: 'memory' as const };
    const search = await createSearchIndex({ ...create, jsonPath: primaryPath });
    const indexes = new SearchIndexRegistry({
      create,
      primaryPath,
      primary: search,
      primaryLibrary: 'user',
      maxOpen: 4,
      logger: silentLogger,
    });
    const config = loadConfig({ ZOTEUS_LOCAL: 'off', ZOTEUS_DATA_DIR: dir, ZOTEUS_EMBEDDINGS: 'off' } as any);
    const ctx: any = { config, search, indexes, searchIndexPath: primaryPath, logger: silentLogger };

    const res = await semanticSearch.handler({ q: 'kalman', libraries: 'all', limit: 4 }, ctx);

    const out = res.structuredContent as any;
    expect(out.embedderMismatch).toBeDefined();
    expect(out.embedderMismatch).toContain('DIFFERENT embedding models');
    expect(out.embedderMismatch).toContain('model-a');
    expect(out.embedderMismatch).toContain('model-b');
    expect(res.content[0]!.text).toContain('DIFFERENT embedding models');
    // And it must still say the merge was by rank, not that it reconciled anything.
    expect(res.content[0]!.text).toContain('MERGED BY RANK');
    expect(out.merge).toBe('rank');
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses mode:"semantic" once, naming the cause, instead of letting every index answer empty', async () => {
    // Without a provider nothing can embed the QUERY, so a vector-only ranking returns the
    // empty list from every index, which reads exactly like "your libraries hold nothing
    // on this".
    const { ctx, dir } = await twoIndexedLibraries(null);

    const res = await semanticSearch.handler({ q: 'kalman', libraries: 'all', mode: 'semantic' }, ctx);

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('mode:"semantic" cannot run');
    expect(res.content[0]!.text).toContain('mode:"keyword"');
    expect((res.structuredContent as any).hits).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips a library that holds no vectors under mode:"semantic" and says which', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-combined-'));
    const primaryPath = defaultIndexPath(dir);
    const groupPath = join(dir, 'search-index-lib-group-4523.json');
    const embedder = fakeEmbedder('model-a');
    const a = await createSearchIndex({ embedder, logger: silentLogger, backend: 'memory', jsonPath: primaryPath });
    await fill(a, makeItems(3, 'U', 'kalman'), 'user');
    await a.close();
    // The group's index was built with embeddings off, so it holds passages and no vectors.
    const b = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'memory', jsonPath: groupPath });
    await fill(b, makeItems(3, 'G', 'kalman'), 'group:4523');
    await b.close();

    const create = { embedder, logger: silentLogger, backend: 'memory' as const };
    const search = await createSearchIndex({ ...create, jsonPath: primaryPath });
    const indexes = new SearchIndexRegistry({
      create,
      primaryPath,
      primary: search,
      primaryLibrary: 'user',
      maxOpen: 4,
      logger: silentLogger,
    });
    const ctx: any = { config: loadConfig({ ZOTEUS_DATA_DIR: dir } as any), search, indexes, searchIndexPath: primaryPath, logger: silentLogger };

    const res = await semanticSearch.handler({ q: 'kalman', libraries: 'all', mode: 'semantic' }, ctx);

    const out = res.structuredContent as any;
    const group = out.libraries.find((l: any) => l.library === 'group:4523');
    expect(group.hits).toBe(0);
    expect(group.note).toContain('holds no vectors');
    expect((out.hits as any[]).every((h) => h.library === 'user')).toBe(true);
    expect(res.content[0]!.text).toContain('Not searched: group 4523');
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses `libraries` together with library_type/library_id rather than guessing', async () => {
    const { ctx, dir } = await twoIndexedLibraries();

    const res = await semanticSearch.handler(
      { q: 'kalman', libraries: 'all', library_type: 'group', library_id: 4523 },
      ctx,
    );

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('not both');
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses an entry that is not a library, naming the spellings it takes', async () => {
    const { ctx, dir } = await twoIndexedLibraries();

    const res = await semanticSearch.handler({ q: 'kalman', libraries: ['user', 'my-group'] }, ctx);

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('"my-group"');
    expect(res.content[0]!.text).toContain('group:<id>');
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a bare number as a group id, the way library_id does, and de-duplicates', async () => {
    const { ctx, dir } = await twoIndexedLibraries();

    const res = await semanticSearch.handler({ q: 'kalman', libraries: ['4523', 'group:4523', 'group-4523'] }, ctx);

    const out = res.structuredContent as any;
    // Three spellings of one library are one library, not three copies of its rows.
    expect(out.libraries.map((l: any) => l.library)).toEqual(['group:4523']);
    expect((out.hits as any[]).every((h) => h.library === 'group:4523')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers from the named library\'s OWN index when it has one', async () => {
    const { ctx, dir } = await twoIndexedLibraries();

    const res = await semanticSearch.handler({ q: 'kalman', library_type: 'group', library_id: 4523, limit: 5 }, ctx);

    expect(res.isError).toBeUndefined();
    const out = res.structuredContent as any;
    // Not the default library's rows, and not a refusal: the group has a store of its own.
    expect(out.library).toBe('group:4523');
    expect((out.hits as any[]).length).toBeGreaterThan(0);
    expect((out.hits as any[]).every((h) => h.itemKey.startsWith('G'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('builds a named library into its OWN index rather than stamping the default file', async () => {
    // The bug this closes: with the default index empty, an auto_build for an explicitly
    // named group used to crawl the group and write its rows (and its stamp) into the
    // personal library's file.
    const { ctx, indexes, dir, search } = await makeCtx({
      user: makeItems(2, 'U', 'kalman'),
      'group:4523': makeItems(4, 'G', 'kalman'),
    });

    const res = await semanticSearch.handler({ q: 'kalman', library_type: 'group', library_id: 4523 }, ctx);

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('background build was started');
    const group = indexes.peek('group:4523')!;
    await settled(group);

    expect(group.buildStatus().library).toBe('group:4523');
    expect(group.buildStatus().items).toBe(4);
    // The default library's index is untouched: still empty, still unstamped.
    expect(search.isEmpty).toBe(true);
    expect(search.buildStatus().library).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses, naming both libraries, when the named one has no index and auto_build is off', async () => {
    const { ctx, indexes, dir } = await twoIndexedLibraries();

    const res = await semanticSearch.handler(
      { q: 'kalman', library_type: 'group', library_id: 999, auto_build: false },
      ctx,
    );

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('This index holds the personal library, not group 999');
    expect(res.content[0]!.text).toContain('an index of its own');
    expect((res.structuredContent as any).requestedLibrary).toBe('group:999');
    // auto_build:false means nothing was created for it either.
    expect(await indexes.exists('group:999')).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves a plain single-library search exactly as it was', async () => {
    const { ctx, dir } = await twoIndexedLibraries();

    const res = await semanticSearch.handler({ q: 'kalman', limit: 3 }, ctx);

    const out = res.structuredContent as any;
    expect(out.library).toBe('user');
    expect(out.merge).toBeUndefined();
    expect(out.libraries).toBeUndefined();
    expect((out.hits as any[]).every((h) => h.library === undefined)).toBe(true);
    expect((out.hits as any[]).every((h) => h.itemKey.startsWith('U'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});


describe('cached index read boundaries', () => {
  it('refuses cached group results and status after key permissions narrow', async () => {
    const { ctx, indexes, dir } = await makeCtx({});
    try {
      await fill(await indexes.open('group:777'), makeItems(2, 'PRIVATE', 'kalman'), 'group:777');
      ctx.capabilities.cloud = { userID: 19552201, access: { user: { library: true }, groups: {} } };
      const result = await semanticSearch.handler({ q: 'kalman', library_type: 'group', library_id: 777, auto_build: false }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('cannot read group 777');
      const status = await indexTool.handler({ action: 'status', library_type: 'group', library_id: 777 }, ctx);
      expect(status.isError).toBe(true);
      // Listed, not hidden: the action promises every index in this data directory, and the
      // one this key can no longer read is the one a user cannot otherwise learn about. It
      // carries the reason, and none of its rows.
      const listing = await indexTool.handler({ action: 'libraries' }, ctx);
      const rows = (listing.structuredContent as any).libraries as any[];
      expect(rows.map((row) => row.library)).toEqual(['user', 'group:777']);
      expect(rows.find((row) => row.library === 'group:777').unreachable).toContain('cannot read group 777');
      expect(rows.find((row) => row.library === 'user').unreachable).toBeUndefined();
      expect(listing.content[0]!.text).toContain('NOT READABLE WITH THIS KEY');
      expect(JSON.stringify(listing)).not.toContain('PRIVATE');
      const combined = await semanticSearch.handler({ q: 'kalman', libraries: 'all' }, ctx);
      expect(combined.isError).toBe(true);
      expect((combined.structuredContent as any).hits).toEqual([]);
      expect(JSON.stringify(combined)).not.toContain('PRIVATE');
    } finally { await indexes.closeAll(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses the cached personal library when the key explicitly denies it', async () => {
    const { ctx, search, indexes, dir } = await makeCtx({});
    try {
      await fill(search, makeItems(2, 'PRIVATE', 'kalman'), 'user');
      ctx.capabilities.cloud = { userID: 19552201, access: { user: { library: false }, groups: { all: { library: true } } } };
      const result = await semanticSearch.handler({ q: 'kalman' }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('cannot read the personal library');
    } finally { await indexes.closeAll(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('never relabels an index stamped for another library in a combined answer', async () => {
    const { ctx, search, indexes, dir } = await makeCtx({});
    try {
      await fill(search, makeItems(1, 'PUBLIC', 'kalman'), 'user');
      await fill(await indexes.open('group:777'), makeItems(2, 'WRONG', 'kalman'), 'group:888');
      const result = await semanticSearch.handler({ q: 'kalman', libraries: ['user', 'group:777'] }, ctx);
      expect(result.isError).toBeUndefined();
      expect((result.structuredContent as any).hits).toHaveLength(1);
      expect((result.structuredContent as any).libraries[1].note).toContain('stamped group 888');
      expect(JSON.stringify(result)).not.toContain('WRONG');
    } finally { await indexes.closeAll(); rmSync(dir, { recursive: true, force: true }); }
  });
});


it.each([false, true])('keeps an active query open while another library opens (combined: %s)', async (combined) => {
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const embedding = new Promise<void>((resolve) => { started = resolve; });
  const embedder: EmbeddingProvider = {
    name: 'openai', model: 'test-lease',
    async embed(texts, kind) {
      if (kind === 'query') { started(); await blocked; }
      return texts.map(() => [1, 2, 3]);
    },
  };
  const { ctx, indexes, dir } = await makeCtx({}, { embedder, maxOpen: 2 });
  try {
    const first = await indexes.open('group:1');
    await fill(first, makeItems(2, 'G', 'kalman'), 'group:1');
    const closed = vi.spyOn(first, 'close');
    const search = semanticSearch.handler({ q: 'kalman', mode: 'semantic', ...(combined
      ? { libraries: ['group:1'] } : { library_type: 'group', library_id: 1 }) }, ctx);
    await embedding;
    await indexes.open('group:2');
    expect(closed).not.toHaveBeenCalled();
    await expect(indexes.reopen('group:1')).rejects.toThrow('while a search is running');
    release();
    const result = await search;
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as any).hits).toHaveLength(2);
    await indexes.open('group:3');
    expect(closed).toHaveBeenCalledOnce();
  } finally { release(); await indexes.closeAll(); rmSync(dir, { recursive: true, force: true }); }
});


it.each(['auto', 'semantic'])('reports combined query-time embedding failure in %s mode', async (mode) => {
  const embedder: EmbeddingProvider = {
    name: 'ollama', model: 'test-failure',
    async embed(texts, kind) {
      if (kind === 'query') throw new Error('test daemon unavailable');
      return texts.map(() => [1, 2, 3]);
    },
  };
  const { ctx, indexes, dir } = await makeCtx({}, { embedder });
  try {
    await fill(await indexes.open('group:1'), makeItems(1, 'G', 'kalman'), 'group:1');
    const result = await semanticSearch.handler({ q: 'kalman', libraries: ['group:1'], mode }, ctx);
    expect(result.content[0]!.text).toContain('test daemon unavailable');
    if (mode === 'semantic') {
      expect(result.isError).toBe(true);
      expect((result.structuredContent as any).hits).toEqual([]);
    } else {
      expect(result.isError).toBeUndefined();
      expect((result.structuredContent as any).hits).toHaveLength(1);
      expect((result.structuredContent as any).embedderActive).toBe(false);
    }
  } finally { await indexes.closeAll(); rmSync(dir, { recursive: true, force: true }); }
});


it('normalizes numeric library aliases before deduplicating combined search', async () => {
  const { ctx, indexes, dir } = await makeCtx({});
  try {
    await fill(await indexes.open('group:7'), makeItems(1, 'G', 'kalman'), 'group:7');
    const result = await semanticSearch.handler({ q: 'kalman', libraries: ['group:007', '7'] }, ctx);
    expect(result.isError).toBeUndefined();
    expect((result.structuredContent as any).libraries).toHaveLength(1);
    expect((result.structuredContent as any).hits[0].library).toBe('group:7');
    const invalid = await semanticSearch.handler({ q: 'kalman', libraries: ['group:0'] }, ctx);
    expect(invalid.isError).toBe(true);
  } finally { await indexes.closeAll(); rmSync(dir, { recursive: true, force: true }); }
});


it('refuses to alias another user library into the personal search index', async () => {
  const { ctx, indexes, dir } = await makeCtx({});
  try {
    const build = await indexTool.handler({ action: 'build', library_type: 'user', library_id: 999 }, ctx);
    expect(build.isError).toBe(true);
    expect(build.content[0]!.text).toContain('cannot index or search user 999');
    const search = await semanticSearch.handler({ q: 'kalman', library_type: 'user', library_id: 999 }, ctx);
    expect(search.isError).toBe(true);
    expect(ctx.web.listItems).not.toHaveBeenCalled();
  } finally { await indexes.closeAll(); rmSync(dir, { recursive: true, force: true }); }
});
