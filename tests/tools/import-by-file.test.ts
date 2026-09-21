import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import importTool from '../../src/tools/import.js';
import {
  BIBTEX_FIXTURE,
  BIBTEX_FIXTURE_PATH,
  CSLJSON_FIXTURE,
  RIS_FIXTURE,
  RIS_FIXTURE_PATH,
} from '../fixtures/bibliographies/index.js';
import { SCHEMA_SLICE } from '../fixtures/zotero-schema.js';

const LIB = { type: 'user' as const, id: 19552201 };

let dataDir: string;
let insideDataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'zoteus-import-file-'));
  // Inside the caller's own subtree: a remote caller with no identity of its own is held
  // to tenants/shared, not to the bare data directory.
  insideDataDir = join(dataDir, 'tenants', 'shared', 'inside.bib');
  mkdirSync(join(dataDir, 'tenants', 'shared'), { recursive: true });
  writeFileSync(insideDataDir, BIBTEX_FIXTURE, 'utf8');
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** A context with no Zotero anywhere: writes go to the stubbed cloud client. */
function makeCtx(overrides: any = {}): any {
  return {
    config: {
      translationServerUrl: 'http://127.0.0.1:1969',
      dataDir,
      importMaxEntries: 200,
      confirmBulkWrites: 0,
    },
    capabilities: { cloud: { userID: LIB.id, username: 'oscardvs', access: {} }, localApi: false },
    remoteCaller: false,
    translation: { isUp: vi.fn(async () => false) },
    schema: { getSchema: vi.fn(async () => SCHEMA_SLICE) },
    router: {
      defaultLibrary: () => LIB,
      searchItems: vi.fn(async () => ({ data: [], totalResults: 0, lastModifiedVersion: 1 })),
    },
    web: {
      writeItems: vi.fn(async (_lib: any, items: any[]) => ({
        successful: items.map((_it, index) => ({ index, key: `NEW${index}`, version: 1 })),
        unchanged: [],
        failed: [],
        newLibraryVersion: 1,
      })),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...overrides,
  };
}

const call = (args: Record<string, unknown>, ctx: any) =>
  importTool.handler({ action: 'by_file', ...args }, ctx) as Promise<any>;

describe('zotero_import action:"by_file"', () => {
  it('previews what would be created, and writes nothing, by default', async () => {
    const ctx = makeCtx();
    const res = await call({ text: BIBTEX_FIXTURE }, ctx);

    expect(res.isError).toBeFalsy();
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
    const sc = res.structuredContent;
    expect(sc.saved).toBe(false);
    expect(sc.format).toBe('bibtex');
    expect(sc.parsed).toBe(4);
    expect(sc.count).toBe(4);
    expect(sc.mapping).toBe('schema');
    expect(sc.items[0]).toMatchObject({
      itemType: 'journalArticle',
      title: 'An Undulatory Theory of the Mechanics of Atoms and Molecules',
      publicationTitle: 'IEEE Transactions on Software Engineering',
    });
    // The payload is someone else's prose, so it carries the untrusted-content marker.
    expect(sc.provenance.trust).toBe('untrusted');
  });

  it('names the entry whose type has no Zotero equivalent instead of hiding it', async () => {
    const res = await call({ text: BIBTEX_FIXTURE }, makeCtx());
    expect(res.structuredContent.warnings.join(' ')).toMatch(/@artifact.*no Zotero equivalent/);
  });

  it('saves when asked, and stamps where each item came from', async () => {
    const ctx = makeCtx();
    const res = await call({ text: BIBTEX_FIXTURE, save_to_library: true }, ctx);

    expect(res.isError).toBeFalsy();
    expect(ctx.web.writeItems).toHaveBeenCalledTimes(1);
    const written = ctx.web.writeItems.mock.calls[0][1];
    expect(written).toHaveLength(4);
    expect(String(written[0].extra)).toMatch(/resolved:bibtex/);
    expect(res.structuredContent.created).toEqual(['NEW0', 'NEW1', 'NEW2', 'NEW3']);
    expect(res.structuredContent.source).toBe('bibtex');
  });

  it('reads the same bibliography from a file path', async () => {
    const ctx = makeCtx();
    const res = await call({ path: BIBTEX_FIXTURE_PATH }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.parsed).toBe(4);
  });

  it('reads RIS and CSL-JSON from text without being told which they are', async () => {
    const ris = await call({ text: RIS_FIXTURE }, makeCtx());
    expect(ris.structuredContent.format).toBe('ris');
    expect(ris.structuredContent.items[0]).toMatchObject({ itemType: 'journalArticle', volume: '3' });

    const csl = await call({ text: CSLJSON_FIXTURE }, makeCtx());
    expect(csl.structuredContent.format).toBe('csljson');
    expect(csl.structuredContent.items[0]).toMatchObject({ itemType: 'journalArticle', pages: '666-677' });
  });

  it('honours an explicit format over the sniffer', async () => {
    const res = await call({ path: RIS_FIXTURE_PATH, format: 'ris' }, makeCtx());
    expect(res.structuredContent.format).toBe('ris');
  });

  it('says what it received when the payload is none of the three formats', async () => {
    const ctx = makeCtx();
    const res = await call({ text: 'Smith, J. (2020). A paper. Journal of Things, 4(2), 1-10.' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Could not tell what format/);
    expect(res.content[0].text).toMatch(/Smith, J\. \(2020\)/);
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
  });

  it('refuses when neither text nor path was given, and when both were', async () => {
    const neither = await call({}, makeCtx());
    expect(neither.isError).toBe(true);
    expect(neither.content[0].text).toMatch(/needs the bibliography/);

    const both = await call({ text: BIBTEX_FIXTURE, path: BIBTEX_FIXTURE_PATH }, makeCtx());
    expect(both.isError).toBe(true);
    expect(both.content[0].text).toMatch(/not both/);
  });

  it('reports a file that does not exist rather than a parse failure', async () => {
    const res = await call({ path: join(dataDir, 'no-such-file.bib') }, makeCtx());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/could not be opened/);
  });
});

describe('zotero_import action:"by_file" entry cap', () => {
  const many = Array.from(
    { length: 6 },
    (_unused, i) => `@article{k${i}, title = {Paper ${i}}, year = {2020}}`,
  ).join('\n');

  it('refuses a payload over the cap, names the cap and its setting, and writes nothing', async () => {
    const ctx = makeCtx({
      config: { ...makeCtx().config, importMaxEntries: 3 },
    });
    const res = await call({ text: many, save_to_library: true }, ctx);

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/6 entries/);
    expect(res.content[0].text).toMatch(/cap of 3/);
    expect(res.content[0].text).toMatch(/ZOTEUS_IMPORT_MAX_ENTRIES/);
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
  });

  it('refuses the preview too, so a file over the cap never renders 5000 items', async () => {
    const ctx = makeCtx({ config: { ...makeCtx().config, importMaxEntries: 3 } });
    const res = await call({ text: many }, ctx);
    expect(res.isError).toBe(true);
  });

  it('lets a payload at the cap through', async () => {
    const ctx = makeCtx({ config: { ...makeCtx().config, importMaxEntries: 6 } });
    const res = await call({ text: many }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.parsed).toBe(6);
  });

  it('gates a bulk save on confirm when the operator set a threshold', async () => {
    const ctx = makeCtx({ config: { ...makeCtx().config, confirmBulkWrites: 2 } });
    const refused = await call({ text: many, save_to_library: true }, ctx);
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/ZOTEUS_CONFIRM_BULK_WRITES/);
    expect(ctx.web.writeItems).not.toHaveBeenCalled();

    const allowed = await call({ text: many, save_to_library: true, confirm: true }, ctx);
    expect(allowed.isError).toBeFalsy();
    expect(ctx.web.writeItems).toHaveBeenCalledTimes(1);
  });
});

