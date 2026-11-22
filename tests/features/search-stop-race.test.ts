import { describe, it, expect } from 'vitest';
import { createSearchIndex, nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { statusSummary } from '../../src/features/search/build.js';
import type { SearchIndex } from '../../src/features/search/backend.js';

/**
 * #120: `action:"stop"` is cooperative, so a job keeps draining after it. An update issued
 * in that window must not be accepted as if it had started, and a stop must only ever
 * cancel the job it was issued against, never one started after it.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const backends: Array<'memory' | 'sqlite'> = nodeSqliteAvailable() ? ['memory', 'sqlite'] : ['memory'];

const item = (key: string) => ({ key, data: { key, itemType: 'journalArticle', title: `Title ${key}` } });

function pager(items: any[], version: number) {
  return async (start: number) => ({
    items: items.slice(start, start + 10),
    totalResults: items.length,
    lastModifiedVersion: version,
  });
}

/** A delta fetcher that stalls on its first page until released, like a saturated Zotero. */
function stallingDelta(items: any[], version: number) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let reached!: () => void;
  const stalled = new Promise<void>((r) => (reached = r));
  const fetchChanged = async (start: number) => {
    if (start === 0) {
      reached();
      await gate;
    }
    return { items: items.slice(start, start + 10), totalResults: items.length, lastModifiedVersion: version };
  };
  return { fetchChanged, release, stalled };
}

async function indexed(backend: 'memory' | 'sqlite'): Promise<{ search: SearchIndex; keys: string[] }> {
  const search = await createSearchIndex({ embedder: null, logger: silentLogger, backend, jsonPath: '' });
  const lib = Array.from({ length: 20 }, (_, i) => item(`OLD${String(i).padStart(5, '0')}`));
  await search.buildIncremental(pager(lib, 10));
  return { search, keys: lib.map((i) => i.key) };
}

describe.each(backends)('stop while a job drains (%s backend)', (backend) => {
  it('reports "stopping" and refuses a new update until the old job has drained', async () => {
    const { search, keys } = await indexed(backend);
    const delta = [item('NEW00001')];
    const old = stallingDelta(delta, 11);
    const live = async () => new Set([...keys, 'NEW00001']);
    const first = search.updateIncremental({ backend: 'local', fetchChanged: old.fetchChanged, liveKeys: live });
    await old.stalled;

    const job = search.buildStatus().job;
    expect(job).toBeGreaterThan(0);
    expect(search.requestStop(job)).toBe(true);
    const draining = search.buildStatus();
    expect(draining.state).toBe('stopping');
    expect(statusSummary(draining)).toMatch(/stopping/);

    // The recovery script's fresh update: refused loudly, nothing started.
    await expect(
      search.updateIncremental({ backend: 'local', fetchChanged: pager(delta, 11), liveKeys: live }),
    ).rejects.toThrow(/still stopping/);

    old.release();
    const stopped = await first;
    expect(stopped.state).toBe('done');
    expect(stopped.updateNotice).toMatch(/Update stopped/);
    expect(search.buildStatus().libraryVersion).toBe(10);

    // Drained: the retry runs to completion and advances the stamp.
    const fresh = await search.updateIncremental({ backend: 'local', fetchChanged: pager(delta, 11), liveKeys: live });
    expect(fresh.state).toBe('done');
    expect(fresh.updateNotice).not.toMatch(/stopped/);
    expect(fresh.libraryVersion).toBe(11);
    await search.close();
  });

  it('a stop bound to an earlier job never cancels a later one', async () => {
    const { search, keys } = await indexed(backend);
    const earlier = search.buildStatus().job!;
    const delta = [item('NEW00002')];
    const next = stallingDelta(delta, 12);
    const live = async () => new Set([...keys, 'NEW00002']);
    const run = search.updateIncremental({ backend: 'local', fetchChanged: next.fetchChanged, liveKeys: live });
    await next.stalled;

    const current = search.buildStatus().job!;
    expect(current).toBeGreaterThan(earlier);
    // The late stop, still naming the job it was issued against.
    expect(search.requestStop(earlier)).toBe(false);
    expect(search.buildStatus().state).toBe('building');

    next.release();
    const final = await run;
    expect(final.updateNotice ?? '').not.toMatch(/stopped/);
    expect(final.libraryVersion).toBe(12);
    await search.close();
  });
});
