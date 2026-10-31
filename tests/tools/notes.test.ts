import { describe, it, expect, vi } from 'vitest';
import createNote from '../../src/tools/create-note.js';
import appendToNote from '../../src/tools/append-to-note.js';
import replaceNote from '../../src/tools/replace-note.js';
import { ZoteroApiError } from '../../src/api/errors.js';

/**
 * zotero_create_note, zotero_append_to_note and zotero_replace_note against a faked desktop
 * app and cloud, shaped like desktop-writes.test.ts: the personal library is users/0 with no
 * key, and the desktop's versions are its own.
 */

const ME = { type: 'user', id: 0 };

const written = (key: string, version = 51) => ({
  successful: [{ index: 0, key, version }],
  unchanged: [],
  failed: [],
  newLibraryVersion: version,
});

const paper = (key: string) => ({
  key,
  version: 12,
  library: { type: 'user', id: 19552201 },
  data: {
    key,
    itemType: 'journalArticle',
    title: 'Kalman filters',
    date: '2019',
    creators: [{ creatorType: 'author', lastName: 'Smith', firstName: 'Ada' }],
  },
  csljson: JSON.stringify([{ id: `19552201/${key}`, type: 'article-journal', title: 'Kalman filters', author: [{ family: 'Smith', given: 'Ada' }], issued: { 'date-parts': [[2019]] } }]),
});

const noteRecord = (key: string, note: string, version = 40) => ({ key, version, data: { key, version, itemType: 'note', note } });

