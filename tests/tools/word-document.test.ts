import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import wordDocument from '../../src/tools/word-document.js';
import { readZip } from '../../src/features/docx/zip.js';
import {
  AMPERSAND_ITEM,
  AUTHOR_DATE_STYLE,
  CONTROL_CHAR_ITEM,
  LOCALE,
  NOTE_STYLE,
  PLAIN_ITEM,
  SECOND_2026_ITEM,
} from '../fixtures/docx-csl.js';

/**
 * These run the real citeproc and the real OOXML emitter, then unzip what landed on disk
 * and assert on the XML. The one thing they cannot do is open the result in Word: no Word
 * and no Zotero word-processor plugin exist on this machine, so "the fields refresh" is
 * asserted nowhere, deliberately.
 */

const ITEMS: Record<string, Record<string, unknown>> = {
  ABCD1234: PLAIN_ITEM,
  EFGH5678: SECOND_2026_ITEM,
  WXYZ9999: AMPERSAND_ITEM,
  CTRL0001: CONTROL_CHAR_ITEM,
};

/** Every character XML 1.0 cannot represent, so a test can say "none of these survived". */
const ILLEGAL = /[\p{Cc}\p{Cs}￾￿]/u;

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'zoteus-docx-tool-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function ctx(over: Record<string, unknown> = {}) {
  return {
    config: { dataDir },
    remoteCaller: false,
    capabilities: {},
    router: {
      defaultLibrary: () => ({ type: 'user', id: 19552201 }),
      exportItems: vi.fn(async (params: { itemKey?: string[] }) => {
        const key = params.itemKey?.[0] ?? '';
        const item = ITEMS[key];
        return JSON.stringify(item ? [item] : []);
      }),
      getItem: vi.fn(async () => ({ library: { type: 'user', id: 19552201 } })),
    },
    styles: {
      resolveId: (s: string) => s.trim().toLowerCase(),
      fetchStyle: vi.fn(async () => AUTHOR_DATE_STYLE),
      fetchLocale: vi.fn(async () => LOCALE),
    },
    web: { exportItems: vi.fn() },
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    ...over,
  } as never;
}

const text = (res: { content?: { text: string }[] }) => (res.content ?? []).map((c) => c.text).join('\n');

async function partsOf(path: string) {
  const zip = readZip(new Uint8Array(await readFile(path)));
  expect(zip).not.toBeNull();
  return zip!;
}

/** Every ZOTERO_ITEM payload in the document, already JSON-parsed, in document order. */
function payloads(documentXml: string): any[] {
  return [...documentXml.matchAll(/<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/g)]
    .map((m) => m[1]!)
    .filter((instr) => instr.includes('ZOTERO_ITEM'))
    .map((instr) => {
      const unescaped = instr.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      return JSON.parse(unescaped.slice(unescaped.indexOf('{'), unescaped.lastIndexOf('}') + 1));
    });
}

