import { describe, it, expect, vi } from 'vitest';
import mergeItems from '../../src/tools/merge-items.js';
import { ZoteroApiError } from '../../src/api/errors.js';

const LIB = { type: 'user' as const, id: 19552201 };
const URI = (key: string) => `http://zotero.org/users/19552201/items/${key}`;

/** The library these tests merge in: one master, one duplicate, one child note. */
function fixture() {
  return {
    K1: {
      key: 'K1',
      version: 3,
      data: {
        key: 'K1',
        itemType: 'journalArticle',
        title: 'Kalman filters',
        DOI: '',
        abstractNote: '',
        date: '2019',
        tags: [{ tag: 'ml' }],
        collections: ['COLA'],
        relations: {},
      },
    },
    D1: {
      key: 'D1',
      version: 5,
      data: {
        key: 'D1',
        itemType: 'journalArticle',
        title: 'Kalman Filters',
        DOI: '10.1/kalman',
        abstractNote: 'An abstract the master is missing.',
        // Not a journalArticle field: the plan must leave it behind rather than send a
        // PATCH Zotero would refuse.
        publisher: 'Nowhere Press',
        tags: [{ tag: 'ml' }, { tag: 'robotics' }],
        collections: ['COLB'],
        relations: { 'dc:relation': URI('OTHER01') },
      },
    },
    C1: {
      key: 'C1',
      version: 7,
      data: { key: 'C1', itemType: 'note', note: '<p>a note</p>', parentItem: 'D1' },
    },
  };
}

