import { describe, it, expect, vi } from 'vitest';
import review from '../../src/tools/review.js';
import screenItems from '../../src/tools/screen-items.js';
import activity from '../../src/tools/activity.js';

/**
 * The review-team kit: zotero_review (read-only views), zotero_screen_items (tag writes) and
 * zotero_activity (what changed, by whom), against a faked group library.
 */

const GROUP = 6666644;

const paper = (key: string, title: string, tags: string[], extra: Record<string, unknown> = {}) => ({
  key,
  version: 5,
  data: {
    key,
    version: 5,
    itemType: 'journalArticle',
    title,
    date: '2021-03-01',
    abstractNote: `Abstract of ${title}`,
    creators: [{ creatorType: 'author', lastName: 'Smith', firstName: 'Ann' }],
    tags: tags.map((tag) => ({ tag })),
    collections: ['REVIEW01'],
    ...extra,
  },
});

function library() {
  return {
    P1: paper('P1', 'Alpha trial', ['screen/title-abstract/include@alice', 'own-tag']),
    P2: paper('P2', 'Beta cohort', ['screen/title-abstract/include@alice', 'screen/title-abstract/exclude:wrong-population@bob']),
    P3: paper('P3', 'Gamma review', []),
    P4: paper('P4', 'Delta study', ['screen/title-abstract/include', 'screen/full-text/include']),
    N1: { key: 'N1', data: { key: 'N1', itemType: 'note', note: '<p>standalone</p>', collections: ['REVIEW01'] } },
  } as Record<string, any>;
}

