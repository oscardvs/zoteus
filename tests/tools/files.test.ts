import { describe, it, expect, vi } from 'vitest';
import groups from '../../src/tools/groups.js';
import exportTool from '../../src/tools/export.js';
import fulltext from '../../src/tools/fulltext.js';
import sync from '../../src/tools/sync.js';

function makeCtx(overrides: any = {}): any {
  const ctx: any = {
    config: { dataDir: '/tmp/zoteus' },
    capabilities: { cloud: { userID: 19552201 }, localApi: false },
    router: {
      whoami: () => ({ userID: 19552201 }),
      defaultLibrary: () => ({ type: 'user', id: 19552201 }),
    },
    web: {
      listGroups: vi.fn(async () => ({ data: [{ id: 7, data: { name: 'Lab', type: 'PublicOpen' }, meta: { numItems: 3 } }], totalResults: 1, lastModifiedVersion: 1 })),
      exportItems: vi.fn(async () => '@article{k, title={X}}'),
      getFullText: vi.fn(async () => ({ content: 'hello text', indexedChars: 10, totalChars: 10 })),
      fullTextSince: vi.fn(async () => ({ AAA: 5 })),
      versions: vi.fn(async (_lib: any, type: string) => (type === 'items' ? { I1: 2, I2: 3 } : {})),
      deleted: vi.fn(async () => ({ items: ['DEL1'] })),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...overrides,
  };
  // Full-text reads are routed now (desktop app first, cloud otherwise). With no local API
  // in these doubles, that is the cloud path; resolve `web` at call time because tests
  // replace individual methods after construction.
  ctx.router.getFullText ??= (key: string, opts: any = {}) =>
    ctx.web.getFullText(opts.library ?? ctx.router.defaultLibrary(), key);
  ctx.router.fullTextSince ??= (version: number, opts: any = {}) =>
    ctx.web.fullTextSince(opts.library ?? ctx.router.defaultLibrary(), version);
  // Exports are routed the same way (#75).
  ctx.router.exportItems ??= ({ library, ...rest }: any) =>
    ctx.web.exportItems(library ?? ctx.router.defaultLibrary(), rest);
  // So is the sync delta, which additionally comes wholly from the ONE API that serves
  // the library, since the two number their library versions independently.
  ctx.router.servesLocally ??= () => Boolean(ctx.capabilities?.localApi && ctx.local);
  ctx.router.versions ??= (type: string, since: number, opts: any = {}) =>
    ctx.web.versions(opts.library ?? ctx.router.defaultLibrary(), type, since);
  ctx.router.deleted ??= (since: number, opts: any = {}) =>
    ctx.web.deleted(opts.library ?? ctx.router.defaultLibrary(), since);
  return ctx;
}

/** A context whose desktop app is up and holds `held`, with or without a cloud key. */
function makeGroupsCtx(opts: { key?: boolean; held?: any[]; localApi?: boolean } = {}) {
  const ctx = makeCtx({
    config: { dataDir: '/tmp/zoteus', local: 'auto' },
    capabilities: {
      cloud: opts.key === false ? null : { userID: 19552201 },
      localApi: opts.localApi ?? true,
      localGroupIds: [],
    },
    local: {
      // `ensureLocalApi` re-probes whenever capabilities say the app is down, which is
      // how a Zotero started after the server is picked up at all.
      ping: vi.fn(async () => opts.localApi ?? true),
      listLocalGroups: vi.fn(async () => opts.held ?? []),
    },
  });
  if (opts.key === false) ctx.router.whoami = () => null;
  return ctx;
}

describe('zotero_groups', () => {
  it('lists groups', async () => {
    const res = await groups.handler({}, makeCtx());
    expect((res.structuredContent?.groups as any[])[0].name).toBe('Lab');
  });

  it('errors with no cloud key and no locally held group', async () => {
    const ctx = makeCtx();
    ctx.router.whoami = () => null;
    const res = await groups.handler({}, ctx);
    expect(res.isError).toBe(true);
  });

  // #77: a local-API-only user was told to get a cloud key to list groups their own
  // desktop was already holding, and whose items the router already reads locally.
  it('lists the desktop app\'s groups with no cloud key at all', async () => {
    const ctx = makeGroupsCtx({
      key: false,
      held: [{ id: 88, name: 'Lab', description: 'Reading group', numItems: 512 }],
    });
    const res = await groups.handler({}, ctx);
    expect(res.isError).toBeUndefined();
    const listed = res.structuredContent?.groups as any[];
    expect(listed).toEqual([
      { id: 88, name: 'Lab', description: 'Reading group', numItems: 512, source: 'local' },
    ]);
    // Nothing the desktop cannot answer is invented for it.
    expect('type' in listed[0]).toBe(false);
    expect('libraryEditing' in listed[0]).toBe(false);
    expect(res.structuredContent?.note).toMatch(/type.*libraryEditing|libraryEditing/);
  });

  it('makes a locally held group readable in the same session', async () => {
    // The id is useless if the router still refuses to serve that group locally, and the
    // startup snapshot may predate the group (or the Zotero holding it).
    const ctx = makeGroupsCtx({ key: false, held: [{ id: 88, name: 'Lab' }] });
    await groups.handler({}, ctx);
    expect(ctx.capabilities.localGroupIds).toEqual([88]);
  });

  it('says which source was missing when there is nothing to list', async () => {
    const up = await groups.handler({}, makeGroupsCtx({ key: false, held: [] }));
    expect(up.isError).toBe(true);
    expect(up.content[0].text).toMatch(/holds no group libraries/);
    const down = await groups.handler({}, makeGroupsCtx({ key: false, held: [], localApi: false }));
    expect(down.isError).toBe(true);
    expect(down.content[0].text).toMatch(/no Zotero desktop app is answering locally/);
    // Neither refusal claims a cloud key is what listing groups requires.
    for (const res of [up, down]) expect(res.content[0].text).not.toMatch(/requires a cloud API key/i);
  });

  it('does not tell a user whose key was refused to set the key they already set', async () => {
    // whoami is null both for a key that was never set and for one the cloud rejected.
    const ctx = makeGroupsCtx({ key: false, held: [] });
    ctx.web.hasKey = true;
    const res = await groups.handler({}, ctx);
    expect(res.content[0].text).toMatch(/did not identify a Zotero user/);
    expect(res.content[0].text).not.toMatch(/there is no cloud API key/);
  });

  it('answers exactly as before when a key is present and the desktop holds nothing', async () => {
    const ctx = makeGroupsCtx({ held: [] });
    const res = await groups.handler({}, ctx);
    expect(res.content[0].text).toBe('1 accessible group(s).');
    // The cloud's rows untouched; the one addition is what their counts count.
    expect(res.structuredContent).toEqual({
      groups: [{ id: 7, name: 'Lab', type: 'PublicOpen', numItems: 3 }],
      numItemsNote: expect.any(String),
    });
    expect('source' in (res.structuredContent?.groups as any[])[0]).toBe(false);
    expect(res.structuredContent?.note).toBeUndefined();
  });

  // The 2026-10-01 stress test: the test group reported `numItems: 9` beside a search that
  // found one item, and the caller was left guessing whether children or the trash made
  // up the difference. Both APIs count every item row, the trash included; a cloud row
  // used to say nothing about it and a desktop row said it only in `note`.
  it('says what numItems counts beside every answer that carries one, cloud or desktop', async () => {
    const cloud = await groups.handler({}, makeGroupsCtx({ held: [] }));
    const local = await groups.handler(
      {},
      makeGroupsCtx({ key: false, held: [{ id: 6666644, name: 'Zoteus Test', numItems: 10 }] }),
    );
    const both = await groups.handler({}, makeGroupsCtx({ held: [{ id: 88, name: 'Local only', numItems: 512 }] }));
    for (const res of [cloud, local, both]) {
      const note = res.structuredContent?.numItemsNote as string;
      expect(note).toMatch(/trash/);
      expect(note).toMatch(/child\s+attachments, notes and annotations/);
      // And how to get the number a caller actually wanted to compare.
      expect(note).toMatch(/zotero_search_items.*top:true.*limit:1/s);
      expect(note).toMatch(/totalResults/);
    }
    // The desktop note no longer claims the two APIs count differently: they run the same
    // count, each over its own copy.
    expect(local.structuredContent?.note).not.toMatch(/not the same figure/);
    expect(local.structuredContent?.note).toMatch(/numItemsNote/);
  });

  it('adds no numItemsNote when no row carries a count', async () => {
    const res = await groups.handler({}, makeGroupsCtx({ key: false, held: [{ id: 88, name: 'Lab' }] }));
    expect(res.structuredContent?.numItemsNote).toBeUndefined();
  });

  it('documents what numItems counts in the tool description and the output schema', () => {
    expect(groups.description).toMatch(/numItems` counts ALL the items/);
    expect(groups.description).toMatch(/trash included/);
    const shape = (groups.outputSchema as any).shape;
    const row = shape.groups._def.type._def.shape();
    expect(row.numItems.description).toMatch(/trash/);
    expect(row.numItems.description).toMatch(/Not comparable with a zotero_search_items totalResults/);
    expect(shape.numItemsNote.description).toMatch(/top-level items/);
  });

  it('merges both sources into one row per group', async () => {
    const ctx = makeGroupsCtx({
      held: [
        { id: 7, name: 'Lab (desktop copy)', numItems: 9 },
        { id: 88, name: 'Local only', numItems: 512 },
      ],
    });
    const res = await groups.handler({}, ctx);
    const listed = res.structuredContent?.groups as any[];
    expect(listed).toHaveLength(2);
    // The cloud's fields win where a group is in both: they are a superset of the
    // desktop's, so the richer row is the one a caller should act on.
    expect(listed[0]).toEqual({
      id: 7,
      name: 'Lab',
      type: 'PublicOpen',
      numItems: 3,
      description: undefined,
      libraryEditing: undefined,
      source: 'both',
    });
    expect(listed[1]).toEqual({
      id: 88,
      name: 'Local only',
      numItems: 512,
      description: undefined,
      source: 'local',
    });
    expect(res.content[0].text).toMatch(/2 group\(s\).*1 held only by the Zotero desktop app/);
  });

  it('marks a cloud group the desktop does not hold as cloud-only', async () => {
    const ctx = makeGroupsCtx({ held: [{ id: 88, name: 'Local only' }] });
    const res = await groups.handler({}, ctx);
    expect((res.structuredContent?.groups as any[])[0].source).toBe('cloud');
  });
});

describe('zotero_export', () => {
  it('returns the exported text', async () => {
    const ctx = makeCtx();
    const res = await exportTool.handler({ format: 'bibtex', limit: 5 }, ctx);
    // Routed read: the default library reaches the cloud double only because these
    // doubles have no local API.
    expect(ctx.web.exportItems).toHaveBeenCalledWith(
      { type: 'user', id: 19552201 },
      expect.objectContaining({ format: 'bibtex', limit: 5 }),
    );
    expect(res.content[0].text).toContain('@article');
  });
});

describe('zotero_fulltext', () => {
  it('get returns content', async () => {
    const res = await fulltext.handler({ action: 'get', item_key: 'A' }, makeCtx());
    expect(res.structuredContent?.found).toBe(true);
    expect(res.structuredContent?.content).toBe('hello text');
  });
  it('get returns found:false when none', async () => {
    const ctx = makeCtx();
    ctx.web.getFullText = vi.fn(async () => null);
    const res = await fulltext.handler({ action: 'get', item_key: 'A' }, ctx);
    expect(res.structuredContent?.found).toBe(false);
  });
  it('since returns the changed map', async () => {
    const res = await fulltext.handler({ action: 'since', since: 1 }, makeCtx());
    expect(res.structuredContent?.count).toBe(1);
  });
});

describe('zotero_sync', () => {
  it('returns changed maps and the deletion log', async () => {
    const res = await sync.handler({ since: 100 }, makeCtx());
    const changed = res.structuredContent?.changed as any;
    expect(changed.items.count).toBe(2);
    expect((res.structuredContent?.deleted as any).items).toEqual(['DEL1']);
    // Which API answered is part of the result: a `since` from one means nothing to the other.
    expect(res.structuredContent?.backend).toBe('cloud');
  });
});
