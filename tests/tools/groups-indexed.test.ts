import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import groups from '../../src/tools/groups.js';
import { createSearchIndex } from '../../src/features/search/factory.js';
import { SearchIndexRegistry, defaultIndexPath } from '../../src/features/search/index-registry.js';

/**
 * `zotero_groups[].indexed` has to answer the question the lab checklist asks it.
 *
 * Step 5 of docs/lab-setup.md builds a group's index with
 * `zotero_index action:"build" library_type:"group" library_id:<id>` and then reads
 * `indexed` on that row. That build writes the group's OWN index file beside the default
 * library's and leaves the primary's stamp alone, so answering from the primary's stamp
 * reported a fully indexed group as un-indexed, and the schema turned that into the claim
 * that the group is searchable by keyword but not by meaning, which is false.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const GROUP_ROW = (id: number, name: string) => ({ id, data: { id, name, type: 'Private' }, meta: { numItems: 3 } });

/** Minimal SearchIndex stand-in, as the rest of the group tests use. */
function searchStub(library?: string) {
  return {
    buildStatus: () => ({ state: 'done', items: 12, documents: 40, ...(library ? { library } : {}) }),
  } as any;
}

/** A groups context carrying a REAL registry over a temp data directory. */
async function ctxWithRegistry(opts: { cloudGroups: number[]; indexed: string[]; primaryStamp?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'zoteus-groups-'));
  const create = { embedder: null, logger: silentLogger, backend: 'memory' as const };
  const primaryPath = defaultIndexPath(dir);
  const primary = await createSearchIndex({ ...create, jsonPath: primaryPath });
  const indexes = new SearchIndexRegistry({
    create,
    primaryPath,
    primary,
    primaryLibrary: opts.primaryStamp ?? 'user',
    maxOpen: 8,
    logger: silentLogger,
  });
  // Each of these is a real store on disk, exactly as a per-library build leaves it.
  for (const library of opts.indexed) {
    const index = await indexes.open(library);
    await index.save();
  }
  const me = { userID: 111, username: 'alice', access: { user: { write: true }, groups: { all: { library: true, write: true } } } };
  const ctx: any = {
    router: { whoami: () => me, defaultLibrary: () => ({ type: 'user', id: 111 }) },
    capabilities: { cloud: me, localApi: false, localGroupIds: [] },
    web: {
      hasKey: true,
      listGroups: vi.fn(async () => ({
        data: opts.cloudGroups.map((id) => GROUP_ROW(id, `Group ${id}`)),
        totalResults: opts.cloudGroups.length,
        lastModifiedVersion: 1,
      })),
    },
    config: { local: 'off', readOnly: false, dataDir: dir },
    search: primary,
    indexes,
    searchIndexPath: primaryPath,
    logger: silentLogger,
  };
  return { ctx, dir, indexes };
}

describe('zotero_groups reports which groups have a search index', () => {
  it('marks a group that has its OWN index, even though the primary holds another library', async () => {
    const { ctx, dir } = await ctxWithRegistry({ cloudGroups: [4523, 789], indexed: ['group:4523'] });

    const rows = (await groups.handler({}, ctx)).structuredContent?.groups as any[];

    // Before this both rows read false: the primary's stamp is the personal library, and
    // that single stamp was compared against every group.
    expect(rows.map((r) => [r.id, r.indexed])).toEqual([
      [4523, true],
      [789, false],
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('can mark several rows at once, which one index file per library makes possible', async () => {
    const { ctx, dir } = await ctxWithRegistry({
      cloudGroups: [4523, 789, 101],
      indexed: ['group:4523', 'group:789'],
    });

    const rows = (await groups.handler({}, ctx)).structuredContent?.groups as any[];

    expect(rows.map((r) => [r.id, r.indexed])).toEqual([
      [4523, true],
      [789, true],
      [101, false],
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('marks the group that IS the default library, whose index is the primary file', async () => {
    const { ctx, dir } = await ctxWithRegistry({ cloudGroups: [4523], indexed: [], primaryStamp: 'group:4523' });

    const rows = (await groups.handler({}, ctx)).structuredContent?.groups as any[];

    expect(rows[0].indexed).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the primary index stamp where the context has no registry', async () => {
    // Every hand-built context and the deferred-startup fake: one index, and its stamp is
    // the only evidence there is.
    const me = { userID: 111, username: 'alice', access: { user: { write: true }, groups: { all: { library: true } } } };
    const ctx: any = {
      router: { whoami: () => me, defaultLibrary: () => ({ type: 'user', id: 111 }) },
      capabilities: { cloud: me, localApi: false, localGroupIds: [] },
      web: {
        hasKey: true,
        listGroups: vi.fn(async () => ({ data: [GROUP_ROW(456, 'Lab'), GROUP_ROW(789, 'Reading')], totalResults: 2, lastModifiedVersion: 1 })),
      },
      config: { local: 'off', readOnly: false, dataDir: '/tmp/zoteus-test' },
      search: searchStub('group:456'),
      logger: silentLogger,
    };

    const rows = (await groups.handler({}, ctx)).structuredContent?.groups as any[];

    expect(rows.map((r) => [r.id, r.indexed])).toEqual([
      [456, true],
      [789, false],
    ]);
  });

  it('no longer tells the model that at most one row can be true', async () => {
    // The string is the claim a model acts on, and it said a false row is "searchable by
    // keyword through the Zotero API but not by meaning", which stopped being true the
    // moment a second library could have an index of its own.
    const described = ((groups.outputSchema as any).shape.groups.element.shape.indexed.description ?? '') as string;
    expect(described).not.toContain('at most one row is true');
    expect(described).toContain('several rows can be true');
    expect(described).toContain('zotero_index action:"build" library_type:"group"');
    expect(groups.description).not.toContain('at most one row can be true');
    expect(groups.description).toContain('several rows can be true');
  });
});