describe('zotero_import action:"by_file" path confinement', () => {
  it('refuses a path outside the data directory for a remote caller, and names the way round it', async () => {
    const ctx = makeCtx({ remoteCaller: true });
    const res = await call({ path: BIBTEX_FIXTURE_PATH }, ctx);

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/must be inside this server's data directory/);
    expect(res.content[0].text).toMatch(/Paste the file contents into `text`/);
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
  });

  it('allows a path inside the data directory for a remote caller', async () => {
    const res = await call({ path: insideDataDir }, makeCtx({ remoteCaller: true }));
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.parsed).toBe(4);
  });

  it('allows any path when the caller is the operator (stdio)', async () => {
    const res = await call({ path: BIBTEX_FIXTURE_PATH }, makeCtx({ remoteCaller: false }));
    expect(res.isError).toBeFalsy();
  });

  it('refuses a symlink inside the data directory that points outside it', async () => {
    const { symlinkSync } = await import('node:fs');
    const link = join(dataDir, 'escape.bib');
    symlinkSync(BIBTEX_FIXTURE_PATH, link);
    const res = await call({ path: link }, makeCtx({ remoteCaller: true }));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/must be inside this server's data directory/);
  });
});

describe('zotero_import action:"by_file" schema handling', () => {
  it('maps from the offline snapshot when the schema cannot be fetched, and says so', async () => {
    const ctx = makeCtx({
      schema: {
        getSchema: vi.fn(async () => {
          throw new Error('getaddrinfo ENOTFOUND api.zotero.org');
        }),
      },
    });
    const res = await call({ text: BIBTEX_FIXTURE }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.mapping).toBe('snapshot');
    expect(res.structuredContent.items[0].itemType).toBe('journalArticle');
  });

  it('skips an entry Zotero would refuse, reports why, and saves the rest', async () => {
    // A schema that does not know `document` is the one case the mapper cannot map around:
    // an entry type with no Zotero equivalent has nowhere left to go.
    const withoutDocument = {
      ...SCHEMA_SLICE,
      itemTypes: SCHEMA_SLICE.itemTypes.filter((t: any) => t.itemType !== 'document'),
    };
    const ctx = makeCtx({ schema: { getSchema: vi.fn(async () => withoutDocument) } });
    const res = await call({ text: BIBTEX_FIXTURE, save_to_library: true }, ctx);

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.skipped).toEqual([
      { entry: 'odd2026', reason: expect.stringMatching(/Unknown itemType "document"/) },
    ]);
    expect(ctx.web.writeItems.mock.calls[0][1]).toHaveLength(3);
  });
});