function makeCtx(overrides: any = {}, edit?: (items: Record<string, any>) => void): any {
  const items: Record<string, any> = fixture();
  edit?.(items);
  const children: Record<string, any[]> = { D1: [items.C1], K1: [] };
  const ctx: any = {
    config: { confirmBulkWrites: 0 },
    capabilities: { cloud: { userID: 19552201, username: 'oscardvs', access: {} }, localApi: false },
    schema: {
      getSchema: vi.fn(async () => ({
        version: 1,
        itemTypes: [
          {
            itemType: 'journalArticle',
            fields: [{ field: 'title' }, { field: 'DOI' }, { field: 'abstractNote' }, { field: 'date' }, { field: 'extra' }],
            creatorTypes: [{ creatorType: 'author' }],
          },
        ],
      })),
    },
    router: {
      defaultLibrary: () => LIB,
      servesLocally: vi.fn(() => false),
      getItem: vi.fn(async (key: string) => items[key]),
      getItemChildren: vi.fn(async (key: string) => ({ data: children[key] ?? [], totalResults: 0, lastModifiedVersion: 1 })),
    },
    web: {
      getItem: vi.fn(async (_lib: any, key: string) => items[key]),
      getItemChildren: vi.fn(async (_lib: any, key: string) => ({ data: (children[key] ?? []).filter((child) => child.data.parentItem === key), totalResults: 0, lastModifiedVersion: 1 })),
      patchItem: vi.fn(async (_lib: any, key: string, patch: any) => {
        Object.assign(items[key].data, patch);
        return 11;
      }),
      writeItems: vi.fn(async (_lib: any, objects: any[]) => ({
        successful: objects.map((o, index) => ({ index, key: o.key, version: 12 })),
        unchanged: [],
        failed: [],
        newLibraryVersion: 12,
      })),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...overrides,
  };
  return ctx;
}

describe('zotero_merge_items dry run', () => {
  it('plans the merge and writes nothing', async () => {
    const ctx = makeCtx();
    const res: any = await mergeItems.handler({ master_key: 'K1', duplicate_keys: ['D1'] }, ctx);

    expect(res.isError).toBeFalsy();
    expect(ctx.web.patchItem).not.toHaveBeenCalled();
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
    const sc = res.structuredContent;
    expect(sc.dryRun).toBe(true);
    // Only the fields the master is MISSING, and the value it would receive.
    expect(sc.plan.fields.DOI).toEqual({ before: '', after: '10.1/kalman', from: 'D1' });
    expect(sc.plan.fields.abstractNote.after).toBe('An abstract the master is missing.');
    // A field the master already has never appears: the title differs only in case, and the
    // master's wins.
    expect(sc.plan.fields.title).toBeUndefined();
    expect(sc.plan.fields.date).toBeUndefined();
    expect(sc.plan.tagsAdded).toEqual(['robotics']);
    expect(sc.plan.collectionsAdded).toEqual(['COLB']);
    expect(sc.plan.relationsAdded['dc:replaces']).toEqual([URI('D1')]);
    expect(sc.plan.relationsAdded['dc:relation']).toEqual([URI('OTHER01')]);
    expect(sc.plan.childrenToMove).toEqual([{ key: 'C1', itemType: 'note', title: undefined, from: 'D1' }]);
    expect(sc.plan.duplicatesToTrash).toEqual(['D1']);
    expect(res.content[0].text).toMatch(/Nothing was written/);
  });

  it('leaves a field the master\'s item type does not have, and says so', async () => {
    const ctx = makeCtx();
    const res: any = await mergeItems.handler({ master_key: 'K1', duplicate_keys: ['D1'] }, ctx);
    const sc = res.structuredContent;
    expect(sc.plan.fields.publisher).toBeUndefined();
    expect(sc.plan.fieldsSkipped).toEqual([
      { field: 'publisher', from: 'D1', reason: expect.stringContaining('not a field of itemType "journalArticle"') },
    ]);
  });

  it('reads through the router only when no merge could be applied at all, and says which copy it read', async () => {
    const ctx = makeCtx({ capabilities: { cloud: null, localApi: true } });
    const res: any = await mergeItems.handler({ master_key: 'K1', duplicate_keys: ['D1'] }, ctx);
    expect(res.isError).toBeFalsy();
    expect(ctx.router.getItem).toHaveBeenCalled();
    expect(ctx.web.getItem).not.toHaveBeenCalled();
    expect(res.structuredContent.readFrom).toBe('local');
    expect(res.structuredContent.note).toMatch(/ZOTERO_API_KEY/);
    expect(res.structuredContent.note).toMatch(/desktop app/);
  });

  it('refuses when duplicate_keys names nothing but the master', async () => {
    const ctx = makeCtx();
    const res: any = await mergeItems.handler({ master_key: 'K1', duplicate_keys: ['K1'] }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/named no other item/);
    expect(ctx.router.getItem).not.toHaveBeenCalled();
  });

  it('refuses when the master does not exist', async () => {
    const ctx = makeCtx();
    ctx.web.getItem = vi.fn(async () => undefined);
    const res: any = await mergeItems.handler({ master_key: 'NOPE', duplicate_keys: ['D1'] }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/nothing to merge into/);
  });
});

describe('zotero_merge_items apply', () => {
  it('fills only the missing fields, moves the children, then trashes the duplicate', async () => {
    const ctx = makeCtx();
    const res: any = await mergeItems.handler({ master_key: 'K1', duplicate_keys: ['D1'], dry_run: false }, ctx);

    expect(res.isError).toBeFalsy();
    // Step 1: one PATCH on the master, carrying its own version.
    const [lib, key, patch, version] = ctx.web.patchItem.mock.calls[0];
    expect(lib).toEqual(LIB);
    expect(key).toBe('K1');
    expect(version).toBe(3);
    expect(patch.DOI).toBe('10.1/kalman');
    expect(patch.title).toBeUndefined();
    expect(patch.publisher).toBeUndefined();
    // PATCH replaces arrays wholesale, so the master's own tag has to be in the payload.
    expect(patch.tags).toEqual([{ tag: 'ml' }, { tag: 'robotics' }]);
    expect(patch.collections).toEqual(['COLA', 'COLB']);
    expect(patch.relations['dc:replaces']).toBe(URI('D1'));
    expect(patch.relations['dc:relation']).toBe(URI('OTHER01'));

    // Step 2: the child note is reparented onto the master.
    expect(ctx.web.patchItem.mock.calls[1]).toEqual([LIB, 'C1', { parentItem: 'K1' }, 7]);

    // Step 3: the duplicate is TRASHED, never deleted.
    expect(ctx.web.writeItems).toHaveBeenCalledWith(LIB, [{ key: 'D1', version: 5, deleted: 1 }], { libraryVersion: 1 });

    const sc = res.structuredContent;
    expect(sc.dryRun).toBe(false);
    expect(sc.applied).toEqual({ masterVersion: 11, childrenMoved: ['C1'], trashed: ['D1'] });
    expect(sc.target).toBe('cloud');
    expect(res.content[0].text).toMatch(/can be restored/);
  });

  it('retries once when the master moved under it (412)', async () => {
    const ctx = makeCtx();
    let calls = 0;
    const applyPatch = ctx.web.patchItem;
    ctx.web.patchItem = vi.fn(async (...args: any[]) => {
      calls++;
      if (calls === 1) throw new ZoteroApiError({ status: 412, message: 'changed on the server' });
      await applyPatch(...args);
      return 21;
    });
    const res: any = await mergeItems.handler({ master_key: 'K1', duplicate_keys: ['D1'], dry_run: false }, ctx);
    expect(res.isError).toBeFalsy();
    expect(calls).toBe(3); // master (412), master (retry), child
    expect(res.structuredContent.applied.trashed).toEqual(['D1']);
  });

  it('stops before trashing anything when the master update fails', async () => {
    const ctx = makeCtx();
    ctx.web.patchItem = vi.fn(async () => {
      throw new ZoteroApiError({ status: 500, message: 'Zotero is down' });
    });
    const res: any = await mergeItems.handler({ master_key: 'K1', duplicate_keys: ['D1'], dry_run: false }, ctx);

    expect(res.isError).toBe(true);
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
    expect(res.structuredContent.applied).toEqual({ childrenMoved: [], trashed: [] });
    expect(res.structuredContent.plan.duplicatesToTrash).toEqual([]);
    expect(res.structuredContent.failed[0]).toMatchObject({ key: 'K1', code: 500 });
    expect(res.content[0].text).toMatch(/nothing was trashed/);
  });

  it('keeps a duplicate out of the trash when its child could not be reparented', async () => {
    const ctx = makeCtx();
    ctx.web.patchItem = vi.fn(async (_lib: any, key: string) => {
      if (key === 'C1') throw new ZoteroApiError({ status: 400, message: 'parentItem is not editable' });
      return 11;
    });
    const res: any = await mergeItems.handler({ master_key: 'K1', duplicate_keys: ['D1'], dry_run: false }, ctx);

    // The master landed, so this is a partial success rather than a failure.
    expect(res.isError).toBeFalsy();
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
    const sc = res.structuredContent;
    expect(sc.applied).toEqual({ masterVersion: 11, childrenMoved: [], trashed: [] });
    expect(sc.failed[0]).toMatchObject({ key: 'C1', code: 400 });
    expect(sc.failed[0].message).toMatch(/refused a parentItem change/);
    expect(sc.failed[0].message).toMatch(/left out of the trash/);
    // The plan is the caller's record of what happened, so it must not still announce a
    // trashing the failures beside it say was refused.
    expect(sc.plan.duplicatesToTrash).toEqual([]);
    expect(res.content[0].text).toMatch(/stayed in the library/);
    // writeResult surfaces the count in the summary, so a caller reading prose learns that
    // part of the merge did not land without opening the payload.
    expect(res.content[0].text).toMatch(/1 failed/);
  });

  it('is an error when every step failed, not a success with a failures list', async () => {
    const ctx = makeCtx();
    ctx.web.patchItem = vi.fn(async () => {
      throw new ZoteroApiError({ status: 403, message: 'Forbidden' });
    });
    const res: any = await mergeItems.handler({ master_key: 'K1', duplicate_keys: ['D1'], dry_run: false }, ctx);
    expect(res.isError).toBe(true);
  });

  it('reports a duplicate it could not read and merges the rest', async () => {
    const ctx = makeCtx();
    const real = ctx.web.getItem;
    ctx.web.getItem = vi.fn(async (lib: any, key: string) => {
      if (key === 'GONE1234') throw new ZoteroApiError({ status: 404, message: 'Not found' });
      return real(lib, key);
    });
    const res: any = await mergeItems.handler(
      { master_key: 'K1', duplicate_keys: ['D1', 'GONE1234'], dry_run: false },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.applied.trashed).toEqual(['D1']);
    expect(res.structuredContent.failed.some((f: any) => f.key === 'GONE1234')).toBe(true);
  });

  it('refuses a bulk merge without confirm when the server sets a threshold', async () => {
    const ctx = makeCtx({ config: { confirmBulkWrites: 1 } });
    const res: any = await mergeItems.handler(
      { master_key: 'K1', duplicate_keys: ['D1', 'D2'], dry_run: false },
      ctx,
    );
    expect(res.isError).toBe(true);
    // The master, its one child note and the one readable duplicate: three item writes.
    expect(res.content[0].text).toMatch(/Refusing to merge 3 item\(s\)/);
    // Reads have happened by now (they are how the true count is known), but nothing is written.
    expect(ctx.web.patchItem).not.toHaveBeenCalled();
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
  });

  it('counts the children and the master in the bulk-write gate, not just the duplicates', async () => {
    const ctx = makeCtx({ config: { confirmBulkWrites: 10 } });
    // One duplicate, twelve attachments hanging off it: the call writes 1 + 12 + 1 = 14 items.
    const attachments = Array.from({ length: 12 }, (_, i) => ({
      key: `A${i}`,
      version: 20 + i,
      data: { key: `A${i}`, itemType: 'attachment', filename: `paper-${i}.pdf`, parentItem: 'D1' },
    }));
    ctx.web.getItemChildren = vi.fn(async (_lib: any, key: string) => ({
      data: key === 'D1' ? attachments : [],
      totalResults: 0,
      lastModifiedVersion: 1,
    }));
    const res: any = await mergeItems.handler({ master_key: 'K1', duplicate_keys: ['D1'], dry_run: false }, ctx);

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Refusing to merge 14 item\(s\)/);
    expect(ctx.web.patchItem).not.toHaveBeenCalled();
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
  });

  it('refuses to write without a cloud key, and says the preview still works', async () => {
    const ctx = makeCtx({ capabilities: { cloud: null, localApi: true } });
    const res: any = await mergeItems.handler({ master_key: 'K1', duplicate_keys: ['D1'], dry_run: false }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/dry_run:true/);
    expect(ctx.web.patchItem).not.toHaveBeenCalled();
  });
});

