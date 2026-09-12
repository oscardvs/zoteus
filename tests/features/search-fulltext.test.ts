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
  /** Page the attachment crawl one at a time and fail its second page, mid-map. */
  pageTwoThrows?: boolean;
  config?: Record<string, string>;
} = {}) {
  const attachments = opts.attachments ?? [];
  const withText = opts.withText ?? {};
  const fullTextSince = vi.fn(async () => {
    if (opts.sinceThrows) throw new Error('403 Forbidden');
    return withText;
  });
  const getFullText = vi.fn(async (key: string) => opts.fulltext?.[key] ?? null);
  const searchItems = vi.fn(async (q: any) => {
    const start = q.start ?? 0;
    const source = q.itemType === 'attachment' ? attachments : [];
    if (opts.pageTwoThrows && q.itemType === 'attachment' && start > 0) throw new Error('page two gone');
    const size = opts.pageTwoThrows ? 1 : (q.limit ?? PAGE_SIZE);
    return { data: source.slice(start, start + size), totalResults: source.length, lastModifiedVersion: 1 };
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

/**
 * A saved web page, which is what Zotero stores for a `webpage` item: `imported_url` rather
 * than `imported_file`, and `text/html` rather than a PDF. Zotero extracts its text into the
 * same full-text index a PDF's goes into and serves it from the same `/fulltext` endpoint, so
 * nothing downstream of the census may treat it differently (#78).
 */
function htmlSnapshot(key: string, parent?: string) {
  return {
    key,
    data: {
      key,
      itemType: 'attachment',
      contentType: 'text/html',
      linkMode: 'imported_url',
      filename: 'index.html',
      parentItem: parent,
    },
  };
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

  it('serves an HTML snapshot exactly as it serves a PDF', async () => {
    // Nothing between Zotero's census and the indexed passage may narrow by content type,
    // link mode or file extension: an `imported_url` `text/html` snapshot is text Zotero
    // extracted, and the map, the read and the cap treat it as such (#78).
    const { ctx, getFullText } = makeCtx({
      attachments: [htmlSnapshot('SNAP1', 'PAGE1'), attachment('ATT1', 'ITEM1')],
      withText: { SNAP1: 12, ATT1: 13 },
      fulltext: { SNAP1: { content: 'the snapshot body' }, ATT1: { content: 'the pdf body' } },
    });
    const src = await createFulltextSource(ctx, undefined);

    expect(src.attachments).toBe(2);
    expect([...src.itemKeys].sort()).toEqual(['ITEM1', 'PAGE1']);
    expect(await src.textFor('PAGE1')).toBe('the snapshot body');
    expect(getFullText).toHaveBeenCalledWith('SNAP1', expect.anything());
    // And the reverse direction, which is what an update resolves its delta through: the
    // snapshot's key comes back as the page it hangs off, not dropped as an unknown item.
    expect([...src.itemsFor(['SNAP1'])]).toEqual(['PAGE1']);
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

  it('refuses to answer for an item its attachment map never reached', async () => {
    // The map stopped early, so an item it does not hold may simply be on the pages this
    // crawl never read. Saying "no text" there is a guess an update would index (#67).
    const { ctx } = makeCtx({
      attachments: [attachment('ATT1', 'ITEM1'), attachment('ATT2', 'ITEM2')],
      withText: { ATT1: 1, ATT2: 2 },
      fulltext: { ATT1: { content: 'first body' } },
      pageTwoThrows: true,
    });
    const src = await createFulltextSource(ctx, undefined);
    expect(src.incomplete).toMatch(/attachment map stopped early after 1\/2 attachment\(s\): page two gone/);
    expect(await src.textFor('ITEM1')).toBe('first body');
    await expect(src.textFor('ITEM2')).rejects.toThrow(/stopped early/);
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

  it('indexes a saved web page\'s body onto the webpage item that owns it', async () => {
    // The shape reported against #78: a `webpage` item whose ONLY child is an `imported_url`
    // `text/html` snapshot, so nothing but the snapshot can put body text on it. Zotero has
    // the text, and the build has to carry it all the way to a passage attributed to the
    // parent, or the page is findable by its title alone.
    const SNAPSHOT_BODY =
      'The scheduler picks the best moment for a card to come up for review again. '.repeat(12);
    const { ctx } = makeCtx({
      attachments: [htmlSnapshot('SNAP1', 'PAGE1')],
      withText: { SNAP1: 7 },
      fulltext: { SNAP1: { content: SNAPSHOT_BODY } },
      config: { ZOTEUS_INDEX_FULLTEXT: 'true' },
    });
    const items = [
      { key: 'PAGE1', data: { itemType: 'webpage', title: 'The Mnemosyne Project', abstractNote: '' } },
      { key: 'K9', data: { itemType: 'journalArticle', title: 'Unrelated paper' } },
    ];
    const listAttachments = ctx.router.searchItems;
    ctx.router.searchItems = vi.fn(async (q: any) =>
      q.top ? { data: items.slice(q.start ?? 0), totalResults: items.length, lastModifiedVersion: 1 } : listAttachments(q),
    );

    startIndexBuild(ctx);
    await finished(ctx.search);

    const s = ctx.search.buildStatus();
    expect(s.state).toBe('done');
    expect(s.fulltextItems).toBe(1);
    expect(s.fulltextPassages).toBeGreaterThan(0);

    // A phrase that exists only inside the snapshot finds the page, as body text and not as
    // a title match: `source` is what separates the two.
    const hits = await ctx.search.query('best moment card come up review', { limit: 1 });
    expect(hits[0]!.itemKey).toBe('PAGE1');
    expect(hits[0]!.source).toBe('fulltext');
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
