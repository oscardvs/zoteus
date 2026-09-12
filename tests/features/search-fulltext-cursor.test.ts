import { describe, it, expect, vi } from 'vitest';
import { createSearchIndex, nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { MemorySearchIndex } from '../../src/features/search/index-manager.js';
import { PAGE_SIZE, startIndexBuild, startIndexUpdate } from '../../src/features/search/build.js';
import { loadConfig } from '../../src/config.js';
import type { IndexSnapshot, SearchIndex, SearchIndexOptions } from '../../src/features/search/backend.js';

/**
 * Zotero versions extracted full text on a sequence of its own, unrelated to item versions.
 * Opening a PDF for the first time makes Zotero extract it and touches no item version at
 * all, so that item appears in no `?since=` delta, ever — and an index's full-text coverage
 * stayed frozen at build time with a rebuild as the only remedy (#26). An update now carries
 * a cursor into the other sequence and asks it what has been extracted since.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

const hasSqlite = nodeSqliteAvailable();
const backends: Array<'memory' | 'sqlite'> = hasSqlite ? ['memory', 'sqlite'] : ['memory'];

const BODY_ONE = 'The ablation removes the recurrent gate entirely. '.repeat(20);
const BODY_TWO = 'Perovskite tandem cells degrade under sustained illumination. '.repeat(20);
const BODY_THREE = 'Appendix C derives the isostatic rebound of the mantle. '.repeat(20);

/** A library with the two independent version sequences the real one has. */
class FakeZotero {
  itemVersion = 0;
  fulltextVersion = 0;
  private readonly items = new Map<string, { key: string; version: number; data: any }>();
  private readonly attachments = new Map<
    string,
    { key: string; parent?: string; version?: number; content?: string }
  >();

  putItem(key: string, title: string, abstractNote = ''): void {
    this.itemVersion++;
    this.items.set(key, { key, version: this.itemVersion, data: { key, itemType: 'journalArticle', title, abstractNote } });
  }

  /** A PDF sits under the item. Zotero has not read it yet, so it has no full text. */
  attach(key: string, parent?: string): void {
    this.itemVersion++;
    this.attachments.set(key, { key, parent });
  }

  /**
   * Zotero extracts the PDF, as it does the first time one is opened: the full-text
   * sequence moves and the item sequence does not. That asymmetry is the whole issue.
   */
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
      servesLocally: vi.fn(() => false),
      defaultLibrary: () => ({ type: 'user' as const, id: 1 }),
      searchItems: vi.fn(async (q: any) => {
        const start = q.start ?? 0;
        const limit = q.limit ?? PAGE_SIZE;
        if (q.itemType === 'attachment') {
          // The map asks for attachments by key, 50 at a time, so this answers by key.
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
      }),
      itemVersions: vi.fn(async (q: any) => {
        const start = q.start ?? 0;
        const page = items().slice(start, start + (q.limit ?? PAGE_SIZE));
        return {
          versions: Object.fromEntries(page.map((it) => [it.key, it.version])),
          totalResults: this.items.size,
          lastModifiedVersion: this.itemVersion,
        };
      }),
      // `/fulltext?since=` answers on the OTHER sequence: attachment keys, their full-text
      // versions, and only those newer than the cursor handed in.
      fullTextSince: vi.fn(async (since: number) =>
        Object.fromEntries(
          atts()
            .filter((a) => a.version !== undefined && a.version > since)
            .map((a) => [a.key, a.version!]),
        ),
      ),
      getFullText: vi.fn(async (key: string) => {
        const att = this.attachments.get(key);
        return att?.content ? { content: att.content } : null;
      }),
    };
  }
}

async function openIndex(backend: 'memory' | 'sqlite', opts: Partial<SearchIndexOptions> = {}): Promise<SearchIndex> {
  return createSearchIndex({ embedder: null, logger: silentLogger, ...opts, backend, jsonPath: '' });
}

function makeCtx(search: SearchIndex, router: any): any {
  return { config: loadConfig({} as any), search, router, logger: silentLogger, searchIndexPath: '' };
}

async function settle(search: SearchIndex): Promise<void> {
  for (let i = 0; i < 2000 && search.isBuilding; i++) await new Promise((r) => setTimeout(r, 2));
}

/** A two-item library: one PDF Zotero has read, one it has not looked at yet. */
function halfExtracted(): FakeZotero {
  const z = new FakeZotero();
  z.putItem('K1', 'Deep learning', 'convolutional networks classify images');
  z.putItem('K2', 'Photovoltaic perovskites', 'tandem cell stability');
  z.attach('ATT1', 'K1');
  z.attach('ATT2', 'K2');
  z.extract('ATT1', BODY_ONE);
  return z;
}