describe('zotero_merge_items conflicts', () => {
  /** The master as the user left it in Zotero after the plan was read: edited, and moved on. */
  function edited(): any {
    return {
      key: 'K1',
      version: 9,
      data: {
        key: 'K1',
        itemType: 'journalArticle',
        title: 'Kalman filters',
        DOI: '',
        abstractNote: "THE USER'S OWN ABSTRACT",
        date: '2019',
        tags: [{ tag: 'ml' }, { tag: 'urgent' }],
        collections: ['COLA', 'COLNEW'],
        relations: { 'dc:relation': URI('MINE0001') },
      },
    };
  }

  /** A ctx whose master changes between the plan read and the PATCH, which then 412s once. */
  function conflicting(): any {
    const ctx = makeCtx();
    let patches = 0;
    const originalGet = ctx.web.getItem;
    const applyPatch = ctx.web.patchItem;
    ctx.web.patchItem = vi.fn(async (lib: any, key: string, patch: any, version: any) => {
      if (key === 'K1') {
        patches++;
        if (patches === 1) throw new ZoteroApiError({ status: 412, message: 'changed on the server' });
        return 21;
      }
      return applyPatch(lib, key, patch, version);
    });
    ctx.web.getItem = vi.fn(async (lib: any, key: string) =>
      key === 'K1' && patches > 0 ? edited() : originalGet(lib, key),
    );
    return ctx;
  }

  it('rebuilds the plan against the fresh record on a 412 instead of replaying the stale patch', async () => {
    const ctx = conflicting();
    const res: any = await mergeItems.handler({ master_key: 'K1', duplicate_keys: ['D1'], dry_run: false }, ctx);

    expect(res.isError).toBeFalsy();
    const [, , retry, retryVersion] = ctx.web.patchItem.mock.calls[1];
    expect(retryVersion).toBe(9);
    // The abstract the user typed in the meantime is a value the master HAS, so the merge
    // must no longer offer to fill it.
    expect(retry.abstractNote).toBeUndefined();
    // A field still empty on the fresh record is still filled: this is a rebuild, not an abort.
    expect(retry.DOI).toBe('10.1/kalman');
    // The arrays are whole-array replacements, so they have to be rebuilt from the fresh
    // record or the concurrently added tag, collection and relation are deleted.
    expect(retry.tags).toEqual([{ tag: 'ml' }, { tag: 'urgent' }, { tag: 'robotics' }]);
    expect(retry.collections).toEqual(['COLA', 'COLNEW', 'COLB']);
    expect(retry.relations['dc:relation']).toEqual([URI('MINE0001'), URI('OTHER01')]);
  });

  it('reports the rebuilt plan rather than the one it started from', async () => {
    const ctx = conflicting();
    const res: any = await mergeItems.handler({ master_key: 'K1', duplicate_keys: ['D1'], dry_run: false }, ctx);

    const sc = res.structuredContent;
    expect(sc.replanned).toBe(true);
    expect(sc.plan.fields.abstractNote).toBeUndefined();
    expect(sc.plan.fields.DOI.after).toBe('10.1/kalman');
    expect(sc.plan.tagsAdded).toEqual(['robotics']);
    expect(res.content[0].text).toMatch(/changed on the server while this merge was being planned/);
    expect(res.content[0].text).toMatch(/filled 1 field\(s\)/);
    // Still a completed merge: the duplicate is in the trash.
    expect(sc.applied.trashed).toEqual(['D1']);
  });

  it('says nothing about a replan when there was no conflict', async () => {
    const ctx = makeCtx();
    const res: any = await mergeItems.handler({ master_key: 'K1', duplicate_keys: ['D1'], dry_run: false }, ctx);
    expect(res.structuredContent.replanned).toBeUndefined();
    expect(res.content[0].text).not.toMatch(/changed on the server/);
  });
});

