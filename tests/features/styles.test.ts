import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMON_STYLES, StyleResolver, resolveLongStyleName } from '../../src/features/citation/styles.js';
import { tools } from '../../src/tools/index.js';
import stylesTool from '../../src/tools/styles.js';

describe('StyleResolver', () => {
  it('resolves common aliases and passes through ids', () => {
    const r = new StyleResolver();
    expect(r.resolveId('APA 7th')).toBe('apa');
    expect(r.resolveId('IEEE')).toBe('ieee');
    // The id "chicago" used to name was renamed upstream for the 18th edition; the alias
    // follows the rename, so it keeps rendering what it always rendered (#58).
    expect(r.resolveId('Chicago')).toBe('chicago-shortened-notes-bibliography');
    expect(r.resolveId('Chicago notes')).toBe('chicago-notes-bibliography');
    expect(r.resolveId('chicago author-date')).toBe('chicago-author-date');
    expect(r.resolveId('some-custom-style')).toBe('some-custom-style');
  });

  it('does not answer with Object.prototype for a name that is one of its members', () => {
    // ALIASES is a plain object, so `ALIASES['constructor']` was a function, and it went out
    // as the style id.
    const r = new StyleResolver();
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(r.resolveId(name)).toBe(name);
  });

  it('follows the repository\'s rename record when an id has moved (#58)', async () => {
    // A raw file fetch does not get the redirect zotero.org applies, so an id copied from
    // Zotero's preferences, or one this project's own table carried, 404s over a rename.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/chicago-note-bibliography.csl')) return new Response('gone', { status: 404 });
      if (url.endsWith('/renamed-styles.json')) {
        return new Response(JSON.stringify({ 'chicago-note-bibliography': 'chicago-shortened-notes-bibliography' }), {
          status: 200,
        });
      }
      if (url.endsWith('/chicago-shortened-notes-bibliography.csl')) {
        return new Response('<style>SHORTENED</style>', { status: 200 });
      }
      return new Response('nope', { status: 404 });
    });
    const r = new StyleResolver({ fetchImpl: fetchImpl as any });
    expect(await r.fetchStyle('chicago-note-bibliography')).toContain('SHORTENED');
    // Cached under the old id too: the record is read once and the 404 is not repeated.
    expect(await r.fetchStyle('chicago-note-bibliography')).toContain('SHORTENED');
    expect(fetchImpl.mock.calls.filter(([u]) => u.endsWith('/renamed-styles.json'))).toHaveLength(1);
    expect(fetchImpl.mock.calls.filter(([u]) => u.endsWith('/chicago-note-bibliography.csl'))).toHaveLength(1);
    // An id the record does not know stays a plain 404.
    await expect(r.fetchStyle('no-such-style')).rejects.toThrow(/"no-such-style" not found \(HTTP 404\)/);
  });

  it('fetches and caches a style', async () => {
    const fetchImpl = vi.fn(async () => new Response('<style>real</style>', { status: 200 }));
    const r = new StyleResolver({ fetchImpl: fetchImpl as any });
    const a = await r.fetchStyle('apa');
    const b = await r.fetchStyle('apa');
    expect(a).toContain('real');
    expect(b).toBe(a);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('follows a dependent style to its independent parent', async () => {
    const dependent =
      '<style><info><link href="http://www.zotero.org/styles/nature" rel="independent-parent"/></info></style>';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/nature-biotechnology.csl')) return new Response(dependent, { status: 200 });
      if (url.endsWith('/nature.csl')) return new Response('<style>PARENT</style>', { status: 200 });
      return new Response('nope', { status: 404 });
    });
    const r = new StyleResolver({ fetchImpl: fetchImpl as any });
    const xml = await r.fetchStyle('nature-biotechnology');
    expect(xml).toContain('PARENT');
  });

  it('falls back to en-US when a locale is missing', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('en-US') ? new Response('<locale>en</locale>', { status: 200 }) : new Response('x', { status: 404 }),
    );
    const r = new StyleResolver({ fetchImpl: fetchImpl as any });
    const xml = await r.fetchLocale('zz-ZZ');
    expect(xml).toContain('en');
  });
});

