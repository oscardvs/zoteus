import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSearchIndex, nodeSqliteAvailable, sqliteIndexPath } from '../../src/features/search/factory.js';
import { MemorySearchIndex } from '../../src/features/search/index-manager.js';
import type { SearchIndex, SearchIndexOptions } from '../../src/features/search/backend.js';
import { FakeEmbeddingProvider, type EmbeddingProvider } from '../../src/features/search/embeddings.js';
import { persistNotice, statusSummary, staleVectorsNotice } from '../../src/features/search/build.js';
import semanticSearch from '../../src/tools/semantic-search.js';
import { loadConfig } from '../../src/config.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * node:sqlite arrived in Node 22.13. Where it is missing the SQLite cases skip rather than
 * fail, exactly as the server falls back rather than refusing to start.
 */
const hasSqlite = nodeSqliteAvailable();
const sqliteIt = hasSqlite ? it : it.skip;

const items = [
  {
    key: 'A',
    data: {
      itemType: 'journalArticle',
      title: 'Deep learning for computer vision',
      abstractNote: 'convolutional neural networks classify images',
      tags: [{ tag: 'cv' }],
    },
  },
  {
    key: 'B',
    data: { itemType: 'book', title: 'Organic gardening', abstractNote: 'growing tomatoes and herbs', tags: [{ tag: 'garden' }] },
  },
  {
    key: 'C',
    data: {
      itemType: 'journalArticle',
      title: 'Reinforcement learning',
      abstractNote: 'reward shaping for neural network policies',
      tags: [{ tag: 'rl' }],
    },
  },
];

function tmpDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `zoteus-${name}-`));
}

/** A store on disk, so an index can be closed and opened again exactly as the server does. */
class Store {
  readonly jsonPath: string;
  private index: SearchIndex | undefined;

  constructor(
    private readonly backend: 'memory' | 'sqlite',
    dir = tmpDir(`idx-${backend}`),
  ) {
    this.jsonPath = join(dir, 'search-index.json');
  }

  async open(opts: Partial<SearchIndexOptions> = {}): Promise<SearchIndex> {
    this.index = await createSearchIndex({
      embedder: null,
      logger: silentLogger,
      ...opts,
      backend: this.backend,
      jsonPath: this.jsonPath,
    });
    return this.index;
  }

  /** Persist, drop the handle, and open the same store again: a server restart. */
  async reopen(opts: Partial<SearchIndexOptions> = {}): Promise<SearchIndex> {
    await this.index!.save();
    await this.index!.close();
    return this.open(opts);
  }

  async close(): Promise<void> {
    await this.index?.close();
  }
}

const backends: Array<'memory' | 'sqlite'> = hasSqlite ? ['memory', 'sqlite'] : ['memory'];

