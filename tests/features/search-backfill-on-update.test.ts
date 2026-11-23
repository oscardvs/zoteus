import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSearchIndex, nodeSqliteAvailable, sqliteIndexPath } from '../../src/features/search/factory.js';
import { createRequire } from 'node:module';
import { FakeEmbeddingProvider, type EmbeddingProvider } from '../../src/features/search/embeddings.js';
import { resetEmbedBudgets, withEmbedBudget } from '../../src/features/search/embed-budget.js';
import type { SearchIndex } from '../../src/features/search/backend.js';

/**
 * An operator flipping ZOTEUS_EMBED_FULLTEXT from false to true over indexes that already
 * hold body passages stored without vectors. Those passages belong to items that have not
 * changed, so no `?since=` delta ever carries them again: action:"update" itself has to
 * find and embed them, inside the per-caller daily allowance, and pick up where it stopped.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

class RecordingEmbedder extends FakeEmbeddingProvider {
  readonly sent: string[] = [];
  override async embed(texts: string[]): Promise<number[][]> {
    this.sent.push(...texts);
    return super.embed(texts);
  }
}

const items = Array.from({ length: 6 }, (_, i) => ({
  key: `K${i}`,
  data: { key: `K${i}`, itemType: 'journalArticle', title: `Paper ${i}`, abstractNote: `Abstract ${i}.` },
}));
const live = new Set(items.map((i) => i.key));
const body = (key: string) => `Body text of ${key} about recurrent gates and ablations. `.repeat(40);
const fetcher = async (start: number) => ({
  items: items.slice(start, start + 100),
  totalResults: items.length,
  lastModifiedVersion: 10,
});
/** An update whose delta is empty: nothing in the library changed. */
const emptyUpdate = {
  backend: 'local' as const,
  fetchChanged: async () => ({ items: [], totalResults: 0, lastModifiedVersion: 10 }),
  liveKeys: async () => live,
};

const backends: Array<'memory' | 'sqlite'> = nodeSqliteAvailable() ? ['memory', 'sqlite'] : ['memory'];

async function open(jsonPath: string, backend: 'memory' | 'sqlite', embedder: EmbeddingProvider, embedFulltext: boolean) {
  return createSearchIndex({ embedder, embedFulltext, logger: silentLogger, backend, jsonPath });
}

/** Build with body text while the operator keeps it out of the embedder, then close. */
async function buildWithoutBodyVectors(jsonPath: string, backend: 'memory' | 'sqlite') {
  const index = await open(jsonPath, backend, new FakeEmbeddingProvider(), false);
  const built = await index.buildIncremental(fetcher, {
    versionBackend: 'local',
    fulltextFor: async (key) => body(key),
  });
  expect(built.fulltextPassages).toBeGreaterThan(0);
  expect(built.vectors).toBe(built.documents - built.fulltextPassages!);
  // Not a shortfall: the server is not allowed to fill it, so it must not be reported as one.
  expect(index.buildStatus().passagesWithoutVectors).toBeUndefined();
  await index.close();
  return built;
}