describe('zotero_import action:"by_file" and the translation-server', () => {
  it('prefers a running translation-server, and reports that it took the payload', async () => {
    const serverImport = vi.fn(async () => [{ itemType: 'book', title: 'From the translator' }]);
    const ctx = makeCtx({ translation: { isUp: vi.fn(async () => true), import: serverImport } });
    const res = await call({ text: BIBTEX_FIXTURE, save_to_library: true }, ctx);

    expect(serverImport).toHaveBeenCalledWith(BIBTEX_FIXTURE);
    expect(res.structuredContent.format).toBe('translation-server');
    expect(res.structuredContent.source).toBe('translation-server-import');
    expect(ctx.web.writeItems.mock.calls[0][1][0]).toMatchObject({ title: 'From the translator' });
  });

  it('falls back to the built-in parser when the server refuses the payload', async () => {
    const ctx = makeCtx({
      translation: {
        isUp: vi.fn(async () => true),
        import: vi.fn(async () => {
          throw new Error('No translator on the translation-server recognised this payload.');
        }),
      },
    });
    const res = await call({ text: BIBTEX_FIXTURE }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.format).toBe('bibtex');
    expect(res.structuredContent.parsed).toBe(4);
  });

  it('falls back when the server answers with nothing', async () => {
    const ctx = makeCtx({ translation: { isUp: vi.fn(async () => true), import: vi.fn(async () => []) } });
    const res = await call({ text: RIS_FIXTURE }, ctx);
    expect(res.structuredContent.format).toBe('ris');
  });
});

describe('zotero_import action:"by_file" duplicate checking', () => {
  const libraryItem = {
    key: 'LIB1',
    version: 1,
    data: {
      key: 'LIB1',
      itemType: 'journalArticle',
      title: 'Something else entirely',
      DOI: '10.1103/physrev.28.1049',
    },
  };

  it('refuses a save that would add a second copy of an entry already held', async () => {
    const ctx = makeCtx();
    ctx.router.searchItems = vi.fn(async () => ({
      data: [libraryItem],
      totalResults: 1,
      lastModifiedVersion: 1,
    }));
    const res = await call({ text: BIBTEX_FIXTURE, save_to_library: true, check_duplicates: true }, ctx);

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/LIB1/);
    expect(res.content[0].text).toMatch(/allow_duplicate:true/);
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
  });

  it('reports the match on a preview without refusing anything', async () => {
    const ctx = makeCtx();
    ctx.router.searchItems = vi.fn(async () => ({
      data: [libraryItem],
      totalResults: 1,
      lastModifiedVersion: 1,
    }));
    const res = await call({ text: BIBTEX_FIXTURE, check_duplicates: true }, ctx);

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.duplicates[0]).toMatchObject({ item_key: 'LIB1', matchedOn: 'doi' });
    expect(res.structuredContent.parsed).toBe(4);
  });
});