describe.each(backends)('full text extracted after the build (%s backend)', (backend) => {
  async function built() {
    const zotero = halfExtracted();
    const search = await openIndex(backend);
    const router = zotero.router();
    const ctx = makeCtx(search, router);
    startIndexBuild(ctx, undefined, undefined, { fulltext: true });
    await settle(search);
    return { zotero, search, router, ctx };
  }

  it('records the highest full-text version the build consumed', async () => {
    const { zotero, search } = await built();
    const s = search.buildStatus();
    expect(s.fulltextItems).toBe(1);
    // The cursor is a number from Zotero's full-text sequence, not from the item one.
    expect(s.fulltextVersion).toBe(zotero.fulltextVersion);
    expect(s.libraryVersion).toBe(zotero.itemVersion);
    expect(s.fulltextVersion).not.toBe(s.libraryVersion);
    await search.close();
  });

  it('is picked up by an update although the item itself never changed', async () => {
    const { zotero, search, router, ctx } = await built();
    expect(await search.query('perovskite illumination degrade', { mode: 'keyword' })).toEqual([]);
    const stamped = search.buildStatus().libraryVersion;

    // The ordinary case: the user opens K2's PDF in Zotero, which extracts it. No item
    // version moves, so `?since=` returns nothing at all.
    zotero.extract('ATT2', BODY_TWO);
    expect(zotero.itemVersion).toBe(stamped);

    startIndexUpdate(ctx, undefined, undefined, { fulltext: true });
    await settle(search);
    const s = search.buildStatus();

    expect(s.state).toBe('done');
    expect(s.operation).toBe('update');
    expect(s.itemsFetched).toBe(0); // nothing changed on the item sequence
    expect(s.fulltextItems).toBe(2);
    const hit = (await search.query('perovskite illumination degrade', { limit: 1 }))[0]!;
    expect(hit.itemKey).toBe('K2');
    expect(hit.source).toBe('fulltext');
    // K1's body is untouched, and was not fetched a second time to prove it.
    expect(router.getFullText.mock.calls.filter((c: any[]) => c[0] === 'ATT1')).toHaveLength(1);
    expect(s.updateNotice).toMatch(/1 unchanged item\(s\) gained newly extracted attachment full text/);
    expect(s.fulltextVersion).toBe(zotero.fulltextVersion);
    await search.close();
  });

  it('replaces an item\'s body passages when a second attachment is extracted', async () => {
    const { zotero, search, ctx } = await built();
    zotero.attach('ATT3', 'K1');
    zotero.extract('ATT3', BODY_THREE);

    startIndexUpdate(ctx, undefined, undefined, { fulltext: true });
    await settle(search);

    // Both bodies are searchable under the one item, and the passage ids the first
    // attachment used were retired rather than written over (SQLite would refuse that).
    expect((await search.query('isostatic rebound mantle', { limit: 1 }))[0]!.itemKey).toBe('K1');
    expect((await search.query('recurrent gate ablation', { limit: 1 }))[0]!.itemKey).toBe('K1');
    expect(search.buildStatus().fulltextItems).toBe(1);
    await search.close();
  });

  it('costs one probe and one empty page when nothing has been extracted since', async () => {
    const { search, router, ctx } = await built();
    router.searchItems.mockClear();
    router.fullTextSince.mockClear();
    router.getFullText.mockClear();

    startIndexUpdate(ctx, undefined, undefined, { fulltext: true });
    await settle(search);

    // The item crawl is the single empty page it always was.
    const crawls = router.searchItems.mock.calls.filter((c: any[]) => c[0].top);
    expect(crawls).toHaveLength(1);
    expect(crawls[0]![0]).toMatchObject({ since: search.buildStatus().libraryVersion, top: true });
    // The other sequence costs exactly one request, which answers with nothing, so the
    // attachment map is never built and no body is fetched.
    expect(router.fullTextSince).toHaveBeenCalledTimes(1);
    expect(router.fullTextSince.mock.calls[0]![0]).toBe(search.buildStatus().fulltextVersion);
    expect(router.searchItems.mock.calls.filter((c: any[]) => c[0].itemType === 'attachment')).toHaveLength(0);
    expect(router.getFullText).not.toHaveBeenCalled();
    expect(search.buildStatus().updateNotice).not.toMatch(/gained newly extracted/);
    await search.close();
  });

  it('advances the cursor only when the update fully succeeded', async () => {
    const { zotero, search, router, ctx } = await built();
    const cursor = search.buildStatus().fulltextVersion;
    zotero.extract('ATT2', BODY_TWO);

    // The deletion census fails, so the whole delta is retried next time: a cursor that
    // moved anyway would skip this text forever.
    router.itemVersions.mockRejectedValueOnce(new Error('Zotero 503'));
    startIndexUpdate(ctx, undefined, undefined, { fulltext: true });
    await settle(search);
    expect(search.buildStatus().state).toBe('error');
    expect(search.buildStatus().fulltextVersion).toBe(cursor);

    startIndexUpdate(ctx, undefined, undefined, { fulltext: true });
    await settle(search);
    expect(search.buildStatus().fulltextVersion).toBe(zotero.fulltextVersion);
    expect((await search.query('perovskite illumination degrade', { limit: 1 }))[0]!.itemKey).toBe('K2');
    await search.close();
  });
});

