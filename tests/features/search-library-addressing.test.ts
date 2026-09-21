import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import indexTool from '../../src/tools/index-tool.js';
import semanticSearch from '../../src/tools/semantic-search.js';
import { PAGE_SIZE } from '../../src/features/search/build.js';
import { createSearchIndex } from '../../src/features/search/factory.js';
import { SearchIndexRegistry, defaultIndexPath } from '../../src/features/search/index-registry.js';
import { LibraryRouter } from '../../src/router/library-router.js';
import { loadConfig } from '../../src/config.js';
import { canonicalLibraryToken, type SearchIndex } from '../../src/features/search/backend.js';

/**
 * Which library a caller may address, and what may be created to answer them.
 *
 * Opening an index CREATES its store, so the tool layer decides two things before it does
 * that: whether the caller can reach the library at all (a hosted tenant naming group ids
 * they cannot read otherwise leaves a permanent file in the operator's shared data
 * directory, once per id), and whether the token can even be written as a file name and
 * read back (`group:-1` spelled a file `discover()` can never see again).
 *
 * The third case here is the opposite mistake: a library the caller named that was DROPPED.
 * `library_type:"user"` with no id is the only spelling of "my personal library" a user
 * who does not know their numeric Zotero userID can produce, and it fell through to the
 * configured default.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function makeItems(n: number, prefix: string): any[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `${prefix}${i}`,
    data: { itemType: 'journalArticle', title: `${prefix} kalman ${i}`, abstractNote: `kalman in context ${i}` },
  }));
}

/**
 * A tool-path context over a real registry and a real router. `access` is the key's own
 * `/keys/current` map, which is the evidence the reachability check reads.
 */
async function makeCtx(opts: {
  env?: Record<string, string>;
  libraries?: Record<string, any[]>;
  access?: Record<string, unknown>;
  localGroupIds?: number[];
}) {
  const dir = mkdtempSync(join(tmpdir(), 'zoteus-addressing-'));
  const config = loadConfig({ ZOTEUS_LOCAL: 'off', ZOTEUS_DATA_DIR: dir, ...(opts.env ?? {}) } as any);
  const libraries = opts.libraries ?? {};
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
  const capabilities = {
    cloud: { userID: 19552201, username: 'oscardvs', access: opts.access ?? {} } as any,
    localApi: false,
    localGroupIds: opts.localGroupIds ?? [],
  };
  const router = new LibraryRouter({ config, capabilities, web: web as any });
  const create = { embedder: null, logger: silentLogger, backend: 'memory' as const };
  const searchIndexPath = defaultIndexPath(dir);
  const search = await createSearchIndex({ ...create, jsonPath: searchIndexPath });
  const indexes = new SearchIndexRegistry({
    create,
    primaryPath: searchIndexPath,
    primary: search,
    // Exactly server.ts: the store's own stamp when it has one, else the configured default.
    primaryLibrary: search.buildStatus().library ?? canonicalLibraryToken(router.defaultLibrary()),
    maxOpen: 4,
    logger: silentLogger,
  });
  const ctx: any = { config, capabilities, router, web, search, indexes, searchIndexPath, logger: silentLogger };
  return { ctx, web, indexes, dir, search };
}