/** The cached text of each field, i.e. what a reader sees before anything refreshes it. */
function cachedTexts(documentXml: string): string[] {
  return [...documentXml.matchAll(/<w:fldChar w:fldCharType="separate"\/><\/w:r><w:r><w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map(
    (m) => m[1]!,
  );
}

describe('zotero_word_document writes a real .docx', () => {
  it('defaults the output under the data directory and reports what it wrote', async () => {
    const c = ctx();
    const res = await wordDocument.handler(
      { body: ['We follow [[cite:ABCD1234,p. 12]] here.'], title: 'A Draft' },
      c,
    );
    expect(res.isError).toBeUndefined();
    const out = res.structuredContent as any;
    expect(out.savedTo.startsWith(join(dataDir, 'documents') + sep)).toBe(true);
    expect(out.savedTo.endsWith('.docx')).toBe(true);
    expect(existsSync(out.savedTo)).toBe(true);
    expect(out.bytes).toBeGreaterThan(0);
    expect(out.style).toBe('apa');
    expect(out.locale).toBe('en-US');
    expect(out.citations).toEqual([
      { item_key: 'ABCD1234', item_keys: ['ABCD1234'], locator: '12', rendered: '(Devos, 2026, p. 12)' },
    ]);
    expect(out.refreshNote).toMatch(/Zotero word-processor plugin/);
    expect(out.refreshNote).toMatch(/Not verified against Word/);
  });

  it('packages the parts Word needs and the title it was given', async () => {
    const c = ctx();
    const res = await wordDocument.handler({ body: ['Plain text.'], title: 'A Draft' }, c);
    const zip = await partsOf((res.structuredContent as any).savedTo);
    expect(zip.names()).toContain('[Content_Types].xml');
    expect(zip.names()).toContain('word/document.xml');
    expect(zip.names()).toContain('docProps/custom.xml');
    expect(zip.text('docProps/core.xml')).toContain('<dc:title>A Draft</dc:title>');
    expect(zip.text('word/document.xml')).toContain('<w:pStyle w:val="Title"/>');
    expect(zip.text('word/document.xml')).toContain('Plain text.');
  });

  it('reads the library through the router, never straight off the cloud client', async () => {
    const c = ctx() as any;
    await wordDocument.handler({ body: ['[[cite:ABCD1234]]'], library_type: 'group', library_id: 42 }, c);
    expect(c.router.exportItems).toHaveBeenCalledWith({
      library: { type: 'group', id: 42 },
      format: 'csljson',
      itemKey: ['ABCD1234'],
      limit: 1,
    });
    expect(c.web.exportItems).not.toHaveBeenCalled();
  });

  it('fetches each distinct item once however often it is cited', async () => {
    const c = ctx() as any;
    await wordDocument.handler(
      { body: ['[[cite:ABCD1234]] and [[cite:ABCD1234,p. 3]]', 'again [[cite:ABCD1234]]'] },
      c,
    );
    expect(c.router.exportItems).toHaveBeenCalledTimes(1);
  });
});

describe('each citation is a live Zotero field', () => {
  it('emits the five-part field sequence, in order, once per citation', async () => {
    const res = await wordDocument.handler(
      { body: ['First [[cite:ABCD1234]] and second [[cite:EFGH5678]].'] },
      ctx(),
    );
    const xml = (await partsOf((res.structuredContent as any).savedTo)).text('word/document.xml')!;
    const order = [...xml.matchAll(/<w:fldChar w:fldCharType="(\w+)"\/>/g)].map((m) => m[1]);
    expect(order).toEqual([
      'begin', 'separate', 'end',
      'begin', 'separate', 'end',
      // The bibliography field, which is on by default.
      'begin', 'separate', 'end',
    ]);
  });

  it('carries the item key, the locator and the full CSL data in the instruction', async () => {
    const res = await wordDocument.handler({ body: ['[[cite:ABCD1234,p. 12]]'] }, ctx());
    const xml = (await partsOf((res.structuredContent as any).savedTo)).text('word/document.xml')!;
    const [payload] = payloads(xml);
    expect(payload.citationID).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(payload.properties.noteIndex).toBe(0);
    expect(payload.schema).toContain('csl-citation.json');
    expect(payload.citationItems).toHaveLength(1);
    expect(payload.citationItems[0].id).toBe('ABCD1234');
    expect(payload.citationItems[0].locator).toBe('12');
    expect(payload.citationItems[0].label).toBe('page');
    expect(payload.citationItems[0].uris).toEqual(['http://zotero.org/users/19552201/items/ABCD1234']);
    expect(payload.citationItems[0].itemData.id).toBe('ABCD1234');
    expect(payload.citationItems[0].itemData.title).toBe('On Kalman filters');
    expect(payload.citationItems[0].itemData.author[0].family).toBe('Devos');
  });

  it('caches exactly the text it claims to cache, which is what stops Zotero crying "modified"', async () => {
    const res = await wordDocument.handler({ body: ['[[cite:ABCD1234,p. 12]]'] }, ctx());
    const xml = (await partsOf((res.structuredContent as any).savedTo)).text('word/document.xml')!;
    const [payload] = payloads(xml);
    const [cached] = cachedTexts(xml);
    expect(cached).toBe('(Devos, 2026, p. 12)');
    expect(payload.properties.plainCitation).toBe(cached);
    expect(payload.properties.formattedCitation).toBe(cached);
  });

  it('renders several works in one field when the placeholder names several', async () => {
    const res = await wordDocument.handler({ body: ['[[cite:ABCD1234;EFGH5678]]'] }, ctx());
    const out = res.structuredContent as any;
    expect(out.citations).toHaveLength(1);
    expect(out.citations[0].item_keys).toEqual(['ABCD1234', 'EFGH5678']);
    const xml = (await partsOf(out.savedTo)).text('word/document.xml')!;
    const [payload] = payloads(xml);
    expect(payload.citationItems.map((i: any) => i.id)).toEqual(['ABCD1234', 'EFGH5678']);
  });

  it('disambiguates across the whole document, not cluster by cluster', async () => {
    // Two 2026 papers by the same author. A per-cluster render would leave the FIRST
    // citation as "(Devos, 2026)" even after the second one made the year ambiguous.
    const res = await wordDocument.handler(
      { body: ['One [[cite:ABCD1234]].', 'Two [[cite:EFGH5678]].'] },
      ctx(),
    );
    const out = res.structuredContent as any;
    expect(out.citations.map((c: any) => c.rendered)).toEqual(['(Devos, 2026a)', '(Devos, 2026b)']);
    const xml = (await partsOf(out.savedTo)).text('word/document.xml')!;
    expect(cachedTexts(xml).slice(0, 2)).toEqual(['(Devos, 2026a)', '(Devos, 2026b)']);
    expect(payloads(xml).map((p) => p.properties.plainCitation)).toEqual(['(Devos, 2026a)', '(Devos, 2026b)']);
  });
});

describe('library text that would break the XML', () => {
  it('escapes an ampersand and a less-than in both the instruction and the visible run', async () => {
    const res = await wordDocument.handler({ body: ['See [[cite:WXYZ9999]].'] }, ctx());
    const zip = await partsOf((res.structuredContent as any).savedTo);
    const xml = zip.text('word/document.xml')!;

    const rawInstr = /<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/.exec(xml)![1]!;
    expect(rawInstr).toContain('Ships &amp; Shoes &lt; Sealing Wax');
    expect(rawInstr).toContain('Journal of R&amp;D');
    expect(rawInstr).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
    expect(rawInstr).not.toContain('<');

    // The bibliography entry renders the same title into a visible run.
    const bibliography = xml.slice(xml.indexOf('ZOTERO_BIBL'));
    expect(bibliography).toContain('Ships &amp; Shoes &lt; Sealing Wax');
    expect(bibliography).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);

    // And the instruction still round-trips to the original title.
    const [payload] = payloads(xml);
    expect(payload.citationItems[0].itemData.title).toBe('Ships & Shoes < Sealing Wax');
  });

  it('keeps the cached text identical to the run when the library holds a control character', async () => {
    // A form feed in an author name and a vertical tab in a title: what a broken PDF
    // extractor leaves behind. The run is escaped, so the character is dropped; the cached
    // copy is JSON-encoded first, where the same character becomes `\f` and survives. If
    // the two diverge, Zotero's Refresh reports every one of these citations as modified
    // and offers to freeze it, detached from the style, in the user's own document.
    const res = await wordDocument.handler({ body: ['As [[cite:CTRL0001]] shows.'] }, ctx());
    expect(res.isError).toBeUndefined();
    const out = res.structuredContent as any;
    const xml = (await partsOf(out.savedTo)).text('word/document.xml')!;

    const [payload] = payloads(xml);
    const [cached] = cachedTexts(xml);
    expect(cached).toBe('(Devos, 2026)');
    expect(payload.properties.plainCitation).toBe(cached);
    expect(payload.properties.formattedCitation).toBe(cached);
    // What the tool REPORTS is the text the document actually shows, not the raw render.
    expect(out.citations[0].rendered).toBe(cached);

    // Nothing illegal is left anywhere the user can see it, embedded record included: that
    // record is what Zotero falls back to for an unlinked citation.
    expect(ILLEGAL.test(payload.citationItems[0].itemData.title)).toBe(false);
    expect(ILLEGAL.test(payload.citationItems[0].itemData.author[0].family)).toBe(false);
    expect(ILLEGAL.test(cached)).toBe(false);
    const bibliography = xml.slice(xml.indexOf('ZOTERO_BIBL'));
    expect(bibliography).toContain('DeepLearning for robots');
  });
});

describe('the bibliography field', () => {
  it('is written by default and stamped into the document preferences', async () => {
    const res = await wordDocument.handler({ body: ['[[cite:ABCD1234]]'] }, ctx());
    const out = res.structuredContent as any;
    expect(out.bibliography).toBe(true);
    const zip = await partsOf(out.savedTo);
    expect(zip.text('word/document.xml')).toContain(' ADDIN ZOTERO_BIBL ');
    expect(zip.text('word/document.xml')).toContain('CSL_BIBLIOGRAPHY');
    expect(zip.text('docProps/custom.xml')).toContain('hasBibliography="1"');
  });

  it('is absent when the caller says so, and the preferences say so too', async () => {
    const res = await wordDocument.handler({ body: ['[[cite:ABCD1234]]'], bibliography: false }, ctx());
    const out = res.structuredContent as any;
    expect(out.bibliography).toBe(false);
    const zip = await partsOf(out.savedTo);
    expect(zip.text('word/document.xml')).not.toContain('ZOTERO_BIBL');
    expect(zip.text('docProps/custom.xml')).toContain('hasBibliography="0"');
  });

  it('is skipped when nothing was cited, rather than written empty', async () => {
    const res = await wordDocument.handler({ body: ['No citations here.'] }, ctx());
    const out = res.structuredContent as any;
    expect(out.bibliography).toBe(false);
    expect((await partsOf(out.savedTo)).text('word/document.xml')).not.toContain('ZOTERO_BIBL');
  });
});

describe('an item key that does not resolve', () => {
  it('lands in `missing` and stays in the document as literal text, uncited', async () => {
    const res = await wordDocument.handler(
      { body: ['Real [[cite:ABCD1234]], fake [[cite:NOPE0000]].'] },
      ctx(),
    );
    const out = res.structuredContent as any;
    expect(out.missing).toEqual(['NOPE0000']);
    expect(out.citations).toHaveLength(1);
    expect(out.warnings.join(' ')).toContain('NOPE0000');
    const xml = (await partsOf(out.savedTo)).text('word/document.xml')!;
    // Visible to whoever reads the draft, and carried by no field.
    expect(xml).toContain('[[cite:NOPE0000]]');
    expect(payloads(xml)).toHaveLength(1);
    expect(payloads(xml)[0].citationItems[0].id).toBe('ABCD1234');
  });

  it('keeps the resolvable half of a mixed cluster and leaves the rest visible', async () => {
    const res = await wordDocument.handler({ body: ['[[cite:ABCD1234;NOPE0000]]'] }, ctx());
    const out = res.structuredContent as any;
    expect(out.missing).toEqual(['NOPE0000']);
    expect(out.citations[0].item_keys).toEqual(['ABCD1234']);
    const xml = (await partsOf(out.savedTo)).text('word/document.xml')!;
    expect(xml).toContain('[[cite:NOPE0000]]');
  });

  it('writes a document with no fields at all when nothing resolves', async () => {
    const res = await wordDocument.handler({ body: ['[[cite:NOPE0000]]'] }, ctx());
    const out = res.structuredContent as any;
    expect(res.isError).toBeUndefined();
    expect(out.citations).toEqual([]);
    expect(out.missing).toEqual(['NOPE0000']);
    expect((await partsOf(out.savedTo)).text('word/document.xml')).not.toContain('ZOTERO_ITEM');
  });
});

describe('item URIs and the users/0 problem', () => {
  it('recovers the real numeric id from an item record when the library resolves to users/0', async () => {
    const c = ctx({
      router: {
        defaultLibrary: () => ({ type: 'user', id: 0 }),
        exportItems: vi.fn(async (p: { itemKey?: string[] }) =>
          JSON.stringify(ITEMS[p.itemKey?.[0] ?? ''] ? [ITEMS[p.itemKey![0]!]] : []),
        ),
        // What the desktop local API actually answers: the record carries the account's
        // real userID even when the library was addressed as users/0.
        getItem: vi.fn(async () => ({ library: { type: 'user', id: 19552201 } })),
      },
    });
    const res = await wordDocument.handler({ body: ['[[cite:ABCD1234]]'] }, c);
    const out = res.structuredContent as any;
    expect(out.linked).toBe(true);
    const xml = (await partsOf(out.savedTo)).text('word/document.xml')!;
    expect(payloads(xml)[0].citationItems[0].uris).toEqual([
      'http://zotero.org/users/19552201/items/ABCD1234',
    ]);
  });

  it('writes an EMPTY uris array, never users/0, when the id cannot be recovered', async () => {
    const c = ctx({
      router: {
        defaultLibrary: () => ({ type: 'user', id: 0 }),
        exportItems: vi.fn(async (p: { itemKey?: string[] }) =>
          JSON.stringify(ITEMS[p.itemKey?.[0] ?? ''] ? [ITEMS[p.itemKey![0]!]] : []),
        ),
        getItem: vi.fn(async () => {
          throw new Error('local API is not answering');
        }),
      },
    });
    const res = await wordDocument.handler({ body: ['[[cite:ABCD1234]]'] }, c);
    const out = res.structuredContent as any;
    expect(out.linked).toBe(false);
    expect(out.warnings.join(' ')).toMatch(/not linked|no Zotero item URIs/);
    expect(out.refreshNote).toContain('not linked');
    const xml = (await partsOf(out.savedTo)).text('word/document.xml')!;
    // An absent `uris` makes Zotero's own fallback throw; an empty one is the safe shape.
    expect(payloads(xml)[0].citationItems[0].uris).toEqual([]);
    expect(xml).not.toContain('users/0/items');
  });

  it('uses the group id for a group library without probing anything', async () => {
    const c = ctx() as any;
    const res = await wordDocument.handler(
      { body: ['[[cite:ABCD1234]]'], library_type: 'group', library_id: 5234875 },
      c,
    );
    expect(c.router.getItem).not.toHaveBeenCalled();
    const xml = (await partsOf((res.structuredContent as any).savedTo)).text('word/document.xml')!;
    expect(payloads(xml)[0].citationItems[0].uris).toEqual([
      'http://zotero.org/groups/5234875/items/ABCD1234',
    ]);
  });
});

describe('style handling', () => {
  it('stamps the style the caller asked for, resolved through the alias table', async () => {
    const c = ctx({
      styles: {
        resolveId: (s: string) => (s.toLowerCase() === 'apa 7th' ? 'apa' : s),
        fetchStyle: vi.fn(async () => AUTHOR_DATE_STYLE),
        fetchLocale: vi.fn(async () => LOCALE),
      },
    });
    const res = await wordDocument.handler({ body: ['[[cite:ABCD1234]]'], style: 'APA 7th' }, c);
    const out = res.structuredContent as any;
    expect(out.style).toBe('apa');
    expect((await partsOf(out.savedTo)).text('docProps/custom.xml')).toContain(
      'http://www.zotero.org/styles/apa',
    );
  });

  it('refuses before touching the library when the style cannot be loaded', async () => {
    const c = ctx({
      styles: {
        resolveId: (s: string) => s,
        fetchStyle: vi.fn(async () => {
          throw new Error('CSL style "nonsense" not found (HTTP 404).');
        }),
        fetchLocale: vi.fn(async () => LOCALE),
      },
    }) as any;
    const res = await wordDocument.handler({ body: ['[[cite:ABCD1234]]'], style: 'nonsense' }, c);
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('Nothing was written.');
    expect(text(res)).toContain('zotero_styles');
    expect(c.router.exportItems).not.toHaveBeenCalled();
  });

  it('says plainly that a note style is rendered inline, because no footnotes are written', async () => {
    const c = ctx({
      styles: {
        resolveId: (s: string) => s,
        fetchStyle: vi.fn(async () => NOTE_STYLE),
        fetchLocale: vi.fn(async () => LOCALE),
      },
    });
    const res = await wordDocument.handler({ body: ['[[cite:ABCD1234]]'], style: 'test-note' }, c);
    const out = res.structuredContent as any;
    expect(out.warnings.join(' ')).toMatch(/note style/);
    expect(out.warnings.join(' ')).toMatch(/does not create footnotes/);
  });
});

describe('caller-supplied output paths', () => {
  it('confines a remote caller instead of refusing: the file is still written, inside the data dir', async () => {
    const res = await wordDocument.handler(
      { body: ['[[cite:ABCD1234]]'], save_path: '/etc/zoteus-owned.docx' },
      ctx({ remoteCaller: true }),
    );
    // Not an error: a .docx has no inline channel, so a refusal would leave a hosted
    // caller with nothing at all.
    expect(res.isError).toBeUndefined();
    const out = res.structuredContent as any;
    // A remote caller with no identity of its own writes into the shared subtree, never
    // the bare data directory (which holds the OAuth store and every tenant's files).
    expect(out.savedTo.startsWith(join(dataDir, 'tenants', 'shared', 'documents') + sep)).toBe(true);
    expect(existsSync('/etc/zoteus-owned.docx')).toBe(false);
    expect(out.warnings.join(' ')).toContain('`save_path`');
    expect(out.warnings.join(' ')).toContain(out.savedTo);
    expect(out.warnings.join(' ')).toContain('zotero_attachment');
  });

  it('honours a remote caller path that is already inside its own subtree', async () => {
    const target = join(dataDir, 'tenants', 'shared', 'mine.docx');
    const res = await wordDocument.handler(
      { body: ['[[cite:ABCD1234]]'], save_path: target },
      ctx({ remoteCaller: true }),
    );
    expect((res.structuredContent as any).savedTo).toBe(target);
    expect(existsSync(target)).toBe(true);
  });

  it('writes wherever a stdio caller asks, because that is their own machine', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'zoteus-docx-elsewhere-'));
    try {
      const target = join(outside, 'paper.docx');
      const res = await wordDocument.handler({ body: ['[[cite:ABCD1234]]'], save_path: target }, ctx());
      expect((res.structuredContent as any).savedTo).toBe(target);
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses to clobber an existing file unless overwrite was asked for', async () => {
    const target = join(dataDir, 'thesis.docx');
    writeFileSync(target, 'six months of work');
    const res = await wordDocument.handler({ body: ['[[cite:ABCD1234]]'], save_path: target }, ctx());
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('overwrite');
    expect(text(res)).toContain('Nothing was written.');
    expect(await readFile(target, 'utf8')).toBe('six months of work');

    const second = await wordDocument.handler(
      { body: ['[[cite:ABCD1234]]'], save_path: target, overwrite: true },
      ctx(),
    );
    expect(second.isError).toBeUndefined();
    expect((await partsOf(target)).names()).toContain('word/document.xml');
    void second;
  });
});