describe('the SQLite backend keeps its FTS5 index honest through a catch-up', () => {
  const sqliteIt = hasSqlite ? it : it.skip;

  sqliteIt('passes an integrity check after body passages are replaced', async () => {
    const zotero = halfExtracted();
    const search = await openIndex('sqlite');
    const ctx = makeCtx(search, zotero.router());
    startIndexBuild(ctx, undefined, undefined, { fulltext: true });
    await settle(search);

    zotero.extract('ATT2', BODY_TWO);
    zotero.attach('ATT3', 'K1');
    zotero.extract('ATT3', BODY_THREE);
    startIndexUpdate(ctx, undefined, undefined, { fulltext: true });
    await settle(search);

    // The external-content delete protocol was followed for the body rows too, or this
    // throws: FTS5 verifies that every indexed term still resolves to a content row.
    const db = (search as any).db;
    expect(() => db.exec("INSERT INTO passages_fts(passages_fts) VALUES('integrity-check')")).not.toThrow();
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM passages_fts').get().n)).toBe(search.buildStatus().documents);
    expect((await search.query('isostatic rebound mantle', { limit: 1 }))[0]!.itemKey).toBe('K1');
    await search.close();
  });
});

describe('an update that was never asked for full text', () => {
  it('does not consult the full-text sequence at all', async () => {
    const zotero = halfExtracted();
    const search = await openIndex('memory');
    const router = zotero.router();
    const ctx = makeCtx(search, router);
    startIndexBuild(ctx, undefined, undefined, { fulltext: true });
    await settle(search);
    router.fullTextSince.mockClear();

    zotero.extract('ATT2', BODY_TWO);
    startIndexUpdate(ctx, undefined, undefined, { fulltext: false });
    await settle(search);

    expect(router.fullTextSince).not.toHaveBeenCalled();
    expect(search.buildStatus().fulltextItems).toBe(1);
  });

  it('never turns a metadata-only index into a full-text crawl', async () => {
    // `update fulltext:true` over an index that holds no body text at all would otherwise
    // become the hours-long build the user did not ask for.
    const zotero = halfExtracted();
    const search = await openIndex('memory');
    const router = zotero.router();
    const ctx = makeCtx(search, router);
    startIndexBuild(ctx);
    await settle(search);
    expect(search.buildStatus().fulltextPassages).toBe(0);
    router.getFullText.mockClear();

    startIndexUpdate(ctx, undefined, undefined, { fulltext: true });
    await settle(search);

    expect(router.getFullText).not.toHaveBeenCalled();
    expect(search.buildStatus().fulltextPassages).toBe(0);
  });

  it('carries on with the delta when the full-text probe fails', async () => {
    const zotero = halfExtracted();
    const search = await openIndex('memory');
    const router = zotero.router();
    const ctx = makeCtx(search, router);
    startIndexBuild(ctx, undefined, undefined, { fulltext: true });
    await settle(search);
    const cursor = search.buildStatus().fulltextVersion;

    router.fullTextSince.mockRejectedValueOnce(new Error('403 Forbidden'));
    zotero.putItem('K3', 'Glacial isostasy', 'mantle viscosity inversions');
    startIndexUpdate(ctx, undefined, undefined, { fulltext: true });
    await settle(search);

    const s = search.buildStatus();
    expect(s.state).toBe('done');
    expect(s.itemsFetched).toBe(1); // the item delta landed
    expect(s.fulltextVersion).toBe(cursor); // and the cursor stayed put, so the next one asks again
    expect((await search.query('mantle viscosity', { limit: 1 }))[0]!.itemKey).toBe('K3');
  });
});

describe('an index built before the full-text cursor existed', () => {
  /** The v1.9.0 artifact: rows, a stamp, and no `fulltextVersion` at all. */
  async function migrated(): Promise<{ zotero: FakeZotero; search: MemorySearchIndex; router: any; ctx: any }> {
    const zotero = halfExtracted();
    const built = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    const first = makeCtx(built, zotero.router());
    startIndexBuild(first, undefined, undefined, { fulltext: true });
    await settle(built);
    const snapshot = JSON.parse(JSON.stringify(built.toJSON())) as IndexSnapshot;
    delete snapshot.fulltextVersion;

    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    search.loadFromJSON(snapshot);
    const router = zotero.router();
    return { zotero, search, router, ctx: makeCtx(search, router) };
  }

  it('loads, and reports no cursor rather than a wrong one', async () => {
    const { search } = await migrated();
    expect(search.buildStatus().fulltextVersion).toBe(0);
    expect(search.buildStatus().fulltextItems).toBe(1);
    expect(search.buildStatus().libraryVersion).toBeGreaterThan(0);
  });

  it('closes its coverage gap once, then keeps a real cursor', async () => {
    const { zotero, search, router, ctx } = await migrated();
    zotero.extract('ATT2', BODY_TWO);
    router.getFullText.mockClear();

    startIndexUpdate(ctx, undefined, undefined, { fulltext: true });
    await settle(search);

    // Bounded by the gap: only the item holding no body passages was fetched, never the
    // one already covered, although a cursor of 0 makes the census report both as new.
    expect(router.getFullText.mock.calls.map((c: any[]) => c[0])).toEqual(['ATT2']);
    expect((await search.query('perovskite illumination degrade', { limit: 1 }))[0]!.itemKey).toBe('K2');
    expect(search.buildStatus().fulltextVersion).toBe(zotero.fulltextVersion);

    // And the catch-up is a one-off: with a real cursor, the next update asks from there.
    router.fullTextSince.mockClear();
    startIndexUpdate(ctx, undefined, undefined, { fulltext: true });
    await settle(search);
    expect(router.fullTextSince.mock.calls[0]![0]).toBe(zotero.fulltextVersion);
  });
});

