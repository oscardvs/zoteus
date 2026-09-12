import { describe, it, expect, vi } from 'vitest';
import { MemorySearchIndex, FULLTEXT_CHUNK_SIZE, type SearchIndex } from '../../src/features/search/index-manager.js';
import { FakeEmbeddingProvider } from '../../src/features/search/embeddings.js';
import { createFulltextSource, DEFAULT_FULLTEXT_MAX_CHARS } from '../../src/features/search/fulltext-source.js';
import { startIndexBuild, statusSummary, PAGE_SIZE } from '../../src/features/search/build.js';
import { loadConfig } from '../../src/config.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** A body of text that shares no vocabulary with the metadata, so hits are attributable. */
const BODY =
  'The ablation removes the recurrent gate entirely. '.repeat(20) +
  'Throughput on the benchmark rises by eleven percent under mixed precision. '.repeat(20);

function makeLibrary(n: number): any[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `K${i}`,
    data: { itemType: 'journalArticle', title: `Item ${i}`, abstractNote: `abstract about topic${i}` },
  }));
}

function pager(library: any[], pageSize = 100) {
  return async (start: number) => ({ items: library.slice(start, start + pageSize), totalResults: library.length });
}

describe('SearchIndex full-text passages', () => {
  it('indexes attachment body text and attributes the hit to the parent item', async () => {
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    const final = await search.buildIncremental(pager(makeLibrary(3)), {
      fulltextFor: async (key) => (key === 'K1' ? BODY : undefined),
    });

    expect(final.fulltextEnabled).toBe(true);
    expect(final.fulltextItems).toBe(1);
    expect(final.fulltextPassages).toBeGreaterThan(1);
    expect(final.documents).toBe(final.fulltextPassages + 3); // 3 metadata passages + body

    // A phrase that exists only in the PDF body finds the item that owns the attachment.
    const hits = await search.query('recurrent gate ablation', { limit: 3 });
    expect(hits[0]!.itemKey).toBe('K1');
    expect(hits[0]!.source).toBe('fulltext');
    expect(hits[0]!.title).toBe('Item 1'); // the parent's title, not the attachment's

    // Metadata hits stay unmarked, so callers can tell a body passage from an abstract.
    const meta = await search.query('topic2', { limit: 1 });
    expect(meta[0]!.itemKey).toBe('K2');
    expect(meta[0]!.source).toBeUndefined();
  });

  it('chunks body text at the larger full-text size and embeds every passage', async () => {
    const search = new MemorySearchIndex({ embedder: new FakeEmbeddingProvider(), logger: silentLogger });
    const long = 'sedimentary layering in the outcrop. '.repeat(300); // ~11k chars
    const final = await search.buildIncremental(pager(makeLibrary(1)), { fulltextFor: async () => long });

    expect(final.fulltextPassages).toBeGreaterThan(Math.floor(long.length / FULLTEXT_CHUNK_SIZE) - 1);
    // Every passage, metadata and body alike, has a vector.
    expect(final.vectors).toBe(final.documents);
  });

  it('reports metadata-only when full text was never requested', async () => {
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    const final = await search.buildIncremental(pager(makeLibrary(2)));
    expect(final.fulltextEnabled).toBe(false);
    expect(final.fulltextItems).toBe(0);
    expect(final.fulltextPassages).toBe(0);
  });

  it('keeps building when one item\'s full text fails, and never asks past the item cap', async () => {
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    const asked: string[] = [];
    const final = await search.buildIncremental(pager(makeLibrary(50), 10), {
      maxItems: 12,
      fulltextFor: async (key) => {
        asked.push(key);
        if (key === 'K3') throw new Error('attachment vanished');
        return key === 'K5' ? BODY : undefined;
      },
    });

    expect(final.state).toBe('done');
    expect(final.items).toBe(12);
    expect(final.fulltextItems).toBe(1);
    // The cap bounds the expensive per-item fetch too: no full text is pulled for item 13+.
    expect(asked).toHaveLength(12);
    expect(asked).not.toContain('K12');
  });

  it('round-trips full-text passages through persistence', async () => {
    const a = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    await a.buildIncremental(pager(makeLibrary(2)), { fulltextFor: async (k) => (k === 'K0' ? BODY : undefined) });

    const b = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    b.loadFromJSON(JSON.parse(JSON.stringify(a.toJSON())));

    const status = b.status();
    expect(status.fulltextEnabled).toBe(true);
    expect(status.fulltextItems).toBe(a.status().fulltextItems);
    expect(status.fulltextPassages).toBe(a.status().fulltextPassages);
    const hits = await b.query('mixed precision throughput', { limit: 1 });
    expect(hits[0]!.itemKey).toBe('K0');
    expect(hits[0]!.source).toBe('fulltext');
  });
});

