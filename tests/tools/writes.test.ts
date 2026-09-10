import { describe, it, expect, vi } from 'vitest';
import createItems from '../../src/tools/create-items.js';
import updateItem from '../../src/tools/update-item.js';
import trashItems from '../../src/tools/trash-items.js';
import deleteItems from '../../src/tools/delete-items.js';
import manageCollections from '../../src/tools/manage-collections.js';
import manageTags from '../../src/tools/manage-tags.js';
import savedSearches from '../../src/tools/saved-searches.js';
import { ZoteroApiError } from '../../src/api/errors.js';

function makeCtx(overrides: any = {}): any {
  return {
    config: { allowDelete: false, ...overrides.config },
    capabilities: { cloud: { userID: 19552201, username: 'oscardvs', access: {} }, localApi: false },
    schema: { validateItem: vi.fn(async () => ({ valid: true, errors: [] })) },
    router: {
      defaultLibrary: () => ({ type: 'user', id: 19552201 }),
      listCollections: vi.fn(async () => ({ data: [], totalResults: 0, lastModifiedVersion: 1 })),
      listTags: vi.fn(async () => ({ data: [{ tag: 'ml' }, { tag: 'robotics' }], totalResults: 2, lastModifiedVersion: 1 })),
      // Saved-search listing is routed now, like every other read, so a desktop-only
      // install can answer it without a cloud key.
      listSearches: vi.fn(async () => ({ data: [{ key: 'S1', data: { name: 'recent', conditions: [] } }], totalResults: 1, lastModifiedVersion: 1 })),
    },
    web: {
      writeItems: vi.fn(async () => ({ successful: [{ index: 0, key: 'NEW1', version: 5 }], unchanged: [], failed: [], newLibraryVersion: 5 })),
      writeCollections: vi.fn(async () => ({ successful: [{ index: 0, key: 'COL1' }], unchanged: [], failed: [], newLibraryVersion: 6 })),
      writeSearches: vi.fn(async () => ({ successful: [{ index: 0, key: 'SRCH1' }], unchanged: [], failed: [], newLibraryVersion: 7 })),
      getItem: vi.fn(async () => ({ key: 'K1', version: 3, data: { itemType: 'book', tags: [], collections: [] } })),
      patchItem: vi.fn(async () => 4),
      deleteItems: vi.fn(async () => undefined),
      deleteCollections: vi.fn(async () => undefined),
      deleteSearches: vi.fn(async () => undefined),
      currentLibraryVersion: vi.fn(async () => 100),
      listTags: vi.fn(async () => ({ data: [{ tag: 'ml' }, { tag: 'robotics' }], totalResults: 2, lastModifiedVersion: 1 })),
      listSearches: vi.fn(async () => ({ data: [{ key: 'S1', data: { name: 'recent', conditions: [] } }], totalResults: 1, lastModifiedVersion: 1 })),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...overrides.top,
  };
}

describe('zotero_create_items', () => {
  it('validates then writes valid items', async () => {
    const ctx = makeCtx();
    const res = await createItems.handler({ items: [{ itemType: 'book', title: 'T' }] }, ctx);
    expect(ctx.schema.validateItem).toHaveBeenCalled();
    expect(ctx.web.writeItems).toHaveBeenCalled();
    expect((res.structuredContent?.created as any[])[0].key).toBe('NEW1');
  });

  it('writes nothing when validation fails', async () => {
    const ctx = makeCtx();
    ctx.schema.validateItem = vi.fn(async () => ({ valid: false, errors: ['bad field'] }));
    const res = await createItems.handler({ items: [{ itemType: 'book', nope: 1 }] }, ctx);
    expect(res.isError).toBe(true);
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
  });
});

describe('zotero_update_item', () => {
  it('fetches version then patches', async () => {
    const ctx = makeCtx();
    const res = await updateItem.handler({ item_key: 'K1', patch: { title: 'New' } }, ctx);
    expect(ctx.web.patchItem).toHaveBeenCalledWith({ type: 'user', id: 19552201 }, 'K1', { title: 'New' }, 3);
    expect(res.structuredContent?.newVersion).toBe(4);
  });

  it('re-fetches and retries once on a 412 conflict', async () => {
    const ctx = makeCtx();
    let calls = 0;
    ctx.web.patchItem = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new ZoteroApiError({ status: 412, message: 'changed on the server' });
      return 9;
    });
    const res = await updateItem.handler({ item_key: 'K1', patch: { title: 'x' }, version: 3 }, ctx);
    expect(calls).toBe(2);
    expect(res.structuredContent?.retried).toBe(true);
    expect(res.structuredContent?.newVersion).toBe(9);
  });

  it('dry_run returns a field diff and does not write', async () => {
    const ctx = makeCtx();
    ctx.web.getItem = vi.fn(async () => ({
      key: 'K1',
      version: 7,
      data: { itemType: 'book', title: 'Old', extra: 'keep', tags: [{ tag: 'a' }] },
    }));
    const res = await updateItem.handler(
      { item_key: 'K1', patch: { title: 'New', tags: [{ tag: 'b' }] }, version: 7, dry_run: true },
      ctx,
    );
    expect(ctx.web.patchItem).not.toHaveBeenCalled();
    const sc = res.structuredContent as any;
    expect(sc.dryRun).toBe(true);
    expect(sc.diff.title).toEqual({ before: 'Old', after: 'New' });
    expect(sc.diff.extra).toBeUndefined(); // unchanged field omitted
    expect(sc.arrayReplacements).toContain('tags');
    const text = (res.content ?? []).map((c: { text: string }) => c.text).join('\n');
    expect(text).toContain('field(s) would change');
    expect(text).toContain('arrays replaced wholesale: tags');
  });

  it('dry_run fetches the item even when version is supplied', async () => {
    const ctx = makeCtx();
    await updateItem.handler({ item_key: 'K1', patch: { title: 'x' }, version: 3, dry_run: true }, ctx);
    expect(ctx.web.getItem).toHaveBeenCalled();
    expect(ctx.web.patchItem).not.toHaveBeenCalled();
  });
});

