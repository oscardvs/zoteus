import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, openSync, writeSync, closeSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSearchIndex, nodeSqliteAvailable, sqliteIndexPath } from '../../src/features/search/factory.js';
import {
  CorruptSearchIndex,
  SearchIndexCorruptError,
  isCorruptionError,
} from '../../src/features/search/corruption.js';
import { statusSummary } from '../../src/features/search/build.js';
import { MemorySearchIndex } from '../../src/features/search/index-manager.js';
import { saveIndex } from '../../src/features/search/persistence.js';

/**
 * A damaged search index used to take the whole MCP server with it: `open()` threw
 * SQLite's own sentence out of `createSearchIndex`, which nothing catches, so `buildServer`
 * rejected and the process exited before serving a single tool. The index is a derived
 * cache that no other tool reads, so the blast radius was the entire server for a file
 * that only search needs.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const hasSqlite = nodeSqliteAvailable();
const sqliteIt = hasSqlite ? it : it.skip;

function tmpJsonPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), `zoteus-${name}-`)), 'search-index.json');
}

/** A real index, closed, with one interior page overwritten: a bad sector or a torn write. */
async function corruptedIndex(): Promise<string> {
  const jsonPath = tmpJsonPath('corrupt');
  const dbPath = sqliteIndexPath(jsonPath);
  const index = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'sqlite', jsonPath });
  await index.build([{ key: 'A', data: { itemType: 'book', title: 'Deep learning', abstractNote: 'neural networks' } }]);
  await index.save();
  await index.close();
  const fd = openSync(dbPath, 'r+');
  // Page 3, leaving the header intact: SQLite opens the file and fails when it reads it.
  writeSync(fd, Buffer.alloc(4096, 0x5a), 0, 4096, 8192);
  closeSync(fd);
  return jsonPath;
}

describe('isCorruptionError', () => {
  it('recognizes SQLite saying the file is not a usable database', () => {
    for (const m of [
      'database disk image is malformed',
      'file is not a database',
      'file is encrypted or is not a database',
      'malformed database schema (passages_fts)',
    ]) {
      expect(isCorruptionError(new Error(m)), m).toBe(true);
    }
    expect(isCorruptionError(new SearchIndexCorruptError('/x.sqlite', 'malformed'))).toBe(true);
  });

  it('leaves every other failure alone, because they are not a reason to delete an index', () => {
    // Deliberately narrow: a locked database, a full disk and a missing table are faults,
    // and telling someone to delete their index over one would be its own defect.
    for (const m of [
      'database is locked',
      'attempt to write a readonly database',
      'no such table: passages',
      'disk I/O error',
      'unable to open database file',
      'database or disk is full',
    ]) {
      expect(isCorruptionError(new Error(m)), m).toBe(false);
    }
  });
});