function ctxWith(items: Record<string, any>, opts: { cloud?: boolean; desktop?: boolean } = {}): any {
  const desktop = opts.desktop ?? true;
  const lookup = async (key: string) => {
    const item = items[key];
    if (!item) throw Object.assign(new Error(`Local API 404 for /users/0/items/${key}`), { status: 404 });
    return item;
  };
  return {
    config: {},
    capabilities: {
      cloud: opts.cloud ? { userID: 19552201, username: 'oscardvs', access: { user: { write: true } } } : null,
      localApi: desktop,
    },
    router: {
      defaultLibrary: () => (opts.cloud ? { type: 'user', id: 19552201 } : ME),
      getItem: vi.fn(async (key: string) => lookup(key)),
    },
    local: {
      ping: vi.fn(async () => desktop),
      getItem: vi.fn(async (key: string) => lookup(key)),
    },
    localWrites: {
      writeItems: vi.fn(async () => written('NOTE0001')),
      patchItem: vi.fn(async () => 41),
    },
    web: {
      getItem: vi.fn(async (_lib: unknown, key: string) => lookup(key)),
      writeItems: vi.fn(async () => written('CLOUDNTE', 8)),
      patchItem: vi.fn(async () => 9),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

const text = (res: any) => (res.content ?? []).map((c: { text: string }) => c.text).join('\n');
const sentNote = (ctx: any) => ctx.localWrites.writeItems.mock.calls[0][0][0];

describe('zotero_create_note', () => {
  it('writes a standalone note from Markdown through the desktop app', async () => {
    const ctx = ctxWith({});
    const res = await createNote.handler(
      { markdown: '## Method\n\n- **Kalman** filter\n- particle filter', collections: ['THESIS01'], tags: ['lit-note'] },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const [[objects, lib]] = ctx.localWrites.writeItems.mock.calls;
    expect(lib).toEqual(ME);
    expect(objects).toEqual([
      {
        itemType: 'note',
        note: '<div data-schema-version="9"><h2>Method</h2>\n<ul>\n<li><strong>Kalman</strong> filter</li>\n<li>particle filter</li>\n</ul>\n</div>',
        tags: [{ tag: 'lit-note' }],
        collections: ['THESIS01'],
      },
    ]);
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
    expect(res.structuredContent).toMatchObject({ key: 'NOTE0001', version: 51, citations: 0, target: 'local' });
    expect(text(res)).toMatch(/Created note NOTE0001 via the Zotero desktop app\./);
  });

  it('attaches a child note under a regular item, checked on the copy the write goes to', async () => {
    const ctx = ctxWith({ PAPER001: paper('PAPER001') });
    const res = await createNote.handler({ markdown: 'Notes on it.', parent_item: 'PAPER001', title: 'Reading notes' }, ctx);
    expect(res.isError).toBeUndefined();
    expect(ctx.local.getItem).toHaveBeenCalledWith('PAPER001', {}, ME);
    expect(sentNote(ctx)).toMatchObject({ parentItem: 'PAPER001', note: '<div data-schema-version="9"><h1>Reading notes</h1>\n<p>Notes on it.</p>\n</div>' });
    expect(res.structuredContent).toMatchObject({ parentItem: 'PAPER001' });
  });

  it('refuses a parent Zotero would refuse, and writes nothing', async () => {
    const ctx = ctxWith({ PDF00001: { key: 'PDF00001', version: 3, data: { itemType: 'attachment', parentItem: 'PAPER001' } } });
    const res = await createNote.handler({ markdown: 'x', parent_item: 'PDF00001' }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/only lets a note hang under a regular item.*Use its parent item, PAPER001/);
    expect(ctx.localWrites.writeItems).not.toHaveBeenCalled();
  });

  it('refuses collections on a child note before reading anything', async () => {
    const ctx = ctxWith({});
    const res = await createNote.handler({ markdown: 'x', parent_item: 'PAPER001', collections: ['C1'] }, ctx);
    expect(res.isError).toBe(true);
    expect(ctx.local.getItem).not.toHaveBeenCalled();
  });

  it('turns [@KEY] into a Zotero citation and stores the item\'s CSL-JSON on the note', async () => {
    const ctx = ctxWith({ PAPER001: paper('PAPER001') });
    const res = await createNote.handler({ markdown: 'Filters drift [@PAPER001, p. 4].' }, ctx);
    expect(res.isError).toBeUndefined();
    expect(ctx.router.getItem).toHaveBeenCalledWith('PAPER001', { library: ME, include: 'data,csljson' });
    const note: string = sentNote(ctx).note;
    const citation = JSON.parse(decodeURIComponent(/data-citation="([^"]+)"/.exec(note)![1]!));
    expect(citation).toEqual({ citationItems: [{ uris: ['http://zotero.org/users/19552201/items/PAPER001'], locator: '4' }], properties: {} });
    expect(note).toMatch(/\(<span class="citation-item">Smith, 2019, p\. 4<\/span>\)<\/span>\.<\/p>/);
    const stored = JSON.parse(decodeURIComponent(/data-citation-items="([^"]+)"/.exec(note)![1]!));
    expect(stored).toEqual([{ uris: ['http://zotero.org/users/19552201/items/PAPER001'], itemData: expect.objectContaining({ title: 'Kalman filters' }) }]);
    expect(res.structuredContent).toMatchObject({ citations: 1 });
  });

  it('refuses a citation that names nothing, or names an attachment, and writes nothing', async () => {
    const ctx = ctxWith({ PDF00001: { key: 'PDF00001', version: 3, data: { itemType: 'attachment', parentItem: 'PAPER001' } } });
    const res = await createNote.handler({ markdown: 'See [@NOPE2345] and [@PDF00001].' }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/\[@NOPE2345\] does not name an item/);
    expect(text(res)).toMatch(/\[@PDF00001\] is an attachment.*Cite its parent item, PAPER001/);
    expect(ctx.localWrites.writeItems).not.toHaveBeenCalled();
  });

  it('leaves [@KEY] as text with cite:false, and reads nothing for it', async () => {
    const ctx = ctxWith({});
    await createNote.handler({ markdown: 'See [@PAPER001].', cite: false }, ctx);
    expect(ctx.router.getItem).not.toHaveBeenCalled();
    expect(sentNote(ctx).note).toBe('<div data-schema-version="9"><p>See [@PAPER001].</p>\n</div>');
  });

  it('writes through the cloud when the desktop app is not running', async () => {
    const ctx = ctxWith({}, { cloud: true, desktop: false });
    const res = await createNote.handler({ markdown: 'x' }, ctx);
    expect(ctx.web.writeItems).toHaveBeenCalledWith({ type: 'user', id: 19552201 }, [expect.objectContaining({ itemType: 'note' })]);
    expect(ctx.localWrites.writeItems).not.toHaveBeenCalled();
    expect(res.structuredContent).toMatchObject({ key: 'CLOUDNTE', target: 'cloud' });
  });

  it('reports a note Zotero refused as an error, not as created', async () => {
    const ctx = ctxWith({});
    ctx.localWrites.writeItems = vi.fn(async () => ({ successful: [], unchanged: [], failed: [{ index: 0, code: 413, message: 'Note too long' }] }));
    const res = await createNote.handler({ markdown: 'x' }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Nothing succeeded: Note too long/);
  });

  it('refuses an empty note', async () => {
    const res = await createNote.handler({ markdown: '  \n' }, ctxWith({}));
    expect(res.isError).toBe(true);
  });
});

describe('zotero_append_to_note', () => {
  const existing = '<div data-schema-version="9"><h1>Reading</h1>\n<p>First thought.</p>\n</div>';

  it('appends inside the note\'s container at the version the desktop reported', async () => {
    const ctx = ctxWith({ NOTE0001: noteRecord('NOTE0001', existing, 40) });
    const res = await appendToNote.handler({ note_key: 'NOTE0001', markdown: 'Second *thought*.' }, ctx);
    expect(res.isError).toBeUndefined();
    expect(ctx.localWrites.patchItem).toHaveBeenCalledWith(
      'NOTE0001',
      { note: '<div data-schema-version="9"><h1>Reading</h1>\n<p>First thought.</p>\n<p>Second <em>thought</em>.</p>\n</div>' },
      40,
      ME,
    );
    expect(res.structuredContent).toMatchObject({ note_key: 'NOTE0001', newVersion: 41, citations: 0, target: 'local' });
  });

  it('re-reads after a version conflict and appends to the fresh copy, keeping what the other writer added', async () => {
    const fresh = '<div data-schema-version="9"><h1>Reading</h1>\n<p>First thought.</p>\n<p>Added in Zotero meanwhile.</p>\n</div>';
    const ctx = ctxWith({ NOTE0001: noteRecord('NOTE0001', existing, 40) });
    ctx.local.getItem = vi
      .fn()
      .mockResolvedValueOnce(noteRecord('NOTE0001', existing, 40))
      .mockResolvedValueOnce(noteRecord('NOTE0001', fresh, 44));
    ctx.localWrites.patchItem = vi
      .fn()
      .mockRejectedValueOnce(new ZoteroApiError({ status: 412, message: 'Item has been modified since specified version' }))
      .mockResolvedValueOnce(45);
    const res = await appendToNote.handler({ note_key: 'NOTE0001', markdown: 'Second thought.' }, ctx);
    expect(res.isError).toBeUndefined();
    const [, [, patch, version]] = ctx.localWrites.patchItem.mock.calls;
    expect(version).toBe(44);
    expect(patch.note).toMatch(/Added in Zotero meanwhile\.<\/p>\n<p>Second thought\.<\/p>\n<\/div>$/);
    expect(res.structuredContent).toMatchObject({ newVersion: 45, retried: true });
  });

  it('refuses an item that is not a note', async () => {
    const ctx = ctxWith({ PAPER001: paper('PAPER001') });
    const res = await appendToNote.handler({ note_key: 'PAPER001', markdown: 'x' }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/is a journalArticle, not a note/);
    expect(ctx.localWrites.patchItem).not.toHaveBeenCalled();
  });

  it('merges a new citation into the note\'s stored items', async () => {
    const ctx = ctxWith({ NOTE0001: noteRecord('NOTE0001', existing), PAPER001: paper('PAPER001') });
    await appendToNote.handler({ note_key: 'NOTE0001', markdown: 'As shown [@PAPER001].' }, ctx);
    const note: string = ctx.localWrites.patchItem.mock.calls[0][1].note;
    expect(note).toMatch(/^<div data-citation-items="[^"]+" data-schema-version="9"><h1>Reading<\/h1>/);
    expect(note).toMatch(/class="citation-item">Smith, 2019</);
  });
});

describe('zotero_replace_note', () => {
  const existing = '<div data-schema-version="9"><p>Old text.</p>\n</div>';

  it('replaces the note and hands back what it held', async () => {
    const ctx = ctxWith({ NOTE0001: noteRecord('NOTE0001', existing, 40) });
    const res = await replaceNote.handler({ note_key: 'NOTE0001', markdown: 'New text.', title: 'Summary' }, ctx);
    expect(res.isError).toBeUndefined();
    expect(ctx.localWrites.patchItem).toHaveBeenCalledWith(
      'NOTE0001',
      { note: '<div data-schema-version="9"><h1>Summary</h1>\n<p>New text.</p>\n</div>' },
      40,
      ME,
    );
    expect(res.structuredContent).toMatchObject({ note_key: 'NOTE0001', newVersion: 41, previousNote: existing });
  });

  it('refuses when a pinned version is stale, and writes nothing', async () => {
    const ctx = ctxWith({ NOTE0001: noteRecord('NOTE0001', existing, 44) });
    const res = await replaceNote.handler({ note_key: 'NOTE0001', markdown: 'New.', version: 40 }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/changed since version 40 \(it is at 44 now\)/);
    expect(ctx.localWrites.patchItem).not.toHaveBeenCalled();
  });

  it('does not retry a pinned version that conflicts at write time', async () => {
    const ctx = ctxWith({ NOTE0001: noteRecord('NOTE0001', existing, 40) });
    ctx.localWrites.patchItem = vi.fn().mockRejectedValue(new ZoteroApiError({ status: 412, message: 'modified' }));
    const res = await replaceNote.handler({ note_key: 'NOTE0001', markdown: 'New.', version: 40 }, ctx);
    expect(res.isError).toBe(true);
    expect(ctx.localWrites.patchItem).toHaveBeenCalledTimes(1);
  });

  it('refuses to replace a note with nothing', async () => {
    const res = await replaceNote.handler({ note_key: 'NOTE0001', markdown: ' ' }, ctxWith({}));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/zotero_trash_items/);
  });
});

describe('note tool annotations', () => {
  it('marks create and append additive, and replace destructive', () => {
    expect(createNote.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(appendToNote.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(replaceNote.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
  });

  it('takes no action enum: one tool per operation', () => {
    for (const t of [createNote, appendToNote, replaceNote]) expect(t.inputSchema).not.toHaveProperty('action');
  });
});