/**
 * Long-form style names, the 2026-10-01 stress test's D4: "Chicago Manual of Style 17th
 * edition author-date" came back from zotero_styles as a 404 with `available: false`, while
 * zotero_word_document offered "Chicago Manual of Style 17th edition" as an example of what
 * `style` takes. Only the exact short aliases resolved.
 *
 * Every id below was checked against the CSL styles repository on 2026-10-01: the bare
 * Chicago ids render the 18th edition, the 17th and 16th live under `-17th-edition` and
 * `-16th-edition`, and `vancouver` is renamed to `nlm-citation-sequence`. Resolution is a
 * table lookup and a parse, so none of this touches the network; the resolver here is
 * given a fetch that fails the test if it is ever called.
 */
function offlineResolver(): { resolver: StyleResolver; fetchImpl: ReturnType<typeof vi.fn> } {
  const fetchImpl = vi.fn(async () => {
    throw new Error('resolveId must not touch the network');
  });
  return { resolver: new StyleResolver({ fetchImpl: fetchImpl as any }), fetchImpl };
}

describe('StyleResolver.resolveId on long-form names', () => {
  const CASES: Array<[string, string]> = [
    // The stress test's name, and the Chicago family with and without edition and variant.
    ['Chicago Manual of Style 17th edition author-date', 'chicago-author-date-17th-edition'],
    ['Chicago Manual of Style 18th edition author-date', 'chicago-author-date'],
    ['Chicago Manual of Style author-date', 'chicago-author-date'],
    ['Chicago author date', 'chicago-author-date'],
    ['Chicago Manual of Style 16th edition (author-date)', 'chicago-author-date-16th-edition'],
    ['Chicago Manual of Style 17th edition notes-bibliography', 'chicago-notes-bibliography-17th-edition'],
    ['Chicago Manual of Style 18th edition notes and bibliography', 'chicago-notes-bibliography'],
    ['Chicago notes-bibliography', 'chicago-notes-bibliography'],
    ['Chicago Manual of Style 17th edition shortened notes', 'chicago-shortened-notes-bibliography-17th-edition'],
    ['Chicago Manual of Style 17th edition', 'chicago-shortened-notes-bibliography-17th-edition'],
    ['Chicago Manual of Style', 'chicago-shortened-notes-bibliography'],
    ['The Chicago Manual of Style, seventeenth edition (author-date)', 'chicago-author-date-17th-edition'],
    ['CMOS 17 author-date', 'chicago-author-date-17th-edition'],
    // APA, MLA and the rest of the common long forms.
    ['APA 7th edition', 'apa'],
    ['APA seventh edition', 'apa'],
    ['American Psychological Association 7th edition', 'apa'],
    ['American Psychological Association (APA) 7th ed.', 'apa'],
    ['APA 6th edition', 'apa-6th-edition'],
    ['Modern Language Association 9th edition', 'modern-language-association'],
    ['MLA 9', 'modern-language-association'],
    ['mla9', 'modern-language-association'],
    ['IEEE', 'ieee'],
    ['Institute of Electrical and Electronics Engineers', 'ieee'],
    ['Vancouver', 'nlm-citation-sequence'],
    ['Vancouver style', 'nlm-citation-sequence'],
    ['Harvard', 'harvard-cite-them-right'],
    ['Harvard referencing', 'harvard-cite-them-right'],
    ['Harvard (Cite Them Right) 11th edition', 'harvard-cite-them-right-11th-edition'],
    ['American Medical Association 10th edition', 'american-medical-association-10th-edition'],
    ['Association for Computing Machinery', 'association-for-computing-machinery'],
    ['Nature style', 'nature'],
  ];
  for (const [name, id] of CASES) {
    it(`"${name}" -> ${id}`, () => {
      const { resolver, fetchImpl } = offlineResolver();
      expect(resolver.resolveId(name)).toBe(id);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  }

  it('reads the titles Zotero lists these styles under, old and current', () => {
    // A user copying a style's name out of Zotero's preferences gets these strings.
    const titles: Array<[string, string]> = [
      ['Chicago Manual of Style 18th edition (author-date)', 'chicago-author-date'],
      ['Chicago Manual of Style 17th edition (author-date)', 'chicago-author-date-17th-edition'],
      ['Chicago Manual of Style 18th edition (notes and bibliography)', 'chicago-notes-bibliography'],
      ['Chicago Manual of Style 18th edition (shortened notes and bibliography)', 'chicago-shortened-notes-bibliography'],
      ['Chicago Manual of Style 17th edition (notes and bibliography)', 'chicago-notes-bibliography-17th-edition'],
      [
        'Chicago Manual of Style 17th edition (shortened notes and bibliography)',
        'chicago-shortened-notes-bibliography-17th-edition',
      ],
      // The pre-18th titles: "(note)" was the shortened style, "(full note)" the full one.
      ['Chicago Manual of Style 17th edition (note)', 'chicago-shortened-notes-bibliography-17th-edition'],
      ['Chicago Manual of Style 17th edition (full note)', 'chicago-notes-bibliography-17th-edition'],
      ['APA Style 7th edition', 'apa'],
      ['APA Style 6th edition', 'apa-6th-edition'],
      ['MLA Handbook 9th edition (in-text citations)', 'modern-language-association'],
      ['MLA Handbook 9th edition (notes)', 'modern-language-association-notes'],
      ['Cite Them Right 12th edition (author-date/Harvard)', 'harvard-cite-them-right'],
      ['IEEE Reference Guide version 11.29.2023', 'ieee'],
      ['NLM/Vancouver: Citing Medicine 2nd edition (citation-sequence)', 'nlm-citation-sequence'],
      ['AMA Manual of Style 11th edition', 'american-medical-association'],
      ['ACS Guide 2026 revision', 'american-chemical-society'],
      ['APSA Style Manual revised 2018 edition', 'american-political-science-association'],
    ];
    const { resolver } = offlineResolver();
    for (const [title, id] of titles) expect([title, resolver.resolveId(title)]).toEqual([title, id]);
  });

  it('agrees with every short alias, so the two paths cannot drift apart', () => {
    const { resolver } = offlineResolver();
    for (const alias of COMMON_STYLES) {
      expect([alias, resolveLongStyleName(alias)]).toEqual([alias, resolver.resolveId(alias)]);
    }
  });

  it('passes CSL ids, URLs and names it cannot read with confidence through untouched', () => {
    const { resolver } = offlineResolver();
    const untouched = [
      // Ids that start like a family but are other styles: a word the parse does not know
      // makes the name not its own to reinterpret.
      'chicago-notes-bibliography-annotated',
      'chicago-notes-bibliography-subsequent-ibid',
      'apa-no-ampersand',
      'nature-biotechnology',
      'harvard-anglia-ruskin-university',
      'ieee-with-url',
      'nlm-citation-name',
      // Ids the parse reads to themselves.
      'chicago-author-date',
      'chicago-author-date-17th-edition',
      'chicago-shortened-notes-bibliography-16th-edition',
      'chicago-notes-bibliography',
      'apa-6th-edition',
      'modern-language-association-notes',
      'american-medical-association-10th-edition',
      // A URL stays a URL (zotero_get_item takes one).
      'https://www.zotero.org/styles/apa',
      // No CSL style of its own, so the honest 404 is the answer.
      'Turabian',
      // Contradictions are not guessed at.
      'Chicago author-date notes',
      'Chicago shortened full notes',
      'APA 6th 7th edition',
      'APA 2020',
    ];
    for (const name of untouched) expect([name, resolver.resolveId(name)]).toEqual([name, name]);
  });
});

/**
 * Every style name a tool description, the zotero-cite prompt or the citations skill offers
 * as an example must resolve, offline, to the style it is an example of. The examples are
 * extracted from the descriptions rather than only listed here, so a new example added to a
 * description without an entry below fails this test instead of shipping unresolved.
 */
describe('the style names the tool descriptions give as examples', () => {
  const EXPECTED: Record<string, string> = {
    apa: 'apa',
    'APA 7th': 'apa',
    IEEE: 'ieee',
    Vancouver: 'nlm-citation-sequence',
    Chicago: 'chicago-shortened-notes-bibliography',
    MLA: 'modern-language-association',
    Nature: 'nature',
    'chicago author-date': 'chicago-author-date',
    'Chicago author-date': 'chicago-author-date',
    // zotero_word_document's example before and after it named the variant. The bare form
    // is what the stress test read there; it means what "Chicago" means, shortened notes.
    'Chicago Manual of Style 17th edition': 'chicago-shortened-notes-bibliography-17th-edition',
    'Chicago Manual of Style 17th edition (author-date)': 'chicago-author-date-17th-edition',
    'American Psychological Association 7th edition': 'apa',
  };
  /** Quoted strings in those same texts that are not style names. */
  const NOT_STYLE_NAMES = new Set(['resolve', 'list', 'bib', 'citation', 'csljson', 'en-US', '(Wu, 2026; Devos, 2026)']);

  /** Every description, and every input description, that talks about styles. */
  function styleTexts(): string[] {
    const texts: string[] = [];
    for (const tool of tools as Array<{ description: string; inputSchema?: Record<string, { description?: string }> }>) {
      for (const text of [tool.description, ...Object.values(tool.inputSchema ?? {}).map((s) => s?.description ?? '')]) {
        if (/\bstyle\b/i.test(text)) texts.push(text);
      }
    }
    return texts;
  }

  it('finds the examples where they are, so this test is reading the real descriptions', () => {
    const quoted = new Set(styleTexts().flatMap((text) => [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)));
    // The stress test's case: zotero_word_document's `style` example, now with its variant.
    expect(quoted).toContain('Chicago Manual of Style 17th edition (author-date)');
    for (const name of quoted) {
      if (NOT_STYLE_NAMES.has(name)) continue;
      expect(EXPECTED, `"${name}" is a style example in a tool description with no expected id here`).toHaveProperty([name]);
    }
  });

  it('includes the examples in the zotero-cite prompt and the citations skill', () => {
    const prompt = readFileSync(join(__dirname, '../../src/prompts/index.ts'), 'utf8');
    expect(prompt).toContain('Citation style (e.g. "APA 7th", default APA)');
    const skill = readFileSync(join(__dirname, '../../plugins/zoteus/skills/citations/SKILL.md'), 'utf8');
    expect(skill).toContain('for example "APA 7th", "IEEE" or "Chicago author-date"');
  });

  for (const [name, id] of Object.entries(EXPECTED)) {
    it(`"${name}" resolves offline to ${id}`, () => {
      const { resolver, fetchImpl } = offlineResolver();
      expect(resolver.resolveId(name)).toBe(id);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  }
});

describe('zotero_styles resolve, through the real resolver', () => {
  it("resolves the stress test's name to the 17th-edition author-date style and finds it", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.endsWith('/chicago-author-date-17th-edition.csl')
        ? new Response('<style><info><title>Chicago Manual of Style 17th edition (author-date)</title></info></style>', {
            status: 200,
          })
        : new Response('nope', { status: 404 }),
    );
    const ctx: any = { styles: new StyleResolver({ fetchImpl: fetchImpl as any }) };
    const res: any = await stylesTool.handler(
      { action: 'resolve', name: 'Chicago Manual of Style 17th edition author-date' },
      ctx,
    );
    expect(res.structuredContent).toMatchObject({ styleId: 'chicago-author-date-17th-edition', available: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