describe('the artifact Word actually receives', () => {
  it('checksums every part in both zip headers, which is what Word validates', async () => {
    const res = await wordDocument.handler(
      { body: ['See [[cite:WXYZ9999]] and [[cite:ABCD1234,p. 1]].'], title: 'Checksums' },
      ctx(),
    );
    const path = (res.structuredContent as any).savedTo;
    const raw = new Uint8Array(await readFile(path));
    const zip = readZip(raw)!;
    for (const name of zip.names()) {
      const entry = zip.entry(name)!;
      const contents = zip.read(name)!;
      expect(entry.localCrc, name).toBe(crc32(contents) >>> 0);
      expect(entry.centralCrc, name).toBe(entry.localCrc);
      expect(entry.uncompressedSize, name).toBe(contents.byteLength);
    }
    expect((res.structuredContent as any).bytes).toBe(raw.byteLength);
  });

  it('leaves no unescaped ampersand anywhere in the package', async () => {
    // The whole document is built out of library text. One raw `&` in a journal title is a
    // file Word refuses to open, and it would be the emitter's fault, not the library's.
    const res = await wordDocument.handler(
      { body: ['See [[cite:WXYZ9999]].'], title: 'R&D < everything' },
      ctx(),
    );
    const zip = await partsOf((res.structuredContent as any).savedTo);
    for (const name of zip.names()) {
      const xml = zip.text(name)!;
      expect(xml.startsWith('<?xml '), name).toBe(true);
      const bare = [...xml.matchAll(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g)];
      expect(bare.map((m) => xml.slice(m.index, m.index! + 20)), name).toEqual([]);
    }
    expect(zip.text('docProps/core.xml')).toContain('R&amp;D &lt; everything');
  });
});