describe.each(backends)('backfilling vectors on action:"update" (%s)', (backend) => {
  beforeEach(() => resetEmbedBudgets());

  it('embeds body passages stored while ZOTEUS_EMBED_FULLTEXT was false, once it is true', async () => {
    const jsonPath = join(mkdtempSync(join(tmpdir(), 'zoteus-backfill-')), 'search-index.json');
    const built = await buildWithoutBodyVectors(jsonPath, backend);

    // Still false: an update must not send body text, and must not loop or report work.
    const stillOff = new RecordingEmbedder();
    let index: SearchIndex = await open(jsonPath, backend, stillOff, false);
    let s = await index.updateIncremental(emptyUpdate);
    expect(stillOff.sent.some((t) => t.includes('Body text of'))).toBe(false);
    expect(s.vectorsBackfilled).toBeUndefined();
    expect(s.vectors).toBe(built.vectors);
    await index.close();

    // Flipped to true: the same empty delta now embeds every body passage.
    const on = new RecordingEmbedder();
    index = await open(jsonPath, backend, on, true);
    s = await index.updateIncremental(emptyUpdate);
    expect(s.vectors).toBe(s.documents);
    expect(s.vectorsBackfilled).toBe(built.fulltextPassages);
    expect(s.passagesWithoutVectors).toBeUndefined();
    expect(s.updateNotice).toMatch(new RegExp(`${built.fulltextPassages} passage\\(s\\) indexed earlier without a vector were embedded`));
    // Only the missing ones: no metadata passage was bought a second time.
    expect(on.sent).toHaveLength(built.fulltextPassages!);
    await index.close();

    // And durable: a reopened index holds the vectors and the next update has nothing to do.
    const after = new RecordingEmbedder();
    index = await open(jsonPath, backend, after, true);
    s = await index.updateIncremental(emptyUpdate);
    expect(s.vectors).toBe(s.documents);
    expect(after.sent).toHaveLength(0);
    expect(s.vectorsBackfilled).toBeUndefined();
    await index.close();
  });

  it('stops cleanly when the daily allowance runs out, keeps what it embedded, and the next update continues', async () => {
    const jsonPath = join(mkdtempSync(join(tmpdir(), 'zoteus-backfill-budget-')), 'search-index.json');
    const built = await buildWithoutBodyVectors(jsonPath, backend);
    const missing = built.fulltextPassages!;
    expect(missing).toBeGreaterThan(2);

    // An allowance worth a couple of body passages: the default embed batch is larger than
    // the shortfall, so pace it one passage per request to let the allowance bite mid-way.
    const perPassage = Math.ceil(body('K0').length / 4);
    let today = new Date('2026-11-20T10:00:00Z');
    const clock = () => today;
    const inner = new RecordingEmbedder();
    const limited = withEmbedBudget(inner, 'user:42', perPassage * 2, clock);
    let index: SearchIndex = await open(jsonPath, backend, limited, true);
    let s = await index.updateIncremental({ ...emptyUpdate, embedBatchSize: 1 });
    expect(s.state).toBe('done');
    expect(s.vectorsBackfilled).toBeGreaterThan(0);
    expect(s.vectorsBackfilled).toBeLessThan(missing);
    const firstRound = s.vectorsBackfilled!;
    expect(s.passagesWithoutVectors).toBe(missing - firstRound);
    expect(s.updateNotice).toMatch(/allowance ran out/);
    expect(s.updateNotice).toMatch(/next zotero_index action:"update" embeds the rest/);
    expect(s.embedderReason).toMatch(/daily allowance/);
    await index.close();

    // The next day, a reopened index (what a hosted tenant gets after eviction) continues
    // from where the first update stopped and finishes.
    today = new Date('2026-11-21T10:00:00Z');
    const fresh = withEmbedBudget(inner, 'user:42', perPassage * 1000, clock);
    index = await open(jsonPath, backend, fresh, true);
    expect(index.buildStatus().vectors).toBe(built.vectors + firstRound);
    s = await index.updateIncremental(emptyUpdate);
    expect(s.vectorsBackfilled).toBe(missing - firstRound);
    expect(s.vectors).toBe(s.documents);
    expect(s.passagesWithoutVectors).toBeUndefined();
    await index.close();
  });

  it('a build also fills vectors an earlier job left out', async () => {
    const jsonPath = join(mkdtempSync(join(tmpdir(), 'zoteus-backfill-build-')), 'search-index.json');
    const built = await buildWithoutBodyVectors(jsonPath, backend);
    // A build that resumes nothing starts over, so it embeds everything as it indexes it;
    // what matters here is that the flag being on leaves no passage without a vector.
    const index = await open(jsonPath, backend, new FakeEmbeddingProvider(), true);
    const s = await index.buildIncremental(fetcher, { versionBackend: 'local', fulltextFor: async (key) => body(key) });
    expect(s.documents).toBe(built.documents);
    expect(s.vectors).toBe(s.documents);
    await index.close();
  });
});