/**
 * The #26/#67 guarantee on the BUILD path (#78). A build narrows its full-text worklist to
 * the keys the attachment map reached, so an attachment the map never listed is never read
 * and never counted as a read failure: the two withholding conditions the build already had
 * (read failures, a cancelled crawl) both stay clean, and the census-wide cursor is stamped
 * over a map that covered a fraction of the library. The items behind that cursor are then
 * named by no `?since=` on either sequence, ever.
 */
describe.each(backends)('a build whose attachment map stopped early (%s backend)', (backend) => {
  /** Three items, three extracted PDFs: enough for a map that stops after the first page. */
  function threeExtracted(): FakeZotero {
    const z = new FakeZotero();
    z.putItem('K1', 'Deep learning', 'convolutional networks classify images');
    z.putItem('K2', 'Photovoltaic perovskites', 'tandem cell stability');
    z.putItem('K3', 'Glacial isostasy', 'mantle viscosity inversions');
    z.attach('ATT1', 'K1');
    z.attach('ATT2', 'K2');
    z.attach('ATT3', 'K3');
    z.extract('ATT1', BODY_ONE);
    z.extract('ATT2', BODY_TWO);
    z.extract('ATT3', BODY_THREE);
    return z;
  }

  /**
   * The reporter's shape at small scale: the attachment listing serves one page and then
   * takes longer than the per-request budget, so the map holds a third of the library and
   * says so. Everything else answers normally.
   */
  function mapStopsAfterOnePage(zotero: FakeZotero): any {
    const router = zotero.router();
    const listing = router.searchItems;
    let attachmentPages = 0;
    router.searchItems = vi.fn(async (q: any) => {
      if (q.itemType !== 'attachment') return listing(q);
      if (attachmentPages++ > 0) {
        throw new Error('Zotero took longer than the 25s budget to answer a single request');
      }
      return listing({ ...q, limit: 1 });
    });
    return router;
  }

  async function builtOverAPartialMap() {
    const zotero = threeExtracted();
    const search = await openIndex(backend);
    const router = mapStopsAfterOnePage(zotero);
    startIndexBuild(makeCtx(search, router), undefined, undefined, { fulltext: true });
    await settle(search);
    return { zotero, search, router };
  }

  it('records no full-text cursor, and keeps the item stamp it did earn', async () => {
    const { zotero, search } = await builtOverAPartialMap();
    const s = search.buildStatus();

    expect(s.state).toBe('done');
    // One of the three PDFs made it into the index, which is exactly the problem: the
    // build looks successful and the census-wide cursor would claim all three.
    expect(s.fulltextItems).toBe(1);
    expect(zotero.fulltextVersion).toBe(3);
    expect(s.fulltextVersion).toBe(0);
    // The metadata pass really did finish, and withholding ITS stamp would turn every
    // later update into the full rebuild this library cannot finish.
    expect(s.libraryVersion).toBe(zotero.itemVersion);
    // And the status says both halves: what stopped, and what was withheld because of it.
    expect(s.fulltextReason).toMatch(/attachment map stopped early after 1\/3/);
    expect(s.fulltextReason).toMatch(/cursor/i);
    await search.close();
  });

  it('lets the next update fill in the attachments the map never reached', async () => {
    const { zotero, search } = await builtOverAPartialMap();
    expect(await search.query('perovskite illumination degrade', { mode: 'keyword' })).toEqual([]);

    // Nothing changed in Zotero; the map is simply readable again.
    const healthy = zotero.router();
    startIndexUpdate(makeCtx(search, healthy), undefined, undefined, { fulltext: true });
    await settle(search);

    const s = search.buildStatus();
    expect(s.state).toBe('done');
    expect(s.fulltextItems).toBe(3);
    expect(s.fulltextVersion).toBe(zotero.fulltextVersion);
    expect((await search.query('perovskite illumination degrade', { limit: 1 }))[0]!.itemKey).toBe('K2');
    expect((await search.query('isostatic rebound mantle', { limit: 1 }))[0]!.itemKey).toBe('K3');
    // K1 is re-read too, although it already held body text. Over a map that stopped
    // early "this item has body passages" does not mean "this item has all of its body
    // text": a second attachment may sit on a page the map never listed. Skipping it is
    // what sealed the gap the recovery is supposed to close, so the recovery runs in full
    // rather than gap-only mode (see the straddling-attachments block below).
    expect(healthy.getFullText.mock.calls.map((c: any[]) => c[0]).sort()).toEqual(['ATT1', 'ATT2', 'ATT3']);
    await search.close();
  });

  /**
   * The map resolving NOTHING is the one answer that is never taken at face value. Zotero
   * has just said this library holds attachments with extracted text; a keyed lookup that
   * names none of them is a broken map, not a library view without them, and stamping a
   * census-wide cursor over it is the silent gap #78 is about, reached without any request
   * failing at all.
   */
  it('withholds the cursor when the keyed lookups resolve no attachment at all', async () => {
    const zotero = new FakeZotero();
    zotero.putItem('K1', 'Deep learning', 'convolutional networks classify images');
    zotero.putItem('K2', 'Photovoltaic perovskites', 'tandem cell stability');
    zotero.attach('ATT1', 'K1');
    zotero.attach('ATT2', 'K2');
    zotero.extract('ATT1', BODY_ONE);
    zotero.extract('ATT2', BODY_TWO);

    const search = await openIndex(backend);
    const router = zotero.router();
    const listing = router.searchItems;
    // Zotero answers the keyed lookup, and names nothing.
    router.searchItems = vi.fn(async (q: any) =>
      q.itemType === 'attachment'
        ? { data: [], totalResults: 0, lastModifiedVersion: zotero.itemVersion }
        : listing(q),
    );
    startIndexBuild(makeCtx(search, router), undefined, undefined, { fulltext: true });
    await settle(search);

    const s = search.buildStatus();
    expect(s.state).toBe('done');
    expect(s.fulltextItems).toBe(0);
    expect(s.fulltextVersion).toBe(0);
    expect(s.fulltextReason).toMatch(/attachment map stopped early after 0\/2/);
    await search.close();
  });

  /**
   * The other side of that rule, and it has to hold or the cursor freezes forever: an
   * attachment Zotero ANSWERS about without naming is one it does not serve in this
   * library view (a trashed attachment, on the desktop API), which is exactly what the old
   * crawl concluded when it walked the whole listing and never saw the key. The rest of
   * the map is whole, so the cursor is stamped.
   */
  it('stamps the cursor when a lookup answers without naming one of its keys', async () => {
    const zotero = threeExtracted();
    const search = await openIndex(backend);
    const router = zotero.router();
    const listing = router.searchItems;
    router.searchItems = vi.fn(async (q: any) => {
      if (q.itemType !== 'attachment') return listing(q);
      const res = await listing(q);
      return { ...res, data: res.data.filter((row: any) => row.key !== 'ATT3') };
    });
    startIndexBuild(makeCtx(search, router), undefined, undefined, { fulltext: true });
    await settle(search);

    const s = search.buildStatus();
    expect(s.state).toBe('done');
    expect(s.fulltextItems).toBe(2);
    expect(s.fulltextVersion).toBe(zotero.fulltextVersion);
    expect(s.fulltextReason).toBeUndefined();
    await search.close();
  });

  /** The usual exit: every attachment with text was resolved, by key, in one batch. */
  it('stamps the cursor over a keyed map, and never pages the attachment listing', async () => {
    const zotero = threeExtracted();
    // Three more attachments Zotero has never opened. The map is driven by the full-text
    // census, so they cost no request at all: nothing walks the attachment listing.
    for (let i = 0; i < 3; i++) zotero.attach(`PAD${i}`, 'K1');
    const search = await openIndex(backend);
    const router = zotero.router();
    startIndexBuild(makeCtx(search, router), undefined, undefined, { fulltext: true });
    await settle(search);

    const s = search.buildStatus();
    expect(s.fulltextItems).toBe(3);
    expect(s.fulltextVersion).toBe(zotero.fulltextVersion);
    expect(s.fulltextReason).toBeUndefined();

    // Three extracted attachments is one batch of keys, and no offset is ever requested:
    // the deep pages that timed out on a 9k-attachment library are gone (#78).
    const lookups = router.searchItems.mock.calls
      .map((c: any[]) => c[0])
      .filter((q: any) => q.itemType === 'attachment');
    expect(lookups).toHaveLength(1);
    expect(lookups[0].itemKey.split(',').sort()).toEqual(['ATT1', 'ATT2', 'ATT3']);
    expect(lookups.every((q: any) => q.start === undefined)).toBe(true);
    await search.close();
  });
});