describe('zotero_trash_items', () => {
  it('trashes by setting deleted:1 with per-item version', async () => {
    const ctx = makeCtx();
    await trashItems.handler({ item_keys: ['K1'] }, ctx);
    expect(ctx.web.writeItems).toHaveBeenCalledWith({ type: 'user', id: 19552201 }, [
      { key: 'K1', version: 3, deleted: 1 },
    ]);
  });

  it('restores with deleted:0', async () => {
    const ctx = makeCtx();
    await trashItems.handler({ item_keys: ['K1'], action: 'restore' }, ctx);
    expect(ctx.web.writeItems).toHaveBeenCalledWith({ type: 'user', id: 19552201 }, [
      { key: 'K1', version: 3, deleted: 0 },
    ]);
  });

  it('uses the desktop deleted-flag write, never the local API DELETE (which erases)', async () => {
    const setDeleted = vi.fn(async () => ({
      successful: [{ index: 0, key: 'K1', version: 9 }],
      unchanged: ['K2'],
      failed: [],
      newLibraryVersion: 9,
    }));
    const deleteItemsLocal = vi.fn(async () => undefined);
    const ctx = makeCtx({ top: { localWrites: { setDeleted, deleteItems: deleteItemsLocal } } });
    ctx.capabilities.localApi = true;
    const res = await trashItems.handler({ item_keys: ['K1', 'K2'] }, ctx);
    expect(setDeleted).toHaveBeenCalledWith(['K1', 'K2'], 1);
    expect(deleteItemsLocal).not.toHaveBeenCalled();
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
    expect(res.structuredContent?.updated).toEqual(['K1', 'K2']);
  });
});