/** Attachment/full-text doubles shaped like the router's own responses. */
function makeCtx(opts: {
  attachments?: any[];
  withText?: Record<string, number>;
  fulltext?: Record<string, any>;
  sinceThrows?: boolean;
  /** Fail the first N keyed attachment lookups, whichever keys they name. */
  failFirstLookups?: number;
  /** Fail every keyed lookup naming one of these attachment keys, forever. */
  failKeys?: string[];
  config?: Record<string, string>;
} = {}) {
  const attachments = opts.attachments ?? [];
  const withText = opts.withText ?? {};
  const fullTextSince = vi.fn(async () => {
    if (opts.sinceThrows) throw new Error('403 Forbidden');
    return withText;
  });
  const getFullText = vi.fn(async (key: string) => opts.fulltext?.[key] ?? null);
  const BUDGET = 'Zotero took longer than the 25s budget to answer a single request';
  let lookups = 0;
  const searchItems = vi.fn(async (q: any) => {
    const start = q.start ?? 0;
    const source = q.itemType === 'attachment' ? attachments : [];
    // The attachment map asks by key, so the double answers by key, as both APIs do.
    const want = q.itemKey ? new Set(String(q.itemKey).split(',')) : undefined;
    if (q.itemType === 'attachment') {
      if (++lookups <= (opts.failFirstLookups ?? 0)) throw new Error(BUDGET);
      if (want && opts.failKeys?.some((k) => want.has(k))) throw new Error(BUDGET);
    }
    const rows = want ? source.filter((row: any) => want.has(row.key)) : source;
    return {
      data: rows.slice(start, start + (q.limit ?? PAGE_SIZE)),
      totalResults: rows.length,
      lastModifiedVersion: 1,
    };
  });
  const ctx: any = {
    config: loadConfig((opts.config ?? {}) as any),
    router: {
      fullTextSince,
      getFullText,
      searchItems,
      servesLocally: () => false,
      defaultLibrary: () => ({ type: 'user', id: 1 }),
    },
    search: new MemorySearchIndex({ embedder: null, logger: silentLogger }),
    logger: silentLogger,
    searchIndexPath: '',
  };
  return { ctx, fullTextSince, getFullText, searchItems };
}

function attachment(key: string, parent?: string) {
  return { key, data: { key, itemType: 'attachment', contentType: 'application/pdf', parentItem: parent } };
}

