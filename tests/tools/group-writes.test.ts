import { describe, it, expect, vi } from 'vitest';
import createItems from '../../src/tools/create-items.js';
import manageCollections from '../../src/tools/manage-collections.js';
import manageTags from '../../src/tools/manage-tags.js';
import savedSearches from '../../src/tools/saved-searches.js';
import listCollections from '../../src/tools/list-collections.js';
import {
  missingWriteAccess,
  optionalLibrary,
  requireCloud,
  requireCloudLibrary,
  resolveLibrary,
} from '../../src/registry/registry.js';
import { LibraryRouter } from '../../src/router/library-router.js';
import { loadConfig } from '../../src/config.js';
import type { LibraryRef } from '../../src/api/web-client.js';

/**
 * Issue #74, "adding references to groups". Three separate ways a group write went wrong
 * without saying so:
 *
 *  1. `library_type:"group"` with no `library_id` fell through to the personal library, so
 *     a call that plainly named a group succeeded — in the wrong library.
 *  2. A key that cannot write the group only found out at api.zotero.org, as a 403 whose
 *     text ("may lack permission for this library or operation") names no remedy, so the
 *     model retried instead of stopping.
 *  3. The `list` sub-actions of the manage tools ignored the library arguments they
 *     advertise, handing back personal-library keys for a call about a group.
 */

const KEY_USER_ID = 123;
const GROUP_ID = 456;
const USER: LibraryRef = { type: 'user', id: KEY_USER_ID };
const GROUP: LibraryRef = { type: 'group', id: GROUP_ID };

/** A `/keys/current` access map with full read/write on every group, as zotero.org emits. */
const ALL_GROUPS_WRITE = {
  user: { library: true, files: true, notes: true, write: true },
  groups: { all: { library: true, write: true } },
};

