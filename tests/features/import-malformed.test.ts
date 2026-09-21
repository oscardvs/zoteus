import { describe, it, expect } from 'vitest';
import { bibtexToRecords, parseBibtex } from '../../src/features/import/bibtex.js';
import { cslJsonToRecords } from '../../src/features/import/csl-json.js';
import { decodeLatex } from '../../src/features/import/latex.js';
import { mappingTables, toZoteroItems } from '../../src/features/import/mapping.js';
import { parseBibliography, sniffFormat } from '../../src/features/import/parse.js';
import { risToRecords } from '../../src/features/import/ris.js';

/**
 * The import parsers read text a user pasted or downloaded, so malformed and hostile input
 * is the normal case rather than the exception. Each test here is a defect that shipped:
 * a payload that froze the whole server, a typo that silently dropped 197 of 200 entries,
 * values deleted without a word, and lookups that answered with Object.prototype.
 */

const OFFLINE = mappingTables(undefined);

describe('sniffFormat on a payload that is not a bibliography', () => {
  it('does not scan a run of blank lines quadratically', () => {
    // `/^\s*@.../m` matched at every line start and let `\s*` cross newlines, so the engine
    // ate the whole remaining run at each line start and backtracked a character at a time.
    // 128 KB took eight seconds; the 2 MB the tool accepts took tens of minutes, during
    // which the single-threaded server answered nothing at all.
    const payload = `Dear colleague,\n${'\n'.repeat(120_000)}`;
    const started = performance.now();
    const format = sniffFormat(payload);
    const elapsed = performance.now() - started;
    expect(format).toBeUndefined();
    expect(elapsed).toBeLessThan(1000);
  }, 60_000);

  it('still recognises each format, including an opener after blank lines', () => {
    expect(sniffFormat('\n\n\n@article{key,\n  title = {T}\n}')).toBe('bibtex');
    expect(sniffFormat('% a comment line\n@Book (k,\n  title = {T})')).toBe('bibtex');
    expect(sniffFormat('TY  - JOUR\nTI  - A study\nER  - \n')).toBe('ris');
    expect(sniffFormat('[{"type":"book"}]')).toBe('csljson');
  });
});

describe('a .bib whose value opens a delimiter that is never closed', () => {
  const entry = (key: string, title: string): string =>
    `@article{${key},\n  title = ${title}\n  author = {Ada Lovelace},\n  year = {2001}\n}\n\n`;
  // The stray "{" is never closed, so every later entry's braces balance inside it and the
  // reader used to consume the rest of the file into this one title.
  const file = entry('key1', '{First},') + entry('key2', '{Unclosed {brace,') + entry('key3', '{Third},');

  it('reads the entries after the broken one instead of swallowing the file', () => {
    const { records } = bibtexToRecords(file);
    expect(records.map((r) => r.label)).toEqual(['key1', 'key2', 'key3']);
    expect(records[2]!.fields.title).toBe('Third');
  });

  it('does not keep the rest of the file as that entry’s title', () => {
    const { records } = bibtexToRecords(file);
    expect(records[1]!.fields.title ?? '').not.toMatch(/@article/);
    expect((records[1]!.fields.title ?? '').length).toBeLessThan(40);
  });

  it('names the entry and the field rather than reporting only "not closed properly"', () => {
    const { warnings } = bibtexToRecords(file);
    expect(warnings.join(' ')).toMatch(/entry "key2" \(@article\): the value of "title" opens a brace that is never closed/);
    expect(warnings.join(' ')).toMatch(/Reading resumed at the next entry/);
  });

  it('counts the entries buried in what it could not read, when it cannot resynchronise', () => {
    // Everything on one line: there is no next line to resume at, so the entries inside the
    // runaway value are gone and the warning has to say how many.
    const oneLine = '@article{a, title = {Unclosed {brace, @article{b, title={B}} @article{c, title={C}}';
    const { records, warnings } = bibtexToRecords(oneLine);
    expect(records).toHaveLength(1);
    expect(warnings.join(' ')).toMatch(/2 further entries were inside what could not be read and were skipped/);
  });

  it('recovers from an unterminated quoted value the same way', () => {
    const { records, warnings } = bibtexToRecords(
      '@article{a, title = "Unclosed, year = {2020}}\n\n@article{b, title = {B}}\n',
    );
    expect(records.map((r) => r.label)).toEqual(['a', 'b']);
    expect(records[1]!.fields.title).toBe('B');
    expect(warnings.join(' ')).toMatch(/the value of "title" opens a quotation mark that is never closed/);
  });

  it('still keeps what it read from an entry that simply ends with the file', () => {
    const broken = parseBibtex('@article{open2020,\n  title = {A title},\n  year = {2020}\n');
    expect(broken.entries[0]!.fields.title).toBe('A title');
    expect(broken.warnings.join(' ')).toMatch(/not closed properly/);
  });

  it('keeps the parse linear when every entry in a large file is broken', () => {
    // Resynchronising by scanning to the end of the file would cost the length of the file
    // once per broken entry: quadratic, and a new way to hang the server.
    const hostile = '@article{k,t={\n'.repeat(60_000);
    const started = performance.now();
    const { entries } = parseBibtex(hostile);
    const elapsed = performance.now() - started;
    expect(entries.length).toBe(60_000);
    expect(elapsed).toBeLessThan(5000);
  }, 60_000);
});