describe('opening an index that cannot be read', () => {
  sqliteIt('serves the rest of the server instead of failing to start', async () => {
    const jsonPath = await corruptedIndex();
    const index = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'sqlite', jsonPath });
    expect(index).toBeInstanceOf(CorruptSearchIndex);
    await index.close();
  });

  sqliteIt('refuses a query with the file, the sidecars and the command to run', async () => {
    const jsonPath = await corruptedIndex();
    const index = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'sqlite', jsonPath });
    await expect(index.query('neural')).rejects.toThrow(SearchIndexCorruptError);
    await expect(index.query('neural')).rejects.toThrow(sqliteIndexPath(jsonPath));
    await expect(index.query('neural')).rejects.toThrow(/-wal/);
    await expect(index.query('neural')).rejects.toThrow(/zotero_index/);
    await index.close();
  });

  sqliteIt('answers no query with an empty result set, which would read as an empty library', async () => {
    // The failure this replaces: `keywordSearch` catches everything, so a corrupt index
    // answered "No matches" forever and looked like a library holding nothing.
    const jsonPath = await corruptedIndex();
    const index = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'sqlite', jsonPath });
    await expect(index.query('neural')).rejects.toThrow();
    await index.close();
  });

  sqliteIt('does not look like a library awaiting its first build', async () => {
    // `zotero_semantic_search` auto-builds an empty index. Reporting empty here would
    // start a full library crawl on top of the fault.
    const jsonPath = await corruptedIndex();
    const index = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'sqlite', jsonPath });
    expect(index.isEmpty).toBe(false);
    expect(index.updateBlocker('local')).toBeTruthy();
    expect(index.buildStatus().state).toBe('error');
    await index.close();
  });

  sqliteIt('states the fault once, not once per status field', async () => {
    const jsonPath = await corruptedIndex();
    const index = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'sqlite', jsonPath });
    const summary = statusSummary(index.buildStatus());
    // The recovery paragraph belongs in exactly one field; it used to land in three.
    expect(summary.match(/To recover, delete the file/g)).toHaveLength(1);
    await index.close();
  });

  sqliteIt('recovers by deleting the file, with no rebuild when the JSON artifact remains', async () => {
    // The recovery the message describes, carried out. `createSearchIndex` migrates a
    // legacy search-index.json on the first open of a data dir that has no database, so a
    // user who still has one is searchable again on the next start rather than after a
    // full library crawl. That is why the message says restart before it says build.
    // A user who migrated from the JSON backend: the import leaves search-index.json in
    // place, so the database can be dropped and re-imported. Someone who only ever ran
    // SQLite has no such artifact and does need the rebuild.
    const jsonPath = tmpJsonPath('recover');
    const legacy = new MemorySearchIndex({ embedder: null, logger: silentLogger, path: jsonPath });
    await legacy.build([{ key: 'A', data: { itemType: 'book', title: 'Deep learning', abstractNote: 'neural networks' } }]);
    await saveIndex(legacy, jsonPath);
    const dbPath = sqliteIndexPath(jsonPath);
    const migrated = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'sqlite', jsonPath });
    await migrated.save();
    await migrated.close();
    const fd = openSync(dbPath, 'r+');
    writeSync(fd, Buffer.alloc(4096, 0x5a), 0, 4096, 8192);
    closeSync(fd);

    const index = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'sqlite', jsonPath });
    expect(index).toBeInstanceOf(CorruptSearchIndex);
    await index.close();

    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) rmSync(p, { force: true });
    const healed = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'sqlite', jsonPath });
    expect(healed).not.toBeInstanceOf(CorruptSearchIndex);
    expect((await healed.query('neural', { mode: 'keyword' }))[0]?.itemKey).toBe('A');
    await healed.close();
  });

  sqliteIt('refuses to report a successful save of an index it never opened', async () => {
    const jsonPath = await corruptedIndex();
    const index = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'sqlite', jsonPath });
    await expect(index.save()).rejects.toThrow(SearchIndexCorruptError);
    await index.close();
  });

  sqliteIt('treats a file that is not a database at all the same way', async () => {
    const jsonPath = tmpJsonPath('notadb');
    writeFileSync(sqliteIndexPath(jsonPath), 'this is not a database, it is a text file\n');
    const index = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'sqlite', jsonPath });
    expect(index).toBeInstanceOf(CorruptSearchIndex);
    await index.close();
  });

  sqliteIt('still throws when the failure is not corruption', async () => {
    // A path that cannot be opened is a fault to fix, not an index to delete: it must not
    // be dressed up as corruption with recovery instructions that would lose data.
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-blocked-'));
    const jsonPath = join(dir, 'search-index.json');
    // The database path is a directory, so SQLite cannot open it as a file.
    mkdirSync(sqliteIndexPath(jsonPath));
    await expect(
      createSearchIndex({ embedder: null, logger: silentLogger, backend: 'sqlite', jsonPath }),
    ).rejects.not.toBeInstanceOf(SearchIndexCorruptError);
  });
});
