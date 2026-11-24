import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSearchIndex, nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { FakeEmbeddingProvider } from '../../src/features/search/embeddings.js';
import {
  MemoryWatchdog,
  defaultMemoryFloorBytes,
  memoryFloorBytes,
  memoryHeadroom,
  type MemoryHeadroom,
} from '../../src/features/search/memory-watch.js';
import type { SearchIndex } from '../../src/features/search/backend.js';

/**
 * #105: on a 6.3 GB machine an index build grew until the kernel's out-of-memory killer
 * sent SIGKILL, twice, taking the MCP session with it and leaving nothing anywhere to say
 * why. These tests stand in for the machine's memory and hold the guard to its promise: a
 * job that runs short stops itself like action:"stop", keeps what it saved, says why, and
 * the next one carries on; a job that cannot start says so before it begins.
 */

const MB = 1024 * 1024;
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const backends: Array<'memory' | 'sqlite'> = nodeSqliteAvailable() ? ['memory', 'sqlite'] : ['memory'];

const headroom = (mb: number, source: MemoryHeadroom['source'] = 'meminfo'): MemoryHeadroom => ({
  availableBytes: mb * MB,
  totalBytes: 8192 * MB,
  source,
});

describe('memory floor', () => {
  it('defaults to 5% of RAM, at least 128 MB and at most 1 GB, and only where the figure is trustworthy', () => {
    const ram = (mb: number, source: MemoryHeadroom['source'] = 'meminfo'): MemoryHeadroom => ({
      availableBytes: 0,
      totalBytes: mb * MB,
      source,
    });
    // The 1 GB cloud machine hosted Zoteus runs on, the 6.3 GB laptop of #105, a workstation.
    expect(defaultMemoryFloorBytes(ram(964))).toBe(128 * MB);
    expect(Math.round(defaultMemoryFloorBytes(ram(6451)) / MB)).toBe(323);
    expect(defaultMemoryFloorBytes(ram(65536))).toBe(1024 * MB);
    expect(defaultMemoryFloorBytes(ram(2048, 'cgroup'))).toBe(128 * MB);
    // macOS reports reclaimable memory as used: no default floor there.
    expect(defaultMemoryFloorBytes(ram(16384, 'os'))).toBe(0);
  });

  it('takes the operator setting over the default, and 0 turns the guard off', () => {
    expect(memoryFloorBytes(300, headroom(0))).toBe(300 * MB);
    expect(memoryFloorBytes(0, headroom(0))).toBe(0);
    expect(memoryFloorBytes(undefined, headroom(0))).toBe(defaultMemoryFloorBytes(headroom(0)));
    expect(memoryFloorBytes(50, headroom(0, 'os'))).toBe(50 * MB);
  });

  it('reads a real, positive headroom on this machine', () => {
    const h = memoryHeadroom();
    expect(h.availableBytes).toBeGreaterThan(0);
    expect(h.totalBytes).toBeGreaterThan(0);
    if (process.platform === 'linux') expect(['meminfo', 'cgroup']).toContain(h.source);
  });
});

describe('MemoryWatchdog', () => {
  it('calls back once, the first time the headroom falls under the floor', async () => {
    const readings = [500, 400, 90, 80, 70];
    let i = 0;
    const dog = new MemoryWatchdog(() => headroom(readings[Math.min(i++, readings.length - 1)]!));
    const seen: number[] = [];
    dog.start(100 * MB, (h) => seen.push(h.availableBytes / MB), 5);
    await new Promise((r) => setTimeout(r, 80));
    dog.stop();
    expect(seen).toEqual([90]);
    expect(dog.lowest!.availableBytes).toBe(70 * MB);
  });

  it('does nothing with a floor of 0', async () => {
    let sampled = 0;
    const dog = new MemoryWatchdog(() => (sampled++, headroom(1)));
    const seen: unknown[] = [];
    dog.start(0, (h) => seen.push(h), 5);
    await new Promise((r) => setTimeout(r, 40));
    dog.stop();
    expect(sampled).toBe(0);
    expect(seen).toEqual([]);
  });
});

const ITEMS = 600;
const items = Array.from({ length: ITEMS }, (_, i) => ({
  key: `K${i}`,
  data: { key: `K${i}`, itemType: 'journalArticle', title: `Paper ${i}`, abstractNote: `Abstract number ${i}.` },
}));
/** Pages of 50 that take a little while to arrive, so a guard sampling every 10 ms has room to act. */
const slowFetcher = async (start: number) => {
  await new Promise((r) => setTimeout(r, 15));
  return { items: items.slice(start, start + 50), totalResults: items.length, lastModifiedVersion: 10 };
};

