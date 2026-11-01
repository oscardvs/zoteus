import { describe, it, expect } from 'vitest';
import { createSearchIndex } from '../../src/features/search/factory.js';
import { startIndexBuild, startIndexUpdate } from '../../src/features/search/build.js';
import type { SearchIndex } from '../../src/features/search/backend.js';
import { loadConfig } from '../../src/config.js';

/**
 * The unresponsiveness of #106: an update whose full-text catch-up re-reads a page of
 * attachments used to spend that whole page inside synchronous chunking and store writes,
 * so the event loop answered nothing — every tool call from every connected client timed
 * out, and `action:"status"` could not even observe the job it was asked about. The loop
 * now yields between the body writes; this test holds a timer up against a catch-up over
 * genuinely large bodies and asserts the loop kept turning *during* the job, not merely
 * between its batches.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** The slice of a ToolContext the index starters read, typed loosely like search-resume's. */
function makeCtx(search: SearchIndex, router: unknown): any {
  return { config: loadConfig({} as any), search, router, logger: silentLogger, searchIndexPath: '' };
}

/** Big enough that chunking one body is hundreds of ms: 2 MB of ordinary words. */
const WORDS = 'experiment reliability replication variance significance. ';
function bigBody(mb: number): string {
  return WORDS.repeat(Math.ceil((mb * 1024 * 1024) / WORDS.length));
}

/**
 * A library of N items, one attachment each, built like the real one: a metadata crawl, an
 * attachment map, and `/fulltext?since=` on a sequence of its own.
 */
class FakeZotero {
  itemVersion = 0;
  fulltextVersion = 0;
  private readonly items = new Map<string, { key: string; version: number; data: any }>();
  private readonly attachments = new Map<
    string,
    { key: string; parent?: string; version?: number; content?: string }
  >();

  putItem(key: string, title: string): void {
    this.itemVersion++;
    this.items.set(key, { key, version: this.itemVersion, data: { key, itemType: 'journalArticle', title } });
  }

  attach(key: string, parent?: string): void {
    this.itemVersion++;
    this.attachments.set(key, { key, parent });
  }

  extract(key: string, content: string): void {
    this.fulltextVersion++;
    const att = this.attachments.get(key);
    if (!att) throw new Error(`no attachment ${key}`);
    att.version = this.fulltextVersion;
    att.content = content;
  }

  router() {
    const items = () => [...this.items.values()];
    const atts = () => [...this.attachments.values()];
    return {
      servesLocally: () => false,
      defaultLibrary: () => ({ type: 'user' as const, id: 1 }),
      searchItems: async (q: any) => {
        const start = q.start ?? 0;
        const limit = q.limit ?? 100;
        if (q.itemType === 'attachment') {
          const want = q.itemKey ? new Set(String(q.itemKey).split(',')) : undefined;
          const all = want ? atts().filter((a) => want.has(a.key)) : atts();
          const page = all.slice(start, start + limit);
          return {
            data: page.map((a) => ({ key: a.key, data: { key: a.key, itemType: 'attachment', parentItem: a.parent } })),
            totalResults: all.length,
            lastModifiedVersion: this.itemVersion,
          };
        }
        const matching = items().filter((it) => it.version > (q.since ?? 0));
        return {
          data: matching.slice(start, start + limit).map((it) => ({ key: it.key, data: it.data })),
          totalResults: matching.length,
          lastModifiedVersion: this.itemVersion,
        };
      },
      itemVersions: async (q: any) => {
        const start = q.start ?? 0;
        const page = items().slice(start, start + (q.limit ?? 100));
        return {
          versions: Object.fromEntries(page.map((it) => [it.key, it.version])),
          totalResults: items().length,
          lastModifiedVersion: this.itemVersion,
        };
      },
      fullTextSince: async (since: number) =>
        Object.fromEntries(
          atts()
            .filter((a) => a.version !== undefined && a.version > since)
            .map((a) => [a.key, a.version!]),
        ),
      getFullText: async (key: string) => {
        const att = this.attachments.get(key);
        return att?.content ? { content: att.content } : null;
      },
    };
  }
}

