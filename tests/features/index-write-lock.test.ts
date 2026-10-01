import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createSearchIndex, nodeSqliteAvailable, sqliteIndexPath } from '../../src/features/search/factory.js';
import { FakeEmbeddingProvider } from '../../src/features/search/embeddings.js';
import type { SearchIndex } from '../../src/features/search/backend.js';

/**
 * The 2026-10-01 stress test: Claude Desktop's Zoteus ran an `action:"update"` that embedded
 * ~3,000 passages on a local CPU model, inside the update's one write transaction, and held
 * SQLite's writer lock for minutes. Every other Zoteus process sharing the data directory
 * waited on it and failed. Embedding is the slow part of every job, so no job may hold the
 * writer lock across an embedding request: a sibling asking for the lock at that moment must
 * get it at once.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const sqliteIt = nodeSqliteAvailable() ? it : it.skip;
// Required rather than imported, as in search-wal.test.ts: the bundler cannot resolve it.
const DatabaseSync = (
  nodeSqliteAvailable() ? (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')) : undefined
)?.DatabaseSync as typeof import('node:sqlite').DatabaseSync;

const item = (key: string, title: string) => ({
  key,
  data: { key, itemType: 'journalArticle', title, abstractNote: `${title}: a study of neural networks.` },
});

function pager(items: any[], size: number, version: number, failAt?: number) {
  return async (start: number) => {
    if (failAt !== undefined && start >= failAt) throw new Error('Zotero went away mid-delta');
    return { items: items.slice(start, start + size), totalResults: items.length, lastModifiedVersion: version };
  };
}

/**
 * An embedder that, at the moment each request arrives, has a second connection try to take
 * the writer lock without waiting, the way a sibling process would. Records each attempt.
 */
class SiblingProbingEmbedder extends FakeEmbeddingProvider {
  attempts: Array<'free' | 'locked'> = [];
  itemsVisible: number[] = [];
  constructor(private readonly file: () => string) {
    super();
  }
  override async embed(texts: string[]): Promise<number[][]> {
    const sibling = new DatabaseSync(this.file());
    try {
      sibling.exec('PRAGMA busy_timeout = 0');
      try {
        sibling.exec('BEGIN IMMEDIATE');
        sibling.exec('ROLLBACK');
        this.attempts.push('free');
      } catch {
        this.attempts.push('locked');
      }
      this.itemsVisible.push((sibling.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n);
    } finally {
      sibling.close();
    }
    return super.embed(texts);
  }
}

async function open(embedder: FakeEmbeddingProvider): Promise<{ search: SearchIndex; file: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'zoteus-writelock-'));
  const jsonPath = join(dir, 'search-index.json');
  const search = await createSearchIndex({ backend: 'sqlite', jsonPath, embedder, logger: silentLogger });
  return { search, file: sqliteIndexPath(jsonPath) };
}

describe('no job holds the writer lock across an embedding request', () => {
  sqliteIt('a build commits before each request', async () => {
    let file = '';
    const embedder = new SiblingProbingEmbedder(() => file);
    const opened = await open(embedder);
    file = opened.file;
    const library = Array.from({ length: 120 }, (_, i) => item(`B${String(i).padStart(7, '0')}`, `Paper ${i}`));
    await opened.search.buildIncremental(pager(library, 50, 7));

    expect(embedder.attempts.length).toBeGreaterThan(1);
    expect(embedder.attempts.every((a) => a === 'free')).toBe(true);
    const s = opened.search.buildStatus();
    expect(s.vectors).toBe(s.documents);
    await opened.search.close();
  });

  sqliteIt('an update commits its delta first and embeds after, a batch at a time', async () => {
    let file = '';
    const embedder = new SiblingProbingEmbedder(() => file);
    const opened = await open(embedder);
    file = opened.file;
    const old = Array.from({ length: 20 }, (_, i) => item(`O${String(i).padStart(7, '0')}`, `Old ${i}`));
    await opened.search.buildIncremental(pager(old, 100, 10));
    embedder.attempts = [];
    embedder.itemsVisible = [];

    const added = Array.from({ length: 80 }, (_, i) => item(`N${String(i).padStart(7, '0')}`, `New ${i}`));
    await opened.search.updateIncremental({
      backend: 'local',
      fetchChanged: pager(added, 25, 20),
      liveKeys: async () => new Set([...old, ...added].map((i) => i.key)),
    });

    expect(embedder.attempts.length).toBeGreaterThan(1);
    expect(embedder.attempts.every((a) => a === 'free')).toBe(true);
    // The whole delta was already committed when the first request went out: a sibling
    // reading the file saw every item, which is what makes the embedding safe to do outside it.
    expect(embedder.itemsVisible[0]).toBe(100);
    const s = opened.search.buildStatus();
    expect(s.state).toBe('done');
    expect(s.items).toBe(100);
    expect(s.vectors).toBe(s.documents);
    expect(s.libraryVersion).toBe(20);
    await opened.search.close();
  });

  sqliteIt('an update that fails mid-delta still rolls back whole, and embeds nothing of it', async () => {
    let file = '';
    const embedder = new SiblingProbingEmbedder(() => file);
    const opened = await open(embedder);
    file = opened.file;
    const old = Array.from({ length: 10 }, (_, i) => item(`O${String(i).padStart(7, '0')}`, `Old ${i}`));
    await opened.search.buildIncremental(pager(old, 100, 10));
    const before = opened.search.buildStatus();
    embedder.attempts = [];

    const added = Array.from({ length: 60 }, (_, i) => item(`N${String(i).padStart(7, '0')}`, `New ${i}`));
    await opened.search.updateIncremental({
      backend: 'local',
      fetchChanged: pager(added, 25, 20, 50),
      liveKeys: async () => new Set([...old, ...added].map((i) => i.key)),
    });

    const s = opened.search.buildStatus();
    expect(s.state).toBe('error');
    expect(s.items).toBe(before.items);
    expect(s.documents).toBe(before.documents);
    expect(s.libraryVersion).toBe(10);
    expect(embedder.attempts).toEqual([]);
    await opened.search.close();
  });
});