describe('createFulltextSource', () => {
  it('maps attachments to their parent and fetches only those that have text', async () => {
    const { ctx, getFullText } = makeCtx({
      attachments: [attachment('ATT1', 'ITEM1'), attachment('ATT2', 'ITEM2'), attachment('ATT3', 'ITEM3')],
      // ATT3 is a PDF Zotero has never extracted, so it is not in the full-text map.
      withText: { ATT1: 10, ATT2: 11 },
      fulltext: { ATT1: { content: 'alpha body' }, ATT2: { content: 'beta body' } },
    });
    const src = await createFulltextSource(ctx, undefined);

    expect(src.attachments).toBe(2);
    expect(src.items).toBe(2);
    expect(src.unavailable).toBeUndefined();
    expect(await src.textFor('ITEM1')).toBe('alpha body');
    expect(await src.textFor('ITEM3')).toBeUndefined();
    // Never fetched: the un-extracted attachment costs no request at all.
    expect(getFullText).toHaveBeenCalledTimes(1);
    expect(getFullText).not.toHaveBeenCalledWith('ATT3', expect.anything());
  });

  it('treats a top-level attachment as its own item', async () => {
    const { ctx } = makeCtx({
      attachments: [attachment('ATT1')],
      withText: { ATT1: 3 },
      fulltext: { ATT1: { content: 'standalone pdf body' } },
    });
    const src = await createFulltextSource(ctx, undefined);
    expect(await src.textFor('ATT1')).toBe('standalone pdf body');
  });

  it('concatenates several attachments and caps the total per item', async () => {
    const { ctx } = makeCtx({
      attachments: [attachment('ATT1', 'ITEM1'), attachment('ATT2', 'ITEM1')],
      withText: { ATT1: 1, ATT2: 2 },
      fulltext: { ATT1: { content: 'a'.repeat(30) }, ATT2: { content: 'b'.repeat(30) } },
    });
    const src = await createFulltextSource(ctx, undefined, { maxChars: 40 });
    const text = await src.textFor('ITEM1');
    // 30 from the first, 10 from the second, plus the separator between them.
    expect(text!.replace(/\n/g, '')).toHaveLength(40);
    expect(text).toContain('a'.repeat(30));
    expect(text).toContain('b'.repeat(10));
  });

  it('takes maxChars:0 as no cap', async () => {
    const { ctx } = makeCtx({
      attachments: [attachment('ATT1', 'ITEM1')],
      withText: { ATT1: 1 },
      fulltext: { ATT1: { content: 'c'.repeat(DEFAULT_FULLTEXT_MAX_CHARS + 500) } },
    });
    const src = await createFulltextSource(ctx, undefined, { maxChars: 0 });
    expect((await src.textFor('ITEM1'))!.length).toBe(DEFAULT_FULLTEXT_MAX_CHARS + 500);
  });

  it('degrades with a reason instead of throwing when full text cannot be listed', async () => {
    const { ctx, searchItems } = makeCtx({ sinceThrows: true });
    const src = await createFulltextSource(ctx, undefined);
    expect(src.unavailable).toMatch(/403 Forbidden/);
    expect(src.attachments).toBe(0);
    // Opening it degrades; ASKING it refuses. A source that never opened knows nothing
    // about any item, and answering "this item has no text" would let an update index that
    // over the body passages it already holds and then stamp past them (#67).
    expect(src.incomplete).toMatch(/full-text index could not be listed: 403 Forbidden/);
    await expect(src.textFor('ITEM1')).rejects.toThrow(/403 Forbidden/);
    // The expensive attachment walk never starts once the cheap probe has failed.
    expect(searchItems).not.toHaveBeenCalled();
  });

  it('explains an empty library rather than reporting a healthy zero', async () => {
    const { ctx } = makeCtx({ withText: {} });
    const src = await createFulltextSource(ctx, undefined);
    expect(src.unavailable).toMatch(/no attachments with extracted full text/i);
  });

  it('survives one unreadable attachment, and says which item it could not read', async () => {
    const { ctx } = makeCtx({
      attachments: [attachment('ATT1', 'ITEM1'), attachment('ATT2', 'ITEM2')],
      withText: { ATT1: 1, ATT2: 2 },
      fulltext: { ATT2: { content: 'readable body' } },
    });
    ctx.router.getFullText = vi.fn(async (key: string) => {
      if (key === 'ATT1') throw new Error('storage offline');
      return { content: 'readable body' };
    });
    const src = await createFulltextSource(ctx, undefined);
    // The failure is confined to the item whose attachment it was: the rest of the library
    // is read normally. It is reported rather than folded into the `undefined` an item with
    // no extracted text gets, which is what let an update erase indexed bodies (#67).
    await expect(src.textFor('ITEM1')).rejects.toThrow(/storage offline/);
    expect(await src.textFor('ITEM2')).toBe('readable body');
    expect(src.readFailures()).toBe(1);
  });

  it('refuses to answer for an item whose batch of keys Zotero never answered', async () => {
    // A batch that never answered leaves its items unknown, so an item the map does not
    // hold may simply belong to it. Saying "no text" there is a guess an update would
    // index over the body passages the item already has (#67).
    const { ctx } = makeCtx({
      attachments: [attachment('ATT1', 'ITEM1'), attachment('ATT2', 'ITEM2')],
      withText: { ATT1: 1, ATT2: 2 },
      fulltext: { ATT1: { content: 'first body' } },
      // ATT1 and ATT2 are one batch, so break it after a first pass has mapped ATT1: the
      // sweep over what is left is what fails for good.
      failKeys: ['ATT2'],
    });
    // Resolve ATT1 out of band, the way a first pass does, then let the sweep fail.
    ctx.router.searchItems.mockImplementationOnce(async () => ({
      data: [attachment('ATT1', 'ITEM1')],
      totalResults: 1,
      lastModifiedVersion: 1,
    }));
    const src = await createFulltextSource(ctx, undefined);
    expect(src.incomplete).toMatch(/attachment map stopped early after 1\/2 attachment\(s\): .*25s budget/);
    expect(await src.textFor('ITEM1')).toBe('first body');
    await expect(src.textFor('ITEM2')).rejects.toThrow(/stopped early/);
  });

  /** #78: the map is driven by the full-text census, in keyed batches, never by offsets. */
  describe('keyed batching (#78)', () => {
    /** `n` attachments, each under its own item, all of them extracted. */
    function manyAttachments(n: number) {
      const attachments = Array.from({ length: n }, (_, i) => attachment(key(i), `ITEM${i}`));
      const withText = Object.fromEntries(attachments.map((a, i) => [a.key, i + 1]));
      const fulltext = Object.fromEntries(attachments.map((a) => [a.key, { content: `body of ${a.key}` }]));
      return { attachments, withText, fulltext };
    }
    /** Zero-padded, so the map's sorted batches are the obvious ones. */
    const key = (i: number) => `A${String(i).padStart(3, '0')}`;

    /** Every attachment lookup the map issued. */
    const lookups = (searchItems: any) =>
      searchItems.mock.calls.map((c: any[]) => c[0]).filter((q: any) => q.itemType === 'attachment');

    it('asks by key, at most 50 at a time, and never asks for an offset', async () => {
      const { ctx, searchItems } = makeCtx(manyAttachments(120));
      const src = await createFulltextSource(ctx, undefined);

      expect(src.incomplete).toBeUndefined();
      expect(src.attachments).toBe(120);
      const asked = lookups(searchItems);
      expect(asked).toHaveLength(3); // 50 + 50 + 20
      for (const q of asked) {
        expect(q.itemKey.split(',').length).toBeLessThanOrEqual(50);
        expect(q.limit).toBe(50);
        // The load-bearing filter: an `itemKey` lookup on the desktop API answers with the
        // named items AND all their descendants unless the type is named.
        expect(q.itemType).toBe('attachment');
        expect(q.start).toBeUndefined();
      }
      // Sorted keys, so batch one is exactly the first fifty.
      expect(asked[0].itemKey.split(',')).toEqual(Array.from({ length: 50 }, (_, i) => key(i)));
    });

    it('retries a batch that fails twice and then succeeds, and stays complete', async () => {
      const { ctx, searchItems } = makeCtx({ ...manyAttachments(20), failFirstLookups: 2 });
      const src = await createFulltextSource(ctx, undefined);

      // Two failures, then the answer: the map is whole, so the cursor may be stamped.
      expect(lookups(searchItems)).toHaveLength(3);
      expect(src.incomplete).toBeUndefined();
      expect(src.attachments).toBe(20);
      expect(src.maxVersion).toBe(20);
      expect(await src.textFor('ITEM7')).toBe(`body of ${key(7)}`);
    });

    it('carries on past a batch that never answers, and ends incomplete', async () => {
      // The middle batch is broken for good; the third must still be asked for. Before
      // this, one failed request ended the whole map (#78).
      const { ctx, searchItems } = makeCtx({ ...manyAttachments(120), failKeys: [key(60)] });
      const src = await createFulltextSource(ctx, undefined);

      expect(src.attachments).toBe(70); // batches one and three
      expect(src.items).toBe(70);
      expect(src.incomplete).toMatch(/attachment map stopped early after 70\/120 attachment\(s\)/);
      // The batch after the broken one was asked for, and its text is served.
      expect(await src.textFor('ITEM110')).toBe(`body of ${key(110)}`);
      // Three attempts on the failing batch in the first pass, three more in the sweep.
      const failed = lookups(searchItems).filter((q: any) => q.itemKey.includes(key(60)));
      expect(failed).toHaveLength(6);
      // An item on the batch that never answered is unknown, not textless (#67).
      await expect(src.textFor('ITEM60')).rejects.toThrow(/stopped early/);
    });
  });
});