describe('what the tool promises before it is called', () => {
  it('hedges the refresh in the description itself, inside the 220 characters a catalog shows', () => {
    // The description is the only string an assistant has BEFORE calling anything, and
    // zotero_search_tools lists just its first 220 characters. A promise of "it refreshes
    // in Word" that is qualified only in the result, after the file is already written, is
    // a promise the assistant will have repeated to the user by then. Nobody has run a
    // refresh against Word, so the string must not claim one.
    const description = wordDocument.description!;
    expect(description.slice(0, 220)).toMatch(/never run here/);
    expect(description).toMatch(/a refresh in Word has never been run/);
    expect(description).toMatch(/LibreOffice.*untested/);
    // The claims that were stated as fact, and are not.
    expect(description).not.toMatch(/exactly as if they had been inserted from Word/);
    expect(description).not.toMatch(/opens and reads correctly everywhere/);
  });

  it('says the same thing in the result the caller reports from', async () => {
    const res = await wordDocument.handler({ body: ['[[cite:ABCD1234]]'] }, ctx());
    expect((res.structuredContent as any).refreshNote).toMatch(/Not verified against Word/);
  });
});

describe('result hygiene', () => {
  it('marks the payload as library content, because rendered citations carry library text', async () => {
    const res = await wordDocument.handler({ body: ['[[cite:ABCD1234]]'] }, ctx());
    expect((res.structuredContent as any).provenance.trust).toBe('untrusted');
  });

  it('refuses a group library named without an id rather than using the personal one', async () => {
    const res = await wordDocument.handler({ body: ['x'], library_type: 'group' }, ctx());
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('library_id');
  });

  it('parses against its own output schema', async () => {
    const res = await wordDocument.handler({ body: ['[[cite:NOPE0000]]'], bibliography: false }, ctx());
    const parsed = (wordDocument.outputSchema as any).safeParse(res.structuredContent);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  });
});