const BODY_FOUR = 'Table 4 lists the wafer annealing temperatures used throughout. '.repeat(20);

/**
 * Recovery has to be complete, or it seals what it did not fix (#78).
 *
 * Zotero lists attachments newest-modified first, so one item's attachments are not
 * adjacent in the crawl: on a library where the map stops at page 15 of 90, an item with
 * one attachment on a mapped page and another on a page the map never reached is ordinary.
 * That item already holds body passages, so the catch-up's gap-only filter (`!hasFulltext`)
 * skips it entirely, and the same update then advances the cursor to the census
 * high-water mark and clears the reason. The attachment the map missed is from then on
 * named by no `?since=` on either sequence, ever.
 */
describe.each(backends)('an item whose attachments straddle the cut (%s backend)', (backend) => {
  /** K1 holds ATT1 and ATT4, K2 holds ATT2, and Zotero has extracted all three. */
  function straddling(): FakeZotero {
    const z = new FakeZotero();
    z.putItem('K1', 'Deep learning', 'convolutional networks classify images');
    z.putItem('K2', 'Photovoltaic perovskites', 'tandem cell stability');
    z.attach('ATT1', 'K1');
    z.attach('ATT2', 'K2');
    z.attach('ATT4', 'K1');
    z.extract('ATT1', BODY_ONE);
    z.extract('ATT2', BODY_TWO);
    z.extract('ATT4', BODY_FOUR);
    return z;
  }

  /** The map serves one attachment (ATT1, K1's first) and then stops. */
  function mapStopsAfterOnePage(zotero: FakeZotero): any {
    const router = zotero.router();
    const listing = router.searchItems;
    let attachmentPages = 0;
    router.searchItems = vi.fn(async (q: any) => {
      if (q.itemType !== 'attachment') return listing(q);
      if (attachmentPages++ > 0) {
        throw new Error('Zotero took longer than the 25s budget to answer a single request');
      }
      return listing({ ...q, limit: 1 });
    });
    return router;
  }

  it('is read in full by the recovering update, not skipped for holding some text', async () => {
    const zotero = straddling();
    const search = await openIndex(backend);
    startIndexBuild(makeCtx(search, mapStopsAfterOnePage(zotero)), undefined, undefined, { fulltext: true });
    await settle(search);
    // The build indexed the half of K1 the map reached, and nothing of K2.
    expect((await search.query('recurrent gate ablation', { limit: 1 }))[0]!.itemKey).toBe('K1');
    expect(await search.query('wafer annealing temperatures', { mode: 'keyword' })).toEqual([]);
    expect(search.buildStatus().fulltextVersion).toBe(0);

    // Nothing changed in Zotero; the map is simply readable again.
    const healthy = zotero.router();
    startIndexUpdate(makeCtx(search, healthy), undefined, undefined, { fulltext: true });
    await settle(search);

    const s = search.buildStatus();
    expect(s.state).toBe('done');
    // The attachment the map never reached, which no `?since=` would ever name again.
    expect(healthy.getFullText.mock.calls.map((c: any[]) => c[0]).sort()).toEqual(['ATT1', 'ATT2', 'ATT4']);
    expect((await search.query('wafer annealing temperatures', { limit: 1 }))[0]!.itemKey).toBe('K1');
    expect((await search.query('recurrent gate ablation', { limit: 1 }))[0]!.itemKey).toBe('K1');
    expect((await search.query('perovskite illumination degrade', { limit: 1 }))[0]!.itemKey).toBe('K2');
    // Only now is the cursor earned, and only now does the reason come off.
    expect(s.fulltextVersion).toBe(zotero.fulltextVersion);
    expect(s.fulltextReason).toBeUndefined();

    // And it is a one-off: the next update is the idle one it always was.
    healthy.getFullText.mockClear();
    startIndexUpdate(makeCtx(search, healthy), undefined, undefined, { fulltext: true });
    await settle(search);
    expect(healthy.getFullText).not.toHaveBeenCalled();
    expect(search.buildStatus().fulltextVersion).toBe(zotero.fulltextVersion);
    expect((await search.query('wafer annealing temperatures', { limit: 1 }))[0]!.itemKey).toBe('K1');
    await search.close();
  });

  it('survives a restart: the partial coverage is remembered, not the cursor alone', async () => {
    const zotero = straddling();
    const built = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    startIndexBuild(makeCtx(built, mapStopsAfterOnePage(zotero)), undefined, undefined, { fulltext: true });
    await settle(built);

    // The process restarts: everything the next update knows comes off the artifact.
    const reloaded = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    reloaded.loadFromJSON(JSON.parse(JSON.stringify(built.toJSON())));
    const healthy = zotero.router();
    startIndexUpdate(makeCtx(reloaded, healthy), undefined, undefined, { fulltext: true });
    await settle(reloaded);

    expect(healthy.getFullText.mock.calls.map((c: any[]) => c[0]).sort()).toEqual(['ATT1', 'ATT2', 'ATT4']);
    expect((await reloaded.query('wafer annealing temperatures', { limit: 1 }))[0]!.itemKey).toBe('K1');
    expect(reloaded.buildStatus().fulltextVersion).toBe(zotero.fulltextVersion);
  });

  it('recovers a build whose map could not be walked at all', async () => {
    // The whole census is unmapped, so the build indexes no body text whatsoever: the
    // narrow case where the catch-up used to hand back the census version having indexed
    // nothing, and the caller stamped it.
    const zotero = straddling();
    const search = await openIndex(backend);
    const router = zotero.router();
    const listing = router.searchItems;
    router.searchItems = vi.fn(async (q: any) => {
      if (q.itemType === 'attachment') {
        throw new Error('Zotero took longer than the 25s budget to answer a single request');
      }
      return listing(q);
    });
    startIndexBuild(makeCtx(search, router), undefined, undefined, { fulltext: true });
    await settle(search);
    const built = search.buildStatus();
    expect(built.fulltextPassages).toBe(0);
    expect(built.fulltextVersion).toBe(0);

    const healthy = zotero.router();
    startIndexUpdate(makeCtx(search, healthy), undefined, undefined, { fulltext: true });
    await settle(search);

    const s = search.buildStatus();
    expect(s.fulltextItems).toBe(2);
    expect(s.fulltextVersion).toBe(zotero.fulltextVersion);
    expect((await search.query('wafer annealing temperatures', { limit: 1 }))[0]!.itemKey).toBe('K1');
    expect((await search.query('perovskite illumination degrade', { limit: 1 }))[0]!.itemKey).toBe('K2');
    await search.close();
  });
});

