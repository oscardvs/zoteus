import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeForSearch, tokenize } from '../../src/features/search/tokenize.js';
import { createSearchIndex, nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { MemorySearchIndex, makeSnippet } from '../../src/features/search/index-manager.js';
import { loadIndex, saveIndex } from '../../src/features/search/persistence.js';
import type { SearchIndex } from '../../src/features/search/backend.js';

/**
 * `tokenize()` matched `[a-z0-9]+` over lowercased text, which is adequate for English and
 * a correctness defect for everything else. On the SQLite backend the document side is
 * folded by SQLite (`unicode61 remove_diacritics 2`) while the query side was not, so
 * `théorie` reached MATCH as `"th" OR "orie"` — and since terms are OR-ed, that is a
 * confident wrong answer rather than an empty one.
 *
 * The fix folds in JS, in front of the tokenizer both backends already share, so the
 * symmetry is structural rather than coincidental. What the fold must reproduce is
 * `unicode61 remove_diacritics 2` and nothing more, because the FTS5 document side cannot
 * be moved into JS: `passages.text` is the display text `get()` reads back for snippets.
 * Every case below is therefore a symmetry assertion as much as a recall one.
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const hasSqlite = nodeSqliteAvailable();
const backends: Array<'memory' | 'sqlite'> = hasSqlite ? ['memory', 'sqlite'] : ['memory'];

type Doc = { key: string; text: string };

/** An index of one-line documents, built on the named backend and queried keyword-only. */
async function indexOf(backend: 'memory' | 'sqlite', docs: Doc[]): Promise<SearchIndex> {
  const index = await createSearchIndex({
    embedder: null,
    logger: silentLogger,
    backend,
    jsonPath: '',
  });
  await index.build(docs.map((d) => ({ key: d.key, data: { itemType: 'book', title: 'Fixture', abstractNote: d.text } })));
  return index;
}

async function hits(index: SearchIndex, q: string): Promise<string[]> {
  const found = await index.query(q, { limit: 5, mode: 'keyword' });
  return [...new Set(found.map((h) => h.itemKey))];
}

describe.each(backends)('accent folding (%s backend)', (backend) => {
  async function oneDoc(text: string): Promise<SearchIndex> {
    return indexOf(backend, [{ key: 'D', text }]);
  }

  it('finds an accented word from the accented spelling', async () => {
    const index = await oneDoc('un élève très appliqué');
    expect(await hits(index, 'élève')).toEqual(['D']);
    await index.close();
  });

  it('finds the accented document from the unaccented spelling', async () => {
    const index = await oneDoc('un élève très appliqué');
    expect(await hits(index, 'eleve')).toEqual(['D']);
    await index.close();
  });

  it('finds the unaccented document from the accented spelling', async () => {
    const index = await oneDoc('un eleve tres applique');
    expect(await hits(index, 'élève')).toEqual(['D']);
    await index.close();
  });

  it('does not shred a French word into a high-frequency fragment', async () => {
    // The defect, stated as retrieval: "théorie" must not reach an English-only passage.
    const index = await indexOf(backend, [
      { key: 'FR', text: 'théorie économique et réalité industrielle' },
      { key: 'EN', text: 'the theatre thrives on thoughtful themes throughout' },
    ]);
    expect(await hits(index, 'théorie')).toEqual(['FR']);
    await index.close();
  });

  it('keeps a Greek word whole and finds it either cased', async () => {
    const index = await oneDoc('Θεωρία της αξίας στην πολιτική οικονομία');
    expect(await hits(index, 'θεωρία')).toEqual(['D']);
    expect(await hits(index, 'Θεωρία')).toEqual(['D']);
    await index.close();
  });

  it('keeps a Cyrillic word whole', async () => {
    const index = await oneDoc('Теория стоимости');
    expect(await hits(index, 'теория')).toEqual(['D']);
    await index.close();
  });

  it('keeps a CJK run whole', async () => {
    const index = await oneDoc('日本語の研究');
    expect(await hits(index, '日本語の研究')).toEqual(['D']);
    await index.close();
  });

  it('strips Vietnamese tone marks but keeps đ, which is a letter and not a diacritic', async () => {
    // Recorded in tokenize.ts: đ does NOT fold to d. unicode61 keeps it ("đại" indexes as
    // "đai"), so folding it in JS would send the query where the FTS5 index is not — this
    // very defect, re-created for Vietnamese. The cost is that "dai" does not reach it.
    const index = await oneDoc('đại học Việt Nam');
    expect(await hits(index, 'đại')).toEqual(['D']);
    expect(await hits(index, 'Viet')).toEqual(['D']);
    expect(await hits(index, 'Việt')).toEqual(['D']);
    expect(await hits(index, 'dai')).toEqual([]);
    await index.close();
  });

  it('treats ø œ æ ł ß as letters, not as accented forms, because unicode61 does', async () => {
    // The hand map Zotero applies (`ø œ æ ł đ ð þ ß ı`) would fold these to o oe ae l ss,
    // and the FTS5 index holds them unfolded — so the query would land where the index is
    // not. The cost, stated as a test rather than left implicit: the ASCII spelling does
    // not reach them.
    const index = await indexOf(backend, [
      { key: 'NO', text: 'Søren Kierkegaard' },
      { key: 'FR', text: "l'œuvre complète" },
      { key: 'DE', text: 'auf der Straße' },
    ]);
    expect(await hits(index, 'søren')).toEqual(['NO']);
    expect(await hits(index, 'œuvre')).toEqual(['FR']);
    expect(await hits(index, 'straße')).toEqual(['DE']);
    expect(await hits(index, 'soren')).toEqual([]);
    expect(await hits(index, 'oeuvre')).toEqual([]);
    expect(await hits(index, 'strasse')).toEqual([]);
    await index.close();
  });

  /**
   * The letters Zotero's own `normalizeForSearch` hand-maps (`ø œ æ ł đ ð þ ß ı`) are the
   * trap here, which is why they are in this list. unicode61 keeps every one of them, so a
   * hand map copied from Zotero would fold the query somewhere the index is not. Each word
   * must reach a passage spelled exactly as typed; that is the symmetry, asserted without
   * reaching into either tokenizer.
   */
  it.each([
    'élève', 'théorie', 'Việt', 'đại', 'søren', 'œuvre', 'łódź', 'straße', 'ışık',
    'Θεωρία', 'λόγος', 'теория', '日本語', 'naïve', 'École',
  ])('a word reaches a passage spelled the same way: %s', async (word) => {
    const index = await oneDoc(`avant ${word} apres`);
    expect(await hits(index, word)).toEqual(['D']);
    await index.close();
  });

  it('still answers [] rather than throwing when nothing survives tokenization', async () => {
    const index = await oneDoc('un élève très appliqué');
    expect(await hits(index, '!!! ??? ***')).toEqual([]);
    expect(await hits(index, 'the a an of')).toEqual([]);
    expect(await hits(index, '')).toEqual([]);
    expect(await hits(index, '   ')).toEqual([]);
    await index.close();
  });
});

describe('normalizeForSearch', () => {
  it('folds Latin diacritics and case', () => {
    expect(normalizeForSearch('Élève Théorie Straße')).toBe('eleve theorie straße');
  });

  it('leaves non-Latin diacritics alone, because remove_diacritics 2 does', () => {
    expect(normalizeForSearch('Θεωρία')).toBe('θεωρία');
    expect(normalizeForSearch('Йошкар')).toBe('йошкар');
  });

  it('folds the Greek final sigma, because unicode61 does', () => {
    expect(normalizeForSearch('λόγος')).toBe('λόγοσ');
  });

  it('is idempotent', () => {
    for (const s of ['élève', 'Θεωρία', 'đại', '日本語', 'Straße', 'ﬁle']) {
      expect(normalizeForSearch(normalizeForSearch(s))).toBe(normalizeForSearch(s));
    }
  });
});

describe('tokenize', () => {
  it('keeps an accented word as one folded token', () => {
    expect(tokenize('théorie')).toEqual(['theorie']);
    expect(tokenize('élève')).toEqual(['eleve']);
  });

  it('keeps non-Latin words as whole tokens', () => {
    expect(tokenize('Θεωρία')).toEqual(['θεωρία']);
    expect(tokenize('теория')).toEqual(['теория']);
    expect(tokenize('日本語の研究')).toEqual(['日本語の研究']);
  });

  it('still drops stopwords and one-character tokens', () => {
    expect(tokenize('the a of neural x networks')).toEqual(['neural', 'networks']);
  });
});

describe('an index written before the fold answers accented queries after it', () => {
  it('re-tokenizes on load, so no stored index is left stale by this change', async () => {
    // The JSON artifact holds raw passage text, not terms: loadIndex replays it and the
    // BM25 postings are rebuilt from that text. So this change needs no schema bump and no
    // forced rebuild — the derived term set is rebuilt on every load by construction.
    const path = join(mkdtempSync(join(tmpdir(), 'zoteus-fold-')), 'search-index.json');
    const written = new MemorySearchIndex({ embedder: null, logger: silentLogger, path });
    await written.build([
      { key: 'X', data: { itemType: 'thesis', title: 'Scolarité', abstractNote: 'un élève très appliqué' } },
    ]);
    await saveIndex(written, path);

    const reloaded = new MemorySearchIndex({ embedder: null, logger: silentLogger, path });
    expect(await loadIndex(reloaded, path)).toBe(true);
    expect((await reloaded.query('eleve', { limit: 3, mode: 'keyword' }))[0]?.itemKey).toBe('X');
    expect((await reloaded.query('élève', { limit: 3, mode: 'keyword' }))[0]?.itemKey).toBe('X');
  });
});

describe('makeSnippet', () => {
  const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '.repeat(6);

  it('centres on an accented term, which it could not locate before the fold', () => {
    const snippet = makeSnippet(`${filler}un élève très appliqué ${filler}`, 'élève');
    expect(snippet).toContain('élève');
    // Folding the haystack must not fold what is shown: the snippet is display text.
    expect(snippet).not.toContain('eleve ');
  });

  it('locates the accented passage from the unaccented spelling too', () => {
    expect(makeSnippet(`${filler}un élève très appliqué ${filler}`, 'eleve')).toContain('élève');
  });
});

/**
 * The twelve codepoints a sweep caught going the WRONG way.
 *
 * The fold was compared against a real FTS5 table declared with the shipped tokenizer,
 * codepoint by codepoint over Latin, Greek, Cyrillic, Latin Extended Additional, letterlike
 * and number forms, fullwidth and the ligatures — 1 301 codepoints. Before the two shields
 * in tokenize.ts, twelve of them resolved the query to a token the index does not hold,
 * which is this defect's own class on rarer input rather than the harmless narrowing a
 * first reading called it.
 *
 * Pinned here because the sweep itself is not something a pull request runs. The expected
 * values are what `unicode61 remove_diacritics 2` actually stores, read off that
 * comparison — not what a reading of the Unicode tables suggests it ought to.
 */
describe('codepoints unicode61 does not fold the way JavaScript would', () => {
  it('keeps the mark on letters whose base is itself non-ASCII Latin', () => {
    // NFD decomposes these and the mark-stripping rule would give `a æ ʒ æ ø`, each of
    // which is a token other documents really contain — confident and wrong, not empty.
    expect(normalizeForSearch('Ǡ')).toBe('ǡ');
    expect(normalizeForSearch('ǡ')).toBe('ǡ');
    expect(normalizeForSearch('Ǣ')).toBe('ǣ');
    expect(normalizeForSearch('Ǯ')).toBe('ǯ');
    expect(normalizeForSearch('Ǽ')).toBe('ǽ');
    expect(normalizeForSearch('Ǿ')).toBe('ǿ');
    // Still lowercased, because unicode61 does lowercase them — the shield is against the
    // mark stripping alone, not against the whole fold.
    expect(normalizeForSearch('ǠǢǮǼǾ')).toBe('ǡǣǯǽǿ');
  });

  it('leaves alone the two Greek codepoints unicode61 does not transform', () => {
    // U+037F is newer than unicode61's case table: the index stores it uppercase.
    expect(normalizeForSearch('Ϳ')).toBe('Ϳ');
    // U+0374 is left as-is by SQLite while `normalize` maps it to U+02B9 — two codepoints
    // that print alike and never match.
    expect(normalizeForSearch('ʹ')).toBe('ʹ');
  });

  it('shields nothing when the text contains none of them, and does not leak a placeholder', () => {
    // The shield hides characters behind U+FDD0..U+FDEF noncharacters. A restore that
    // failed would leave one of those in a token, and it would match nothing forever.
    const folded = normalizeForSearch("Théorie générale de l'emploi Ǽ Ϳ");
    expect(folded).toBe("theorie generale de l'emploi ǽ Ϳ");
    expect(/[﷐-﷯]/u.test(folded)).toBe(false);
    expect(normalizeForSearch('plain ascii text')).toBe('plain ascii text');
  });
});
