import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSearchIndex } from '../../src/features/search/factory.js';
import {
  SearchIndexRegistry,
  defaultIndexPath,
  libraryPathSegment,
  siblingIndexPath,
} from '../../src/features/search/index-registry.js';
import { PAGE_SIZE } from '../../src/features/search/build.js';
import type { SearchIndex } from '../../src/features/search/backend.js';

/**
 * Several persistent library indexes in one data directory.
 *
 * One store holds ONE library's rows (passage ids are `${itemKey}#${n}` with no library
 * component and Zotero item keys repeat across libraries), so a second library is a
 * second file. What is tested here is the part that decides WHICH file, how many are held
 * open, and that a hosted tenant's files are unreachable from another tenant's registry.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function makeItems(n: number, prefix: string): any[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `${prefix}${i}`,
    data: { itemType: 'journalArticle', title: `${prefix} item ${i}`, abstractNote: `kalman filtering ${i}` },
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

/** Index `items` into `index` under `library`'s stamp, and write it to disk. */
async function fill(index: SearchIndex, items: any[], library: string): Promise<void> {
  await index.buildIncremental(pageFetcher(items), { library, maxItems: items.length });
  await index.save();
}

const create = { embedder: null, logger: silentLogger, backend: 'memory' as const };

/** A registry over a fresh temp data dir. `memory` backend: no node:sqlite needed. */
async function makeRegistry(
  opts: {
    userId?: number;
    primaryLibrary?: string;
    maxOpen?: number;
    dir?: string;
    logger?: typeof silentLogger;
  } = {},
) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'zoteus-index-registry-'));
  const primaryPath = defaultIndexPath(dir, opts.userId);
  const primary = await createSearchIndex({ ...create, jsonPath: primaryPath });
  const registry = new SearchIndexRegistry({
    create,
    primaryPath,
    primary,
    primaryLibrary: opts.primaryLibrary ?? 'user',
    maxOpen: opts.maxOpen ?? 4,
    logger: opts.logger ?? silentLogger,
  });
  return { dir, primaryPath, primary, registry };
}

/** An index stuck mid-build on a page fetcher that only answers once `release` is called. */
function stuckBuild(index: SearchIndex, library: string): { job: Promise<unknown>; release: () => void } {
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  const job = index.buildIncremental(
    async () => {
      await blocked;
      return { items: [], totalResults: 0 };
    },
    { library },
  );
  return { job, release: release! };
}