/**
 * The cursor is a claim about coverage, so an update that indexed nothing may not make it
 * (#78). `action:"update"` deliberately leaves a metadata-only index alone rather than
 * turning into the hours-long full-text crawl nobody asked for, but it used to hand back
 * the whole census's high-water mark on its way past, and the caller stamped it. The next
 * update then asked `?since=<that>`, so every attachment Zotero had already extracted was
 * named by no `?since=` on either sequence, ever.
 */
describe('an update over an index holding no body text at all', () => {
  it('leaves the cursor alone rather than stamping coverage it never indexed', async () => {
    const zotero = halfExtracted();
    const search = await openIndex('memory');
    const router = zotero.router();
    const ctx = makeCtx(search, router);
    startIndexBuild(ctx); // metadata only
    await settle(search);

    startIndexUpdate(ctx, undefined, undefined, { fulltext: true });
    await settle(search);
    expect(router.getFullText).not.toHaveBeenCalled();
    expect(search.buildStatus().fulltextVersion).toBe(0);

    // The seal this prevents: with a cursor stamped, the next update would index the one
    // attachment extracted after it and nothing else, leaving an index that holds a third
    // of the library's body text under a cursor claiming all of it.
    zotero.extract('ATT2', BODY_TWO);
    startIndexUpdate(ctx, undefined, undefined, { fulltext: true });
    await settle(search);
    expect(router.getFullText).not.toHaveBeenCalled();
    expect(search.buildStatus().fulltextVersion).toBe(0);
    expect(search.buildStatus().fulltextPassages).toBe(0);
  });
});

