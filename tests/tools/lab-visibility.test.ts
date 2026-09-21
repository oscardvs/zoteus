import { describe, it, expect, vi } from 'vitest';
import whoami from '../../src/tools/whoami.js';
import groups from '../../src/tools/groups.js';

/**
 * What a lab has to be able to see without a failed write or a support mail.
 *
 * Three questions, all answerable from primitives the server already holds, none of them
 * touching a subscription, a seat or a licence (Zoteus keeps no account of its own):
 *
 *  1. Whose context am I on? On a shared deployment a caller either has their own Zotero
 *     key and their own search index, or is answered by the one the operator configured.
 *  2. Which library does a call with no library argument land in, and WHO decided that?
 *     ZOTERO_LIBRARY_ID is process-wide, so on a shared server it pins every account to
 *     the same library, which was previously visible nowhere.
 *  3. Can this key actually write to the shared group library, and if not, why? The key's
 *     own access map already answers it locally, which is how a write decides it a moment
 *     before sending the request.
 *
 * Plus "is this library searchable by meaning yet", which is the index's own library stamp
 * read through `buildStatus()` and nothing else.
 */

/** Minimal SearchIndex stand-in: healthy embedder, and an index that holds `library`. */
function searchStub(over: Record<string, unknown> = {}) {
  const { status, ...rest } = over as { status?: Record<string, unknown> };
  return {
    embedderConfigured: 'local',
    embedderActive: true,
    embedderName: 'local',
    embedderReason: undefined,
    buildStatus: () => ({ state: 'done', items: 12, documents: 40, ...(status ?? {}) }),
    ...rest,
  };
}

function whoamiCtx(over: Record<string, unknown> = {}) {
  const cloud = (over.cloud ?? null) as any;
  return {
    router: {
      whoami: () => cloud,
      defaultLibrary: () =>
        (over.defaultLibrary as any) ?? { type: 'user', id: cloud?.userID ?? 0 },
    },
    capabilities: { cloud, localApi: false },
    search: (over.search as any) ?? searchStub(),
    config: (over.config as any) ?? {},
    zoteroUserId: over.zoteroUserId as number | undefined,
    remoteCaller: Boolean(over.remoteCaller),
  } as any;
}

const KEY_USER = { userID: 111, username: 'alice', access: { user: { write: true }, groups: { all: { library: true, write: true } } } };