describe('zotero_delete_items', () => {
  it('refuses when allowDelete is false', async () => {
    const ctx = makeCtx();
    const res = await deleteItems.handler({ item_keys: ['K1'], confirm: true }, ctx);
    expect(res.isError).toBe(true);
    expect(ctx.web.deleteItems).not.toHaveBeenCalled();
  });

  it('refuses without confirm even when enabled', async () => {
    const ctx = makeCtx({ config: { allowDelete: true } });
    const res = await deleteItems.handler({ item_keys: ['K1'] }, ctx);
    expect(res.isError).toBe(true);
    expect(ctx.web.deleteItems).not.toHaveBeenCalled();
  });

  it('deletes when enabled and confirmed', async () => {
    const ctx = makeCtx({ config: { allowDelete: true } });
    const res = await deleteItems.handler({ item_keys: ['K1', 'K2'], confirm: true }, ctx);
    expect(ctx.web.deleteItems).toHaveBeenCalledWith({ type: 'user', id: 19552201 }, ['K1', 'K2'], 100);
    expect(res.isError).toBeUndefined();
  });

  it('purges through the desktop app when it accepts local-API writes', async () => {
    const localDelete = vi.fn(async () => undefined);
    const ctx = makeCtx({ config: { allowDelete: true }, top: { localWrites: { deleteItems: localDelete } } });
    ctx.capabilities.localApi = true;
    const res = await deleteItems.handler({ item_keys: ['K1'], confirm: true }, ctx);
    expect(localDelete).toHaveBeenCalledWith(['K1']);
    expect(ctx.web.deleteItems).not.toHaveBeenCalled();
    expect(res.structuredContent?.target).toBe('local');
  });

  it('falls back to the cloud when the running Zotero has no local-API writes', async () => {
    const localDelete = vi.fn(async () => {
      throw new Error('Local API writes are not supported by this Zotero: no Zotero-Server-ID header.');
    });
    const ctx = makeCtx({ config: { allowDelete: true }, top: { localWrites: { deleteItems: localDelete } } });
    ctx.capabilities.localApi = true;
    const res = await deleteItems.handler({ item_keys: ['K1'], confirm: true }, ctx);
    expect(localDelete).toHaveBeenCalled();
    expect(ctx.web.deleteItems).toHaveBeenCalledWith({ type: 'user', id: 19552201 }, ['K1'], 100);
    expect(res.isError).toBeUndefined();
  });
});

describe('zotero_manage_collections', () => {
  it('lists collections via the router', async () => {
    const ctx = makeCtx();
    ctx.router.listCollections = vi.fn(async () => ({
      data: [{ key: 'C1', data: { name: 'Reading', parentCollection: false } }],
      totalResults: 1,
      lastModifiedVersion: 1,
    }));
    const res = await manageCollections.handler({ action: 'list' }, ctx);
    expect((res.structuredContent?.collections as any[])[0].name).toBe('Reading');
  });

  it('creates a collection', async () => {
    const ctx = makeCtx();
    const res = await manageCollections.handler({ action: 'create', name: 'New' }, ctx);
    expect(ctx.web.writeCollections).toHaveBeenCalledWith({ type: 'user', id: 19552201 }, [
      { name: 'New', parentCollection: false },
    ]);
    expect((res.structuredContent?.created as string[])[0]).toBe('COL1');
  });
});

describe('zotero_manage_tags', () => {
  it('lists tags', async () => {
    const ctx = makeCtx();
    const res = await manageTags.handler({ action: 'list' }, ctx);
    expect(res.structuredContent?.tags).toEqual(['ml', 'robotics']);
  });

  // The list action read ctx.web directly, so on a desktop-only setup it asked
  // api.zotero.org for users/0 and came back "Invalid user ID" for the one group of users
  // whose desktop was serving the tags all along. Same cause as #64, #26 and #67.
  it('lists tags through the router, never straight at the cloud', async () => {
    const ctx = makeCtx();
    await manageTags.handler({ action: 'list', limit: 5 }, ctx);
    expect(ctx.router.listTags).toHaveBeenCalledWith(
      expect.objectContaining({ library: { type: 'user', id: 19552201 }, limit: 5 }),
    );
    expect(ctx.web.listTags).not.toHaveBeenCalled();
  });

  it('keeps an explicit group library on the list action', async () => {
    const ctx = makeCtx();
    await manageTags.handler({ action: 'list', library_type: 'group', library_id: 6666644 }, ctx);
    expect(ctx.router.listTags).toHaveBeenCalledWith(
      expect.objectContaining({ library: { type: 'group', id: 6666644 } }),
    );
  });

  it('adds a tag by patching the item', async () => {
    const ctx = makeCtx();
    await manageTags.handler({ action: 'add', tags: ['new'], item_keys: ['K1'] }, ctx);
    expect(ctx.web.patchItem).toHaveBeenCalledWith(
      { type: 'user', id: 19552201 },
      'K1',
      { tags: [{ tag: 'new' }] },
      3,
    );
  });
});

