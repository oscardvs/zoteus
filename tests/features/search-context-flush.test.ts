import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { ContextCache, buildContext } from '../../src/server.js';

/**
 * Every library's index is released on shutdown and on eviction, not just the default
 * library's.
 *
 * `close()` is what checkpoints SQLite's write-ahead log and releases the file handle, so
 * an index that is dropped without it leaks both for the life of the process. Before the
 * registry there was one index per context and the shutdown flush closed it; now a context
 * holds one per library it has addressed, so "the index" is the wrong number of things to
 * close, and `ContextCache.evictIfNeeded` closed none of them at all.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Everything a test context needs, with no network and no real Zotero. */
function env(dir: string): Record<string, string> {
  return {
    ZOTEUS_LOCAL: 'off',
    ZOTEUS_DATA_DIR: dir,
    ZOTEUS_EMBEDDINGS: 'off',
    ZOTEUS_INDEX_BACKEND: 'memory',
    ZOTEUS_UPDATE_CHECK: 'false',
  };
}

/** `/keys/current` and nothing else: a per-user context probes the key at build time. */
/** Which account each fixture key belongs to; anything unlisted is tenant 222. */
const KEY_OWNERS: Record<string, number> = { k1: 111, k2: 222, k3: 333 };

function stubZoteroKeyProbe(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) =>
      new Response(JSON.stringify({ userID: KEY_OWNERS[init?.headers?.['Zotero-API-Key'] as string] ?? 222, username: 'tenant', access: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('releasing a context\'s search indexes', () => {
  it('flushes and closes EVERY library\'s index on shutdown, not only the default one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-flush-'));
    const ctx = await buildContext(loadConfig(env(dir) as any), { telemetry: { logger: silentLogger as any } });
    const group = await ctx.indexes!.open('group:4523');
    const spies = [ctx.search, group].map((i) => ({ save: vi.spyOn(i, 'save'), close: vi.spyOn(i, 'close') }));

    await new ContextCache(loadConfig(env(dir) as any), ctx, 50).flushIndexes();

    for (const s of spies) {
      expect(s.save).toHaveBeenCalled();
      expect(s.close).toHaveBeenCalled();
    }
    expect(ctx.indexes!.openLibraries()).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('closes an evicted per-user context\'s indexes instead of dropping the handles', async () => {
    stubZoteroKeyProbe();
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-evict-'));
    const config = loadConfig(env(dir) as any);
    const operator = await buildContext(config, { telemetry: { logger: silentLogger as any } });
    // maxEntries 1: resolving a second tenant evicts the first.
    const cache = new ContextCache(config, operator, 1, { logger: silentLogger as any });

    const first = await cache.resolve({ extra: { zoteroKey: 'k1', zoteroUserId: 111 } } as any);
    const firstGroup = await first.indexes!.open('group:4523');
    const saved = vi.spyOn(first.search, 'save');
    const closed = vi.spyOn(first.search, 'close');
    const groupSaved = vi.spyOn(firstGroup, 'save');
    const groupClosed = vi.spyOn(firstGroup, 'close');

    const second = await cache.resolve({ extra: { zoteroKey: 'k2', zoteroUserId: 222 } } as any);

    expect(second).not.toBe(first);
    // Both of the evicted tenant's indexes, saved then closed. Dropping the cache entry
    // alone left a SQLite handle and an uncheckpointed WAL behind on every eviction.
    expect(saved).toHaveBeenCalled();
    expect(closed).toHaveBeenCalled();
    expect(groupSaved).toHaveBeenCalled();
    expect(groupClosed).toHaveBeenCalled();
    expect(first.indexes!.openLibraries()).toEqual([]);
    // And the tenants never shared a file in the first place.
    expect(first.searchIndexPath).toContain('111');
    expect(second.searchIndexPath).toContain('222');
    expect(first.indexes!.pathFor('group:4523')).not.toBe(second.indexes!.pathFor('group:4523'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('never evicts a context while a search is holding one of its indexes open', async () => {
    stubZoteroKeyProbe();
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-evict-'));
    const config = loadConfig(env(dir) as any);
    const operator = await buildContext(config, { telemetry: { logger: silentLogger as any } });
    const cache = new ContextCache(config, operator, 1, { logger: silentLogger as any });

    const first = await cache.resolve({ extra: { zoteroKey: 'k1', zoteroUserId: 111 } } as any);
    const closed = vi.spyOn(first.search, 'close');
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // A search in flight: withIndex holds its lease until the work resolves.
    const inflight = first.indexes!.withIndex('user', async () => {
      await gate;
      return 'done';
    });
    await new Promise((r) => setTimeout(r, 0));

    const second = await cache.resolve({ extra: { zoteroKey: 'k2', zoteroUserId: 222 } } as any);
    expect(second).not.toBe(first);
    // Over its bound with the only candidate busy, the cache waits rather than closing an
    // index under a query that would then end in "not open".
    expect(closed).not.toHaveBeenCalled();
    expect(first.invalidated).toBeUndefined();

    release();
    await expect(inflight).resolves.toBe('done');
    // The next miss makes room the ordinary way.
    await cache.resolve({ extra: { zoteroKey: 'k3', zoteroUserId: 333 } } as any);
    expect(closed).toHaveBeenCalled();
    expect(first.invalidated).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('never evicts a context whose index is building', async () => {
    stubZoteroKeyProbe();
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-evict-'));
    const config = loadConfig(env(dir) as any);
    const operator = await buildContext(config, { telemetry: { logger: silentLogger as any } });
    const cache = new ContextCache(config, operator, 1, { logger: silentLogger as any });

    const first = await cache.resolve({ extra: { zoteroKey: 'k1', zoteroUserId: 111 } } as any);
    let release: (() => void) | undefined;
    const stuck = new Promise<void>((r) => {
      release = r;
    });
    const job = first.search.buildIncremental(
      async () => {
        await stuck;
        return { items: [], totalResults: 0 };
      },
      { library: 'user' },
    );
    const closed = vi.spyOn(first.search, 'close');

    const second = await cache.resolve({ extra: { zoteroKey: 'k2', zoteroUserId: 222 } } as any);
    const secondClosed = vi.spyOn(second.search, 'close');

    // A running build holds the instance rather than reading the field, so closing under it
    // would leave the build writing into a store nothing can reach. The cache stays over
    // its limit instead.
    expect(closed).not.toHaveBeenCalled();
    // And the context that was just resolved is not the fallback victim: it is about to be
    // handed to a caller, and it only becomes a candidate at all because the building rule
    // skipped the other one.
    expect(second.search.storeFault).toBeUndefined();
    expect(await second.search.query('anything', { limit: 1 })).toEqual([]);
    expect(secondClosed).not.toHaveBeenCalled();
    release!();
    await job;
    rmSync(dir, { recursive: true, force: true });
  });

  it('never evicts a context whose GROUP index is building, not just the default one', async () => {
    // A build on a named library runs inside that library's own index: zotero_index hands
    // the registry's store to startIndexBuild, so `ctx.search.isBuilding` stays false for
    // the whole of it. Asking only the primary let the next tenant's first request evict
    // this context, close the group's store through `closeAll`, and end an hours-long,
    // possibly paid-embedding build at "The SQLite search index is not open."
    stubZoteroKeyProbe();
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-evict-'));
    const config = loadConfig(env(dir) as any);
    const operator = await buildContext(config, { telemetry: { logger: silentLogger as any } });
    const cache = new ContextCache(config, operator, 1, { logger: silentLogger as any });

    const first = await cache.resolve({ extra: { zoteroKey: 'k1', zoteroUserId: 111 } } as any);
    const group = await first.indexes!.open('group:4523');
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
    const primaryClosed = vi.spyOn(first.search, 'close');
    const groupClosed = vi.spyOn(group, 'close');
    expect(group.isBuilding).toBe(true);
    expect(first.search.isBuilding).toBe(false);

    await cache.resolve({ extra: { zoteroKey: 'k2', zoteroUserId: 222 } } as any);

    expect(groupClosed).not.toHaveBeenCalled();
    expect(primaryClosed).not.toHaveBeenCalled();
    expect(first.indexes!.openLibraries()).toContain('group:4523');
    release!();
    await job;
    expect(group.buildStatus().lastError).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});