describe('zotero_whoami says which context answered and why this library is the default', () => {
  it('reports a configured default library as configured, and warns that it is shared when the caller is remote', async () => {
    const res = await whoami.handler(
      {},
      whoamiCtx({
        cloud: KEY_USER,
        config: { libraryId: 4523, libraryType: 'group' },
        defaultLibrary: { type: 'group', id: 4523 },
        remoteCaller: true,
        zoteroUserId: 111,
      }),
    );
    const lib = res.structuredContent?.defaultLibrary as any;
    expect(lib.source).toBe('configured');
    expect(lib).toMatchObject({ type: 'group', id: 4523 });
    expect(lib.sourceDetail).toMatch(/ZOTERO_LIBRARY_ID/);
    expect(lib.sourceDetail).toMatch(/every account connecting to this server/);
    expect(res.content[0].text).toMatch(/Default library: groups\/4523 \(pinned for this server with ZOTERO_LIBRARY_ID\)/);
  });

  it('does not call a pinned library shared on a single-user install', async () => {
    const res = await whoami.handler(
      {},
      whoamiCtx({
        cloud: KEY_USER,
        config: { libraryId: 4523, libraryType: 'group' },
        defaultLibrary: { type: 'group', id: 4523 },
      }),
    );
    const lib = res.structuredContent?.defaultLibrary as any;
    expect(lib.source).toBe('configured');
    expect(lib.sourceDetail).not.toMatch(/every account/);
    expect(lib.sourceDetail).toMatch(/this server's own configuration/);
  });

  it('reports a key-derived default as derived from the key', async () => {
    const res = await whoami.handler({}, whoamiCtx({ cloud: KEY_USER }));
    const lib = res.structuredContent?.defaultLibrary as any;
    expect(lib).toMatchObject({ type: 'user', id: 111, source: 'key' });
    expect(lib.sourceDetail).toMatch(/No ZOTERO_LIBRARY_ID is set/);
  });

  it('still answers with no cloud key at all: users/0 from the desktop app', async () => {
    const res = await whoami.handler({}, whoamiCtx({}));
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent?.cloud).toBe(false);
    const lib = res.structuredContent?.defaultLibrary as any;
    expect(lib).toMatchObject({ type: 'user', id: 0, source: 'local' });
    expect(lib.sourceDetail).toMatch(/users\/0/);
    expect((res.structuredContent?.context as any).perUser).toBe(false);
  });

  it('distinguishes a per-user context from the operator context', async () => {
    const own = await whoami.handler({}, whoamiCtx({ cloud: KEY_USER, zoteroUserId: 111, remoteCaller: true }));
    expect(own.structuredContent?.context).toMatchObject({ perUser: true, confined: true, zoteroUserId: 111 });
    // A per-user context is built with no desktop client at all, so its local API is out of
    // reach by construction rather than merely down.
    expect(own.structuredContent?.localApiReason).toMatch(/never reaches a Zotero desktop app/);

    const operator = await whoami.handler({}, whoamiCtx({ cloud: KEY_USER }));
    expect(operator.structuredContent?.context).toMatchObject({ perUser: false, confined: false });
    expect((operator.structuredContent?.context as any).zoteroUserId).toBeUndefined();
    expect(operator.structuredContent?.localApiReason).toBeUndefined();
  });

  it('names the library its search index holds, and says so when that is not the default', async () => {
    const match = await whoami.handler(
      {},
      whoamiCtx({ cloud: KEY_USER, search: searchStub({ status: { library: 'user', items: 12 } }) }),
    );
    expect(match.structuredContent?.searchIndex).toMatchObject({
      library: 'user',
      libraryLabel: 'the personal library',
      holdsDefaultLibrary: true,
      items: 12,
    });
    expect(match.content[0].text).toMatch(/Search index holds the personal library \(12 items\), which is the default library/);

    const mismatch = await whoami.handler(
      {},
      whoamiCtx({ cloud: KEY_USER, search: searchStub({ status: { library: 'group:4523' } }) }),
    );
    expect(mismatch.structuredContent?.searchIndex).toMatchObject({
      library: 'group:4523',
      libraryLabel: 'group 4523',
      holdsDefaultLibrary: false,
    });
    expect(mismatch.content[0].text).toMatch(/Search index holds group 4523, which is NOT this server's default library/);
    // The old wording promised searches would keep coming from this index. They no longer do:
    // a call naming no library reaches the default library's own file once that exists.
    expect(mismatch.content[0].text).not.toMatch(/keeps answering from/);
    expect(mismatch.content[0].text).not.toContain('at undefined');
  });

  it('says nothing has been indexed yet rather than inventing a library', async () => {
    const res = await whoami.handler(
      {},
      whoamiCtx({ cloud: KEY_USER, search: searchStub({ status: { items: 0, documents: 0 } }) }),
    );
    const idx = res.structuredContent?.searchIndex as any;
    expect(idx.library).toBeUndefined();
    expect(idx.holdsDefaultLibrary).toBeUndefined();
    expect(res.content[0].text).toMatch(/nothing indexed here yet/);
  });

  it('reports an index that predates the library stamp as unknown, not as the default', async () => {
    const res = await whoami.handler(
      {},
      whoamiCtx({ cloud: KEY_USER, search: searchStub({ status: { items: 900, documents: 4000 } }) }),
    );
    const idx = res.structuredContent?.searchIndex as any;
    expect(idx.library).toBeUndefined();
    expect(idx.holdsDefaultLibrary).toBeUndefined();
    expect(res.content[0].text).toMatch(/did not record which library they came from/);
  });
});

const GROUP_ROW = (id: number, name: string, over: Record<string, unknown> = {}) => ({
  id,
  data: { id, name, type: 'Private', libraryEditing: 'members', ...(over.data as object ?? {}) },
  meta: { numItems: 7 },
});

function groupsCtx(over: Record<string, unknown> = {}) {
  // `me: null` is the keyless case, so it has to survive the default, which `??` would eat.
  const me = ('me' in over ? over.me : { userID: 111, username: 'alice', access: over.access ?? {} }) as any;
  return {
    router: { whoami: () => me, defaultLibrary: () => ({ type: 'user', id: 111 }) },
    capabilities: { cloud: me, localApi: Boolean(over.localApi), localGroupIds: [] },
    web: {
      hasKey: true,
      listGroups: vi.fn(async () => ({
        data: (over.cloudGroups as any[]) ?? [GROUP_ROW(456, 'Lab library')],
        totalResults: 1,
        lastModifiedVersion: 1,
      })),
    },
    local: over.held
      ? { ping: vi.fn(async () => true), listLocalGroups: vi.fn(async () => over.held) }
      : undefined,
    config: { local: over.held ? 'auto' : 'off', readOnly: Boolean(over.readOnly), dataDir: '/tmp/zoteus-test' },
    search: over.search as any,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  } as any;
}

describe('zotero_groups says whether this key can write to each group, and why not', () => {
  it('reports a group the key cannot write, with the reason and the remedy', async () => {
    const ctx = groupsCtx({ access: { user: { write: true }, groups: { all: { library: true } } } });
    const res = await groups.handler({}, ctx);
    const row = (res.structuredContent?.groups as any[])[0];
    expect(row.canWrite).toBe(false);
    expect(row.writeBlockedReason).toMatch(/read-only access to group 456/);
    expect(row.writeBlockedReason).toMatch(/zotero\.org\/settings\/keys/);
    expect(res.content[0].text).toMatch(/can write to 0 of 1 of them/);
  });

  it('reports a key with no group access at all against the group it cannot reach', async () => {
    const ctx = groupsCtx({ access: { user: { library: true, write: true } } });
    const row = ((await groups.handler({}, ctx)).structuredContent?.groups as any[])[0];
    expect(row.canWrite).toBe(false);
    expect(row.writeBlockedReason).toMatch(/no access to any group library/);
  });

  it('reports a writable group as writable, and says so once for the whole list', async () => {
    const ctx = groupsCtx({ access: { user: { write: true }, groups: { all: { library: true, write: true } } } });
    const res = await groups.handler({}, ctx);
    const row = (res.structuredContent?.groups as any[])[0];
    expect(row.canWrite).toBe(true);
    expect(row.writeBlockedReason).toBeUndefined();
    expect(res.content[0].text).toMatch(/can write to all 1 of them/);
  });

  it('lets a per-group entry override the all-groups default, row by row', async () => {
    const ctx = groupsCtx({
      access: { user: { write: true }, groups: { all: { library: true, write: true }, '456': { library: true } } },
      cloudGroups: [GROUP_ROW(456, 'Lab library'), GROUP_ROW(789, 'Reading group')],
    });
    const res = await groups.handler({}, ctx);
    const [locked, open] = res.structuredContent?.groups as any[];
    expect(locked).toMatchObject({ id: 456, canWrite: false });
    expect(locked.writeBlockedReason).toMatch(/read-only access to group 456/);
    expect(open).toMatchObject({ id: 789, canWrite: true });
    expect(res.content[0].text).toMatch(/can write to 1 of 2 of them/);
  });

  it('says nothing about writing when the key reported no access map, rather than claiming it can', async () => {
    const res = await groups.handler({}, groupsCtx({ access: {} }));
    const row = (res.structuredContent?.groups as any[])[0];
    expect('canWrite' in row).toBe(false);
    expect('writeBlockedReason' in row).toBe(false);
    // And the summary keeps quiet too, rather than reporting "0 of 1 writable".
    expect(res.content[0].text).toBe('1 accessible group(s).');
  });

  it('warns that a read-only deployment writes nothing, whatever the key allows', async () => {
    const ctx = groupsCtx({
      access: { user: { write: true }, groups: { all: { library: true, write: true } } },
      readOnly: true,
    });
    const res = await groups.handler({}, ctx);
    expect(res.content[0].text).toMatch(/read-only mode \(ZOTEUS_READ_ONLY\)/);
  });

  it('marks the one group this context has a search index for, and only that one', async () => {
    const ctx = groupsCtx({
      access: { user: { write: true }, groups: { all: { library: true, write: true } } },
      cloudGroups: [GROUP_ROW(456, 'Lab library'), GROUP_ROW(789, 'Reading group')],
      search: searchStub({ status: { library: 'group:456' } }),
    });
    const rows = (await groups.handler({}, ctx)).structuredContent?.groups as any[];
    expect(rows.map((r) => [r.id, r.indexed])).toEqual([
      [456, true],
      [789, false],
    ]);
  });

  it('omits `indexed` entirely when the index records no library', async () => {
    const ctx = groupsCtx({
      access: { user: { write: true }, groups: { all: { library: true, write: true } } },
      search: searchStub({ status: { items: 0 } }),
    });
    const row = ((await groups.handler({}, ctx)).structuredContent?.groups as any[])[0];
    expect('indexed' in row).toBe(false);
  });

  it('keeps the keyless desktop fallback working, and puts no write verdict on a desktop row', async () => {
    const ctx = groupsCtx({
      me: null,
      held: [{ id: 88, name: 'Lab library', description: 'Reading group', numItems: 512 }],
      localApi: true,
      search: searchStub({ status: { library: 'group:88' } }),
    });
    const res = await groups.handler({}, ctx);
    expect(res.isError).toBeUndefined();
    const row = (res.structuredContent?.groups as any[])[0];
    expect(row).toEqual({
      id: 88,
      name: 'Lab library',
      description: 'Reading group',
      numItems: 512,
      source: 'local',
      indexed: true,
    });
    expect('canWrite' in row).toBe(false);
    expect(res.structuredContent?.note).toMatch(/carry no `canWrite`/);
    expect(ctx.web.listGroups).not.toHaveBeenCalled();
  });

  it('puts a write verdict on the cloud half of a merged list and not on the desktop-only half', async () => {
    const ctx = groupsCtx({
      access: { user: { write: true }, groups: { all: { library: true } } },
      held: [
        { id: 456, name: 'Lab library (desktop copy)', numItems: 9 },
        { id: 88, name: 'Desktop only', numItems: 512 },
      ],
      localApi: true,
    });
    const rows = (await groups.handler({}, ctx)).structuredContent?.groups as any[];
    expect(rows[0]).toMatchObject({ id: 456, source: 'both', canWrite: false });
    expect(rows[0].writeBlockedReason).toMatch(/read-only access to group 456/);
    expect(rows[1]).toMatchObject({ id: 88, source: 'local' });
    expect('canWrite' in rows[1]).toBe(false);
  });
});

describe('an index that cannot report itself costs one field, not the answer', () => {
  const throwingSearch = () =>
    searchStub({
      buildStatus: () => {
        throw new Error('index store is unreadable');
      },
    });

  it('zotero_whoami still resolves the identity and the default library', async () => {
    const res = await whoami.handler({}, whoamiCtx({ cloud: KEY_USER, search: throwingSearch() }));
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent?.userID).toBe(111);
    expect(res.structuredContent?.searchIndex).toBeUndefined();
    expect((res.structuredContent?.defaultLibrary as any).source).toBe('key');
  });

  it('zotero_groups still lists the groups and their write verdicts', async () => {
    const ctx = groupsCtx({
      access: { user: { write: true }, groups: { all: { library: true } } },
      search: throwingSearch(),
    });
    const res = await groups.handler({}, ctx);
    expect(res.isError).toBeUndefined();
    const row = (res.structuredContent?.groups as any[])[0];
    expect(row).toMatchObject({ id: 456, canWrite: false });
    expect('indexed' in row).toBe(false);
  });
});