describe.each(backends)('SearchIndex contract (%s backend)', (backend) => {
  it('builds, ranks, and cites the item a passage belongs to', async () => {
    const store = new Store(backend);
    const index = await store.open({ embedder: new FakeEmbeddingProvider() });
    const status = await index.build(items, { version: 3 });

    expect(status.storage).toBe(backend);
    expect(status.items).toBe(3);
    expect(status.documents).toBe(3);
    expect(status.vectors).toBe(3);
    const hits = await index.query('neural networks', { limit: 2 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.itemKey).toBe('A');
    expect(hits[0]!.snippet.length).toBeGreaterThan(0);
    await store.close();
  });

  it('works keyword-only when there is no embedder', async () => {
    const store = new Store(backend);
    const index = await store.open();
    await index.build(items);

    expect(index.status().vectors).toBe(0);
    expect((await index.query('tomatoes', { limit: 3 }))[0]!.itemKey).toBe('B');
    await store.close();
  });

  it('survives a restart with its passages, vectors and truncation state', async () => {
    const store = new Store(backend);
    const index = await store.open({ embedder: new FakeEmbeddingProvider() });
    await index.buildIncremental(
      async (start) => ({ items: items.slice(start, start + 2), totalResults: 9 }),
      { maxItems: 3 },
    );
    const before = index.buildStatus();

    const reopened = await store.reopen({ embedder: new FakeEmbeddingProvider() });
    const after = reopened.buildStatus();

    expect(after.documents).toBe(before.documents);
    expect(after.vectors).toBe(before.vectors);
    expect(after.items).toBe(before.items);
    // The truncation counts outlive the process that measured them (PR #11).
    expect(after.itemsTotal).toBe(3);
    expect(after.itemsAvailable).toBe(9);
    expect(after.builtFromVersion).toBe(3);
    expect((await reopened.query('gardening', { limit: 1 }))[0]!.itemKey).toBe('B');
    await store.close();
  });

  it('indexes attachment full text and attributes the hit to the parent item', async () => {
    const body = 'The ablation removes the recurrent gate entirely. '.repeat(20);
    const store = new Store(backend);
    const index = await store.open();
    const final = await index.buildIncremental(async () => ({ items, totalResults: items.length }), {
      fulltextFor: async (key) => (key === 'B' ? body : undefined),
    });

    expect(final.fulltextEnabled).toBe(true);
    expect(final.fulltextItems).toBe(1);
    expect(final.fulltextPassages).toBeGreaterThan(0);
    expect(final.documents).toBe(final.fulltextPassages + 3);

    const hits = await index.query('recurrent gate ablation', { limit: 3 });
    expect(hits[0]!.itemKey).toBe('B');
    expect(hits[0]!.source).toBe('fulltext');
    // A reopened index reports what it holds, without being told again.
    const reopened = await store.reopen();
    expect(reopened.status().fulltextEnabled).toBe(true);
    expect(reopened.status().fulltextItems).toBe(1);
    await store.close();
  });

  it('drops vectors built by another embedding model, and says so', async () => {
    const model = (name: string): EmbeddingProvider => ({
      name: 'openai',
      model: name,
      embed: async (texts) => texts.map(() => [1, 0, 0]),
    });
    const store = new Store(backend);
    const index = await store.open({ embedder: model('text-embedding-3-small'), configured: 'openai' });
    await index.build(items);
    expect(index.status().vectors).toBeGreaterThan(0);

    const switched = await store.reopen({ embedder: model('text-embedding-3-large'), configured: 'openai' });
    const s = switched.buildStatus();

    expect(s.vectors).toBe(0);
    expect(s.vectorsStaleReason).toContain('openai:text-embedding-3-small');
    expect(staleVectorsNotice(s)).toContain('not comparable');
    // Passages are model-independent, so keyword search is untouched.
    expect((await switched.query('tomatoes', { mode: 'keyword' })).length).toBeGreaterThan(0);
    await store.close();
  });

  it('reports a build it could not save instead of claiming it is done', async () => {
    const store = new Store(backend);
    const index = await store.open();
    // Any write error: a full disk for SQLite, a JSON.stringify past V8's string limit
    // for the legacy backend. What matters is that "done" stops meaning "saved".
    vi.spyOn(index, 'save').mockRejectedValue(new Error('database or disk is full'));
    const final = await index.buildIncremental(async () => ({ items, totalResults: items.length }));

    expect(final.state).toBe('done');
    expect(final.persistError).toMatch(/disk is full/);
    expect(persistNotice(final)).toMatch(/could NOT be saved/);
    expect(statusSummary(final)).toMatch(/could NOT be saved/);
    // The search a user actually runs says it too: these hits vanish on restart.
    const res = await semanticSearch.handler({ q: 'tomatoes' }, { search: index } as any);
    expect(res.content[0]!.text).toMatch(/could NOT be saved/);
    expect(res.structuredContent?.persistError).toMatch(/disk is full/);
    await store.close();
  });
});

describe('a store that cannot be written', () => {
  /** A path whose parent is a FILE: every write below it fails with ENOTDIR. */
  function blockedPath(name: string): string {
    const blocker = join(tmpDir(name), 'blocker');
    writeFileSync(blocker, 'not a directory');
    return join(blocker, 'search-index.json');
  }

  it('leaves the JSON backend building, and names the failure on the status', async () => {
    const index = await createSearchIndex({
      embedder: null,
      logger: silentLogger,
      backend: 'memory',
      jsonPath: blockedPath('idx-blocked-json'),
    });
    const final = await index.buildIncremental(async () => ({ items, totalResults: items.length }));

    expect(final.state).toBe('done');
    expect(final.documents).toBe(3); // queryable, just not durable
    expect(final.persistError).toMatch(/EEXIST|ENOTDIR|not a directory/i);
    expect(statusSummary(final)).toMatch(/could NOT be saved/);
  });

  sqliteIt('fails at startup rather than serving an index it cannot persist', async () => {
    await expect(
      createSearchIndex({
        embedder: null,
        logger: silentLogger,
        backend: 'sqlite',
        jsonPath: blockedPath('idx-blocked-sqlite'),
      }),
    ).rejects.toThrow(/EEXIST|ENOTDIR|not a directory/i);
  });
});

describe('the SQLite backend answers the same queries as the JSON one', () => {
  async function both(): Promise<{ memory: SearchIndex; sqlite: SearchIndex }> {
    const memory = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    await memory.build(items);
    const sqlite = await createSearchIndex({
      embedder: null,
      logger: silentLogger,
      backend: 'sqlite',
      jsonPath: '',
    });
    await sqlite.build(items);
    return { memory, sqlite };
  }

  sqliteIt('returns the same top hit for representative queries', async () => {
    const { memory, sqlite } = await both();
    for (const q of ['neural networks', 'tomatoes herbs', 'reward shaping policies', 'computer vision images']) {
      const m = await memory.query(q, { limit: 3 });
      const s = await sqlite.query(q, { limit: 3 });
      expect(s[0]?.itemKey, `top hit for "${q}"`).toBe(m[0]?.itemKey);
    }
    await sqlite.close();
  });

  sqliteIt('ORs the query terms, where FTS5 would AND them and find nothing', async () => {
    const { memory, sqlite } = await both();
    // No passage holds both terms: with FTS5's implicit AND this query has no hits at all,
    // which is exactly the regression the OR rewrite prevents.
    const q = 'convolutional policies';
    const s = await sqlite.query(q, { limit: 5, mode: 'keyword' });
    const m = await memory.query(q, { limit: 5, mode: 'keyword' });

    expect(s.map((h) => h.itemKey).sort()).toEqual(['A', 'C']);
    expect(s.map((h) => h.itemKey).sort()).toEqual(m.map((h) => h.itemKey).sort());
    await sqlite.close();
  });

  sqliteIt('tokenizes the query exactly like the JSON backend, stopwords included', async () => {
    const { memory, sqlite } = await both();
    // "of"/"the" are dropped by tokenize.ts, so a query made only of them matches nothing
    // on either backend rather than erroring or returning everything.
    expect(await sqlite.query('of the', { mode: 'keyword' })).toEqual([]);
    expect(await memory.query('of the', { mode: 'keyword' })).toEqual([]);
    // Punctuation is not FTS5 syntax here: every term is quoted before it is OR-ed.
    const hits = await sqlite.query('"gardening" OR (tomatoes*)', { limit: 3, mode: 'keyword' });
    expect(hits[0]!.itemKey).toBe('B');
    await sqlite.close();
  });

  sqliteIt('matches across diacritics, in both directions and on both backends', async () => {
    const accented = [
      { key: 'X', data: { itemType: 'book', title: 'Étude sur les Brontë', abstractNote: 'Yorkshire naïveté' } },
    ];
    const sqlite = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'sqlite', jsonPath: '' });
    await sqlite.build(accented);
    const memory = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    await memory.build(accented);

    for (const index of [sqlite, memory]) {
      // Unaccented query, accented document: what remove_diacritics 2 buys on the FTS5
      // side, and what tokenize.ts's fold now buys on the JSON side.
      expect((await index.query('Bronte', { mode: 'keyword' }))[0]?.itemKey).toBe('X');
      expect((await index.query('etude naivete', { mode: 'keyword' }))[0]?.itemKey).toBe('X');
      // And the other direction, which is the one that used to fail: an accented query
      // reached MATCH as fragments of itself. See accent-folding.test.ts.
      expect((await index.query('Brontë', { mode: 'keyword' }))[0]?.itemKey).toBe('X');
      expect((await index.query('Étude naïveté', { mode: 'keyword' }))[0]?.itemKey).toBe('X');
    }
    await sqlite.close();
  });
});

