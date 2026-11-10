import { describe, it, expect, vi } from 'vitest';
import saveExtraction from '../../src/tools/save-extraction.js';
import extractionTable from '../../src/tools/extraction-table.js';
import { EXTRACTION_TAG, extractionNoteHtml, parseExtractionNote, type Extraction } from '../../src/features/extraction/record.js';
import { checkQuote, quoteOccurs, normalizeForMatch } from '../../src/features/extraction/quote-check.js';
import { mergeFields } from '../../src/features/extraction/merge.js';
import { ZoteroApiError } from '../../src/api/errors.js';

const ME = { type: 'user', id: 0 };
const GROUP = { type: 'group', id: 5234875 };

const FULLTEXT =
  'Methods. We randomised 120 partici-\npants across four sites in Kenya. The ﬁnal sample was analysed using “intention to treat”. Results follow.';

const paper = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  version: 12,
  library: { type: 'user', id: 19552201 },
  data: { key, itemType: 'journalArticle', title: `Paper ${key}`, date: '2019-05-01', creators: [{ creatorType: 'author', lastName: 'Smith' }], ...extra },
});

const pdf = (key: string, parent: string) => ({ key, version: 3, data: { key, itemType: 'attachment', parentItem: parent, contentType: 'application/pdf', filename: 'p.pdf' } });

const written = (key: string, version = 51) => ({ successful: [{ index: 0, key, version }], unchanged: [], failed: [], newLibraryVersion: version });