/**
 * The partial-coverage flag is a claim about what this index is missing, and only a pass
 * that actually made the coverage whole may retire it (#78).
 *
 * `recovered` was `!gapOnly && !token.cancelled`, and `gapOnly` is false for every
 * `since > 0` update, so an ordinary idle update, which reads nothing at all, reported
 * itself as a recovery and cleared the flag a moment after it was raised. The text the
 * truncated map dropped was then recorded nowhere: not in the index, not in the flag.
 *
 * The mirror of that: a delta raises the flag on an index that already carries a cursor,
 * and while it stands the catch-up asks Zotero's full-text sequence from the START rather
 * than from that cursor. Keying the recovery on `since === 0` instead made a flag raised
 * this way unreachable forever, since the cursor only ever moves forward.
 */
describe('a flag raised by a delta over a truncated map', () => {
  /** K1 holds ATT1 and ATT4, K2 holds ATT2, and Zotero has extracted all three. */
  function straddling(): FakeZotero {
    const z = new FakeZotero();
    z.putItem('K1', 'Deep learning', 'convolutional networks classify images');
    z.putItem('K2', 'Photovoltaic perovskites', 'tandem cell stability');
    z.attach('ATT1', 'K1');
    z.attach('ATT2', 'K2');
    z.attach('ATT4', 'K1');
    z.extract('ATT1', BODY_ONE);
    z.extract('ATT2', BODY_TWO);
    z.extract('ATT4', BODY_FOUR);
    return z;
  }

  /** The attachment listing serves one attachment and then takes too long, every time. */
  function mapStopsAfterOnePage(zotero: FakeZotero): any {
    const router = zotero.router();
    const listing = router.searchItems;
    let attachmentPages = 0;
    router.searchItems = vi.fn(async (q: any) => {
      if (q.itemType !== 'attachment') return listing(q);
      if (attachmentPages++ > 0) {
        throw new Error('Zotero took longer than the 25s budget to answer a single request');
      }
      return listing({ ...q, limit: 1 });
    });
    return router;
  }

  it('is retired only by a pass that made the coverage whole, and is reachable at all', async () => {
    const zotero = straddling();
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    // A healthy build: a real cursor, whole coverage, both of K1's bodies indexed.
    startIndexBuild(makeCtx(search, zotero.router()), undefined, undefined, { fulltext: true });
    await settle(search);
    expect(search.buildStatus().fulltextVersion).toBe(zotero.fulltextVersion);
    expect(search.toJSON().fulltextPartial).toBe(false);
    expect((await search.query('wafer annealing temperatures', { limit: 1 }))[0]!.itemKey).toBe('K1');

    // The reader edits K1 while the attachment map truncates: the delta re-indexes K1 off
    // ATT1 alone and drops ATT4's body text, which no `?since=` will ever name again.
    zotero.putItem('K1', 'Deep learning revisited', 'convolutional networks classify images');
    startIndexUpdate(makeCtx(search, mapStopsAfterOnePage(zotero)), undefined, undefined, { fulltext: true });
    await settle(search);
    expect(await search.query('wafer annealing temperatures', { mode: 'keyword' })).toEqual([]);
    expect(search.toJSON().fulltextPartial).toBe(true);
    const cursor = search.buildStatus().fulltextVersion;

    // An update whose own map stops short again: it can fill the coverage gap (there is
    // none here) and nothing more, so it has recovered nothing and says so.
    const stillTruncating = mapStopsAfterOnePage(zotero);
    startIndexUpdate(makeCtx(search, stillTruncating), undefined, undefined, { fulltext: true });
    await settle(search);

    expect(search.buildStatus().state).toBe('done');
    expect(search.buildStatus().fulltextVersion).toBe(cursor);
    expect(await search.query('wafer annealing temperatures', { mode: 'keyword' })).toEqual([]);
    // The one thing that still records the missing body text.
    expect(search.toJSON().fulltextPartial).toBe(true);

    // And the flag is reachable: the next update over a map that reaches the end of the
    // library asks the full-text sequence from the START, although a cursor is stored and
    // a `?since=<cursor>` delta of that sequence would name nothing at all.
    const healthy = zotero.router();
    startIndexUpdate(makeCtx(search, healthy), undefined, undefined, { fulltext: true });
    await settle(search);

    expect(healthy.fullTextSince.mock.calls[0]![0]).toBe(0);
    expect(healthy.getFullText.mock.calls.map((c: any[]) => c[0]).sort()).toEqual(['ATT1', 'ATT2', 'ATT4']);
    expect((await search.query('wafer annealing temperatures', { limit: 1 }))[0]!.itemKey).toBe('K1');
    expect(search.toJSON().fulltextPartial).toBe(false);
    expect(search.buildStatus().fulltextVersion).toBe(zotero.fulltextVersion);
  });
});

