import { describe, it, expect } from 'vitest';
import { bibtexToRecords, parseBibtex } from '../../src/features/import/bibtex.js';
import { decodeLatex, splitTopLevel } from '../../src/features/import/latex.js';
import { BIBTEX_FIXTURE } from '../fixtures/bibliographies/index.js';

describe('decodeLatex', () => {
  it('composes every accent form an export actually uses', () => {
    expect(decodeLatex('Schr\\"{o}dinger')).toBe('Schrödinger');
    expect(decodeLatex('Schr\\"odinger')).toBe('Schrödinger');
    expect(decodeLatex('{\\"O}sterreich')).toBe('Österreich');
    expect(decodeLatex("Garc{\\'i}a")).toBe('García');
    expect(decodeLatex("Jos\\'e")).toBe('José');
    expect(decodeLatex('\\c{C}elik')).toBe('Çelik');
    expect(decodeLatex('Dvo\\v{r}\\\'{a}k')).toBe('Dvořák');
    expect(decodeLatex('\\~{n}')).toBe('ñ');
    expect(decodeLatex('Erd\\H{o}s')).toBe('Erdős');
    // A dotless i under an accent is the standard way to write an accented i.
    expect(decodeLatex("\\'{\\i}")).toBe('í');
  });

  it('handles the single-character commands that are whole letters', () => {
    expect(decodeLatex('Wei\\ss{}enberg')).toBe('Weißenberg');
    expect(decodeLatex('\\o{}stergaard')).toBe('østergaard');
    expect(decodeLatex('\\L{}ukasiewicz')).toBe('Łukasiewicz');
  });

  it('unescapes the characters LaTeX reserves', () => {
    expect(decodeLatex('50\\% \\& more \\_ and \\$5 \\#1')).toBe('50% & more _ and $5 #1');
  });

  it('drops grouping braces but keeps what they protect', () => {
    expect(decodeLatex('The {DNA} of {Software {Systems}}')).toBe('The DNA of Software Systems');
  });

  it('drops a styling command and keeps its argument', () => {
    expect(decodeLatex('an \\emph{in vivo} study')).toBe('an in vivo study');
    expect(decodeLatex('\\url{https://example.org/x}')).toBe('https://example.org/x');
  });

  it('collapses the whitespace a wrapped value carries', () => {
    expect(decodeLatex('a title that\n      wraps across lines')).toBe('a title that wraps across lines');
  });
});

describe('splitTopLevel', () => {
  it('does not split inside braces', () => {
    expect(splitTopLevel('{Smith and Sons} and Ada Lovelace', /\s+and\s+/i)).toEqual([
      '{Smith and Sons}',
      'Ada Lovelace',
    ]);
  });
});

describe('parseBibtex', () => {
  const parsed = parseBibtex(BIBTEX_FIXTURE);

  it('reads every entry and skips @comment and @preamble', () => {
    expect(parsed.entries.map((e) => e.key)).toEqual(['schrodinger1926', 'lovelace1843', 'turing1938', 'odd2026']);
    expect(parsed.entries.map((e) => e.type)).toEqual(['article', 'inproceedings', 'phdthesis', 'artifact']);
  });

  it('expands an @string macro used as a bare value', () => {
    expect(parsed.entries[0]!.fields.journal).toBe('IEEE Transactions on Software Engineering');
  });

  it('reads a quoted value that contains braces and escapes', () => {
    expect(parsed.entries[0]!.fields.abstract).toBe('A quoted value with {braces}, a 50\\% escape \\& an ampersand.');
  });

  it('keeps nested braces intact for the decoder', () => {
    expect(parsed.entries[0]!.fields.title).toBe('An Undulatory Theory of the {Mechanics} of {Atoms {and} Molecules}');
  });

  it('reads a bare numeric value', () => {
    expect(parsed.entries[1]!.fields.year).toBe('1843');
  });

  it('reports no warnings for a well-formed file', () => {
    expect(parsed.warnings).toEqual([]);
  });

  it('keeps what it could read from an entry that is never closed', () => {
    const broken = parseBibtex('@article{open2020,\n  title = {A title},\n  year = {2020}\n');
    expect(broken.entries[0]!.fields.title).toBe('A title');
    expect(broken.warnings.join(' ')).toMatch(/not closed properly/);
  });

  it('says so when the payload looks like BibTeX but holds no entry', () => {
    const none = parseBibtex('@ nonsense with no delimiter');
    expect(none.entries).toEqual([]);
    expect(none.warnings.join(' ')).toMatch(/no complete entry/);
  });

  it('accepts parenthesised entry delimiters', () => {
    const paren = parseBibtex('@misc(x2020, title = {Round brackets}, year = {2020})');
    expect(paren.entries[0]!.fields.title).toBe('Round brackets');
  });

  it('concatenates with # and substitutes macros on both sides', () => {
    const joined = parseBibtex('@string{pre = {Proc. }}\n@misc{k, title = pre # {of Nothing}}');
    expect(joined.entries[0]!.fields.title).toBe('Proc. of Nothing');
  });
});

describe('bibtexToRecords', () => {
  const { records, warnings } = bibtexToRecords(BIBTEX_FIXTURE);

  it('splits creators on the top-level "and" and keeps an organisation whole', () => {
    expect(records[0]!.creators).toEqual([
      { cslName: 'author', family: 'Schrödinger', given: 'Erwin' },
      { cslName: 'author', family: 'García', given: 'José' },
      { cslName: 'author', literal: 'Institute of Physics' },
    ]);
  });

  it('does not split a publisher that happens to contain "and"', () => {
    expect(records[1]!.fields.publisher).toBe('Richard and John E. Taylor');
  });

  it('folds year and a month macro into one date', () => {
    expect(records[0]!.fields.issued).toBe('1926-12');
    expect(records[1]!.fields.issued).toBe('1843');
  });

  it('normalises an en-dash page range to a plain hyphen', () => {
    expect(records[0]!.fields.page).toBe('1049-1070');
  });

  it('turns keywords into tags', () => {
    expect(records[0]!.tags).toEqual(['quantum mechanics', 'wave functions']);
  });

  it('routes booktitle to the container when the entry has its own title', () => {
    expect(records[1]!.cslType).toBe('paper-conference');
    expect(records[1]!.fields.title).toBe('Notes by the Translator');
    expect(records[1]!.fields['container-title']).toBe("Taylor's Scientific Memoirs");
  });

  it('names the entry whose type has no Zotero equivalent instead of silently guessing', () => {
    const odd = records[3]!;
    expect(odd.cslType).toBe('document');
    expect(warnings.join(' ')).toMatch(/odd2026: BibTeX type "@artifact" has no Zotero equivalent/);
  });

  it('keeps a field with no CSL home in Extra rather than dropping it', () => {
    const thesis = records[2]!;
    expect(thesis.fields.publisher).toBe('Princeton University');
    expect(thesis.fields.genre).toBe('PhD thesis');
  });

  it('warns rather than pretending a crossref was followed', () => {
    const { warnings: w } = bibtexToRecords('@inproceedings{a, title = {T}, crossref = {proc2020}}');
    expect(w.join(' ')).toMatch(/crossref, which is not resolved here/);
  });
});