function ctxWith(opts: { items?: Record<string, any>; children?: Record<string, any[]>; fulltext?: Record<string, string | null>; desktop?: boolean; cloud?: boolean; groups?: number[] } = {}): any {
  const items = opts.items ?? {};
  const children = opts.children ?? {};
  const desktop = opts.desktop ?? true;
  const lookup = async (key: string) => {
    const item = items[key];
    if (!item) throw Object.assign(new Error(`Local API 404 for /users/0/items/${key}`), { status: 404 });
    return item;
  };
  const kids = async (key: string) => ({ data: children[key] ?? [], totalResults: (children[key] ?? []).length });
  return {
    config: {},
    capabilities: {
      cloud: opts.cloud ? { userID: 19552201, username: 'u', access: { user: { write: true }, groups: { all: { library: true, write: true } } } } : null,
      localApi: desktop,
      localGroupIds: opts.groups ?? [],
    },
    router: {
      defaultLibrary: () => ME,
      getItem: vi.fn(async (key: string) => lookup(key)),
      getItemChildren: vi.fn(async (key: string) => kids(key)),
      getFullText: vi.fn(async (key: string) => {
        const t = opts.fulltext?.[key];
        return t ? { content: t } : null;
      }),
      searchItems: vi.fn(async () => ({ data: [], totalResults: 0 })),
    },
    local: {
      ping: vi.fn(async () => desktop),
      getItem: vi.fn(async (key: string) => lookup(key)),
      getItemChildren: vi.fn(async (key: string) => kids(key)),
    },
    localWrites: {
      writeItems: vi.fn(async () => written('NOTE0001')),
      patchItem: vi.fn(async () => 41),
    },
    web: {
      getItem: vi.fn(async (_lib: unknown, key: string) => lookup(key)),
      getItemChildren: vi.fn(async (_lib: unknown, key: string) => kids(key)),
      writeItems: vi.fn(async () => written('CLOUDNTE', 8)),
      patchItem: vi.fn(async () => 9),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

const text = (res: any) => (res.content ?? []).map((c: { text: string }) => c.text).join('\n');

const sample: Extraction = {
  schema: 'rct-review',
  itemKey: 'PAPER001',
  updated: '2026-11-10T10:00:00.000Z',
  fields: [
    { name: 'sample_size', value: 120, quote: 'We randomised 120 participants', page: '3', check: 'verified', checkNote: 'checked against the zotero index text' },
    { name: 'country', value: 'Kenya & <Uganda> "east"' },
    { name: 'blinded', value: false },
  ],
};

describe('extraction note format', () => {
  it('round-trips through the note HTML, special characters included', () => {
    const html = extractionNoteHtml(sample);
    expect(html).toMatch(/^<div data-schema-version="9"><h1>Extraction: rct-review<\/h1>/);
    expect(html).toContain('<table>');
    expect(html).toContain('<td>Kenya &amp; &lt;Uganda&gt; "east"</td>');
    expect(parseExtractionNote(html)).toEqual(sample);
  });

  it('survives the note editor wrapping the block in <code> and turning newlines into <br>', () => {
    const html = extractionNoteHtml(sample).replace(/<pre>([\s\S]*?)<\/pre>/, (_m, inner: string) => `<pre><code>${inner.replace(/\n/g, '<br>')}</code></pre>`);
    expect(parseExtractionNote(html)).toEqual(sample);
  });

  it('ignores a code block that is not ours, and a damaged one', () => {
    expect(parseExtractionNote('<div><pre>{"schema":"x","fields":[]}</pre></div>')).toBeNull();
    expect(parseExtractionNote(extractionNoteHtml(sample).replace('"fields"', '"fie'))).toBeNull();
  });
});

describe('quote check', () => {
  const norm = normalizeForMatch(FULLTEXT);
  it('matches through hyphenation, ligatures, typographic quotes and case', () => {
    expect(quoteOccurs('randomised 120 participants', norm).found).toBe(true);
    expect(quoteOccurs('The final sample was analysed using "intention to treat"', norm).found).toBe(true);
  });
  it('matches an elided quote fragment by fragment, in order only', () => {
    expect(quoteOccurs('We randomised 120 ... in Kenya', norm).found).toBe(true);
    expect(quoteOccurs('in Kenya … We randomised 120', norm).found).toBe(false);
  });
  it('does not match words the text does not hold', () => {
    expect(quoteOccurs('We randomised 240 participants', norm).found).toBe(false);
  });
  it('leaves a too-short quote unchecked and finds the page when pages are known', () => {
    expect(checkQuote('120', { text: FULLTEXT, source: 'PDF' }).check).toBe('unchecked');
    const verdict = checkQuote('four sites in Kenya', { text: 'a\nb', pages: ['intro text', 'across four sites in Kenya'], source: 'PDF' }, { text: 'across four sites in kenya' });
    expect(verdict).toMatchObject({ check: 'verified', foundPage: 2 });
  });
});

describe('mergeFields', () => {
  it('replaces in place, appends new, removes on null, keeps the rest', () => {
    const m = mergeFields(sample.fields, [{ name: 'country', value: 'Kenya' }, { name: 'outcome', value: 'mortality' }], ['blinded'], false);
    expect(m.fields.map((f) => f.name)).toEqual(['sample_size', 'country', 'outcome']);
    expect(m.replaced).toEqual([{ name: 'country', previous: 'Kenya & <Uganda> "east"', value: 'Kenya' }]);
    expect(m.removed).toEqual([{ name: 'blinded', previous: false }]);
    expect(m.kept).toEqual(['sample_size']);
    expect(m.added).toEqual(['outcome']);
  });
  it('drops unmentioned fields with replaceAll', () => {
    const m = mergeFields(sample.fields, [{ name: 'country', value: 'Kenya' }], [], true);
    expect(m.fields.map((f) => f.name)).toEqual(['country']);
    expect(m.removed.map((r) => r.name)).toEqual(['sample_size', 'blinded']);
  });
});

describe('zotero_save_extraction', () => {
  it('creates a tagged child note through the desktop, with quotes checked against the full text', async () => {
    const ctx = ctxWith({ items: { PAPER001: paper('PAPER001') }, children: { PAPER001: [pdf('PDF00001', 'PAPER001')] }, fulltext: { PDF00001: FULLTEXT } });
    const res: any = await saveExtraction.handler(
      {
        schema: 'rct-review',
        items: [
          {
            item_key: 'PAPER001',
            fields: [
              { name: 'sample_size', value: 120, quote: 'We randomised 120 participants', page: '3' },
              { name: 'country', value: 'Uganda', quote: 'four sites in Uganda' },
              { name: 'design', value: 'RCT' },
            ],
          },
        ],
      },
      ctx,
    );
    expect(res.isError).toBeUndefined();
    const [[objects, lib]] = ctx.localWrites.writeItems.mock.calls;
    expect(lib).toEqual(ME);
    expect(objects[0]).toMatchObject({ itemType: 'note', parentItem: 'PAPER001', tags: [{ tag: EXTRACTION_TAG }] });
    const stored = parseExtractionNote(objects[0].note)!;
    expect(stored.schema).toBe('rct-review');
    expect(stored.fields.map((f) => [f.name, f.check])).toEqual([
      ['sample_size', 'verified'],
      ['country', 'not-found'],
      ['design', undefined],
    ]);
    expect(res.structuredContent).toMatchObject({
      saved: 1,
      target: 'local',
      items: [{ item_key: 'PAPER001', status: 'created', note_key: 'NOTE0001', quotes: { verified: 1, notFound: 1, unchecked: 0 }, notFound: ['country'] }],
    });
    expect(text(res)).toMatch(/Quotes NOT found in the full text: PAPER001 \(country\)/);
  });

  it('updates the existing note for the same schema in place and reports what it replaced', async () => {
    const existing = { key: 'NOTEOLD1', version: 30, data: { key: 'NOTEOLD1', itemType: 'note', parentItem: 'PAPER001', note: extractionNoteHtml(sample), tags: [{ tag: EXTRACTION_TAG }] } };
    const other = { key: 'NOTEOTH1', version: 31, data: { key: 'NOTEOTH1', itemType: 'note', note: extractionNoteHtml({ ...sample, schema: 'other' }), tags: [{ tag: EXTRACTION_TAG }] } };
    const ctx = ctxWith({ items: { PAPER001: paper('PAPER001') }, children: { PAPER001: [other, existing] } });
    const res: any = await saveExtraction.handler(
      { schema: 'rct-review', items: [{ item_key: 'PAPER001', fields: [{ name: 'country', value: 'Kenya' }, { name: 'blinded', value: null }] }] },
      ctx,
    );
    expect(ctx.localWrites.writeItems).not.toHaveBeenCalled();
    const [[key, patch, version]] = ctx.localWrites.patchItem.mock.calls;
    expect([key, version]).toEqual(['NOTEOLD1', 30]);
    expect(parseExtractionNote(patch.note)!.fields.map((f) => [f.name, f.value])).toEqual([
      ['sample_size', 120],
      ['country', 'Kenya'],
    ]);
    expect(res.structuredContent.items[0]).toMatchObject({
      status: 'updated',
      note_key: 'NOTEOLD1',
      replaced: [{ name: 'country', previous: 'Kenya & <Uganda> "east"', value: 'Kenya' }],
      removed: [{ name: 'blinded', previous: false }],
      kept: ['sample_size'],
    });
  });

  it('re-reads and merges once after a version conflict', async () => {
    const existing = { key: 'NOTEOLD1', version: 30, data: { key: 'NOTEOLD1', itemType: 'note', note: extractionNoteHtml(sample), tags: [{ tag: EXTRACTION_TAG }] } };
    const ctx = ctxWith({ items: { PAPER001: paper('PAPER001') }, children: { PAPER001: [existing] } });
    ctx.localWrites.patchItem.mockRejectedValueOnce(new ZoteroApiError({ status: 412, message: 'Precondition Failed' }));
    const res: any = await saveExtraction.handler({ schema: 'rct-review', items: [{ item_key: 'PAPER001', fields: [{ name: 'country', value: 'Kenya' }] }] }, ctx);
    expect(ctx.localWrites.patchItem).toHaveBeenCalledTimes(2);
    expect(res.structuredContent.items[0].status).toBe('updated');
  });

  it('writes nothing when the values did not change', async () => {
    const existing = { key: 'NOTEOLD1', version: 30, data: { key: 'NOTEOLD1', itemType: 'note', note: extractionNoteHtml(sample), tags: [{ tag: EXTRACTION_TAG }] } };
    const ctx = ctxWith({ items: { PAPER001: paper('PAPER001') }, children: { PAPER001: [existing] } });
    const res: any = await saveExtraction.handler({ schema: 'rct-review', items: [{ item_key: 'PAPER001', fields: [{ name: 'blinded', value: false }] }] }, ctx);
    expect(ctx.localWrites.patchItem).not.toHaveBeenCalled();
    expect(res.structuredContent.items[0].status).toBe('unchanged');
  });

  it('stores a quote as unchecked when the paper has no readable text, and fails a missing item alone', async () => {
    const ctx = ctxWith({ items: { PAPER001: paper('PAPER001') } });
    const res: any = await saveExtraction.handler(
      {
        schema: 's',
        items: [
          { item_key: 'PAPER001', fields: [{ name: 'n', value: 5, quote: 'five participants enrolled' }] },
          { item_key: 'MISSING1', fields: [{ name: 'n', value: 6 }] },
        ],
      },
      ctx,
    );
    const stored = parseExtractionNote(ctx.localWrites.writeItems.mock.calls[0][0][0].note)!;
    expect(stored.fields[0]).toMatchObject({ check: 'unchecked', checkNote: 'no readable attachment' });
    expect(res.structuredContent).toMatchObject({ saved: 1, failed: 1, items: [{ status: 'created' }, { item_key: 'MISSING1', status: 'failed' }] });
  });

  it('refuses a field named twice before writing anything', async () => {
    const ctx = ctxWith({ items: { PAPER001: paper('PAPER001') } });
    const res: any = await saveExtraction.handler({ schema: 's', items: [{ item_key: 'PAPER001', fields: [{ name: 'n', value: 1 }, { name: 'n', value: 2 }] }] }, ctx);
    expect(res.isError).toBe(true);
    expect(ctx.localWrites.writeItems).not.toHaveBeenCalled();
  });

  it('writes a group library the desktop does not hold through the cloud', async () => {
    const ctx = ctxWith({ items: { PAPER001: paper('PAPER001') }, cloud: true });
    const res: any = await saveExtraction.handler(
      { schema: 's', items: [{ item_key: 'PAPER001', fields: [{ name: 'n', value: 1 }] }], library_type: 'group', library_id: GROUP.id },
      ctx,
    );
    expect(ctx.localWrites.writeItems).not.toHaveBeenCalled();
    expect(ctx.web.writeItems.mock.calls[0][0]).toEqual(GROUP);
    expect(res.structuredContent).toMatchObject({ target: 'cloud', saved: 1 });
  });
});

describe('zotero_extraction_table', () => {
  const note = (key: string, parent: string, ex: Extraction) => ({
    key,
    version: 5,
    data: { key, itemType: 'note', parentItem: parent, note: extractionNoteHtml(ex), tags: [{ tag: EXTRACTION_TAG }] },
  });
  const exA: Extraction = { ...sample, itemKey: 'PAPER001' };
  const exB: Extraction = {
    schema: 'rct-review',
    itemKey: 'PAPER002',
    updated: '2026-11-09T10:00:00.000Z',
    fields: [
      { name: 'country', value: '=HYPERLINK("x")' },
      { name: 'sample_size', value: 40, quote: 'forty were enrolled', check: 'not-found' },
    ],
  };

  function tableCtx(): any {
    const ctx = ctxWith();
    ctx.router.searchItems = vi.fn(async (q: any) => {
      if (q.tag === EXTRACTION_TAG) {
        return { data: [note('NOTEA001', 'PAPER001', exA), note('NOTEB001', 'PAPER002', exB), note('NOTEX001', 'PAPER009', { ...exA, schema: 'other' })], totalResults: 3 };
      }
      if (q.collectionKey) return { data: [paper('PAPER001'), paper('PAPER002', { creators: [{ lastName: 'Jones' }], date: '2021' }), paper('PAPER003')], totalResults: 3 };
      return { data: [], totalResults: 0 };
    });
    return ctx;
  }

  it('lays a collection out as one table with gaps listed', async () => {
    const ctx = tableCtx();
    const res: any = await extractionTable.handler({ schema: 'rct-review', collection_key: 'COLL0001' }, ctx);
    expect(res.isError).toBeUndefined();
    const s = res.structuredContent;
    expect(s.columns).toEqual(['sample_size', 'country', 'blinded']);
    expect(s.rows.map((r: any) => r.item_key)).toEqual(['PAPER001', 'PAPER002']);
    expect(s.missingItems).toEqual([{ item_key: 'PAPER003', study: 'Smith (2019)' }]);
    expect(s.missingFields).toEqual([{ item_key: 'PAPER002', fields: ['blinded'] }]);
    expect(s.markdown).toContain('| Study | sample_size | country | blinded |');
    expect(s.markdown).toContain('| Jones (2021) (PAPER002) | 40 [quote not found] | =HYPERLINK("x") | (missing) |');
    expect(s.markdown).toContain('No extraction saved for: Smith (2019) (PAPER003).');
    expect(s.csv.split('\r\n')[0]).toBe(
      'Item key,Study,Title,sample_size,sample_size quote,sample_size page,sample_size quote check,country,country quote,country page,country quote check,blinded,blinded quote,blinded page,blinded quote check',
    );
    expect(s.csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(s.warnings).toHaveLength(1);
  });

  it('refuses to guess between several schemas', async () => {
    const res: any = await extractionTable.handler({}, tableCtx());
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/"rct-review", "other"/);
  });

  it('names item keys with no extraction', async () => {
    const ctx = tableCtx();
    const res: any = await extractionTable.handler({ item_keys: ['PAPER002', 'NOPE0001'] }, ctx);
    expect(res.structuredContent.rows.map((r: any) => r.item_key)).toEqual(['PAPER002']);
    expect(res.structuredContent.missingItems).toEqual([{ item_key: 'NOPE0001', study: 'NOPE0001' }]);
  });
});