describe('Word document release regressions', () => {
  it('preserves a file created while citations are being loaded', async () => {
    const savedTo = join(dataDir, 'draft.docx');
    const c = ctx() as any;
    c.styles.fetchStyle.mockImplementation(async () => {
      writeFileSync(savedTo, 'A newer document');
      return AUTHOR_DATE_STYLE;
    });
    const result = await wordDocument.handler({ body: ['[[cite:ABCD1234]]'], save_path: savedTo }, c);
    expect(result.isError).toBe(true);
    expect(await readFile(savedTo, 'utf8')).toBe('A newer document');
  });

  it('retains locator labels and whitespace on unresolved members of a mixed cluster', async () => {
    const result = await wordDocument.handler({ body: ['[[cite:ABCD1234; missing1,sv. interpretation]]'] }, ctx());
    const parts = await partsOf((result.structuredContent as any).savedTo);
    expect(parts.text('word/document.xml')).toContain('[[cite: missing1,sv. interpretation]]');
    expect((result.structuredContent as any).citations).toHaveLength(1);
  });

  it('retains the locator of an unresolved citation for later repair', async () => {
    const raw = '[[cite:MISSING1,chapter 12]]';
    const result = await wordDocument.handler({ body: [raw] }, ctx());
    const parts = await partsOf((result.structuredContent as any).savedTo);
    expect(parts.text('word/document.xml')).toContain(raw);
  });
});
