import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSearchIndex, nodeSqliteAvailable, sqliteIndexPath } from '../../src/features/search/factory.js';
import { FakeEmbeddingProvider } from '../../src/features/search/embeddings.js';
import type { SearchIndex } from '../../src/features/search/backend.js';

/**
 * The end of a build stalled the server for 184 s on 2026-11-23: a 5,000-item full-text
 * library on a shared e2-micro, where the accent-map scan, the binary codes and the
 * droplist scan ran one after another without the event loop turning once, so every client
 * of every library waited for all of it. The same tail measured 2.9 s on a laptop over a
 * synthetic library of the same size. These tests hold a timer up against that tail on a
 * smaller library and assert the loop kept turning inside it, and that the derived state it
 * leaves is exactly what the one-go path left.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const hasSqlite = nodeSqliteAvailable();
const sqliteIt = hasSqlite ? it : it.skip;
const DatabaseSync = hasSqlite
  ? ((createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')).DatabaseSync as typeof import('node:sqlite').DatabaseSync)
  : (undefined as never);

/**
 * Words enough for a vocabulary in the tens of thousands, some accented, with a skewed
 * frequency so the droplist has terms to find. Seeded, so every run indexes the same text.
 */
function corpus(seed: number) {
  let s = seed;
  const rnd = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296;
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const vocab: string[] = [];
  for (let i = 0; i < 60_000; i++) {
    let w = '';
    const len = 3 + Math.floor(rnd() * 8);
    for (let j = 0; j < len; j++) w += letters[Math.floor(rnd() * 26)];
    if (rnd() < 0.05) w = `${w.slice(0, 1)}é${w.slice(2)}`;
    vocab.push(w);
  }
  const word = () => vocab[Math.floor(Math.pow(rnd(), 2.2) * vocab.length)]!;
  const text = (words: number) => Array.from({ length: words }, word).join(' ');
  return { text };
}

const ITEMS = 48;
const { text } = corpus(7);
const items = Array.from({ length: ITEMS }, (_, i) => ({
  key: `K${i}`,
  data: { key: `K${i}`, itemType: 'book', title: `Volume ${i} ${text(6)}`, abstractNote: text(120) },
}));
const bodies = new Map(items.map((it) => [it.key, text(4_000)]));
const fetcher = async (start: number) => ({
  items: items.slice(start, start + 100),
  totalResults: items.length,
  lastModifiedVersion: 10,
});

async function open(): Promise<{ index: SearchIndex; file: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'zoteus-derive-'));
  const jsonPath = join(dir, 'search-index.json');
  const index = await createSearchIndex({
    backend: 'sqlite',
    jsonPath,
    embedder: new FakeEmbeddingProvider(),
    logger: silentLogger,
    annMinCandidates: 50,
  });
  return { index, file: sqliteIndexPath(jsonPath) };
}

/** The derived state a build leaves: what the codes, the accent map and the droplist hold. */
function derived(file: string) {
  const db = new DatabaseSync(file);
  try {
    const one = (sql: string) => db.prepare(sql).get() as Record<string, unknown> | undefined;
    return {
      codes: (one('SELECT count(*) AS n FROM vector_codes')!.n as number) ?? 0,
      vectors: one('SELECT count(*) AS n FROM passages WHERE vector IS NOT NULL')!.n as number,
      codeMean: one("SELECT value FROM meta WHERE key = 'codeMean'")?.value,
      codeDigest: one("SELECT count(*) AS n, sum(length(code)) AS bytes, hex(max(code)) AS top FROM vector_codes"),
      accentRows: one('SELECT count(*) AS n, sum(df) AS df FROM accent_variants'),
      accentStamp: one("SELECT value FROM meta WHERE key = 'accentVariantsPassages'")?.value,
      droplist: one("SELECT value FROM meta WHERE key = 'droplist'")?.value,
    };
  } finally {
    db.close();
  }
}

describe("the end of a build hands the event loop back (2026-11-23's 184 s stall)", () => {
  sqliteIt(
    'derives the accent map, the codes and the droplist in slices, to the same result as in one go',
    async () => {
      // Reference: the same library through the one-go path, which open() and queries keep.
      const ref = await open();
      await ref.index.buildIncremental(fetcher, {
        versionBackend: 'local',
        fulltextFor: async (key) => bodies.get(key),
      });
      const asBuilt = derived(ref.file);
      // Run the one-go path explicitly over the finished build, so the reference is that
      // path's output and not the sliced one the build itself now ends with.
      const refAny = ref.index as unknown as {
        finalizeVectors(): void;
        refreshDroplist(force: boolean): void;
        save(): Promise<void>;
      };
      new DatabaseSync(ref.file).exec("DELETE FROM meta WHERE key = 'codeMean'");
      refAny.finalizeVectors();
      refAny.refreshDroplist(true);
      await refAny.save();
      const oneGo = derived(ref.file);
      await ref.index.close();

      // The library is big enough for the derived state to mean something.
      expect(oneGo.vectors).toBeGreaterThan(500);
      expect(oneGo.codes).toBe(oneGo.vectors);
      expect(Number(oneGo.accentRows!.n)).toBeGreaterThan(100);
      expect(String(oneGo.droplist ?? '').length).toBeGreaterThan(0);

      // The build under test, with a timer ticking every 5 ms and the build's last two steps
      // bracketed, so only the gaps inside them are judged.
      const run = await open();
      const job = run.index as unknown as {
        finalizeVectorsSliced(): Promise<void>;
        refreshDroplistSliced(force: boolean): Promise<void>;
      };
      let inTail = false;
      let tailStart = 0;
      let tailEnd = 0;
      let tailTicks = 0;
      let tailMaxGap = 0;
      let last = performance.now();
      const timer = setInterval(() => {
        const now = performance.now();
        if (inTail) {
          tailMaxGap = Math.max(tailMaxGap, now - last);
          tailTicks++;
        }
        last = now;
      }, 5);
      const finalize = job.finalizeVectorsSliced.bind(job);
      const droplist = job.refreshDroplistSliced.bind(job);
      job.finalizeVectorsSliced = async () => {
        inTail = true;
        tailStart = performance.now();
        last = tailStart;
        await finalize();
      };
      job.refreshDroplistSliced = async (force: boolean) => {
        await droplist(force);
        // The stretch since the last tick counts too: a tail that never yields ends before
        // the overdue tick can run.
        tailMaxGap = Math.max(tailMaxGap, performance.now() - last);
        tailEnd = performance.now();
        inTail = false;
      };
      try {
        await run.index.buildIncremental(fetcher, {
          versionBackend: 'local',
          fulltextFor: async (key) => bodies.get(key),
        });
      } finally {
        clearInterval(timer);
      }
      const tail = tailEnd - tailStart;
      const after = derived(run.file);
      await run.index.close();

      // The tail is real work, long enough for the bound below to be a test of slicing.
      expect(tail).toBeGreaterThan(60);
      // It turned the loop inside the tail, and no stretch in it came near the whole tail.
      // In one go the tail is a single stretch: one gap as long as the tail and no tick at all.
      expect(tailTicks).toBeGreaterThanOrEqual(3);
      expect(tailMaxGap).toBeLessThan(tail / 2);

      // Same derived state as the one-go path, and as the build left before this change.
      expect(after).toEqual(oneGo);
      expect(after).toEqual(asBuilt);
    },
    180_000,
  );
});