function readCtx(lib = library(), extra: Record<string, any> = {}) {
  return {
    config: {},
    capabilities: { cloud: null, localApi: true, localGroupIds: [GROUP] },
    router: {
      defaultLibrary: () => ({ type: 'user', id: 0 }),
      getCollection: vi.fn(async (key: string) => (key === 'REVIEW01' ? { key, data: { key, name: 'Screening' } } : null)),
      searchItems: vi.fn(async (q: any) => {
        const all = Object.values(lib);
        const start = q.start ?? 0;
        return { data: all.slice(start, start + (q.limit ?? 25)), totalResults: all.length };
      }),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...extra,
  } as any;
}

const call = (tool: any, args: any, ctx: any) => tool.handler(args, ctx);

describe('zotero_review', () => {
  it('is read-only', () => {
    expect(review.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it('queues a blind per-reviewer batch, never showing other decisions', async () => {
    const ctx = readCtx();
    const r = await call(review, { action: 'queue', collection_key: 'REVIEW01', reviewer: 'Bob', library_type: 'group', library_id: GROUP }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.reviewer).toBe('bob');
    expect(r.structuredContent.queue.map((q: any) => q.key)).toEqual(['P1', 'P3']);
    expect(r.structuredContent.queue[0]).toEqual({
      key: 'P1',
      title: 'Alpha trial',
      authors: ['Smith, Ann'],
      itemType: 'journalArticle',
      year: '2021',
      abstract: 'Abstract of Alpha trial',
    });
    expect(r.structuredContent.records).toBe(4);
    expect(ctx.router.searchItems).toHaveBeenCalledWith(expect.objectContaining({ collectionKey: 'REVIEW01', top: true, library: { type: 'group', id: GROUP } }));
  });

  it('team queue holds undecided records and flags conflicts; it pages', async () => {
    const r = await call(review, { action: 'queue', collection_key: 'REVIEW01', limit: 1 }, readCtx());
    expect(r.structuredContent.queued).toBe(2);
    expect(r.structuredContent.queue).toEqual([expect.objectContaining({ key: 'P2', conflict: true })]);
    expect(r.structuredContent.nextStart).toBe(1);
  });

  it('full-text queue holds only records included at title-abstract', async () => {
    const r = await call(review, { action: 'queue', collection_key: 'REVIEW01', stage: 'full-text' }, readCtx());
    expect(r.structuredContent.queue.map((q: any) => q.key)).toEqual(['P1']);
  });

  it('status reports tallies and disagreements', async () => {
    const r = await call(review, { action: 'status', collection_key: 'REVIEW01' }, readCtx());
    expect(r.structuredContent.stages['title-abstract']).toMatchObject({ include: 2, conflict: 1, pending: 1 });
    expect(r.structuredContent.disagreementsTotal).toBe(1);
    expect(r.structuredContent.provenance).toBeDefined();
  });

  it('prisma returns numbers, text and mermaid', async () => {
    const r = await call(review, { action: 'prisma', collection_key: 'REVIEW01', records_identified: 10, duplicates_removed: 6 }, readCtx());
    expect(r.structuredContent.prisma).toMatchObject({ recordsIdentified: 10, duplicatesRemoved: 6, studiesIncluded: 1 });
    expect(r.structuredContent.text).toContain('Studies included in review: n = 1');
    expect(r.structuredContent.mermaid).toMatch(/^flowchart TD/);
  });

  it('duplicates reports groups and merges nothing', async () => {
    const lib = library();
    lib.P5 = paper('P5', 'Alpha trial.', [], { date: '2022' });
    const r = await call(review, { action: 'duplicates', collection_key: 'REVIEW01' }, readCtx(lib));
    expect(r.structuredContent.duplicateGroups).toHaveLength(1);
    expect(r.structuredContent.duplicateGroups[0].items.map((i: any) => i.key).sort()).toEqual(['P1', 'P5']);
    expect(r.content[0].text).toMatch(/nothing was merged/);
  });

  it('refuses an unknown collection', async () => {
    const r = await call(review, { action: 'status', collection_key: 'NOPE' }, readCtx());
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/zotero_list_collections/);
  });
});

function writeCtx(lib = library()) {
  const web = {
    getItem: vi.fn(async (_l: any, key: string) => {
      if (!lib[key]) throw Object.assign(new Error('404'), { status: 404 });
      return lib[key];
    }),
    patchItem: vi.fn(async (_l: any, key: string, patch: any, _version?: number) => {
      lib[key].data.tags = patch.tags;
      return 6;
    }),
  };
  return {
    lib,
    web,
    ctx: {
      config: {},
      capabilities: { cloud: { userID: 1, username: 'u', access: { user: { library: true, write: true }, groups: { all: { library: true, write: true } } } }, localApi: false, localGroupIds: [] },
      router: { defaultLibrary: () => ({ type: 'user', id: 1 }) },
      web,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    } as any,
  };
}

describe('zotero_screen_items', () => {
  it('is an additive write, not destructive', () => {
    expect(screenItems.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
  });

  it('replaces only the reviewer\'s own tag for the stage and keeps user tags', async () => {
    const { ctx, lib, web } = writeCtx();
    const r = await call(
      screenItems,
      {
        stage: 'title-abstract',
        reviewer: 'Alice',
        decisions: [
          { item_key: 'P1', decision: 'exclude', reason: 'Wrong design' },
          { item_key: 'P2', decision: 'include' },
          { item_key: 'P3', decision: 'maybe' },
        ],
        library_type: 'group',
        library_id: GROUP,
      },
      ctx,
    );
    expect(r.isError).toBeFalsy();
    expect(lib.P1.data.tags.map((t: any) => t.tag)).toEqual(['own-tag', 'screen/title-abstract/exclude:wrong-design@alice']);
    // P2 already said include@alice: nothing written, bob's tag untouched.
    expect(r.structuredContent.recorded.find((x: any) => x.key === 'P2')).toMatchObject({ unchanged: true });
    expect(web.patchItem).toHaveBeenCalledTimes(2);
    expect(web.patchItem.mock.calls[0]![0]).toEqual({ type: 'group', id: GROUP });
    expect(web.patchItem.mock.calls[0]![3]).toBe(5);
    expect(lib.P3.data.tags).toEqual([{ tag: 'screen/title-abstract/maybe@alice' }]);
    expect(r.structuredContent.target).toBe('cloud');
  });

  it('records a final decision without touching reviewer tags', async () => {
    const { ctx, lib } = writeCtx();
    await call(screenItems, { stage: 'title-abstract', decisions: [{ item_key: 'P2', decision: 'include' }] }, ctx);
    expect(lib.P2.data.tags.map((t: any) => t.tag)).toEqual([
      'screen/title-abstract/include@alice',
      'screen/title-abstract/exclude:wrong-population@bob',
      'screen/title-abstract/include',
    ]);
  });

  it('refuses a reason on include and duplicate keys before writing anything', async () => {
    const { ctx, web } = writeCtx();
    const r = await call(
      screenItems,
      { stage: 'title-abstract', decisions: [{ item_key: 'P1', decision: 'include', reason: 'x' }, { item_key: 'P1', decision: 'exclude' }] },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(web.patchItem).not.toHaveBeenCalled();
  });

  it('reports notes and missing items as failures', async () => {
    const { ctx } = writeCtx();
    const r = await call(screenItems, { stage: 'full-text', decisions: [{ item_key: 'N1', decision: 'include' }, { item_key: 'ZZZ', decision: 'include' }] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.structuredContent.failed).toHaveLength(2);
  });
});

describe('zotero_activity', () => {
  const NOW = Date.parse('2026-11-10T12:00:00Z');
  const rows = [
    { key: 'A1', meta: { createdByUser: { id: 1, username: 'alice', name: 'Alice A' }, lastModifiedByUser: { id: 1, username: 'alice', name: 'Alice A' } }, data: { key: 'A1', itemType: 'annotation', parentItem: 'PDF1', annotationType: 'highlight', annotationText: 'Key finding', annotationComment: 'yes', dateAdded: '2026-11-09T10:00:00Z', dateModified: '2026-11-09T10:00:00Z' } },
    { key: 'NT', meta: { createdByUser: { id: 2, username: 'bob' }, lastModifiedByUser: { id: 2, username: 'bob' } }, data: { key: 'NT', itemType: 'note', parentItem: 'P1', note: '<h1>Notes</h1><p>Good &amp; useful</p>', dateAdded: '2026-11-08T10:00:00Z', dateModified: '2026-11-08T10:00:00Z' } },
    { key: 'P1', meta: { createdByUser: { id: 2, username: 'bob' }, lastModifiedByUser: { id: 1, username: 'alice', name: 'Alice A' } }, data: { key: 'P1', itemType: 'journalArticle', title: 'Alpha trial', collections: ['REVIEW01'], dateAdded: '2026-01-01T00:00:00Z', dateModified: '2026-11-07T00:00:00Z' } },
    { key: 'P9', meta: {}, data: { key: 'P9', itemType: 'book', title: 'Elsewhere', collections: [], dateAdded: '2026-11-06T00:00:00Z', dateModified: '2026-11-06T00:00:00Z' } },
    { key: 'OLD', meta: {}, data: { key: 'OLD', itemType: 'book', title: 'Old', dateAdded: '2025-01-01T00:00:00Z', dateModified: '2025-01-01T00:00:00Z' } },
  ];
  const PDF1 = { key: 'PDF1', data: { key: 'PDF1', itemType: 'attachment', parentItem: 'P1', dateModified: '2026-01-01T00:00:00Z' } };

  function actCtx(cloud: boolean, failCloud = false) {
    return {
      config: {},
      capabilities: { cloud: cloud ? { userID: 1 } : null, localApi: true, localGroupIds: [GROUP] },
      router: {
        defaultLibrary: () => ({ type: 'user', id: 0 }),
        searchItems: vi.fn(async (q: any) => {
          if (failCloud && q.backend === 'cloud') throw new Error('403');
          const strip = q.backend === 'cloud' ? rows : rows.map((r) => ({ ...r, meta: {} }));
          return { data: strip.slice(q.start ?? 0, (q.start ?? 0) + q.limit), totalResults: strip.length };
        }),
        getItem: vi.fn(async (key: string) => (key === 'PDF1' ? PDF1 : null)),
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    } as any;
  }

  it('is read-only', () => {
    expect(activity.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it('attributes group changes from the cloud and stops at the window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const ctx = actCtx(true);
      const r = await call(activity, { days: 7, library_type: 'group', library_id: GROUP }, ctx);
      const s = r.structuredContent;
      expect(ctx.router.searchItems).toHaveBeenCalledWith(expect.objectContaining({ sort: 'dateModified', direction: 'desc', backend: 'cloud' }));
      expect(s.attribution).toBe('cloud');
      expect(s.items.map((i: any) => i.key)).toEqual(['P1', 'P9']);
      expect(s.items[0]).toMatchObject({ change: 'modified', createdBy: 'bob', modifiedBy: 'Alice A' });
      expect(s.annotations[0]).toMatchObject({ key: 'A1', text: 'Key finding', item: 'P1', itemTitle: 'Alpha trial', createdBy: 'Alice A' });
      expect(s.notes[0].text).toBe('Notes Good & useful');
      expect(s.byUser).toEqual({ 'Alice A': { added: 1, modified: 1 }, bob: { added: 1, modified: 0 } });
      expect(s.scanned).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('scopes to a collection through each child\'s top-level item', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const r = await call(activity, { collection_key: 'REVIEW01' }, actCtx(false));
      const s = r.structuredContent;
      expect(s.items.map((i: any) => i.key)).toEqual(['P1']);
      expect(s.annotations.map((i: any) => i.key)).toEqual(['A1']);
      expect(s.notes.map((i: any) => i.key)).toEqual(['NT']);
      expect(s.attribution).toBe('personal-library');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says names are unavailable for a group without a cloud key, or when the cloud refuses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const a = await call(activity, { library_type: 'group', library_id: GROUP }, actCtx(false));
      expect(a.structuredContent.attribution).toBe('unavailable');
      expect(a.structuredContent.items[0].createdBy).toBeUndefined();
      const b = await call(activity, { library_type: 'group', library_id: GROUP }, actCtx(true, true));
      expect(b.structuredContent.attribution).toBe('unavailable');
      expect(b.structuredContent.items).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
