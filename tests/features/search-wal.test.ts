import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSearchIndex, nodeSqliteAvailable, sqliteIndexPath } from '../../src/features/search/factory.js';

/**
 * A write-ahead log never shrinks by itself: after one large transaction it keeps that
 * transaction's size through every later checkpoint and restart. #98 found a 1.08 GB log
 * beside a 3.6 GB index that had stayed that size for three weeks. The index now caps the
 * log at every restart of it and truncates it, without waiting, when it opens and closes.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const sqliteIt = nodeSqliteAvailable() ? it : it.skip;
const ITEM = { key: 'A', data: { itemType: 'book', title: 'Deep learning', abstractNote: 'neural networks' } };
const MB = 1024 * 1024;

const sqliteModule = nodeSqliteAvailable()
  ? (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'))
  : undefined;
const DatabaseSync = sqliteModule?.DatabaseSync as typeof import('node:sqlite').DatabaseSync;
type Database = InstanceType<typeof DatabaseSync>;

const openIndex = (jsonPath: string) =>
  createSearchIndex({ embedder: null, logger: silentLogger, backend: 'sqlite', jsonPath });

async function builtIndexPath(name: string): Promise<{ jsonPath: string; dbPath: string }> {
  const jsonPath = join(mkdtempSync(join(tmpdir(), `zoteus-${name}-`)), 'search-index.json');
  const index = await openIndex(jsonPath);
  await index.build([ITEM]);
  await index.save();
  await index.close();
  return { jsonPath, dbPath: sqliteIndexPath(jsonPath) };
}

/** Bytes the log holds on disk; a log SQLite deleted holds none. */
const walSize = (dbPath: string): number => (existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0);

/**
 * Grow the log the way a big transaction does, from a second connection that stays open so
 * that no close along the way is the last one (which would checkpoint and delete the log).
 */
function growWal(sibling: Database): void {
  sibling.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('pad', randomblob(?))").run(8 * MB);
  sibling.exec("DELETE FROM meta WHERE key = 'pad'");
}

describe('SQLite index write-ahead log', () => {
  sqliteIt('truncates a log an earlier run left behind when it opens', async () => {
    const { jsonPath, dbPath } = await builtIndexPath('wal-open');
    const sibling = new DatabaseSync(dbPath);
    try {
      growWal(sibling);
      expect(walSize(dbPath)).toBeGreaterThan(8 * MB);
      const index = await openIndex(jsonPath);
      expect(walSize(dbPath)).toBe(0);
      // Truncating copied every frame into the database first, so nothing was lost.
      expect(await index.query('neural networks', { limit: 1 })).not.toHaveLength(0);
      await index.close();
    } finally {
      sibling.close();
    }
  });

  sqliteIt('does not wait on a sibling that is mid-read, and truncates when it closes instead', async () => {
    const { jsonPath, dbPath } = await builtIndexPath('wal-reader');
    const sibling = new DatabaseSync(dbPath);
    try {
      growWal(sibling);
      sibling.exec('BEGIN');
      sibling.prepare('SELECT count(*) FROM passages').get();
      // Under the ten-second busy timeout a TRUNCATE checkpoint would sit out this read.
      // node:sqlite is synchronous, so the read could not even end while it waited.
      const started = Date.now();
      const index = await openIndex(jsonPath);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(walSize(dbPath)).toBeGreaterThan(8 * MB);
      sibling.exec('COMMIT');
      await index.close();
      expect(walSize(dbPath)).toBe(0);
    } finally {
      sibling.close();
    }
  });

  sqliteIt('caps the log at every restart of it', async () => {
    const jsonPath = join(mkdtempSync(join(tmpdir(), 'zoteus-wal-limit-')), 'search-index.json');
    const index = await openIndex(jsonPath);
    // Per connection and never stored in the file, so only the index's own handle can say.
    const db = (index as unknown as { db: Database }).db;
    const row = db.prepare('PRAGMA journal_size_limit').get() as { journal_size_limit: number };
    expect(row.journal_size_limit).toBe(64 * MB);
    await index.close();
  });
});