describe('zotero_merge_items preview and apply agree', () => {
  /**
   * A desktop that is ahead of the cloud, which is the ordinary state of a local install:
   * the user has typed an abstract onto the master and saved a PDF under the duplicate, and
   * neither has synced yet.
   */
  function aheadDesktop(ctx: any): void {
    const desktop: Record<string, any> = fixture();
    desktop.K1.data.abstractNote = 'MY OWN NOTES, typed locally';
    const a9 = { key: 'A9', version: 4, data: { key: 'A9', itemType: 'attachment', filename: 'paper.pdf', parentItem: 'D1' } };
    ctx.router.getItem = vi.fn(async (key: string) => desktop[key]);
    ctx.router.getItemChildren = vi.fn(async (key: string) => ({
      data: key === 'D1' ? [desktop.C1, a9] : [],
      totalResults: 0,
      lastModifiedVersion: 1,
    }));
  }

  it('previews from the cloud, so the approved plan is the plan that runs', async () => {
    const ctx = makeCtx();
    aheadDesktop(ctx);
    const res: any = await mergeItems.handler({ master_key: 'K1', duplicate_keys: ['D1'] }, ctx);

    expect(res.structuredContent.readFrom).toBe('cloud');
    expect(ctx.web.getItem).toHaveBeenCalled();
    expect(ctx.router.getItem).not.toHaveBeenCalled();
    // The cloud master has no abstract, so the preview says the field would be filled, which
    // is exactly what dry_run:false would then do.
    expect(res.structuredContent.plan.fields.abstractNote.after).toBe('An abstract the master is missing.');
    // And it promises only the reparenting the cloud can actually perform.
    expect(res.structuredContent.plan.childrenToMove.map((c: any) => c.key)).toEqual(['C1']);
  });

  it.each([true, false])('excludes unsynced desktop children from planned trashing (dry_run:%s)', async (dryRun) => {
    const ctx = makeCtx();
    aheadDesktop(ctx);
    ctx.router.servesLocally = vi.fn(() => true);
    const res: any = await mergeItems.handler({ master_key: 'K1', duplicate_keys: ['D1'], dry_run: dryRun }, ctx);

    expect(ctx.web.writeItems).not.toHaveBeenCalled();
    const sc = res.structuredContent;
    if (!dryRun) expect(sc.applied.trashed).toEqual([]);
    expect(sc.plan.duplicatesToTrash).toEqual([]);
    expect(sc.failed.some((f: any) => /A9/.test(f.message ?? ''))).toBe(true);
    expect(sc.failed.some((f: any) => /does not have yet/.test(f.message ?? ''))).toBe(true);
  });

  it('does not ask the desktop at all when it does not serve this library', async () => {
    const ctx = makeCtx();
    aheadDesktop(ctx);
    const res: any = await mergeItems.handler({ master_key: 'K1', duplicate_keys: ['D1'], dry_run: false }, ctx);
    expect(ctx.router.getItemChildren).not.toHaveBeenCalled();
    expect(res.structuredContent.applied.trashed).toEqual(['D1']);
  });
});

