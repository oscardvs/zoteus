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
import { buildContext } from '../../src/server.js';
import type { SearchIndex } from '../../src/features/search/backend.js';

/**
 * When the primary index's own stamp disagrees with the configured default library.
 *
 * `buildContext` keys the primary index by the STAMP (server.ts), while every tool
 * resolves an omitted library to the CONFIGURED default. Where the two disagree those are
 * two different files, and before this the two sides never met: `zotero_index` built and
 * reported the default library's sibling while every plain `zotero_semantic_search`
 * answered from the primary, indefinitely, with nothing anywhere saying so.
 *
 * The population that matters is not a contrived config change. Every group-default
 * install indexed by a Zoteus older than the stamp holds its GROUP's rows under the
 * personal library's token, so on upgrade stamp 'user' != configured 'group:<id>' for all
 * of them. Their case is tested explicitly below.
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

/**
 * A tool-path context over a REAL registry whose primary index is already filled and
 * stamped `stamped`, exactly as `buildContext` would hand it over after a restart.
 */
async function makeCtx(opts: {
  env?: Record<string, string>;
  libraries: Record<string, any[]>;
  /** What the primary file already holds, and the token it is stamped with. */
  primary?: { rows: any[]; stamped: string };
}) {
  const dir = mkdtempSync(join(tmpdir(), 'zoteus-split-'));
  const config = loadConfig({ ZOTEUS_LOCAL: 'off', ZOTEUS_DATA_DIR: dir, ...(opts.env ?? {}) } as any);
  const key = (lib: any): string => (lib?.type === 'group' ? `group:${lib.id}` : 'user');
  const web = {
    listItems: vi.fn(async (lib: any, q: { limit?: number; start?: number }) => {
      const items = opts.libraries[key(lib)] ?? [];
      return {
        data: items.slice(q.start ?? 0, (q.start ?? 0) + (q.limit ?? PAGE_SIZE)),
        totalResults: items.length,
        lastModifiedVersion: 2114,
      };
    }),
  };
  const capabilities = { cloud: cloudInfo as any, localApi: false, localGroupIds: [] };
  const router = new LibraryRouter({ config, capabilities, web: web as any });
  const create = { embedder: null, logger: silentLogger, backend: 'memory' as const };
  const searchIndexPath = defaultIndexPath(dir);
  const search = await createSearchIndex({ ...create, jsonPath: searchIndexPath });
  if (opts.primary) {
    await search.buildIncremental(pageFetcher(opts.primary.rows), {
      library: opts.primary.stamped,
      maxItems: opts.primary.rows.length,
    });
    await search.save();
  }
  // Exactly server.ts:190: the store's OWN stamp wins over the configured default.
  const primaryLibrary = search.buildStatus().library ?? 'user';
  const indexes = new SearchIndexRegistry({
    create,
    primaryPath: searchIndexPath,
    primary: search,
    primaryLibrary,
    maxOpen: 4,
    logger: silentLogger,
  });
  const ctx: any = { config, capabilities, router, web, search, indexes, searchIndexPath, logger: silentLogger };
  return { ctx, web, indexes, dir, search, primaryLibrary };
}

