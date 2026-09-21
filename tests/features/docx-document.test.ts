import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDocx, type Block } from '../../src/features/docx/document.js';
import { readZip } from '../../src/features/docx/zip.js';
import {
  bibliographyFieldCode,
  chunkPrefs,
  citationFieldCode,
  documentPrefsXml,
  isNoteStyle,
  itemUri,
  randomFieldId,
  MAX_PROPERTY_LENGTH,
} from '../../src/features/docx/zotero-fields.js';
import { chunkText, escapeXml, escapeXmlAttr, stripIllegalXml } from '../../src/features/docx/xml.js';

/** A character no XML can hold: a form feed, which is what a broken PDF extractor leaves. */
const FORM_FEED = '';
/** One astral code point, i.e. two UTF-16 code units that must never be separated. */
const ASTRAL = String.fromCodePoint(0x1f600);

const CITATION = citationFieldCode({
  citationID: 'aB3dEf9h',
  properties: { formattedCitation: '(Wu, 2026)', plainCitation: '(Wu, 2026)', noteIndex: 0 },
  citationItems: [
    {
      id: 'ABCD1234',
      uris: ['http://zotero.org/users/19552201/items/ABCD1234'],
      itemData: { id: 'ABCD1234', title: 'Ships & Shoes < Sealing Wax' },
      locator: '12',
      label: 'page',
    },
  ],
  schema: 'https://github.com/citation-style-language/schema/raw/master/csl-citation.json',
});

function docWithOneField(): Uint8Array {
  const blocks: Block[] = [
    {
      kind: 'paragraph',
      pieces: [
        { type: 'text', text: 'As shown ' },
        { type: 'field', instruction: CITATION, text: '(Wu, 2026)' },
        { type: 'text', text: ', the method holds.' },
      ],
    },
  ];
  return buildDocx({ blocks, prefs: documentPrefsXml({ styleId: 'http://www.zotero.org/styles/apa', locale: 'en-US', hasBibliography: true, sessionId: 'sEsSiOn1' }), now: new Date('2026-09-14T12:00:00Z') });
}

/**
 * CT_PPrBase, in the order ECMA-376 declares it, with the three children CT_PPr adds after
 * it. The content model is an xsd:sequence, so this order is a rule and not a convention:
 * `ind` before `spacing` is invalid OOXML even though it parses as XML, which is exactly
 * the kind of break "the package is well formed" cannot see.
 */
const PPR_CHILD_ORDER = [
  'pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr',
  'suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap',
  'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd',
  'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap',
  'jc', 'textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId',
  'cnfStyle', 'rPr', 'sectPr', 'pPrChange',
];

/** The direct children of every `w:pPr` in a part, in document order. */
function pPrChildren(xml: string): string[][] {
  return [...xml.matchAll(/<w:pPr>([\s\S]*?)<\/w:pPr>/g)].map((block) => {
    const names: string[] = [];
    let depth = 0;
    for (const tag of block[1]!.matchAll(/<(\/?)w:([A-Za-z]+)([^>]*?)(\/?)>/g)) {
      const [, closing, name, , selfClosing] = tag;
      if (closing) {
        depth -= 1;
        continue;
      }
      if (depth === 0) names.push(name!);
      if (!selfClosing) depth += 1;
    }
    return names;
  });
}