describe('the SQLite backend keeps passages and vectors out of JS memory', () => {
  sqliteIt('never reads the vector column for a keyword-only search', async () => {
    const index = await createSearchIndex({
      embedder: new FakeEmbeddingProvider(),
      logger: silentLogger,
      backend: 'sqlite',
      jsonPath: '',
    });
    await index.build(items);
    const scan = vi.spyOn(index as any, 'vectorSearch');

    const keyword = await index.query('neural networks', { mode: 'keyword' });
    expect(keyword.length).toBeGreaterThan(0);
    expect(scan).not.toHaveBeenCalled();
    // The vectors are there: hybrid mode does scan them, so the assertion above is about
    // the keyword path and not about an index that simply has nothing to scan.
    expect((index as any).vectorScans).toBe(0);
    await index.query('neural networks', { mode: 'auto' });
    expect(scan).toHaveBeenCalledTimes(1);
    expect((index as any).vectorScans).toBe(1);
    await index.close();
  });
});

describe('migration from an existing JSON index', () => {
  /** A real search-index.json, written by the backend that owns that format. */
  async function writeJsonIndex(dir: string): Promise<string> {
    const jsonPath = join(dir, 'search-index.json');
    const memory = new MemorySearchIndex({ embedder: new FakeEmbeddingProvider(), path: jsonPath });
    await memory.build(items, { version: 4 });
    await memory.save();
    return jsonPath;
  }

  sqliteIt('imports a small one on first open and leaves the file in place', async () => {
    const dir = tmpDir('idx-migrate');
    const jsonPath = await writeJsonIndex(dir);
    const index = await createSearchIndex({
      embedder: new FakeEmbeddingProvider(),
      logger: silentLogger,
      backend: 'sqlite',
      jsonPath,
    });
    const s = index.buildStatus();

    expect(s.storage).toBe('sqlite');
    expect(s.documents).toBe(3);
    expect(s.vectors).toBe(3);
    expect(s.builtFromVersion).toBe(4);
    expect(s.storageNotice).toMatch(/Imported 3 passages/);
    expect(statusSummary(s)).toMatch(/Imported 3 passages/);
    expect((await index.query('tomatoes', { limit: 1 }))[0]!.itemKey).toBe('B');
    // No silent loss: the JSON file is still there, and the database sits beside it.
    expect(existsSync(jsonPath)).toBe(true);
    expect(JSON.parse(await readFile(jsonPath, 'utf8')).chunks).toHaveLength(3);
    expect(existsSync(sqliteIndexPath(jsonPath))).toBe(true);
    await index.close();
  });

  sqliteIt('does not import it a second time', async () => {
    const dir = tmpDir('idx-migrate-once');
    const jsonPath = await writeJsonIndex(dir);
    const first = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'sqlite', jsonPath });
    await first.close();

    const second = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'sqlite', jsonPath });
    expect(second.status().documents).toBe(3); // not 6
    expect(second.status().storageNotice).toBeUndefined();
    await second.close();
  });

  sqliteIt('refuses to parse an oversized one and asks for a rebuild', async () => {
    const dir = tmpDir('idx-migrate-big');
    const jsonPath = await writeJsonIndex(dir);
    const { SqliteSearchIndex } = await import('../../src/features/search/sqlite-index.js');
    // The size check, not a 200 MB fixture: parsing the real file is the OOM this avoids.
    const index = new SqliteSearchIndex({
      embedder: null,
      logger: silentLogger,
      path: sqliteIndexPath(jsonPath),
      migrateFrom: jsonPath,
      maxMigrationBytes: 16,
    });
    await index.open();
    const s = index.buildStatus();

    expect(s.documents).toBe(0);
    expect(s.storageNotice).toMatch(/NOT imported/);
    expect(s.storageNotice).toMatch(/zotero_index action:"build"/);
    expect(statusSummary(s)).toMatch(/NOT imported/);
    expect(existsSync(jsonPath)).toBe(true); // untouched
    await index.close();
  });
});

describe('ZOTEUS_INDEX_BACKEND', () => {
  it('defaults to auto and accepts only the three known stores', () => {
    expect(loadConfig({} as any).indexBackend).toBe('auto');
    expect(loadConfig({ ZOTEUS_INDEX_BACKEND: 'sqlite' } as any).indexBackend).toBe('sqlite');
    expect(loadConfig({ ZOTEUS_INDEX_BACKEND: 'memory' } as any).indexBackend).toBe('memory');
    expect(() => loadConfig({ ZOTEUS_INDEX_BACKEND: 'postgres' } as any)).toThrow();
  });

  it('memory keeps the JSON artifact, and auto takes SQLite where the runtime has it', async () => {
    const store = new Store('memory');
    const index = await store.open();
    await index.build(items);
    await index.save();
    expect(index.storage).toBe('memory');
    expect(existsSync(store.jsonPath)).toBe(true);
    await store.close();

    const auto = await createSearchIndex({ embedder: null, logger: silentLogger, backend: 'auto', jsonPath: '' });
    expect(auto.storage).toBe(hasSqlite ? 'sqlite' : 'memory');
    await auto.close();
  });
});