async function settled(index: SearchIndex) {
  for (let i = 0; i < 500 && index.buildStatus().state === 'building'; i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
  return index.buildStatus();
}

/** A key that may read one group and no others: the shape `/keys/current` answers with. */
const ONE_GROUP = { user: { library: true, write: true }, groups: { '4523': { library: true } } };

describe('a group the caller cannot reach', () => {
  it('refuses a build for it instead of creating an index store for it', async () => {
    const { ctx, dir, indexes } = await makeCtx({ access: ONE_GROUP });

    const res = await indexTool.handler({ action: 'build', library_type: 'group', library_id: 777 }, ctx);

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('cannot read group 777');
    expect(res.content[0]!.text).toContain('zotero_groups');
    // The point of the ordering: nothing was written to the data directory.
    expect(existsSync(join(dir, 'search-index-lib-group-777.json'))).toBe(false);
    expect(indexes.openLibraries()).not.toContain('group:777');
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses the automatic build a search would otherwise start for it', async () => {
    const { ctx, dir } = await makeCtx({ access: ONE_GROUP });

    const res = await semanticSearch.handler({ q: 'kalman', library_type: 'group', library_id: 777 }, ctx);

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('cannot read group 777');
    expect(existsSync(join(dir, 'search-index-lib-group-777.json'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('still builds a group the key CAN read', async () => {
    const { ctx, dir, indexes } = await makeCtx({
      access: ONE_GROUP,
      libraries: { 'group:4523': makeItems(3, 'G') },
    });

    const res = await indexTool.handler({ action: 'build', library_type: 'group', library_id: 4523 }, ctx);

    expect(res.isError).toBeUndefined();
    const group = indexes.peek('group:4523')!;
    expect((await settled(group)).items).toBe(3);
    rmSync(dir, { recursive: true, force: true });
  });

  it('says nothing when the key reported no access map at all', async () => {
    // Evidence, not a schema: a local-only install and a key that answered with no map
    // must keep working, exactly as the write-side check already decides it.
    const { ctx, dir, indexes } = await makeCtx({ access: {}, libraries: { 'group:777': makeItems(2, 'G') } });

    const res = await indexTool.handler({ action: 'build', library_type: 'group', library_id: 777 }, ctx);

    expect(res.isError).toBeUndefined();
    expect((await settled(indexes.peek('group:777')!)).items).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('a library id that could never be read back off disk', () => {
  it('refuses a negative group id rather than writing a file action:"libraries" can never see', async () => {
    const { ctx, dir, indexes } = await makeCtx({ access: {} });

    const res = await indexTool.handler({ action: 'build', library_type: 'group', library_id: -1 }, ctx);

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('POSITIVE numeric id');
    // `libraryPathSegment` spells group:-1 as "group--1", which discover()'s ^group-(\d+)$
    // cannot parse: such a file is invisible to action:"libraries" for ever after.
    expect(indexes.openLibraries()).not.toContain('group:-1');
    expect(readdirSync(dir).some((f) => f.includes('group--1'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses it on the search path too, where auto_build would have created the store', async () => {
    const { ctx, dir, indexes } = await makeCtx({ access: {} });

    const res = await semanticSearch.handler({ q: 'kalman', library_type: 'group', library_id: -1 }, ctx);

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('POSITIVE numeric id');
    // No store was opened for it, so nothing can flush one to disk later either.
    expect(indexes.openLibraries()).not.toContain('group:-1');
    expect(readdirSync(dir).some((f) => f.includes('group--1'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('library_type:"user" with no library_id', () => {
  it('builds the personal library, not the configured group', async () => {
    // On a ZOTERO_LIBRARY_TYPE=group install this dropped the argument and re-crawled and
    // re-embedded the GROUP, replaced the group's own index from its first commit, created
    // no personal index, and reported success.
    const { ctx, web, indexes, dir } = await makeCtx({
      env: { ZOTERO_LIBRARY_TYPE: 'group', ZOTERO_LIBRARY_ID: '4523' },
      libraries: { user: makeItems(9, 'U'), 'group:4523': makeItems(5, 'G') },
    });
    await indexTool.handler({ action: 'build' }, ctx);
    await settled(ctx.search);
    web.listItems.mockClear();

    const res = await indexTool.handler({ action: 'build', library_type: 'user' }, ctx);

    expect(res.isError).toBeUndefined();
    expect((res.structuredContent as any).library).toBe('user');
    expect(web.listItems.mock.calls[0]![0]).toEqual({ type: 'user', id: 19552201 });
    const mine = indexes.peek('user')!;
    expect(mine).not.toBe(ctx.search);
    expect((await settled(mine)).items).toBe(9);
    // And the group's own index is untouched by a call that never named it.
    expect(ctx.search.buildStatus().items).toBe(5);
    expect(ctx.search.buildStatus().library).toBe('group:4523');
    rmSync(dir, { recursive: true, force: true });
  });

  it('searches the personal library rather than the configured group', async () => {
    const { ctx, indexes, dir } = await makeCtx({
      env: { ZOTERO_LIBRARY_TYPE: 'group', ZOTERO_LIBRARY_ID: '4523' },
      libraries: { user: makeItems(4, 'U'), 'group:4523': makeItems(5, 'G') },
    });
    await indexTool.handler({ action: 'build' }, ctx);
    await settled(ctx.search);
    await indexTool.handler({ action: 'build', library_type: 'user' }, ctx);
    await settled(indexes.peek('user')!);

    const res = await semanticSearch.handler({ q: 'kalman', library_type: 'user' }, ctx);

    expect(res.isError).toBeUndefined();
    const out = res.structuredContent as any;
    expect(out.library).toBe('user');
    expect((out.hits as any[]).every((h) => h.itemKey.startsWith('U'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