describe('zotero_merge_items never replaces the master\'s creators', () => {
  const ADA = { creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' };
  const WRONG = { creatorType: 'author', firstName: 'Some', lastName: 'WRONG' };

  /** The PATCH body the master would receive, and the plan that produced it. */
  async function merged(edit: (items: Record<string, any>) => void): Promise<{ patch: any; sc: any }> {
    const ctx = makeCtx({}, edit);
    const res: any = await mergeItems.handler({ master_key: 'K1', duplicate_keys: ['D1'], dry_run: false }, ctx);
    return { patch: ctx.web.patchItem.mock.calls[0][2], sc: res.structuredContent };
  }

  it('keeps an author list the master already has, and sends no creators at all', async () => {
    const { patch, sc } = await merged((items) => {
      items.K1.data.creators = [ADA];
      items.D1.data.creators = [WRONG];
    });
    expect(patch.creators).toBeUndefined();
    expect(sc.plan.fields.creators).toBeUndefined();
    // Not an omission to be explained away either: nothing was "skipped", it was simply not
    // a field this merge may touch.
    expect(sc.plan.fieldsSkipped.some((f: any) => f.field === 'creators')).toBe(false);
  });

  it('fills the creators when the master has none', async () => {
    const { patch, sc } = await merged((items) => {
      items.D1.data.creators = [ADA];
    });
    expect(patch.creators).toEqual([ADA]);
    expect(sc.plan.fields.creators.after).toEqual([ADA]);
  });

  it('refuses a creator type the master\'s item type does not accept, and says which', async () => {
    const { patch, sc } = await merged((items) => {
      items.D1.data.creators = [{ creatorType: 'inventor', lastName: 'Edison' }];
    });
    expect(patch.creators).toBeUndefined();
    expect(sc.plan.fields.creators).toBeUndefined();
    expect(sc.plan.fieldsSkipped).toContainEqual({
      field: 'creators',
      from: 'D1',
      reason: expect.stringContaining('creator type "inventor" is not valid for itemType "journalArticle"'),
    });
  });

  it('does not even consider a bad creator type when the master already has creators', async () => {
    const { patch, sc } = await merged((items) => {
      items.K1.data.creators = [ADA];
      items.D1.data.creators = [{ creatorType: 'inventor', lastName: 'Edison' }];
    });
    expect(patch.creators).toBeUndefined();
    expect(sc.plan.fieldsSkipped.some((f: any) => f.field === 'creators')).toBe(false);
  });
});

describe('zotero_merge_items plan and failures agree', () => {
  it('does not plan a trashing the same answer reports as refused', async () => {
    const ctx = makeCtx();
    ctx.web.getItemChildren = vi.fn(async (_lib: any, key: string) => {
      if (key === 'D1') throw new ZoteroApiError({ status: 429, message: 'rate limited' });
      return { data: [], totalResults: 0, lastModifiedVersion: 1 };
    });
    const res: any = await mergeItems.handler({ master_key: 'K1', duplicate_keys: ['D1'] }, ctx);

    const sc = res.structuredContent;
    expect(sc.failed[0].message).toMatch(/left out of the trash/);
    expect(sc.plan.duplicatesToTrash).toEqual([]);
    expect(res.content[0].text).toMatch(/trash 0 item\(s\)/);
    // And the prose no longer stays silent about the failure it just recorded.
    expect(res.content[0].text).toMatch(/could not be planned in full/);
  });
});


describe('merge child safety', () => {
  it('reads every page before planning or moving children', async () => {
    const ctx = makeCtx();
    const children = Array.from({ length: 101 }, (_, i) => ({
      key: `N${i}`, version: 7,
      data: { key: `N${i}`, itemType: 'note', parentItem: 'D1' },
    }));
    ctx.web.getItemChildren = vi.fn(async (_lib: any, _key: string, query: any = {}) => ({
      data: query.limit === 1 ? [] : children.slice(query.start ?? 0, (query.start ?? 0) + (query.limit ?? 25)),
      totalResults: query.limit === 1 ? 0 : children.length, lastModifiedVersion: 1,
    }));
    ctx.web.patchItem = vi.fn(async () => 11);
    const preview: any = await mergeItems.handler({ master_key: 'K1', duplicate_keys: ['D1'] }, ctx);
    expect(preview.structuredContent.plan.childrenToMove).toHaveLength(101);
    const result: any = await mergeItems.handler({ master_key: 'K1', duplicate_keys: ['D1'], dry_run: false }, ctx);
    expect(result.structuredContent.applied.childrenMoved).toHaveLength(101);
    expect(result.structuredContent.applied.trashed).toEqual(['D1']);
  });

  it('preserves a child concurrently moved to a different parent', async () => {
    const ctx = makeCtx();
    ctx.web.patchItem = vi.fn(async (_lib: any, key: string) => {
      if (key === 'C1') throw new ZoteroApiError({ status: 412, message: 'changed' });
      return 11;
    });
    const originalGet = ctx.web.getItem;
    ctx.web.getItem = vi.fn(async (lib: any, key: string) => key === 'C1'
      ? { key: 'C1', version: 8, data: { key: 'C1', itemType: 'note', parentItem: 'OTHER' } }
      : originalGet(lib, key));
    const result: any = await mergeItems.handler({ master_key: 'K1', duplicate_keys: ['D1'], dry_run: false }, ctx);
    expect(ctx.web.patchItem.mock.calls.filter((call: any[]) => call[1] === 'C1')).toHaveLength(1);
    expect(result.structuredContent.applied.trashed).toEqual([]);
    expect(result.structuredContent.failed[0].message).toMatch(/parent|moved/);
  });
});


it('refuses to trash a duplicate when a new child appeared after the planned moves', async () => {
  const ctx = makeCtx();
  const read = ctx.web.getItemChildren;
  ctx.web.getItemChildren = vi.fn(async (lib: any, key: string, query: any) => query?.limit === 1
    ? { data: [{ key: 'NEWCHILD', version: 15, data: { itemType: 'note', parentItem: key } }], totalResults: 1, lastModifiedVersion: 15 }
    : read(lib, key, query));
  const result: any = await mergeItems.handler({ master_key: 'K1', duplicate_keys: ['D1'], dry_run: false }, ctx);
  expect(ctx.web.writeItems).not.toHaveBeenCalled();
  expect(result.structuredContent.applied.trashed).toEqual([]);
  expect(result.structuredContent.failed[0].message).toMatch(/Child items remain or appeared/);
});


it.each(['note', 'attachment', 'annotation'])('refuses to merge %s content that field merging cannot preserve', async (itemType) => {
  for (const key of ['K1', 'D1']) {
    const ctx = makeCtx({}, (items) => { items[key].data.itemType = itemType; });
    const result = await mergeItems.handler({ master_key: 'K1', duplicate_keys: ['D1'], dry_run: false }, ctx);
    expect(result.isError).toBe(true);
    expect(ctx.web.patchItem).not.toHaveBeenCalled();
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
  }
});
