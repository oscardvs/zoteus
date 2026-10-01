import { describe, it, expect } from 'vitest';
import { createSearchIndex, nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { progressLine, queuedNotice, statusSummary } from '../../src/features/search/build.js';
import type { IndexBuildStatus, SearchIndex } from '../../src/features/search/backend.js';

/**
 * The 2026-10-01 stress test read a running index as a short one: "the index holds 280-295
 * items against 350 in the library; passages without vectors fell from 3,358 to 2,988",
 * measured while a job was still filling it in. A finished index counts every top-level
 * item it reached, text or no text, so nothing was missing; what was missing was a status
 * that said the count was a running one.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const hasSqlite = nodeSqliteAvailable();
const backends: Array<'memory' | 'sqlite'> = hasSqlite ? ['memory', 'sqlite'] : ['memory'];

async function openIndex(backend: 'memory' | 'sqlite'): Promise<SearchIndex> {
  return createSearchIndex({ embedder: null, logger: silentLogger, backend, jsonPath: '' });
}

const item = (key: string, data: Record<string, unknown> = {}) => ({ key, data: { key, ...data } });

/** One page per call, `size` items from a list, in the shape both crawls take. */
function pager(items: any[], size: number, version: number, onPage?: (start: number) => void) {
  return async (start: number) => {
    onPage?.(start);
    return { items: items.slice(start, start + size), totalResults: items.length, lastModifiedVersion: version };
  };
}

describe.each(backends)('what a finished build counts (%s backend)', (backend) => {
  it('counts every top-level item, including ones with no text beyond their key', async () => {
    const search = await openIndex(backend);
    const library = [
      item('ARTICLE1', { itemType: 'journalArticle', title: 'Deep learning', abstractNote: 'Convolutional networks.' }),
      // A standalone attachment and a standalone note as the desktop lists them on
      // /items/top: a title or nothing at all, and no abstract, creators or tags.
      item('ATTACHM1', { itemType: 'attachment', title: 'frames_2026-09-10_10.19.08' }),
      item('NOTEONLY', { itemType: 'note' }),
      item('EMPTYDOC', { itemType: 'document' }),
    ];
    await search.buildIncremental(pager(library, 100, 7));
    const s = search.buildStatus();
    expect(s.state).toBe('done');
    expect(s.items).toBe(4);
    expect(s.itemsFetched).toBe(4);
    expect(s.itemsTotal).toBe(4);
    // Nothing is left out for want of text, so no build owes a "skipped" count.
    expect(progressLine(s)).toContain('4 of 4 items indexed');
    await search.close();
  });
});

describe.each(backends)('a running update says how far through its delta it is (%s backend)', (backend) => {
  it('reports the delta size, and calls the item count a running one until it ends', async () => {
    const search = await openIndex(backend);
    const old = Array.from({ length: 50 }, (_, i) => item(`OLD${String(i).padStart(5, '0')}`, { title: `Old ${i}` }));
    await search.buildIncremental(pager(old, 100, 10));

    const added = Array.from({ length: 100 }, (_, i) => item(`NEW${String(i).padStart(5, '0')}`, { title: `New ${i}` }));
    let midway: IndexBuildStatus | undefined;
    await search.updateIncremental({
      backend: 'local',
      fetchChanged: pager(added, 50, 20, (start) => {
        if (start === 50) midway = search.buildStatus();
      }),
      liveKeys: async () => new Set([...old, ...added].map((i) => i.key)),
    });

    expect(midway).toMatchObject({ state: 'building', operation: 'update', itemsChanged: 100, itemsFetched: 50, items: 100 });
    const line = progressLine(midway!);
    expect(line).toContain('50 of 100 changed items re-indexed');
    expect(line).toContain('100 items in the index so far');
    expect(line).not.toContain('items total');

    const done = search.buildStatus();
    expect(done.state).toBe('done');
    expect(done.items).toBe(150);
    expect(done.itemsChanged).toBe(100);
    // Finished, the count is the index's total again and the delta needs no denominator.
    expect(progressLine(done)).toContain('100 changed items re-indexed, 0 removed, 150 items total');
    await search.close();
  });

  it('carries no itemsChanged on a build, whose denominator is itemsTotal', async () => {
    const search = await openIndex(backend);
    await search.buildIncremental(pager([item('ONLYITEM', { title: 'x' })], 100, 1));
    expect('itemsChanged' in search.buildStatus()).toBe(false);
    await search.close();
  });
});

describe('the embedding queue while a job runs', () => {
  const base = {
    state: 'building',
    operation: 'build',
    phase: 'metadata',
    items: 285,
    itemsFetched: 285,
    itemsTotal: 350,
    itemsAvailable: 350,
    itemsRemoved: 0,
    documents: 4000,
    passages: 4000,
    vectors: 642,
    passagesWithoutVectors: 3358,
    embedder: 'local',
    embedderConfigured: 'local',
    embedderActive: true,
    fulltextEnabled: false,
    fulltextItemsScanned: 0,
    fulltextItemsTotal: 0,
  } as unknown as IndexBuildStatus;

  it('says a running build is still embedding, rather than leaving a falling number unexplained', () => {
    const text = statusSummary(base);
    expect(text).toContain('285 of 350 items indexed');
    expect(text).toContain('3358 passage(s) are still waiting for a vector, which this build adds as it goes');
    // And not the after-the-fact remedy, which would be wrong mid-build.
    expect(text).not.toMatch(/Run zotero_index action:"build" again/);
  });

  it('promises an update only what an update does', () => {
    const text = queuedNotice({ ...base, operation: 'update', itemsChanged: 70 } as IndexBuildStatus);
    expect(text).toMatch(/this update embeds those of the items it re-indexes/);
    expect(text).not.toMatch(/adds as it goes/);
  });

  it('says nothing about a queue once the embedder has failed, or once the job is over', () => {
    expect(queuedNotice({ ...base, embedderActive: false } as IndexBuildStatus)).toBe('');
    const done = { ...base, state: 'done' } as IndexBuildStatus;
    expect(queuedNotice(done)).toBe('');
    // Finished, the same number is a gap, and the existing notice names the remedy.
    expect(statusSummary(done)).toMatch(/3358 indexed passage\(s\) carry no vector yet/);
  });
});
