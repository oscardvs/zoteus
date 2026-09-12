import { describe, it, expect, vi } from 'vitest';
import { MemorySearchIndex, type SearchIndex } from '../../src/features/search/index-manager.js';
import { startIndexBuild, statusSummary, PAGE_SIZE } from '../../src/features/search/build.js';
import {
  DEFAULT_FULLTEXT_CONCURRENCY_CLOUD,
  DEFAULT_FULLTEXT_CONCURRENCY_LOCAL,
  SATURATED_FULLTEXT_CONCURRENCY,
} from '../../src/features/search/limits.js';
import { LocalApiStatus } from '../../src/router/local-status.js';
import { loadConfig } from '../../src/config.js';
import type { Capabilities } from '../../src/router/capabilities.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * A build whose full-text reads report how many of them were ever in flight at once.
 *
 * The semaphore inside the build is what bounds that number, so counting arrivals and
 * departures in the router double is a direct measurement of the concurrency in force,
 * with no access to the semaphore itself (#39).
 */
function makeCtx(opts: {
  items: number;
  /** Whether the router serves this library from the desktop app (pins backend:"local"). */
  local: boolean;
  config?: Record<string, string>;
  /** Called on every full-text read, with the number of reads issued so far. */
  onFetch?: (n: number, stats: Stats) => void | Promise<void>;
  /** A live LocalApiStatus for the build to watch, where the test drives one. */
  localStatus?: LocalApiStatus;
  capabilities?: Capabilities;
}) {
  const items = Array.from({ length: opts.items }, (_, i) => ({
    key: `K${i}`,
    data: { itemType: 'journalArticle', title: `Item ${i}`, abstractNote: `abstract ${i}` },
  }));
  const attachments = items.map((it) => ({
    key: `A${it.key}`,
    data: { key: `A${it.key}`, itemType: 'attachment', contentType: 'application/pdf', parentItem: it.key },
  }));
  const withText = Object.fromEntries(attachments.map((a, i) => [a.key, i + 1]));

  const stats: Stats = { active: 0, peak: 0, calls: 0 };
  const getFullText = vi.fn(async (key: string) => {
    stats.calls++;
    stats.active++;
    stats.peak = Math.max(stats.peak, stats.active);
    try {
      await opts.onFetch?.(stats.calls, stats);
      // A real full-text read is a round trip; without a turn of the event loop here every
      // fetch would resolve before the next was even dispatched and nothing would overlap.
      await new Promise((r) => setTimeout(r, 1));
      return { content: `body of ${key} `.repeat(20) };
    } finally {
      stats.active--;
    }
  });

  const searchItems = vi.fn(async (q: any) => {
    const start = q.start ?? 0;
    let source: any[] = q.itemType === 'attachment' ? attachments : items;
    // The attachment map asks by key, 50 at a time, so the double has to answer by key.
    if (q.itemKey) {
      const want = new Set(String(q.itemKey).split(','));
      source = source.filter((row) => want.has(row.key));
    }
    return {
      data: source.slice(start, start + (q.limit ?? PAGE_SIZE)),
      totalResults: source.length,
      lastModifiedVersion: 7,
    };
  });

  const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
  const ctx: any = {
    // Own words are a separate crawl with separate doubles; this file is about the
    // full-text pass, so keep them out of the way.
    config: loadConfig({ ZOTEUS_INDEX_OWN_WORDS: 'false', ...(opts.config ?? {}) } as any),
    capabilities: opts.capabilities,
    router: {
      fullTextSince: vi.fn(async () => withText),
      getFullText,
      searchItems,
      servesLocally: () => opts.local,
      defaultLibrary: () => ({ type: 'user', id: 1 }),
    },
    search,
    logger: silentLogger,
    searchIndexPath: '',
    localStatus: opts.localStatus,
  };
  return { ctx, search, stats, getFullText };
}

interface Stats {
  active: number;
  peak: number;
  calls: number;
}

async function finished(search: SearchIndex): Promise<void> {
  for (let i = 0; i < 2000 && search.buildStatus().state === 'building'; i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** A LocalApiStatus the test can push from "up" to "down" on demand. */
function makeLocalStatus() {
  const capabilities: Capabilities = { cloud: null, localApi: true, localGroupIds: [] };
  let up = true;
  const status = new LocalApiStatus({
    config: loadConfig({ ZOTEUS_LOCAL: 'auto' } as any),
    client: { probe: async () => ({ up, timedOut: false }), listLocalGroupIds: async () => [] } as any,
    capabilities,
    logger: silentLogger,
  });
  return {
    status,
    capabilities,
    /**
     * Saturate the app. Two probes because one failure is not enough to declare a running
     * Zotero gone (FAILURES_BEFORE_DOWN), which is the same path the real down-edge takes.
     */
    async saturate() {
      up = false;
      await status.ensure({ force: true });
      await status.ensure({ force: true });
    },
  };
}

describe('full-text fetch concurrency (#39)', () => {
  it('holds the local API to fewer concurrent reads than the Web API', async () => {
    const local = makeCtx({ items: 40, local: true });
    startIndexBuild(local.ctx, undefined, undefined, { fulltext: true });
    await finished(local.search);
    expect(local.stats.calls).toBe(40);
    expect(local.stats.peak).toBe(DEFAULT_FULLTEXT_CONCURRENCY_LOCAL);

    const cloud = makeCtx({ items: 40, local: false });
    startIndexBuild(cloud.ctx, undefined, undefined, { fulltext: true });
    await finished(cloud.search);
    expect(cloud.stats.peak).toBe(DEFAULT_FULLTEXT_CONCURRENCY_CLOUD);

    // The point of the split: the desktop app is held to strictly less than the cloud.
    expect(DEFAULT_FULLTEXT_CONCURRENCY_LOCAL).toBeLessThan(DEFAULT_FULLTEXT_CONCURRENCY_CLOUD);
  });

  it('lets ZOTEUS_INDEX_FULLTEXT_CONCURRENCY override both defaults', async () => {
    const config = { ZOTEUS_INDEX_FULLTEXT_CONCURRENCY: '1' };
    for (const local of [true, false]) {
      const { ctx, search, stats } = makeCtx({ items: 20, local, config });
      startIndexBuild(ctx, undefined, undefined, { fulltext: true });
      await finished(search);
      expect(stats.peak).toBe(1);
    }
  });

  it('ignores an unusable value and keeps the backend-aware default', async () => {
    const { ctx, search, stats } = makeCtx({
      items: 20,
      local: true,
      config: { ZOTEUS_INDEX_FULLTEXT_CONCURRENCY: 'lots' },
    });
    startIndexBuild(ctx, undefined, undefined, { fulltext: true });
    await finished(search);
    expect(stats.peak).toBe(DEFAULT_FULLTEXT_CONCURRENCY_LOCAL);
  });
});

describe('degradation to the Web API (#39)', () => {
  it('backs the crawl off to one read at a time once Zotero stops answering', async () => {
    const local = makeLocalStatus();
    let saturated = false;
    const { ctx, search, stats } = makeCtx({
      items: 60,
      local: true,
      localStatus: local.status,
      capabilities: local.capabilities,
      async onFetch(n, s) {
        if (n === 10) {
          await local.saturate();
          saturated = true;
        }
        // Measure the post-degradation peak from a point where the reads that were already
        // in flight when the ceiling dropped have certainly finished.
        if (n === 24) s.peak = 0;
      },
    });
    startIndexBuild(ctx, undefined, undefined, { fulltext: true });
    await finished(search);

    expect(saturated).toBe(true);
    expect(stats.calls).toBe(60);
    expect(stats.peak).toBe(SATURATED_FULLTEXT_CONCURRENCY);
  });

  it('records on the status that the build degraded, and when', async () => {
    const local = makeLocalStatus();
    const before = Date.now();
    const { ctx, search } = makeCtx({
      items: 30,
      local: true,
      localStatus: local.status,
      capabilities: local.capabilities,
      async onFetch(n) {
        if (n === 5) await local.saturate();
      },
    });
    startIndexBuild(ctx, undefined, undefined, { fulltext: true });
    await finished(search);

    const s = search.buildStatus();
    expect(s.state).toBe('done');
    expect(s.localApiDegradedAt).toBeTruthy();
    expect(Date.parse(s.localApiDegradedAt!)).toBeGreaterThanOrEqual(before);
    // Legible without reading the log: the summary a caller of action:"status" is handed
    // has to say what happened and what it cost, which is the whole complaint in #39.
    expect(statusSummary(s)).toMatch(/local API stopped answering/i);
    expect(statusSummary(s)).toMatch(/Web API/);
  });

  it('says nothing when the local API held up, and clears the flag on the next build', async () => {
    const local = makeLocalStatus();
    const { ctx, search } = makeCtx({
      items: 20,
      local: true,
      localStatus: local.status,
      capabilities: local.capabilities,
      async onFetch(n) {
        if (n === 5) await local.saturate();
      },
    });
    startIndexBuild(ctx, undefined, undefined, { fulltext: true });
    await finished(search);
    expect(search.buildStatus().localApiDegradedAt).toBeTruthy();

    // The app came back, and a fresh build must report on ITSELF rather than inheriting the
    // last one's bad afternoon.
    local.capabilities.localApi = true;
    startIndexBuild(ctx, undefined, undefined, { fulltext: true, fresh: true });
    await finished(search);
    const s = search.buildStatus();
    expect(s.localApiDegradedAt).toBeUndefined();
    expect(statusSummary(s)).not.toMatch(/stopped answering/i);
  });

  it('leaves a cloud build alone: nothing there can saturate a desktop app', async () => {
    const local = makeLocalStatus();
    const { ctx, search, stats } = makeCtx({
      items: 40,
      local: false,
      localStatus: local.status,
      capabilities: local.capabilities,
      async onFetch(n) {
        if (n === 5) await local.saturate();
      },
    });
    startIndexBuild(ctx, undefined, undefined, { fulltext: true });
    await finished(search);

    // The crawl was never reading from the desktop app, so a desktop app going away is not
    // this build's problem and must not throttle it or appear on its status.
    expect(search.buildStatus().localApiDegradedAt).toBeUndefined();
    expect(stats.peak).toBe(DEFAULT_FULLTEXT_CONCURRENCY_CLOUD);
  });
});