describe('per-library index paths', () => {
  it('leaves the personal library on exactly the filename this data directory already uses', async () => {
    const { dir, registry } = await makeRegistry();
    // The compatibility requirement, spelled out: no migration, no rename, no suffix.
    expect(registry.pathFor('user')).toBe(join(dir, 'search-index.json'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the per-user filename in multi-tenant mode', async () => {
    const { dir, registry } = await makeRegistry({ userId: 19552201 });
    expect(registry.pathFor('user')).toBe(join(dir, 'search-index-19552201.json'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('gives a group a sibling file whose name carries the id and no colon', async () => {
    const { dir, registry } = await makeRegistry();
    const path = registry.pathFor('group:4523');

    expect(path).toBe(join(dir, 'search-index-lib-group-4523.json'));
    // `canonicalLibraryToken` emits `group:4523`, and a colon is illegal in a Windows
    // filename: the raw token must never reach a path.
    expect(path).not.toContain(':');
    expect(path).not.toBe(registry.pathFor('user'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('encodes the token without letting a group collide with the personal library', () => {
    expect(libraryPathSegment('user')).toBe('user');
    expect(libraryPathSegment('group:4523')).toBe('group-4523');
    expect(siblingIndexPath('/d/search-index.json', 'user')).toBe('/d/search-index-lib-user.json');
    expect(siblingIndexPath('/d/search-index.json', 'group:1')).toBe('/d/search-index-lib-group-1.json');
  });

  it('keys the primary by the library the file actually holds, not by the default', async () => {
    // A ZOTERO_LIBRARY_TYPE=group install has been writing its group's rows into
    // search-index.json all along. Keying that file by the configured default and handing
    // the group a new sibling would orphan a complete index and silently start over.
    const { dir, registry } = await makeRegistry({ primaryLibrary: 'group:4523' });

    expect(registry.pathFor('group:4523')).toBe(join(dir, 'search-index.json'));
    expect(registry.pathFor('user')).toBe(join(dir, 'search-index-lib-user.json'));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('opening and closing per-library indexes', () => {
  it('opens a second library into its own store, and keeps the two sets of rows apart', async () => {
    const { dir, primary, registry } = await makeRegistry();
    await fill(primary, makeItems(3, 'U'), 'user');
    const group = await registry.open('group:4523');
    await fill(group, makeItems(4, 'G'), 'group:4523');

    expect(primary.buildStatus().items).toBe(3);
    expect(group.buildStatus().items).toBe(4);
    expect(primary.buildStatus().library).toBe('user');
    expect(group.buildStatus().library).toBe('group:4523');
    // The rows themselves, not just the counts: a hit from one must never be in the other.
    expect((await primary.query('kalman', { limit: 10 })).every((h) => h.itemKey.startsWith('U'))).toBe(true);
    expect((await group.query('kalman', { limit: 10 })).every((h) => h.itemKey.startsWith('G'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('hands back the same object for the default library that ctx.search holds', async () => {
    const { dir, primary, registry } = await makeRegistry();
    expect(await registry.open('user')).toBe(primary);
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens each library once, even when two callers ask at the same time', async () => {
    const { dir, registry } = await makeRegistry();
    const [a, b] = await Promise.all([registry.open('group:7'), registry.open('group:7')]);
    expect(a).toBe(b);
    expect(registry.openLibraries()).toEqual(['user', 'group:7']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('closes the least recently used index, through save then close, to stay within the bound', async () => {
    const { dir, registry } = await makeRegistry({ maxOpen: 2 });
    const first = await registry.open('group:1');
    const saved = vi.spyOn(first, 'save');
    const closed = vi.spyOn(first, 'close');

    await registry.open('group:2');

    expect(registry.openLibraries()).toEqual(['user', 'group:2']);
    expect(registry.peek('group:1')).toBeUndefined();
    // save() BEFORE close(), the same pair the shutdown flush uses: close is what
    // checkpoints the write-ahead log, and dropping the entry without saving would throw
    // away whatever the index held that had not reached disk.
    expect(saved).toHaveBeenCalled();
    expect(closed).toHaveBeenCalled();
    expect(saved.mock.invocationCallOrder[0]!).toBeLessThan(closed.mock.invocationCallOrder[0]!);
    rmSync(dir, { recursive: true, force: true });
  });

  it('never closes the default library index, however long ago it was used', async () => {
    const { dir, primary, registry } = await makeRegistry({ maxOpen: 2 });
    const closed = vi.spyOn(primary, 'close');

    await registry.open('group:1');
    await registry.open('group:2');
    await registry.open('group:3');

    // ctx.search points at the primary and 31 tools read that field, so it is pinned.
    expect(registry.openLibraries()).toEqual(['user', 'group:3']);
    expect(registry.peek('user')).toBe(primary);
    expect(closed).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });

  it('exceeds the bound rather than closing an index with a build running', async () => {
    const { dir, registry } = await makeRegistry({ maxOpen: 2 });
    const busy = await registry.open('group:1');
    // A page fetcher that never answers: the build stays running for the whole test.
    let release: (() => void) | undefined;
    const stuck = new Promise<void>((r) => {
      release = r;
    });
    const job = busy.buildIncremental(
      async () => {
        await stuck;
        return { items: [], totalResults: 0 };
      },
      { library: 'group:1' },
    );
    expect(busy.isBuilding).toBe(true);

    const fresh = await registry.open('group:2');

    // A running build holds the instance rather than re-reading the field, so closing it
    // would leave the build writing into a store nothing can reach.
    expect(registry.openLibraries()).toEqual(['user', 'group:1', 'group:2']);
    expect(registry.peek('group:1')).toBe(busy);
    expect(registry.peek('group:2')).toBe(fresh);
    release!();
    await job;
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to reopen an index while its own build is running, and says how to stop it', async () => {
    const { dir, primary, registry } = await makeRegistry();
    let release: (() => void) | undefined;
    const stuck = new Promise<void>((r) => {
      release = r;
    });
    const job = primary.buildIncremental(
      async () => {
        await stuck;
        return { items: [], totalResults: 0 };
      },
      { library: 'user' },
    );

    await expect(registry.reopen('user')).rejects.toThrow(/cannot be reopened while a build is running/);
    expect(registry.peek('user')).toBe(primary);
    release!();
    await job;
    rmSync(dir, { recursive: true, force: true });
  });

  it('replaces the entry on reopen, and a failed reopen is retried rather than cached', async () => {
    const { dir, primary, registry } = await makeRegistry();
    const fresh = await registry.reopen('user');
    expect(fresh).not.toBe(primary);
    expect(registry.peek('user')).toBe(fresh);
    // Reopening again gives another new object, i.e. the single-flight promise was cleared.
    expect(await registry.reopen('user')).not.toBe(fresh);
    rmSync(dir, { recursive: true, force: true });
  });

  it('saves and closes EVERY open index, not only the default one', async () => {
    const { dir, primary, registry } = await makeRegistry();
    const group = await registry.open('group:4523');
    const spies = [primary, group].map((i) => ({ save: vi.spyOn(i, 'save'), close: vi.spyOn(i, 'close') }));

    await registry.closeAll();

    for (const s of spies) {
      expect(s.save).toHaveBeenCalled();
      expect(s.close).toHaveBeenCalled();
    }
    expect(registry.openLibraries()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('cancels a running build and waits for it, rather than closing the store under it', async () => {
    const { dir, registry } = await makeRegistry();
    const busy = await registry.open('group:4523');
    const { job, release } = stuckBuild(busy, 'group:4523');
    expect(busy.isBuilding).toBe(true);
    const stop = vi.spyOn(busy, 'requestStop');
    const closed = vi.spyOn(busy, 'close');

    const closing = registry.closeAll();
    // Long enough for an unguarded closeAll to have saved and closed everything already.
    await new Promise((r) => setTimeout(r, 40));

    // The build is asked to stop, and its store stays open until it has: closing it here
    // is what ended a job at "The SQLite search index is not open.", in `error`, having
    // lost the checkpoint that says where the next build picks it up.
    expect(stop).toHaveBeenCalled();
    expect(busy.isBuilding).toBe(true);
    expect(closed).not.toHaveBeenCalled();

    release();
    await closing;
    await job;
    expect(busy.isBuilding).toBe(false);
    expect(busy.buildStatus().state).not.toBe('error');
    expect(closed).toHaveBeenCalled();
    expect(registry.openLibraries()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('closes anyway, and says which build it closed under, when one will not stop in time', async () => {
    const warn = vi.fn();
    const { dir, registry } = await makeRegistry({ logger: { ...silentLogger, warn } });
    const busy = await registry.open('group:4523');
    const { job, release } = stuckBuild(busy, 'group:4523');
    const closed = vi.spyOn(busy, 'close');

    // Bound 0: the caller is a shutdown with a deadline of its own, so a build that cannot
    // answer must not hold it open indefinitely.
    await registry.closeAll(0);

    expect(closed).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('did not stop within 0ms'));
    expect(registry.openLibraries()).toEqual([]);
    release();
    await job;
    rmSync(dir, { recursive: true, force: true });
  });

  it('stops a job in ANY open index, not only the default library\'s', async () => {
    const { dir, registry } = await makeRegistry();
    const group = await registry.open('group:4523');
    let release: (() => void) | undefined;
    const stuck = new Promise<void>((r) => {
      release = r;
    });
    const job = group.buildIncremental(
      async () => {
        await stuck;
        return { items: [], totalResults: 0 };
      },
      { library: 'group:4523' },
    );

    // What a Ctrl-C needs: a `--library-id` job runs in that library's own index.
    expect(registry.requestStopAll()).toBe(true);
    release!();
    await job;
    expect(group.isBuilding).toBe(false);
    // Nothing running anywhere: says so rather than claiming it stopped something.
    expect(registry.requestStopAll()).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('saveAll persists every open index and leaves them open', async () => {
    const { dir, primary, registry } = await makeRegistry();
    const group = await registry.open('group:4523');
    const saves = [primary, group].map((i) => vi.spyOn(i, 'save'));
    const closes = [primary, group].map((i) => vi.spyOn(i, 'close'));

    await registry.saveAll();

    for (const s of saves) expect(s).toHaveBeenCalled();
    // A periodic flush is not a shutdown: nothing is released, so the handles stay usable.
    for (const c of closes) expect(c).not.toHaveBeenCalled();
    expect(registry.openLibraries()).toEqual(['user', 'group:4523']);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('listing which libraries have an index', () => {
  it('finds an index a previous run left on disk, with its counts and its stamp', async () => {
    const { dir, primary, registry } = await makeRegistry();
    await fill(primary, makeItems(2, 'U'), 'user');
    const group = await registry.open('group:4523');
    await fill(group, makeItems(5, 'G'), 'group:4523');
    await registry.closeAll();

    // A second registry over the same directory: nothing is open, so everything it reports
    // it found by reading the directory.
    const reopened = await makeRegistry({ dir });
    const rows = await reopened.registry.list();

    expect(rows.map((r) => r.library)).toEqual(['user', 'group:4523']);
    expect(rows[0]).toMatchObject({ library: 'user', primary: true, stamp: 'user', items: 2 });
    expect(rows[1]).toMatchObject({
      library: 'group:4523',
      label: 'group 4523',
      primary: false,
      stamp: 'group:4523',
      items: 5,
    });
    expect(rows[1]!.path).toBe(join(dir, 'search-index-lib-group-4523.json'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not create a store for a library that has no index', async () => {
    const { dir, registry } = await makeRegistry();

    expect(await registry.exists('group:999')).toBe(false);
    expect(await registry.openIfExists('group:999')).toBeUndefined();
    expect(existsSync(join(dir, 'search-index-lib-group-999.json'))).toBe(false);
    expect((await registry.list()).map((r) => r.library)).toEqual(['user']);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('tenant isolation', () => {
  it('keeps every per-library path inside the asking user\'s own key, in both directions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-index-tenants-'));
    const a = await makeRegistry({ dir, userId: 19552201 });
    const b = await makeRegistry({ dir, userId: 8675309 });

    for (const token of ['user', 'group:4523']) {
      expect(a.registry.pathFor(token)).not.toBe(b.registry.pathFor(token));
      expect(a.registry.pathFor(token)).toContain('19552201');
      expect(b.registry.pathFor(token)).toContain('8675309');
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('cannot reach another tenant\'s index for the same group', async () => {
    // Two hosted users who both belong to group 4523. They index through different Zotero
    // keys and may see different subsets of it, so they must not share a file.
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-index-tenants-'));
    const a = await makeRegistry({ dir, userId: 19552201 });
    const b = await makeRegistry({ dir, userId: 8675309 });

    const aGroup = await a.registry.open('group:4523');
    await fill(aGroup, makeItems(6, 'A'), 'group:4523');

    const bGroup = await b.registry.open('group:4523');

    expect(bGroup).not.toBe(aGroup);
    expect(bGroup.isEmpty).toBe(true);
    expect(await bGroup.query('kalman', { limit: 10 })).toEqual([]);
    // And user B's listing cannot even SEE user A's file, though it sits in the same
    // directory: discovery is anchored on B's own per-user stem.
    const seen = await b.registry.list();
    expect(seen.every((r) => r.path.includes('8675309'))).toBe(true);
    expect(seen.some((r) => r.path.includes('19552201'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the operator context blind to a tenant\'s sibling indexes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-index-tenants-'));
    const tenant = await makeRegistry({ dir, userId: 19552201 });
    await fill(await tenant.registry.open('group:4523'), makeItems(3, 'T'), 'group:4523');
    await tenant.registry.closeAll();

    const operator = await makeRegistry({ dir });
    const rows = await operator.registry.list();

    expect(rows.map((r) => r.library)).toEqual(['user']);
    rmSync(dir, { recursive: true, force: true });
  });
});
