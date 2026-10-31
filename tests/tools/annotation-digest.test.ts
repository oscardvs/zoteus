import { describe, it, expect, vi } from 'vitest';
import annotationDigest from '../../src/tools/annotation-digest.js';
import saveAnnotationDigest from '../../src/tools/save-annotation-digest.js';

/**
 * zotero_annotation_digest (read-only) and zotero_save_annotation_digest (writes one note)
 * against a faked library: PAPER001 has a stored PDF and a linked URL, PAPER002 an EPUB,
 * STANDPDF is a PDF filed at the top level, and NOTE0001 is a standalone note.
 */

const ME = { type: 'user', id: 0 };

const paper = (key: string, title: string, family: string) => ({
  key,
  version: 10,
  library: { type: 'user', id: 19552201 },
  data: { key, itemType: 'journalArticle', title, date: '2019', creators: [{ creatorType: 'author', lastName: family, firstName: 'A' }] },
});

const att = (key: string, parentItem: string | undefined, contentType: string, linkMode = 'imported_file', extra: Record<string, unknown> = {}) => ({
  key,
  data: { key, itemType: 'attachment', title: `${key}.file`, contentType, linkMode, ...(parentItem ? { parentItem } : {}), ...extra },
});

const ann = (key: string, parentItem: string, fields: Record<string, unknown>) => ({
  key,
  data: { key, itemType: 'annotation', parentItem, tags: [], ...fields },
});

const LIBRARY: Record<string, any> = {
  PAPER001: paper('PAPER001', 'Kalman filters', 'Smith'),
  PAPER002: paper('PAPER002', 'Particle filters', 'Jones'),
  STANDPDF: { key: 'STANDPDF', version: 3, library: { type: 'user', id: 19552201 }, data: { key: 'STANDPDF', itemType: 'attachment', title: 'Loose scan', contentType: 'application/pdf', linkMode: 'imported_file', collections: ['READING1'] } },
  NOTE0001: { key: 'NOTE0001', version: 4, data: { key: 'NOTE0001', itemType: 'note', note: '<p>x</p>' } },
};

const CHILDREN: Record<string, any[]> = {
  PAPER001: [att('PDF00001', 'PAPER001', 'application/pdf'), att('LINK0001', 'PAPER001', 'text/html', 'linked_url'), { key: 'CNOTE001', data: { itemType: 'note' } }],
  PAPER002: [att('EPUB0001', 'PAPER002', 'application/epub+zip')],
};

const ANNOTATIONS: Record<string, any[]> = {
  // Out of reading order on purpose: the digest sorts by annotationSortIndex.
  PDF00001: [
    ann('ANN00002', 'PDF00001', { annotationType: 'note', annotationComment: 'Check the noise model.', annotationColor: '#2ea8e5', annotationPageLabel: '5', annotationSortIndex: '00004|000000|00100' }),
    ann('ANN00001', 'PDF00001', {
      annotationType: 'highlight',
      annotationText: 'The filter is optimal for <i>linear</i> systems.',
      annotationComment: 'Only under Gaussian noise.',
      annotationColor: '#FFD400',
      annotationPageLabel: '4',
      annotationSortIndex: '00003|000120|00200',
      annotationPosition: '{"pageIndex":3,"rects":[[10,20,30,40]]}',
      tags: [{ tag: 'Key-Claim' }],
    }),
    ann('ANN00003', 'PDF00001', { annotationType: 'underline', annotationText: 'Divergence follows.', annotationColor: '#ff6666', annotationPageLabel: '9', annotationSortIndex: '00008|000000|00300' }),
  ],
  EPUB0001: [ann('ANN00004', 'EPUB0001', { annotationType: 'highlight', annotationText: 'Resampling.', annotationColor: '#5fb236', annotationPageLabel: '2', annotationSortIndex: '1' })],
  STANDPDF: [ann('ANN00005', 'STANDPDF', { annotationType: 'highlight', annotationText: 'Scanned claim.', annotationColor: '#ffd400', annotationPageLabel: '1', annotationSortIndex: '0' })],
};