async function settled(index: SearchIndex) {
  for (let i = 0; i < 500 && index.buildStatus().state === 'building'; i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
  return index.buildStatus();
}

const GROUP_DEFAULT = { ZOTERO_LIBRARY_TYPE: 'group', ZOTERO_LIBRARY_ID: '4523' };

describe('startup', () => {
  it('warns when the index it opened is stamped a library other than the configured default', async () => {
    // The only place this state is visible before a tool call: the operator has one index
    // holding somebody's rows and a default library that will be given another.
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-split-'));
    const path = defaultIndexPath(dir);
    const seed = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'memory', jsonPath: path });
    await seed.buildIncremental(pageFetcher(makeItems(3, 'G', 'kalman')), { library: 'user', maxItems: 3 });
    await seed.save();
    await seed.close();
    const warn = vi.fn();
    const logger = { ...silentLogger, warn };

    const ctx = await buildContext(
      loadConfig({
        ZOTEUS_LOCAL: 'off',
        ZOTEUS_DATA_DIR: dir,
        ZOTEUS_EMBEDDINGS: 'off',
        ZOTEUS_INDEX_BACKEND: 'memory',
        ZOTEUS_UPDATE_CHECK: 'false',
        ...GROUP_DEFAULT,
      } as any),
      { telemetry: { logger: logger as any } },
    );

    const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toContain('stamped the personal library');
    expect(said).toContain('default library is group 4523');
    expect(said).toContain(path);
    expect(said).toContain('delete it and run zotero_index action:"build" again');
    await ctx.indexes!.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  it('says nothing when the stamp and the configured default agree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-split-'));
    const path = defaultIndexPath(dir);
    const seed = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'memory', jsonPath: path });
    await seed.buildIncremental(pageFetcher(makeItems(3, 'G', 'kalman')), { library: 'group:4523', maxItems: 3 });
    await seed.save();
    await seed.close();
    const warn = vi.fn();

    const ctx = await buildContext(
      loadConfig({
        ZOTEUS_LOCAL: 'off',
        ZOTEUS_DATA_DIR: dir,
        ZOTEUS_EMBEDDINGS: 'off',
        ZOTEUS_INDEX_BACKEND: 'memory',
        ZOTEUS_UPDATE_CHECK: 'false',
        ...GROUP_DEFAULT,
      } as any),
      { telemetry: { logger: { ...silentLogger, warn } as any } },
    );

    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('stamped');
    await ctx.indexes!.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('a primary index stamped for a library other than the configured default', () => {
  it('answers a plain search from the file a plain build wrote, not from the primary', async () => {
    // A genuine personal index in a data directory whose server is now configured for a
    // group: the group gets an index of its own once the caller names it (a plain build is
    // refused here, because this file is indistinguishable from a mis-stamped group index),
    // which is the feature working. What must not happen is the build filling one file
    // while every plain search reads another.
    const { ctx, indexes, dir, search } = await makeCtx({
      env: GROUP_DEFAULT,
      libraries: { user: makeItems(3, 'U', 'kalman'), 'group:4523': makeItems(4, 'G', 'kalman') },
      primary: { rows: makeItems(3, 'U', 'kalman'), stamped: 'user' },
    });
    expect(indexes.primaryLibrary).toBe('user');

    await indexTool.handler({ action: 'build', library_type: 'group', library_id: 4523 }, ctx);
    const group = indexes.peek('group:4523')!;
    await settled(group);

    const res = await semanticSearch.handler({ q: 'kalman' }, ctx);

    const out = res.structuredContent as any;
    // The default library's rows, from the default library's file. Before this the same
    // call answered from the primary: library 'user', item keys U0..U2.
    expect(out.library).toBe('group:4523');
    expect((out.hits as any[]).every((h) => h.itemKey.startsWith('G'))).toBe(true);
    expect(search.buildStatus().items).toBe(3);
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps answering from the primary while the default library has no index of its own', async () => {
    // The documented case: a data directory whose index was built for a group while the
    // server's default library is still the personal one. `openIfExists` never creates a
    // store, so the fallback is exactly what it always was.
    const { ctx, dir } = await makeCtx({
      libraries: { user: makeItems(2, 'U', 'kalman'), 'group:4523': makeItems(4, 'G', 'kalman') },
      primary: { rows: makeItems(4, 'G', 'kalman'), stamped: 'group:4523' },
    });

    const res = await semanticSearch.handler({ q: 'kalman', auto_build: false }, ctx);

    const out = res.structuredContent as any;
    expect(res.isError).toBeUndefined();
    expect(out.library).toBe('group:4523');
    expect((out.hits as any[]).every((h) => h.itemKey.startsWith('G'))).toBe(true);
    // And a search must never leave an index file behind for the library it looked for.
    expect(existsSync(join(dir, 'search-index-lib-user.json'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('a group-default install upgrading from a Zoteus that mis-stamped its index', () => {
  /** The pre-upgrade state: the GROUP's rows in the primary file, stamped 'user'. */
  async function misstamped() {
    return makeCtx({
      env: GROUP_DEFAULT,
      libraries: { user: makeItems(2, 'U', 'kalman'), 'group:4523': makeItems(4, 'G', 'kalman') },
      primary: { rows: makeItems(4, 'G', 'kalman'), stamped: 'user' },
    });
  }

  it('says which file holds what instead of a flat "no search index exists"', async () => {
    const { ctx, dir } = await misstamped();

    const res = await indexTool.handler({ action: 'status' }, ctx);

    expect(res.isError).toBe(true);
    const text = res.content[0]!.text as string;
    // Still true and still actionable ...
    expect(text).toContain('No search index exists for group 4523');
    // ... but no longer the whole story: this data directory does hold an index, stamped
    // the personal library, and it may be this very group's rows.
    expect(text).toContain('original index');
    expect(text).toContain(ctx.searchIndexPath);
    expect(text).toContain('older than the library stamp');
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not call the mis-stamped file "the default library" in action:"libraries"', async () => {
    const { ctx, dir } = await misstamped();

    const res = await indexTool.handler({ action: 'libraries' }, ctx);

    const text = res.content[0]!.text as string;
    expect(text).toContain('the personal library');
    expect(text).not.toContain('the personal library (the default library)');
    expect(text).toContain('the default library here is group 4523');
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(['build', 'update', 'refresh'])(
    'refuses a plain action:"%s" rather than start a second crawl the caller did not choose',
    async (action) => {
      const { ctx, indexes, dir } = await misstamped();

      const res = await indexTool.handler({ action }, ctx);

      expect(res.isError).toBe(true);
      const text = res.content[0]!.text as string;
      expect(text).toContain('Not started');
      // Both ways out, named: restamp the original, or name the group to build beside it.
      expect(text).toContain(ctx.searchIndexPath);
      expect(text).toContain('delete it and run action:"build" again');
      expect(text).toContain('library_type:"group" library_id:4523');
      // And nothing was created: an empty sibling left behind here is what would turn the
      // next plain search into the very crawl this refusal exists to prevent.
      expect(indexes.peek('group:4523')).toBeUndefined();
      expect(existsSync(join(dir, 'search-index-lib-group-4523.json'))).toBe(false);
      rmSync(dir, { recursive: true, force: true });
    },
  );

  it('keeps answering a plain search from the original index while the sibling is unbuilt', async () => {
    const { ctx, indexes, dir } = await misstamped();
    // Even an empty sibling that somehow exists (a build named explicitly and stopped
    // before its first commit) is not yet anybody's choice.
    await indexes.open('group:4523');

    const search = await semanticSearch.handler({ q: 'kalman' }, ctx);

    expect((search.structuredContent as any).library).toBe('user');
    expect((search.structuredContent as any).hits.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts the crawl when the caller names the group, discloses it, and then searches what it built', async () => {
    const { ctx, indexes, dir } = await misstamped();

    const res = await indexTool.handler({ action: 'build', library_type: 'group', library_id: 4523 }, ctx);

    expect(res.isError).toBeUndefined();
    const text = res.content[0]!.text as string;
    expect(text).toContain('Index build started');
    // The sentence that turns a silent second embedding bill into one the user chose.
    expect(text).toContain('original index');
    expect(text).toContain('delete it and build again');
    const group = indexes.peek('group:4523')!;
    await settled(group);
    expect(group.buildStatus().library).toBe('group:4523');

    // And once that index holds rows, the plain search path uses it rather than the orphan.
    const search = await semanticSearch.handler({ q: 'kalman' }, ctx);
    expect((search.structuredContent as any).library).toBe('group:4523');
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers action:"pause" for a library with no index without creating one', async () => {
    const { ctx, indexes, dir } = await misstamped();

    const res = await indexTool.handler({ action: 'pause' }, ctx);

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('No search index exists for group 4523');
    expect(indexes.peek('group:4523')).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});