describe('zotero_saved_searches', () => {
  it('lists saved searches', async () => {
    const ctx = makeCtx();
    const res = await savedSearches.handler({ action: 'list' }, ctx);
    expect((res.structuredContent?.searches as any[])[0].name).toBe('recent');
  });

  it('creates a saved search', async () => {
    const ctx = makeCtx();
    await savedSearches.handler(
      { action: 'create', name: 's', conditions: [{ condition: 'title', operator: 'contains', value: 'ai' }] },
      ctx,
    );
    expect(ctx.web.writeSearches).toHaveBeenCalled();
  });
});

// The bulk-write gate (ZOTEUS_CONFIRM_BULK_WRITES). Off by default, so every test above
// runs unchanged; these set a threshold explicitly and check both sides of it.
describe('bulk-write confirmation gate', () => {
  const keys = (n: number) => Array.from({ length: n }, (_, i) => `K${i}`);

  it('is off by default: a large trash still goes through', async () => {
    const ctx = makeCtx();
    const res = await trashItems.handler({ item_keys: keys(500) }, ctx);
    expect(res.isError).toBeUndefined();
    expect(ctx.web.writeItems).toHaveBeenCalled();
  });

  it('refuses a bulk trash above the threshold without confirm', async () => {
    const ctx = makeCtx({ config: { confirmBulkWrites: 10 } });
    const res = await trashItems.handler({ item_keys: keys(11) }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/ZOTEUS_CONFIRM_BULK_WRITES/);
    expect(res.content[0].text).toMatch(/confirm:true/);
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
  });

  it('lets the same call through with confirm:true', async () => {
    const ctx = makeCtx({ config: { confirmBulkWrites: 10 } });
    const res = await trashItems.handler({ item_keys: keys(11), confirm: true }, ctx);
    expect(res.isError).toBeUndefined();
    expect(ctx.web.writeItems).toHaveBeenCalled();
  });

  it('leaves a call at or below the threshold fluent', async () => {
    const ctx = makeCtx({ config: { confirmBulkWrites: 10 } });
    const res = await trashItems.handler({ item_keys: keys(10) }, ctx);
    expect(res.isError).toBeUndefined();
    expect(ctx.web.writeItems).toHaveBeenCalled();
  });

  it('does not gate restore, which puts items back', async () => {
    const ctx = makeCtx({ config: { confirmBulkWrites: 10 } });
    const res = await trashItems.handler({ item_keys: keys(50), action: 'restore' }, ctx);
    expect(res.isError).toBeUndefined();
  });

  it('gates a bulk retag, in both directions', async () => {
    for (const action of ['add', 'remove'] as const) {
      const ctx = makeCtx({ config: { confirmBulkWrites: 10 } });
      const res = await manageTags.handler({ action, tags: ['t'], item_keys: keys(40) }, ctx);
      expect(res.isError).toBe(true);
      expect(ctx.web.patchItem).not.toHaveBeenCalled();
    }
  });

  it('gates removing items from a collection, but not adding them', async () => {
    const ctx = makeCtx({ config: { confirmBulkWrites: 10 } });
    const removed = await manageCollections.handler(
      { action: 'remove_items', collection_key: 'C1', item_keys: keys(40) },
      ctx,
    );
    expect(removed.isError).toBe(true);
    expect(ctx.web.patchItem).not.toHaveBeenCalled();

    const added = await manageCollections.handler(
      { action: 'add_items', collection_key: 'C1', item_keys: keys(40) },
      ctx,
    );
    expect(added.isError).toBeUndefined();
    expect(ctx.web.patchItem).toHaveBeenCalled();
  });
});