/**
 * The two costs a backfill used to pay on every page, both measured on 2026-11-23 over a
 * synthetic 117k-passage library: each page of 500 re-read the table from its first row to
 * find the next 500 without a vector, and each round then walked the whole table again to
 * code the vectors it had bought. Together they made a 102k-passage backfill take 114 s,
 * in stalls of up to 1.2 s; with both gone it takes 15 s.
 */
describe.skipIf(!nodeSqliteAvailable())('backfill paging and codes (sqlite)', () => {
  beforeEach(() => resetEmbedBudgets());

  const DatabaseSync = nodeSqliteAvailable()
    ? (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')).DatabaseSync
    : (undefined as never);

  it('pages through the passages without a vector instead of starting at the top each time', async () => {
    const jsonPath = join(mkdtempSync(join(tmpdir(), 'zoteus-backfill-pages-')), 'search-index.json');
    const built = await buildWithoutBodyVectors(jsonPath, 'sqlite');
    expect(built.fulltextPassages).toBeGreaterThanOrEqual(6);
    const index = await open(jsonPath, 'sqlite', new FakeEmbeddingProvider(), true);
    const store = index as unknown as {
      passagesMissingVectors(limit: number, includeFulltext: boolean, resume?: boolean): Array<{ id: string }>;
    };
    const first = store.passagesMissingVectors(3, true).map((r) => r.id);
    // Nothing was embedded in between, so a page from the top would be the same three.
    const second = store.passagesMissingVectors(3, true, true).map((r) => r.id);
    expect(first).toHaveLength(3);
    expect(second).toHaveLength(3);
    expect(second.some((id) => first.includes(id))).toBe(false);
    // Asked from the top again, it starts over.
    expect(store.passagesMissingVectors(3, true).map((r) => r.id)).toEqual(first);
    await index.close();
  });

  it('leaves the binary codes level with the vectors after a backfill of several pages', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      key: `M${i}`,
      data: { key: `M${i}`, itemType: 'journalArticle', title: `Monograph ${i}`, abstractNote: `Abstract ${i}.` },
    }));
    const bigBody = (key: string) => `Chapter text of ${key} on counterpoint, cadence and tuning systems. `.repeat(400);
    const manyFetcher = async (start: number) => ({
      items: many.slice(start, start + 100),
      totalResults: many.length,
      lastModifiedVersion: 10,
    });
    const manyLive = new Set(many.map((i) => i.key));
    const jsonPath = join(mkdtempSync(join(tmpdir(), 'zoteus-backfill-codes-')), 'search-index.json');
    const openWithCodes = (embedFulltext: boolean) =>
      createSearchIndex({
        embedder: new FakeEmbeddingProvider(),
        embedFulltext,
        logger: silentLogger,
        backend: 'sqlite',
        jsonPath,
        annMinCandidates: 1,
      });

    let index = await openWithCodes(false);
    const built = await index.buildIncremental(manyFetcher, {
      versionBackend: 'local',
      fulltextFor: async (key) => bigBody(key),
    });
    await index.close();
    // More than one page of 500, so the second page comes from the cursor.
    expect(built.fulltextPassages).toBeGreaterThan(500);

    index = await openWithCodes(true);
    const s = await index.updateIncremental({
      backend: 'local',
      fetchChanged: async () => ({ items: [], totalResults: 0, lastModifiedVersion: 10 }),
      liveKeys: async () => manyLive,
    });
    expect(s.vectorsBackfilled).toBe(built.fulltextPassages);
    expect(s.vectors).toBe(s.documents);
    await index.close();

    const db = new DatabaseSync(sqliteIndexPath(jsonPath));
    const codes = (db.prepare('SELECT count(*) AS n FROM vector_codes').get() as { n: number }).n;
    const vectors = (db.prepare('SELECT count(*) AS n FROM passages WHERE vector IS NOT NULL').get() as { n: number }).n;
    db.close();
    expect(vectors).toBe(s.documents);
    expect(codes).toBe(vectors);
  });
});