describe('a .bib that repeats a field name inside one entry', () => {
  it('keeps both creators instead of the last one only', () => {
    const { records, warnings } = bibtexToRecords('@article{k, author={A B}, author={C D}, title={T}}');
    expect(records[0]!.creators).toEqual([
      { cslName: 'author', family: 'B', given: 'A' },
      { cslName: 'author', family: 'D', given: 'C' },
    ]);
    expect(warnings.join(' ')).toMatch(/entry "k" \(@article\): the field "author" appears more than once/);
  });

  it('keeps every keyword from a repeated keywords field', () => {
    const { records } = bibtexToRecords('@article{k, title={T}, keywords={x}, keywords={y}}');
    expect(records[0]!.tags).toEqual(['x', 'y']);
  });

  it('keeps the first value of any other repeated field, and says it did', () => {
    const { records, warnings } = bibtexToRecords('@article{k, title={T}, volume={1}, volume={2}}');
    expect(records[0]!.fields.volume).toBe('1');
    expect(warnings.join(' ')).toMatch(/the field "volume" appears more than once.*the first value was kept/);
  });
});

describe('RIS tags that repeat or collide on one CSL variable', () => {
  const record = [
    'TY  - JOUR',
    'TI  - A study',
    'AB  - Short abstract.',
    'N2  - BACKGROUND: the long structured abstract.',
    'DO  - 10.1234/abc',
    'UR  - https://doi.org/10.1234/abc',
    'UR  - https://search.ebscohost.com/permalink',
    'ER  - ',
    '',
  ].join('\n');

  it('keeps the surplus values in Extra instead of deleting them', () => {
    const { records } = risToRecords(record);
    expect(records[0]!.fields.URL).toBe('https://doi.org/10.1234/abc');
    expect(records[0]!.extra).toContain('UR: https://search.ebscohost.com/permalink');
    expect(records[0]!.extra).toContain('N2: BACKGROUND: the long structured abstract.');
  });

  it('says which tags it could not fit, which its own comment promised and never did', () => {
    const { warnings } = risToRecords(record);
    expect(warnings.join(' ')).toMatch(/A study: .*N2.*UR.* gave a second value for a field that was already filled/);
    expect(warnings.join(' ')).toMatch(/kept in Extra rather than dropped/);
  });

  it('says nothing about an exact duplicate, which is what PubMed and EndNote emit', () => {
    const { records, warnings } = risToRecords(
      'TY  - JOUR\nTI  - A study\nT1  - A study\nAB  - The same text.\nN2  - The same text.\nJO  - J. Things\nJF  - J. Things\nER  - \n',
    );
    expect(records[0]!.extra).toEqual([]);
    expect(warnings.join(' ')).not.toMatch(/gave a second value/);
  });
});

describe('a name from the payload that is also a member of Object.prototype', () => {
  it('does not turn a bare value of "constructor" into a function', () => {
    const { records } = bibtexToRecords('@article{k, title = constructor, year = 2020}');
    expect(records[0]!.fields.title).toBe('constructor');
  });

  it('does not make a field called "constructor" an author', () => {
    const { records } = bibtexToRecords('@article{k2, constructor = {Ada Lovelace}, title = {T}}');
    expect(records[0]!.creators).toEqual([]);
    expect(records[0]!.extra).toContain('constructor: Ada Lovelace');
  });

  it('reports an entry type of "constructor" as having no Zotero equivalent', () => {
    const { records, warnings } = bibtexToRecords('@constructor{k3, title={T}}');
    expect(records[0]!.cslType).toBe('document');
    expect(warnings.join(' ')).toMatch(/BibTeX type "@constructor" has no Zotero equivalent/);
  });

  it('does not expand a "\\constructor" command into native code', () => {
    expect(decodeLatex('Ada \\constructor Lovelace')).toBe('Ada Lovelace');
  });

  it('maps a CSL-JSON type of "constructor" instead of throwing out of the whole batch', () => {
    const { records } = cslJsonToRecords('[{"type":"constructor","title":"X"},{"type":"book","title":"Y"}]');
    const { items, warnings } = toZoteroItems(records, OFFLINE);
    expect(items.map((i) => i.itemType)).toEqual(['document', 'book']);
    expect(warnings.join(' ')).toMatch(/Zotero has no item type for CSL type "constructor"/);
  });
});

describe('a LaTeX value that nests accent groups without end', () => {
  it('stops decoding rather than exhausting the stack', () => {
    const deep = `${"\\'{".repeat(20_000)}a${'}'.repeat(20_000)}`;
    expect(() => decodeLatex(deep)).not.toThrow();
  }, 60_000);

  it('does not let one such entry fail the whole file', () => {
    const deep = `${"\\'{".repeat(20_000)}a${'}'.repeat(20_000)}`;
    const { records } = parseBibliography(`@article{deep, title = {${deep}}}\n\n@article{ok, title = {Fine}}\n`, 'bibtex');
    expect(records.map((r) => r.label)).toEqual(['deep', 'ok']);
    expect(records[1]!.fields.title).toBe('Fine');
  }, 60_000);
});