/**
 * The recovery pass is bounded by the thing that makes it worth paying: a full-census
 * re-read can only make coverage whole over a map that reached the end of the library
 * (#78). Over a map that stops short again it cannot finish the job whatever it reads, so
 * it falls back to filling the coverage gap alone: the items holding no body text at all.
 */
describe.each(backends)('a recovery whose attachment map keeps stopping short (%s backend)', (backend) => {
  function threeExtracted(): FakeZotero {
    const z = new FakeZotero();
    z.putItem('K1', 'Deep learning', 'convolutional networks classify images');
    z.putItem('K2', 'Photovoltaic perovskites', 'tandem cell stability');
    z.putItem('K3', 'Glacial isostasy', 'mantle viscosity inversions');
    z.attach('ATT1', 'K1');
    z.attach('ATT2', 'K2');
    z.attach('ATT3', 'K3');
    z.extract('ATT1', BODY_ONE);
    z.extract('ATT2', BODY_TWO);
    z.extract('ATT3', BODY_THREE);
    return z;
  }

  /** The listing serves `pages` attachments, one per page, and then takes too long. */
  function mapStopsAfter(zotero: FakeZotero, pages: number): any {
    const router = zotero.router();
    const listing = router.searchItems;
    let served = 0;
    router.searchItems = vi.fn(async (q: any) => {
      if (q.itemType !== 'attachment') return listing(q);
      if (served++ >= pages) {
        throw new Error('Zotero took longer than the 25s budget to answer a single request');
      }
      return listing({ ...q, limit: 1 });
    });
    return router;
  }

  it('fills the gap it can and stops there, rather than re-reading the census every update', async () => {
    const zotero = threeExtracted();
    const search = await openIndex(backend);
    startIndexBuild(makeCtx(search, mapStopsAfter(zotero, 1)), undefined, undefined, { fulltext: true });
    await settle(search);
    expect(search.buildStatus().fulltextItems).toBe(1);
    expect(search.buildStatus().fulltextVersion).toBe(0);

    // The map is readable one attachment further this time, and stops short again. The
    // whole-census re-read cannot make coverage whole over a map like this, so it is not
    // paid: only K2, which holds no body text at all, is read. K1 is left alone.
    const stillTruncating = mapStopsAfter(zotero, 2);
    startIndexUpdate(makeCtx(search, stillTruncating), undefined, undefined, { fulltext: true });
    await settle(search);
    expect(search.buildStatus().state).toBe('done');
    expect(stillTruncating.getFullText.mock.calls.map((c: any[]) => c[0])).toEqual(['ATT2']);
    expect((await search.query('perovskite illumination degrade', { limit: 1 }))[0]!.itemKey).toBe('K2');
    // Nothing was recovered, so nothing is claimed: no cursor, and the status says why.
    expect(search.buildStatus().fulltextVersion).toBe(0);
    expect(search.buildStatus().fulltextReason).toMatch(/attachment map stopped early after 2\/3/);

    // And it converges: the next update over the same truncated map reads nothing at all,
    // where a whole-census re-read would pay for K1 and K2 again, every time, forever.
    const again = mapStopsAfter(zotero, 2);
    startIndexUpdate(makeCtx(search, again), undefined, undefined, { fulltext: true });
    await settle(search);
    expect(again.getFullText).not.toHaveBeenCalled();
    expect(search.buildStatus().fulltextVersion).toBe(0);

    // The map comes back, and only then is the full recovery pass paid, once.
    const healthy = zotero.router();
    startIndexUpdate(makeCtx(search, healthy), undefined, undefined, { fulltext: true });
    await settle(search);
    expect(healthy.getFullText.mock.calls.map((c: any[]) => c[0]).sort()).toEqual(['ATT1', 'ATT2', 'ATT3']);
    expect(search.buildStatus().fulltextVersion).toBe(zotero.fulltextVersion);
    expect(search.buildStatus().fulltextReason).toBeUndefined();
    expect((await search.query('isostatic rebound mantle', { limit: 1 }))[0]!.itemKey).toBe('K3');
    await search.close();
  });
});