function ctxWith(opts: { collectionItems?: string[]; total?: number } = {}): any {
  const notFound = (key: string) => Object.assign(new Error(`Local API 404 for ${key}`), { status: 404 });
  return {
    config: {},
    capabilities: { cloud: null, localApi: true },
    router: {
      defaultLibrary: () => ME,
      getItem: vi.fn(async (key: string) => {
        if (!LIBRARY[key]) throw notFound(key);
        return LIBRARY[key];
      }),
      getItemChildren: vi.fn(async (key: string, q: any) => {
        const all = q?.itemType === 'annotation' ? (ANNOTATIONS[key] ?? []) : (CHILDREN[key] ?? []);
        const start = q?.start ?? 0;
        return { data: all.slice(start, start + (q?.limit ?? 100)), totalResults: all.length };
      }),
      getCollection: vi.fn(async (key: string) => (key === 'READING1' ? { key, data: { key, name: 'Reading group' } } : null)),
      searchItems: vi.fn(async (q: any) => {
        const keys = opts.collectionItems ?? [];
        const page = keys.slice(q.start ?? 0, (q.start ?? 0) + (q.limit ?? 25)).map((k) => LIBRARY[k]);
        return { data: page, totalResults: opts.total ?? keys.length };
      }),
    },
    local: { ping: vi.fn(async () => true), getItem: vi.fn(async (key: string) => LIBRARY[key]) },
    localWrites: {
      writeItems: vi.fn(async () => ({ successful: [{ index: 0, key: 'DIGEST01', version: 60 }], unchanged: [], failed: [], newLibraryVersion: 60 })),
    },
    web: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

const text = (res: any) => (res.content ?? []).map((c: { text: string }) => c.text).join('\n');

describe('zotero_annotation_digest', () => {
  it('lists one paper\'s annotations in reading order, with colour names and its citation', async () => {
    const ctx = ctxWith();
    const res = await annotationDigest.handler({ item_key: 'PAPER001' }, ctx);
    expect(res.isError).toBeUndefined();
    const out = res.structuredContent as any;
    expect(out).toMatchObject({ scope: 'item PAPER001', annotations: 3, itemsScanned: 1 });
    expect(out.provenance).toMatchObject({ trust: 'untrusted' });
    const [item] = out.items;
    expect(item).toMatchObject({ key: 'PAPER001', title: 'Kalman filters', citation: 'Smith, 2019', attachments: [{ key: 'PDF00001', annotations: 3 }] });
    expect(item.annotations.map((a: any) => a.key)).toEqual(['ANN00001', 'ANN00002', 'ANN00003']);
    expect(item.annotations[0]).toEqual({
      key: 'ANN00001',
      type: 'highlight',
      color: '#ffd400',
      colorName: 'yellow',
      pageLabel: '4',
      text: 'The filter is optimal for <i>linear</i> systems.',
      comment: 'Only under Gaussian noise.',
      tags: ['Key-Claim'],
      attachment: 'PDF00001',
    });
    // The linked URL is not annotatable, so it is never asked for annotations.
    expect(ctx.router.getItemChildren).not.toHaveBeenCalledWith('LINK0001', expect.anything());
    expect(text(res)).toMatch(/^3 annotation\(s\) on item PAPER001\./);
  });

  it('filters by type, colour name and tag', async () => {
    const byColour = await annotationDigest.handler({ item_key: 'PAPER001', colors: ['Yellow', '#ff6666'] }, ctxWith());
    expect((byColour.structuredContent as any).items[0].annotations.map((a: any) => a.key)).toEqual(['ANN00001', 'ANN00003']);
    const byType = await annotationDigest.handler({ item_key: 'PAPER001', types: ['note'] }, ctxWith());
    expect((byType.structuredContent as any).items[0].annotations.map((a: any) => a.key)).toEqual(['ANN00002']);
    const byTag = await annotationDigest.handler({ item_key: 'PAPER001', tags: ['key-claim'] }, ctxWith());
    expect((byTag.structuredContent as any).annotations).toBe(1);
  });

  it('reads a standalone PDF as its own annotations', async () => {
    const res = await annotationDigest.handler({ item_key: 'STANDPDF' }, ctxWith());
    expect((res.structuredContent as any).items[0]).toMatchObject({ key: 'STANDPDF', citation: 'Loose scan', attachments: [{ key: 'STANDPDF' }] });
  });

  it('pages through a collection by title and says where the next page starts', async () => {
    const ctx = ctxWith({ collectionItems: ['PAPER001', 'NOTE0001', 'PAPER002'] });
    const res = await annotationDigest.handler({ collection_key: 'READING1', limit: 2 }, ctx);
    expect(ctx.router.searchItems).toHaveBeenCalledWith(
      expect.objectContaining({ library: ME, collectionKey: 'READING1', top: true, sort: 'title', start: 0, limit: 2 }),
    );
    expect(res.structuredContent).toMatchObject({
      scope: 'collection READING1',
      collection: { key: 'READING1', name: 'Reading group' },
      itemsScanned: 2,
      totalItems: 3,
      nextStart: 2,
    });
    expect((res.structuredContent as any).items.map((i: any) => i.key)).toEqual(['PAPER001']);
    expect(text(res)).toMatch(/call again with start:2/);

    const last = await annotationDigest.handler({ collection_key: 'READING1', limit: 2, start: 2 }, ctx);
    expect(last.structuredContent).not.toHaveProperty('nextStart');
    expect((last.structuredContent as any).items.map((i: any) => i.key)).toEqual(['PAPER002']);
  });

  it('refuses an unknown collection, a note, and an ambiguous scope', async () => {
    expect((await annotationDigest.handler({ collection_key: 'NOPE0000' }, ctxWith())).isError).toBe(true);
    const note = await annotationDigest.handler({ item_key: 'NOTE0001' }, ctxWith());
    expect(text(note)).toMatch(/is a note; annotations hang off a paper/);
    expect((await annotationDigest.handler({ item_key: 'A', collection_key: 'B' }, ctxWith())).isError).toBe(true);
    expect((await annotationDigest.handler({}, ctxWith())).isError).toBe(true);
  });

  it('answers a paper with no annotations without an error', async () => {
    const res = await annotationDigest.handler({ item_key: 'PAPER001', tags: ['absent'] }, ctxWith());
    expect(res.isError).toBeUndefined();
    expect(text(res)).toMatch(/^No matching annotations on item PAPER001\./);
  });

  it('is read-only, so read-only mode keeps it and clients may run it unasked', () => {
    expect(annotationDigest.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });
});

describe('zotero_save_annotation_digest', () => {
  const noteOf = (ctx: any) => ctx.localWrites.writeItems.mock.calls[0][0][0];

  it('saves one paper\'s annotations as a child note laid out like Zotero\'s own', async () => {
    const ctx = ctxWith();
    const res = await saveAnnotationDigest.handler({ item_key: 'PAPER001', title: 'Annotations', note_tags: ['digest'] }, ctx);
    expect(res.isError).toBeUndefined();
    expect(ctx.router.getItem).toHaveBeenCalledWith('PAPER001', { library: ME, include: 'data,csljson' });
    const note = noteOf(ctx);
    expect(note).toMatchObject({ itemType: 'note', parentItem: 'PAPER001', tags: [{ tag: 'digest' }] });
    const html: string = note.note;
    // Underline annotations need schema 10, exactly as Zotero stamps them.
    expect(html).toMatch(/^<div data-citation-items="[^"]+" data-schema-version="10"><h1>Annotations<\/h1>/);
    expect(html).not.toMatch(/<h2>/);
    // The highlight carries what Zotero needs to open the PDF at it.
    const stored = JSON.parse(decodeURIComponent(/<span class="highlight" data-annotation="([^"]+)">/.exec(html)![1]!));
    expect(stored).toEqual({
      attachmentURI: 'http://zotero.org/users/19552201/items/PDF00001',
      annotationKey: 'ANN00001',
      color: '#ffd400',
      pageLabel: '4',
      position: { pageIndex: 3, rects: [[10, 20, 30, 40]] },
      citationItem: { uris: ['http://zotero.org/users/19552201/items/PAPER001'], locator: '4' },
    });
    expect(html).toContain('\u201cThe filter is optimal for <i>linear</i> systems.\u201d</span> <span class="citation"');
    expect(html).toContain('(<span class="citation-item">Smith, 2019, p. 4</span>)</span> Only under Gaussian noise.<br>Tags: Key-Claim</p>');
    expect(html).toContain('<p><span class="citation"');
    expect(html).toContain('<span class="underline" data-annotation=');
    expect(res.structuredContent).toMatchObject({ key: 'DIGEST01', parentItem: 'PAPER001', items: 1, annotations: 3, target: 'local' });
  });

  it('files a collection digest in the collection, with a heading per paper', async () => {
    const ctx = ctxWith({ collectionItems: ['PAPER001', 'NOTE0001', 'PAPER002'] });
    const res = await saveAnnotationDigest.handler({ collection_key: 'READING1', types: ['highlight'] }, ctx);
    expect(res.isError).toBeUndefined();
    const note = noteOf(ctx);
    expect(note.parentItem).toBeUndefined();
    expect(note.collections).toEqual(['READING1']);
    expect(note.note).toMatch(/<h1>Annotations: Reading group \(\d{4}-\d{2}-\d{2}\)<\/h1>\n<h2>Kalman filters<\/h2>/);
    expect(note.note).toMatch(/<h2>Particle filters<\/h2>/);
    expect(note.note).toMatch(/data-schema-version="9"/);
    expect(res.structuredContent).toMatchObject({ items: 2, annotations: 2, collections: ['READING1'] });
  });

  it('files a standalone PDF\'s digest beside it, since Zotero gives an attachment no child notes', async () => {
    const ctx = ctxWith();
    await saveAnnotationDigest.handler({ item_key: 'STANDPDF' }, ctx);
    const note = noteOf(ctx);
    expect(note.parentItem).toBeUndefined();
    expect(note.collections).toEqual(['READING1']);
    expect(note.note).toMatch(/<h3>Loose scan<\/h3>/);
  });

  it('writes nothing when no annotation matches', async () => {
    const ctx = ctxWith();
    const res = await saveAnnotationDigest.handler({ item_key: 'PAPER001', colors: ['purple'] }, ctx);
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/No matching annotations on item PAPER001, so no note was written/);
    expect(ctx.localWrites.writeItems).not.toHaveBeenCalled();
  });

  it('says so in the note and the result when a collection is past the cap', async () => {
    const keys = Array.from({ length: 250 }, (_, i) => (i === 0 ? 'PAPER001' : 'NOTE0001'));
    const ctx = ctxWith({ collectionItems: keys });
    const res = await saveAnnotationDigest.handler({ collection_key: 'READING1' }, ctx);
    expect(res.structuredContent).toMatchObject({ truncated: true });
    expect(noteOf(ctx).note).toMatch(/covers the first 200 of 250 items/);
    expect(ctx.router.searchItems).toHaveBeenCalledTimes(2);
  });

  it('is a non-destructive write', () => {
    expect(saveAnnotationDigest.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });
});