describe('startIndexBuild with full text', () => {
  async function finished(search: SearchIndex): Promise<void> {
    for (let i = 0; i < 1000 && search.buildStatus().state === 'building'; i++) {
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  it('is off unless asked for, and ZOTEUS_INDEX_FULLTEXT is what asks by default', async () => {
    const { ctx, fullTextSince } = makeCtx();
    ctx.router.searchItems = vi.fn(async (q: any) =>
      q.top
        ? { data: makeLibrary(2).slice(q.start ?? 0), totalResults: 2, lastModifiedVersion: 1 }
        : { data: [], totalResults: 0, lastModifiedVersion: 1 },
    );
    startIndexBuild(ctx);
    await finished(ctx.search);
    expect(fullTextSince).not.toHaveBeenCalled();
    expect(ctx.search.buildStatus().fulltextEnabled).toBe(false);
  });

  it('indexes PDF bodies end to end when enabled by config', async () => {
    const { ctx, fullTextSince } = makeCtx({
      attachments: [attachment('ATT1', 'K1')],
      withText: { ATT1: 9 },
      fulltext: { ATT1: { content: BODY } },
      config: { ZOTEUS_INDEX_FULLTEXT: 'true' },
    });
    const items = makeLibrary(3);
    const listAttachments = ctx.router.searchItems;
    ctx.router.searchItems = vi.fn(async (q: any) =>
      q.top ? { data: items.slice(q.start ?? 0), totalResults: items.length, lastModifiedVersion: 1 } : listAttachments(q),
    );

    startIndexBuild(ctx);
    await finished(ctx.search);

    const s = ctx.search.buildStatus();
    expect(s.state).toBe('done');
    expect(fullTextSince).toHaveBeenCalledTimes(1); // one library-wide probe, not one per item
    expect(s.fulltextEnabled).toBe(true);
    expect(s.fulltextItems).toBe(1);
    expect(statusSummary(s)).toMatch(/including attachment full text for 1 of them/);

    const hits = await ctx.search.query('eleven percent throughput', { limit: 1 });
    expect(hits[0]!.itemKey).toBe('K1');
    expect(hits[0]!.source).toBe('fulltext');
  });

  it('stamps the full-text cursor over a map whose retries made it whole (#78)', async () => {
    const { ctx } = makeCtx({
      attachments: [attachment('ATT1', 'K1')],
      withText: { ATT1: 9 },
      fulltext: { ATT1: { content: BODY } },
      failFirstLookups: 2,
    });
    const items = makeLibrary(3);
    const listAttachments = ctx.router.searchItems;
    ctx.router.searchItems = vi.fn(async (q: any) =>
      q.top ? { data: items.slice(q.start ?? 0), totalResults: items.length, lastModifiedVersion: 1 } : listAttachments(q),
    );

    startIndexBuild(ctx, undefined, undefined, { fulltext: true });
    await finished(ctx.search);

    const s = ctx.search.buildStatus();
    expect(s.state).toBe('done');
    expect(s.fulltextItems).toBe(1);
    // Two failed attempts cost the map nothing: it is whole, so the cursor is stamped and
    // the next update asks Zotero's full-text sequence from there rather than from 0.
    expect(s.fulltextReason).toBeUndefined();
    expect(s.fulltextVersion).toBe(9);
  });

  it('says why a requested full-text build produced nothing', async () => {
    const { ctx } = makeCtx({ sinceThrows: true });
    const items = makeLibrary(2);
    ctx.router.searchItems = vi.fn(async (q: any) => ({
      data: q.top ? items.slice(q.start ?? 0) : [],
      totalResults: q.top ? items.length : 0,
      lastModifiedVersion: 1,
    }));

    startIndexBuild(ctx, undefined, undefined, { fulltext: true });
    await finished(ctx.search);

    const s = ctx.search.buildStatus();
    expect(s.state).toBe('done');
    expect(s.items).toBe(2); // the metadata index still built
    expect(s.fulltextEnabled).toBe(true);
    expect(s.fulltextPassages).toBe(0);
    expect(s.fulltextReason).toMatch(/403 Forbidden/);
    expect(statusSummary(s)).toMatch(/Full-text indexing produced nothing/);
  });
});