type Guarded = SearchIndex & { memoryHeadroom(): MemoryHeadroom; memoryWatchIntervalMs: number };

async function open(backend: 'memory' | 'sqlite', memoryFloorMb: number | undefined): Promise<Guarded> {
  const jsonPath = join(mkdtempSync(join(tmpdir(), 'zoteus-memguard-')), 'search-index.json');
  const index = (await createSearchIndex({
    backend,
    jsonPath,
    embedder: new FakeEmbeddingProvider(),
    logger: silentLogger,
    ...(memoryFloorMb === undefined ? {} : { memoryFloorMb }),
  })) as unknown as Guarded;
  index.memoryWatchIntervalMs = 10;
  return index;
}

describe.each(backends)('the memory guard on index jobs (%s)', (backend) => {
  it('stops a build that runs short, says why, and the next build carries on from there', async () => {
    const index = await open(backend, 100);
    // Plenty at the start, then the machine runs short a few samples in.
    let samples = 0;
    index.memoryHeadroom = () => headroom(++samples > 4 ? 60 : 4000);
    const stopped = await index.buildIncremental(slowFetcher, { versionBackend: 'local' });
    expect(stopped.state).toBe('done');
    expect(stopped.itemsFetched).toBeGreaterThan(0);
    expect(stopped.itemsFetched).toBeLessThan(ITEMS);
    expect(stopped.updateNotice).toMatch(/This build stopped itself when the machine was down to 60 MB of memory/);
    expect(stopped.updateNotice).toMatch(/under the 100 MB floor/);
    expect(stopped.updateNotice).toMatch(/ZOTEUS_INDEX_MIN_FREE_MB/);
    // Nothing indexed was thrown away.
    expect(stopped.items).toBe(stopped.itemsFetched);

    // Memory back: the next build resumes rather than starting over, and finishes.
    index.memoryHeadroom = () => headroom(4000);
    const finished = await index.buildIncremental(slowFetcher, { versionBackend: 'local' });
    expect(finished.itemsFetched).toBe(ITEMS);
    expect(finished.updateNotice).toMatch(/RESUMED/);
    expect(finished.updateNotice ?? '').not.toMatch(/stopped itself/);
    await index.close();
  }, 30_000);

  it('stops an update the same way, and leaves its version stamp for the next update', async () => {
    const index = await open(backend, 100);
    index.memoryHeadroom = () => headroom(4000);
    const built = await index.buildIncremental(slowFetcher, { versionBackend: 'local' });
    expect(built.itemsFetched).toBe(ITEMS);
    let samples = 0;
    index.memoryHeadroom = () => headroom(++samples > 4 ? 60 : 4000);
    const s = await index.updateIncremental({
      backend: 'local',
      // Every item changed since the build, served as slowly as the build was.
      fetchChanged: async (start: number) => {
        await new Promise((r) => setTimeout(r, 15));
        return { items: items.slice(start, start + 50), totalResults: items.length, lastModifiedVersion: 11 };
      },
      liveKeys: async () => new Set(items.map((i) => i.key)),
    });
    expect(s.state).toBe('done');
    expect(s.updateNotice).toMatch(/^Update stopped after \d+ changed items/);
    expect(s.updateNotice).toMatch(/This update stopped itself when the machine was down to 60 MB of memory/);
    await index.close();
  }, 30_000);

  it('refuses to start a job on a machine already under the floor, and names the remedy', async () => {
    const index = await open(backend, 100);
    index.memoryHeadroom = () => headroom(60);
    await expect(index.buildIncremental(slowFetcher, { versionBackend: 'local' })).rejects.toThrow(
      /Not starting: this machine has 60 MB of memory left \(free RAM plus free swap\), under the 100 MB floor/,
    );
    expect(index.isBuilding).toBe(false);
    // Refused before it claimed anything: the store is untouched and a later job runs.
    index.memoryHeadroom = () => headroom(4000);
    const s = await index.buildIncremental(slowFetcher, { versionBackend: 'local' });
    expect(s.itemsFetched).toBe(ITEMS);
    await index.close();
  }, 30_000);

  it('leaves jobs alone when the operator turns the guard off', async () => {
    const index = await open(backend, 0);
    index.memoryHeadroom = () => headroom(1);
    const s = await index.buildIncremental(slowFetcher, { versionBackend: 'local' });
    expect(s.itemsFetched).toBe(ITEMS);
    expect(s.updateNotice ?? '').not.toMatch(/stopped itself/);
    await index.close();
  }, 30_000);
});