describe('the package is a valid .docx', () => {
  it('orders the children of every w:pPr the way the schema sequence requires', () => {
    const zip = readZip(
      buildDocx({
        blocks: [
          { kind: 'paragraph', style: 'Title', pieces: [{ type: 'text', text: 'A Draft' }] },
          { kind: 'spanningField', instruction: bibliographyFieldCode(), paragraphs: ['Entry.'], style: 'Bibliography' },
        ],
        prefs: documentPrefsXml({ styleId: 'x', hasBibliography: true, sessionId: 'sEsSiOn1' }),
      }),
    )!;
    const blocks = zip.names().flatMap((name) => pPrChildren(zip.text(name)!).map((c) => [name, c] as const));
    // The Bibliography style's pPr is the one that shipped `ind` before `spacing`, so an
    // empty scan would pass this test for the wrong reason.
    expect(blocks.some(([, children]) => children.includes('spacing') && children.includes('ind'))).toBe(true);
    for (const [name, children] of blocks) {
      expect(children.filter((c) => !PPR_CHILD_ORDER.includes(c)), `${name}: unknown pPr child`).toEqual([]);
      const positions = children.map((c) => PPR_CHILD_ORDER.indexOf(c));
      expect(positions, `${name}: ${children.join(', ')} is out of sequence`).toEqual(
        [...positions].sort((a, b) => a - b),
      );
    }
  });

  it('carries every part Word needs, and nothing it does not', () => {
    const zip = readZip(docWithOneField())!;
    expect(zip.names()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/_rels/document.xml.rels',
      'word/styles.xml',
      'docProps/core.xml',
      'docProps/app.xml',
      'docProps/custom.xml',
    ]);
  });

  it('declares a content type for every part that needs an Override', () => {
    const types = readZip(docWithOneField())!.text('[Content_Types].xml')!;
    expect(types).toContain('PartName="/word/document.xml"');
    expect(types).toContain('wordprocessingml.document.main+xml');
    expect(types).toContain('PartName="/docProps/custom.xml"');
    expect(types).toContain('custom-properties+xml');
    expect(types).toContain('PartName="/word/styles.xml"');
    expect(types).toContain('Default Extension="rels"');
  });

  it('relates the package root to the document and the custom properties', () => {
    const zip = readZip(docWithOneField())!;
    const rels = zip.text('_rels/.rels')!;
    expect(rels).toContain('Target="word/document.xml"');
    expect(rels).toContain('relationships/officeDocument"');
    expect(rels).toContain('Target="docProps/custom.xml"');
    expect(rels).toContain('relationships/custom-properties"');
    expect(zip.text('word/_rels/document.xml.rels')).toContain('Target="styles.xml"');
  });

  it('opens cleanly under an external unzip', () => {
    let unzipAvailable = true;
    try {
      execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    } catch {
      unzipAvailable = false;
    }
    if (!unzipAvailable) return; // the CRC assertions in docx-zip.test.ts still cover this
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-docx-'));
    try {
      const file = join(dir, 'probe.docx');
      writeFileSync(file, docWithOneField());
      expect(execFileSync('unzip', ['-t', file], { encoding: 'utf8' })).toContain('No errors detected');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a citation is a five-part Word field, in order', () => {
  it('emits begin, instrText, separate, the cached text, then end', () => {
    const xml = readZip(docWithOneField())!.text('word/document.xml')!;
    const order = [...xml.matchAll(/<w:fldChar w:fldCharType="(\w+)"\/>|<w:(instrText|t)\b/g)].map(
      (m) => m[1] ?? m[2],
    );
    // The leading and trailing literal text runs are `t`s of their own.
    expect(order).toEqual(['t', 'begin', 'instrText', 'separate', 't', 'end', 't']);
  });

  it('caches exactly the text the field payload claims it caches', () => {
    const xml = readZip(docWithOneField())!.text('word/document.xml')!;
    const instr = /<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/.exec(xml)![1]!;
    const payload = JSON.parse(instr.slice(instr.indexOf('{'), instr.lastIndexOf('}') + 1));
    const result = /<w:fldChar w:fldCharType="separate"\/><\/w:r><w:r><w:t[^>]*>([\s\S]*?)<\/w:t>/.exec(xml)![1]!;
    // Zotero compares plainCitation against the field's visible text on refresh and prompts
    // "this citation was modified" when they differ, so they must be identical.
    expect(result).toBe(payload.properties.plainCitation);
    expect(result).toBe(payload.properties.formattedCitation);
  });

  it('writes an instruction that parses back to the Zotero payload', () => {
    const xml = readZip(docWithOneField())!.text('word/document.xml')!;
    const instr = /<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/.exec(xml)![1]!;
    expect(instr.startsWith(' ADDIN ZOTERO_ITEM CSL_CITATION ')).toBe(true);
    const payload = JSON.parse(instr.slice(instr.indexOf('{'), instr.lastIndexOf('}') + 1));
    expect(payload.citationID).toBe('aB3dEf9h');
    expect(payload.citationItems[0].uris).toEqual(['http://zotero.org/users/19552201/items/ABCD1234']);
    expect(payload.citationItems[0].locator).toBe('12');
    expect(payload.citationItems[0].label).toBe('page');
    expect(payload.schema).toContain('csl-citation.json');
  });

  it('splits a very long instruction across several instrText runs', () => {
    const big = citationFieldCode({
      citationID: 'longlong',
      properties: { formattedCitation: '(X)', plainCitation: '(X)', noteIndex: 0 },
      citationItems: [{ id: 'K', uris: [], itemData: { id: 'K', abstract: 'a'.repeat(6000) } }],
      schema: 'https://example.invalid/csl-citation.json',
    });
    const xml = readZip(
      buildDocx({ blocks: [{ kind: 'paragraph', pieces: [{ type: 'field', instruction: big, text: '(X)' }] }] }),
    )!.text('word/document.xml')!;
    const runs = [...xml.matchAll(/<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/g)].map((m) => m[1]!);
    expect(runs.length).toBeGreaterThan(1);
    // Word concatenates them, so the joined text must still be the whole instruction.
    const joined = runs.join('').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    expect(joined).toBe(big);
  });
});

describe('library text is escaped before it reaches the XML', () => {
  it('escapes an ampersand and a less-than in BOTH the instruction and the visible run', () => {
    const instruction = citationFieldCode({
      citationID: 'escape01',
      properties: { formattedCitation: '(Ships & Shoes < 1)', plainCitation: '(Ships & Shoes < 1)', noteIndex: 0 },
      citationItems: [{ id: 'K', uris: [], itemData: { id: 'K', title: 'Ships & Shoes < Sealing Wax' } }],
      schema: 'https://example.invalid/csl-citation.json',
    });
    const xml = readZip(
      buildDocx({
        blocks: [
          { kind: 'paragraph', pieces: [{ type: 'field', instruction, text: '(Ships & Shoes < 1)' }] },
        ],
      }),
    )!.text('word/document.xml')!;

    // No raw & or < survives inside either element's text.
    const instr = /<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/.exec(xml)![1]!;
    expect(instr).toContain('Ships &amp; Shoes &lt; Sealing Wax');
    expect(instr).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
    expect(instr).not.toContain('<');

    const run = /<w:fldChar w:fldCharType="separate"\/><\/w:r><w:r><w:t[^>]*>([\s\S]*?)<\/w:t>/.exec(xml)![1]!;
    expect(run).toBe('(Ships &amp; Shoes &lt; 1)');

    // And the escaped instruction still parses as the original JSON once unescaped.
    const unescaped = instr.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const payload = JSON.parse(unescaped.slice(unescaped.indexOf('{'), unescaped.lastIndexOf('}') + 1));
    expect(payload.citationItems[0].itemData.title).toBe('Ships & Shoes < Sealing Wax');
  });

  it('drops a form feed from the CACHED TEXT INSIDE THE FIELD CODE too, not just from the run', () => {
    // The two copies of a citation take different routes into the file: the visible run is
    // escaped directly, the cached copy is JSON-encoded first, and JSON.stringify turns a
    // form feed into the two ASCII characters `\` and `f` that survive escaping. Zotero
    // compares the two on every refresh, so a divergence here marks every such citation as
    // hand-edited in the user's own document.
    const text = `(W${FORM_FEED}u, 2026)`;
    const instruction = citationFieldCode({
      citationID: 'ctrl0001',
      properties: { formattedCitation: text, plainCitation: text, noteIndex: 0 },
      citationItems: [{ id: 'K', uris: [], itemData: { id: 'K', title: `Deep${FORM_FEED}Learning` } }],
      schema: 'https://example.invalid/csl-citation.json',
    });
    const xml = readZip(
      buildDocx({ blocks: [{ kind: 'paragraph', pieces: [{ type: 'field', instruction, text }] }] }),
    )!.text('word/document.xml')!;

    const instr = /<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/.exec(xml)![1]!;
    const unescaped = instr.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const payload = JSON.parse(unescaped.slice(unescaped.indexOf('{'), unescaped.lastIndexOf('}') + 1));
    const run = /<w:fldChar w:fldCharType="separate"\/><\/w:r><w:r><w:t[^>]*>([\s\S]*?)<\/w:t>/.exec(xml)![1]!;

    expect(run).toBe('(Wu, 2026)');
    expect(payload.properties.plainCitation).toBe(run);
    expect(payload.properties.formattedCitation).toBe(run);
    // The embedded record is what Zotero falls back to for an unlinked citation, so it is
    // normalised the same way rather than keeping a character the document cannot show.
    expect(payload.citationItems[0].itemData.title).toBe('DeepLearning');
  });

  it('drops an unpaired surrogate, which is not a character, and keeps a real pair', () => {
    expect(stripIllegalXml(`a${ASTRAL}b`)).toBe(`a${ASTRAL}b`);
    expect(escapeXml(`a${ASTRAL}b`)).toBe(`a${ASTRAL}b`);
    expect(escapeXml(`a\uD83Db`)).toBe('ab');
    expect(escapeXml(`a\uDE00b`)).toBe('ab');
  });

  it('drops characters XML 1.0 cannot represent, and keeps tabs and newlines', () => {
    expect(escapeXml('a bc')).toBe('abc');
    expect(escapeXml('a\tb\nc')).toBe('a\tb\nc');
    expect(escapeXmlAttr('say "hi" & <bye>')).toBe('say &quot;hi&quot; &amp; &lt;bye&gt;');
  });
});

describe('splitting a long instruction across runs', () => {
  /**
   * An instruction whose astral character sits exactly on the 1000-code-unit boundary, so
   * the naive `slice(i, i + 1000)` puts its two halves in different runs.
   */
  function instructionWithPairOnTheBoundary(): string {
    for (let pad = 0; pad < 1200; pad += 1) {
      const instruction = citationFieldCode({
        citationID: 'astral01',
        properties: { formattedCitation: '(X)', plainCitation: '(X)', noteIndex: 0 },
        citationItems: [
          { id: 'K', uris: [], itemData: { id: 'K', title: `${'A'.repeat(pad)}${ASTRAL} tail` } },
        ],
        schema: 'https://example.invalid/csl-citation.json',
      });
      if (instruction.indexOf(ASTRAL) === 999) return instruction;
    }
    throw new Error('no padding put the surrogate pair on the chunk boundary');
  }

  it('never cuts a surrogate pair in half, so the CSL record keeps the character', () => {
    const instruction = instructionWithPairOnTheBoundary();
    const xml = readZip(
      buildDocx({ blocks: [{ kind: 'paragraph', pieces: [{ type: 'field', instruction, text: '(X)' }] }] }),
    )!.text('word/document.xml')!;
    const runs = [...xml.matchAll(/<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/g)].map((m) => m[1]!);
    expect(runs.length).toBeGreaterThan(1);

    const joined = runs.join('').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    // Nothing was replaced, nothing was dropped: the bytes on disk still hold the character.
    expect(joined).toBe(instruction);
    expect(joined).not.toContain('�');
    const payload = JSON.parse(joined.slice(joined.indexOf('{'), joined.lastIndexOf('}') + 1));
    expect(payload.citationItems[0].itemData.title).toContain(`${ASTRAL} tail`);
  });

  it('keeps each run inside the size it promised while it moves the cut', () => {
    const instruction = instructionWithPairOnTheBoundary();
    const xml = readZip(
      buildDocx({ blocks: [{ kind: 'paragraph', pieces: [{ type: 'field', instruction, text: '(X)' }] }] }),
    )!.text('word/document.xml')!;
    const runs = [...xml.matchAll(/<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/g)].map((m) => m[1]!);
    // The first run gives up one code unit rather than splitting the pair, the whole
    // character opens the next one, and no run ends on a high surrogate. (Checking only the
    // lengths would pass on the broken splitter too, because the escaper drops a lone
    // surrogate: the character would be gone, not halved.)
    expect(runs[0]!.length).toBe(999);
    expect(runs[1]!.startsWith(ASTRAL)).toBe(true);
    for (const run of runs) {
      const last = run.charCodeAt(run.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it('chunkText splits by size and only ever moves a cut off a surrogate pair', () => {
    expect(chunkText('abcdef', 2)).toEqual(['ab', 'cd', 'ef']);
    expect(chunkText('', 4)).toEqual([]);
    // 'a' + pair + 'b': a cut at 2 would land inside the pair, so it backs off to 1.
    expect(chunkText(`a${ASTRAL}b`, 2)).toEqual(['a', ASTRAL, 'b']);
    expect(chunkText(`${ASTRAL}${ASTRAL}`, 3)).toEqual([ASTRAL, ASTRAL]);
    // A size of one cannot hold a pair at all; it must still terminate.
    expect(chunkText(`a${ASTRAL}`, 1).join('')).toBe(`a${ASTRAL}`);
  });

  it('chunks the document preferences the same way', () => {
    const raw = `${'p'.repeat(254)}${ASTRAL}${'q'.repeat(10)}`;
    const chunks = chunkPrefs(raw);
    expect(chunks.join('')).toBe(raw);
    expect(chunks.every((c) => c.length <= MAX_PROPERTY_LENGTH)).toBe(true);
    for (const chunk of chunks) {
      const last = chunk.charCodeAt(chunk.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });
});

describe('the bibliography field spans its paragraphs', () => {
  it('opens in the first entry and closes in the last', () => {
    const xml = readZip(
      buildDocx({
        blocks: [
          {
            kind: 'spanningField',
            instruction: bibliographyFieldCode(),
            paragraphs: ['Entry one.', 'Entry two.', 'Entry three.'],
            style: 'Bibliography',
          },
        ],
      }),
    )!.text('word/document.xml')!;
    const paragraphs = [...xml.matchAll(/<w:p>([\s\S]*?)<\/w:p>/g)].map((m) => m[1]!);
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0]).toContain('fldCharType="begin"');
    expect(paragraphs[0]).toContain(' ADDIN ZOTERO_BIBL ');
    expect(paragraphs[0]).toContain('fldCharType="separate"');
    expect(paragraphs[0]).not.toContain('fldCharType="end"');
    expect(paragraphs[1]).not.toContain('fldChar');
    expect(paragraphs[2]).toContain('fldCharType="end"');
    expect(paragraphs.every((p) => p.includes('<w:pStyle w:val="Bibliography"/>'))).toBe(true);
    expect(xml).toContain('CSL_BIBLIOGRAPHY');
  });

  it('still produces a well-formed field when there are no entries', () => {
    const xml = readZip(
      buildDocx({
        blocks: [{ kind: 'spanningField', instruction: bibliographyFieldCode(), paragraphs: [] }],
      }),
    )!.text('word/document.xml')!;
    expect((xml.match(/fldCharType="begin"/g) ?? []).length).toBe(1);
    expect((xml.match(/fldCharType="end"/g) ?? []).length).toBe(1);
  });
});

describe('the Zotero document preferences', () => {
  it('serialize the shape Zotero 7 reads back', () => {
    const prefs = documentPrefsXml({
      styleId: 'http://www.zotero.org/styles/apa',
      locale: 'en-US',
      hasBibliography: true,
      sessionId: 'sEsSiOn1',
    });
    expect(prefs).toContain('<data data-version="3">');
    expect(prefs).toContain('<session id="sEsSiOn1"/>');
    expect(prefs).toContain('id="http://www.zotero.org/styles/apa"');
    expect(prefs).toContain('locale="en-US"');
    expect(prefs).toContain('hasBibliography="1"');
    expect(prefs).toContain('bibliographyStyleHasBeenSet="0"');
    expect(prefs).toContain('<pref name="fieldType" value="Field"/>');
  });

  it('chunk at 255 characters with contiguous, ordered pids', () => {
    const prefs = documentPrefsXml({
      // Long enough to need three properties, which is the case that silently truncates
      // when the pids or the numbering go wrong.
      styleId: `http://www.zotero.org/styles/${'a'.repeat(500)}`,
      locale: 'en-US',
      hasBibliography: true,
      sessionId: 'sEsSiOn1',
    });
    const chunks = chunkPrefs(prefs);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.every((c) => c.length <= MAX_PROPERTY_LENGTH)).toBe(true);
    expect(chunks.join('')).toBe(prefs);

    const custom = readZip(buildDocx({ blocks: [], prefs }))!.text('docProps/custom.xml')!;
    const properties = [...custom.matchAll(/<property [^>]*pid="(\d+)" name="(ZOTERO_PREF_\d+)"><vt:lpwstr>([\s\S]*?)<\/vt:lpwstr>/g)];
    expect(properties).toHaveLength(chunks.length);
    properties.forEach((match, i) => {
      expect(Number(match[1])).toBe(i + 2); // pids 0 and 1 are reserved
      expect(match[2]).toBe(`ZOTERO_PREF_${i + 1}`);
    });
    // Zotero concatenates the property VALUES, so the round trip has to be exact.
    const joined = properties
      .map((m) => m[3]!.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
      .join('');
    expect(joined).toBe(prefs);
    expect(custom).toContain('fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}"');
  });

  it('writes no ZOTERO_PREF property at all when there are no prefs', () => {
    const custom = readZip(buildDocx({ blocks: [] }))!.text('docProps/custom.xml')!;
    expect(custom).not.toContain('ZOTERO_PREF');
    expect(custom).toContain('custom-properties');
  });
});

describe('zotero-fields helpers', () => {
  it('builds an item URI for a real user or group id, and refuses users/0', () => {
    expect(itemUri({ type: 'user', id: 19552201 }, 'ABCD1234')).toBe(
      'http://zotero.org/users/19552201/items/ABCD1234',
    );
    expect(itemUri({ type: 'group', id: 5234875 }, 'ABCD1234')).toBe(
      'http://zotero.org/groups/5234875/items/ABCD1234',
    );
    expect(itemUri({ type: 'user', id: 0 }, 'ABCD1234')).toBeNull();
    expect(itemUri({ type: 'user', id: -1 }, 'ABCD1234')).toBeNull();
  });

  it('recognises a note style and leaves an in-text one alone', () => {
    expect(isNoteStyle('<style xmlns="x" class="note" version="1.0">')).toBe(true);
    expect(isNoteStyle('<style xmlns="x" class="in-text" version="1.0">')).toBe(false);
  });

  it('generates distinct 8-character alphanumeric ids', () => {
    const ids = new Set(Array.from({ length: 500 }, () => randomFieldId()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9]{8}$/);
  });
});