function makeCtx(opts: { access?: Record<string, unknown> | null } = {}) {
  const web = {
    hasKey: opts.access !== null,
    writeItems: vi.fn(async (_lib: LibraryRef, items: unknown[]) => ({
      successful: items.map((_, i) => ({ index: i, key: `NEW${i}`, version: 4 })),
      unchanged: [],
      failed: [],
      newLibraryVersion: 4,
    })),
    writeCollections: vi.fn(async () => ({
      successful: [{ index: 0, key: 'COLL0001', version: 4 }],
      unchanged: [],
      failed: [],
      newLibraryVersion: 4,
    })),
    listCollections: vi.fn(async (_lib: LibraryRef) => ({
      data: [{ key: 'GRPCOLL1', data: { key: 'GRPCOLL1', name: 'Screening' } }],
      totalResults: 1,
      lastModifiedVersion: 4,
    })),
    listTags: vi.fn(async (_lib: LibraryRef) => ({
      data: [{ tag: 'included' }],
      totalResults: 1,
      lastModifiedVersion: 4,
    })),
    listSearches: vi.fn(async (_lib: LibraryRef) => ({
      data: [{ key: 'SRCH0001', data: { key: 'SRCH0001', name: 'Unscreened', conditions: [] } }],
      totalResults: 1,
      lastModifiedVersion: 4,
    })),
  };
  const config = loadConfig({ ZOTEUS_LOCAL: 'off' } as any);
  const capabilities = {
    cloud:
      opts.access === null
        ? null
        : { userID: KEY_USER_ID, username: 'probe', access: opts.access ?? ALL_GROUPS_WRITE },
    localApi: false,
    localGroupIds: [],
  };
  const router = new LibraryRouter({ config, capabilities: capabilities as any, web: web as any });
  const ctx: any = {
    config,
    capabilities,
    router,
    web,
    schema: { validateItem: vi.fn(async () => ({ valid: true, errors: [] })) },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
  return { ctx, web };
}

describe('a group is addressed by id, never by library_type alone (#74)', () => {
  it('refuses library_type:"group" with no library_id, and says where the id comes from', () => {
    expect(() => optionalLibrary({ library_type: 'group' })).toThrow(/library_id/);
    expect(() => optionalLibrary({ library_type: 'group' })).toThrow(/zotero_groups/);
  });

  it('still resolves library_type:"user" with no id to the default library', () => {
    const { ctx } = makeCtx();
    expect(resolveLibrary(ctx, { library_type: 'user' })).toEqual(USER);
    expect(resolveLibrary(ctx, {})).toEqual(USER);
  });

  it('honors an explicit personal library for reads and writes on a group-default install', async () => {
    const { ctx, web } = makeCtx();
    ctx.config.libraryType = 'group';
    ctx.config.libraryId = GROUP_ID;
    expect(resolveLibrary(ctx, {})).toEqual(GROUP);
    expect(resolveLibrary(ctx, { library_type: 'user' })).toEqual(USER);
    await listCollections.handler({ library_type: 'user' }, ctx);
    expect(web.listCollections.mock.calls[0][0]).toEqual(USER);
    await createItems.handler({ items: [{ itemType: 'book', title: 'Personal reference' }], library_type: 'user' }, ctx);
    expect(web.writeItems.mock.calls[0][0]).toEqual(USER);
  });

  it('routes the explicit personal library locally when the configured default is a group', async () => {
    const { ctx, web } = makeCtx();
    ctx.config.libraryType = 'group';
    ctx.config.libraryId = GROUP_ID;
    ctx.config.local = 'auto';
    ctx.capabilities.localApi = true;
    const local = { listCollections: vi.fn(async () => ({ data: [], totalResults: 0 })) };
    ctx.router = new LibraryRouter({ config: ctx.config, capabilities: ctx.capabilities, web: web as any, local: local as any });
    await listCollections.handler({ library_type: 'user' }, ctx);
    expect(local.listCollections).toHaveBeenCalled();
    expect(web.listCollections).not.toHaveBeenCalled();
    expect(ctx.router.servesLocally({ type: 'user', id: GROUP_ID })).toBe(false);
  });

  it('keeps a configured personal library local when no cloud key is installed', () => {
    const { ctx, web } = makeCtx({ access: null });
    ctx.config.libraryType = 'user';
    ctx.config.libraryId = KEY_USER_ID;
    ctx.config.local = 'auto';
    ctx.capabilities.localApi = true;
    const router = new LibraryRouter({ config: ctx.config, capabilities: ctx.capabilities, web: web as any, local: {} as any });
    expect(router.servesLocally()).toBe(true);
    expect(router.servesLocally({ type: 'user', id: 0 })).toBe(true);
    expect(router.servesLocally({ type: 'user', id: GROUP_ID })).toBe(false);
  });

  it('takes the id when one is given, group or user', () => {
    expect(optionalLibrary({ library_type: 'group', library_id: GROUP_ID })).toEqual(GROUP);
    expect(optionalLibrary({ library_id: GROUP_ID })).toEqual(GROUP);
    expect(optionalLibrary({ library_type: 'user', library_id: KEY_USER_ID })).toEqual(USER);
  });

  it('writes nothing when zotero_create_items names a group with no id', async () => {
    const { ctx, web } = makeCtx();
    await expect(
      createItems.handler({ items: [{ itemType: 'book', title: 'x' }], library_type: 'group' }, ctx),
    ).rejects.toThrow(/library_id/);
    expect(web.writeItems).not.toHaveBeenCalled();
  });

  it('reads nothing from the wrong library when a read names a group with no id', async () => {
    const { ctx, web } = makeCtx();
    await expect(listCollections.handler({ library_type: 'group' }, ctx)).rejects.toThrow(
      /library_id/,
    );
    expect(web.listCollections).not.toHaveBeenCalled();
  });
});

describe("the key's own access map decides a group write before the request (#74)", () => {
  it('allows a group when the key has write access to all groups', () => {
    expect(missingWriteAccess({ userID: KEY_USER_ID, access: ALL_GROUPS_WRITE }, GROUP)).toBeNull();
  });

  it('names the group and the settings page when the key is read-only there', () => {
    const access = { user: { write: true }, groups: { all: { library: true } } };
    const why = missingWriteAccess({ userID: KEY_USER_ID, access }, GROUP);
    expect(why).toMatch(/read-only access to group 456/);
    expect(why).toMatch(/zotero\.org\/settings\/keys/);
    // The other reason a group refuses a write, which no key setting fixes.
    expect(why).toMatch(/only admins/);
  });

  it('lets a per-group entry override the all-groups default', () => {
    const access = {
      user: { write: true },
      groups: { all: { library: true, write: true }, [String(GROUP_ID)]: { library: true } },
    };
    expect(missingWriteAccess({ userID: KEY_USER_ID, access }, GROUP)).toMatch(/read-only/);
    // A different group still follows the permissive default.
    expect(missingWriteAccess({ userID: KEY_USER_ID, access }, { type: 'group', id: 789 })).toBeNull();
  });

  it('says so when the key was created with no group access at all', () => {
    const access = { user: { library: true, write: true } };
    expect(missingWriteAccess({ userID: KEY_USER_ID, access }, GROUP)).toMatch(
      /no access to any group library/,
    );
  });

  it('holds no opinion when the key reports no access map', () => {
    expect(missingWriteAccess({ userID: KEY_USER_ID, access: {} }, GROUP)).toBeNull();
    expect(missingWriteAccess({ userID: KEY_USER_ID }, GROUP)).toBeNull();
  });

  it('catches a read-only personal key too, and points at the desktop app', () => {
    const access = { user: { library: true, write: false }, groups: { all: { library: true } } };
    expect(missingWriteAccess({ userID: KEY_USER_ID, access }, USER)).toMatch(/read-only/);
    expect(missingWriteAccess({ userID: KEY_USER_ID, access }, USER)).toMatch(/desktop app/);
  });

  it("refuses another account's personal library outright", () => {
    expect(missingWriteAccess({ userID: KEY_USER_ID, access: ALL_GROUPS_WRITE }, { type: 'user', id: 999 })).toMatch(
      /another account/,
    );
  });

  it('stops zotero_create_items before the request when the key cannot write the group', async () => {
    const { ctx, web } = makeCtx({ access: { user: { write: true }, groups: { all: { library: true } } } });
    await expect(
      createItems.handler(
        { items: [{ itemType: 'book', title: 'x' }], library_type: 'group', library_id: GROUP_ID },
        ctx,
      ),
    ).rejects.toThrow(/read-only access to group 456/);
    expect(web.writeItems).not.toHaveBeenCalled();
  });

  it('lets the same call through when the key does have group write access', async () => {
    const { ctx, web } = makeCtx();
    const res = await createItems.handler(
      { items: [{ itemType: 'book', title: 'x' }], library_type: 'group', library_id: GROUP_ID },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(web.writeItems.mock.calls[0]![0]).toEqual(GROUP);
  });

  it('tells a key-free install that the desktop app cannot stand in for a group write', () => {
    const { ctx } = makeCtx({ access: null });
    expect(() => requireCloud(ctx, GROUP)).toThrow(/group library 456/);
    expect(() => requireCloudLibrary(ctx, { library_type: 'group', library_id: GROUP_ID })).toThrow(
      /personal library only/,
    );
  });
});

describe('the manage tools list the library the caller named (#74)', () => {
  it('zotero_manage_collections list reads the group, not the personal library', async () => {
    const { ctx, web } = makeCtx();
    const res = await manageCollections.handler(
      { action: 'list', library_type: 'group', library_id: GROUP_ID },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(web.listCollections.mock.calls[0]![0]).toEqual(GROUP);
    expect(res.structuredContent?.collections).toEqual([
      { key: 'GRPCOLL1', name: 'Screening', parentCollection: false, numItems: undefined },
    ]);
  });

  it('zotero_manage_tags list reads the group', async () => {
    const { ctx, web } = makeCtx();
    const res = await manageTags.handler(
      { action: 'list', library_type: 'group', library_id: GROUP_ID },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(web.listTags.mock.calls[0]![0]).toEqual(GROUP);
  });

  it('zotero_saved_searches list reads the group', async () => {
    const { ctx, web } = makeCtx();
    const res = await savedSearches.handler(
      { action: 'list', library_type: 'group', library_id: GROUP_ID },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(web.listSearches.mock.calls[0]![0]).toEqual(GROUP);
  });

  it('still lists the default library when the call names none', async () => {
    const { ctx, web } = makeCtx();
    await manageCollections.handler({ action: 'list' }, ctx);
    expect(web.listCollections.mock.calls[0]![0]).toEqual(USER);
  });
});