/**
 * One job per index file, across processes. A build that finds no checkpoint to resume
 * starts by emptying the store, so a second process that started one while the first was
 * mid-build wiped the first one's rows. Measured on 2026-10-01: fresh processes searching
 * every two seconds during a 350-item build auto-started builds of their own, and the build
 * they interrupted finished with 557 of 1967 passages carrying no vector.
 */
describe('one build or update per index file', () => {
  const lib = Array.from({ length: 60 }, (_, i) => item(`L${String(i).padStart(7, '0')}`, `Paper ${i}`));

  async function twoHandles() {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-lease-'));
    const jsonPath = join(dir, 'search-index.json');
    const open = () =>
      createSearchIndex({ backend: 'sqlite', jsonPath, embedder: new FakeEmbeddingProvider(), logger: silentLogger });
    return { first: await open(), second: await open(), file: sqliteIndexPath(jsonPath) };
  }

  sqliteIt('refuses a second job while one runs, and leaves the running one whole', async () => {
    const { first, second } = await twoHandles();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchPage = async (start: number) => {
      if (start >= 25) await gate;
      return { items: lib.slice(start, start + 25), totalResults: lib.length, lastModifiedVersion: 9 };
    };
    const running = first.buildIncremental(fetchPage);
    // Let the first page commit, so the store holds rows a second build would have erased.
    await new Promise((r) => setTimeout(r, 50));

    second.syncFromStore?.();
    expect(second.jobElsewhere?.()).toMatchObject({ pid: process.pid, kind: 'build' });
    expect(second.buildStatus().elsewhere).toMatchObject({ kind: 'build' });
    await expect(second.buildIncremental(async () => ({ items: [], totalResults: 0, lastModifiedVersion: 9 }))).rejects.toThrow(
      /one index takes one job at a time/,
    );

    release();
    const done = await running;
    expect(done.state).toBe('done');
    expect(done.items).toBe(lib.length);
    expect(done.vectors).toBe(done.documents);
    // Released at the end: the other handle may now run a job of its own.
    expect(second.jobElsewhere?.()).toBeUndefined();
    await first.close();
    await second.close();
  });

  sqliteIt('takes over a lease whose process is gone, and refuses one whose process is alive', async () => {
    const { first, file } = await twoHandles();
    const writeLease = (pid: number) => {
      const db = new DatabaseSync(file);
      const now = Date.now();
      db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
        'jobLease',
        JSON.stringify({ pid, host: hostname(), kind: 'build', since: now, beat: now, token: 'elsewhere' }),
      );
      db.close();
    };
    const pager1 = async (start: number) => ({ items: lib.slice(start, start + 100), totalResults: lib.length, lastModifiedVersion: 9 });

    // A process that is alive: refused.
    const alive = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      writeLease(alive.pid!);
      await expect(first.buildIncremental(pager1)).rejects.toThrow(new RegExp(`process ${alive.pid}`));
    } finally {
      alive.kill();
      await new Promise((r) => alive.once('exit', r));
    }

    // The same lease once that process has exited: nobody holds it, so the build runs.
    expect(first.jobElsewhere?.()).toBeUndefined();
    const done = await first.buildIncremental(pager1);
    expect(done.state).toBe('done');
    expect(done.items).toBe(lib.length);
    await first.close();
  });
});