async function settle(search: SearchIndex, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (search.isBuilding && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  expect(search.isBuilding).toBe(false);
}

describe('an update stays responsive while its full-text catch-up re-reads large bodies (#106)', () => {
  it('keeps the event loop turning through the catch-up, and reports the stalls it did have', async () => {
    const N = 16;
    const zotero = new FakeZotero();
    for (let i = 0; i < N; i++) {
      const k = `K${i}`;
      zotero.putItem(k, `Study ${i}`);
      zotero.attach(`A${i}`, k);
      zotero.extract(`A${i}`, 'placeholder abstract text. ');
    }
    const search = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'memory', jsonPath: '' });
    const ctx = makeCtx(search, zotero.router());

    startIndexBuild(ctx, undefined, undefined, { fulltext: true, fulltextMaxChars: 0 });
    await settle(search);
    expect(search.buildStatus().state).toBe('done');

    // Zotero extracts every PDF after the build: the item sequence does not move, the
    // full-text sequence does, and the next update's delta is empty while its catch-up
    // has every item to re-read — the exact shape that went dark in #106.
    const body = bigBody(2);
    for (let i = 0; i < N; i++) zotero.extract(`A${i}`, body);

    // The watchdog: between two ticks the loop must have turned, so the largest gap is
    // the longest busy stretch the job inflicted on every other request.
    let last = Date.now();
    let maxGap = 0;
    const watchdog = setInterval(() => {
      const now = Date.now();
      if (now - last > maxGap) maxGap = now - last;
      last = now;
    }, 25);

    const started = Date.now();
    startIndexUpdate(ctx, undefined, undefined, { fulltext: true, fulltextMaxChars: 0 });
    await settle(search);
    // A job that blocks the loop from start to finish can end before the overdue tick ever
    // runs, and `settle` then returns in the same turn, so the watchdog would read 0. The
    // time since its last tick is that unmeasured stretch.
    maxGap = Math.max(maxGap, Date.now() - last);
    clearInterval(watchdog);
    const elapsed = Date.now() - started;

    const s = search.buildStatus();
    // The catch-up did the work, and did it through the loop, not over its head.
    expect(s.state).toBe('done');
    expect(s.itemsFetched).toBe(0);
    expect(s.updateNotice).toMatch(new RegExp(`${N} unchanged item\\(s\\) gained newly extracted attachment full text`));
    expect(elapsed).toBeGreaterThan(0);
    // Measured on a laptop: with the yield the longest stall is about 230 ms of a 1.5 s job;
    // without it the whole re-read of all N bodies is one stall of about 1.2 s, which is
    // under any fixed bound a slow CI runner would also pass. So the bound is a
    // share of the job's own duration, which scales with the machine: one body's writes
    // are a sixteenth of the work, an unyielded page is all of it.
    expect(maxGap).toBeLessThan(elapsed / 3);
    expect(s.worstLoopStallMs).toBeLessThan(elapsed / 3);
    await search.close();
  }, 120_000);
});

describe("a build's full-text pass stays responsive over large bodies (#106)", () => {
  it('yields between the body writes of a page, not only between pages', async () => {
    // The build writes a page of bodies the same synchronous way the catch-up does, and
    // a page holds up to 100 items, so 16 large bodies are one page: without the per-item
    // yield, the whole pass is one stall.
    const N = 16;
    const zotero = new FakeZotero();
    const body = bigBody(2);
    for (let i = 0; i < N; i++) {
      zotero.putItem(`K${i}`, `Study ${i}`);
      zotero.attach(`A${i}`, `K${i}`);
      zotero.extract(`A${i}`, body);
    }
    const search = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'memory', jsonPath: '' });
    const ctx = makeCtx(search, zotero.router());

    const started = Date.now();
    startIndexBuild(ctx, undefined, undefined, { fulltext: true, fulltextMaxChars: 0 });
    await settle(search);
    const elapsed = Date.now() - started;

    const s = search.buildStatus();
    expect(s.state).toBe('done');
    expect(s.fulltextItemsScanned).toBe(N);
    // The same share-of-the-job bound as the catch-up test above, for the same reason.
    expect(s.worstLoopStallMs).toBeLessThan(elapsed / 3);
    await search.close();
  }, 120_000);
});
