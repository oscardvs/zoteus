import { describe, it, expect } from 'vitest';
import { bibtexToRecords } from '../../src/features/import/bibtex.js';
import { cslJsonToRecords } from '../../src/features/import/csl-json.js';
import { mappingTables, toZoteroItem, toZoteroItems } from '../../src/features/import/mapping.js';
import { parseBibliography, sniffFormat } from '../../src/features/import/parse.js';
import { risToRecords } from '../../src/features/import/ris.js';
import { validateItem } from '../../src/schema/validate.js';
import { BIBTEX_FIXTURE, CSLJSON_FIXTURE, RIS_FIXTURE } from '../fixtures/bibliographies/index.js';
import { SCHEMA_SLICE } from '../fixtures/zotero-schema.js';

const LIVE = mappingTables(SCHEMA_SLICE);
const OFFLINE = mappingTables(undefined);

describe('mappingTables', () => {
  it('reads the live schema when there is one, and says so', () => {
    expect(LIVE.origin).toBe('schema');
    expect(LIVE.itemTypes?.has('conferencePaper')).toBe(true);
  });

  it('falls back to the frozen snapshot with no schema, and says so', () => {
    expect(OFFLINE.origin).toBe('snapshot');
    expect(OFFLINE.itemTypes).toBeUndefined();
    expect(OFFLINE.types['article-journal']).toEqual(['journalArticle']);
  });

  it('inverts the schema creator table, which is written the other way round', () => {
    expect(LIVE.creatorTypes.author).toBe('author');
    expect(LIVE.creatorTypes['collection-editor']).toBe('seriesEditor');
  });
});

describe('toZoteroItems, mapping through the live schema', () => {
  const { items } = toZoteroItems(bibtexToRecords(BIBTEX_FIXTURE).records, LIVE);

  it('maps a journal article onto its own fields', () => {
    expect(items[0]).toMatchObject({
      itemType: 'journalArticle',
      title: 'An Undulatory Theory of the Mechanics of Atoms and Molecules',
      publicationTitle: 'IEEE Transactions on Software Engineering',
      volume: '28',
      issue: '6',
      pages: '1049-1070',
      DOI: '10.1103/PhysRev.28.1049',
      date: '1926-12',
    });
    expect(items[0]!.tags).toEqual([{ tag: 'quantum mechanics' }, { tag: 'wave functions' }]);
  });

  it('follows a base field to the type-specific field, instead of writing a field that does not exist', () => {
    // csl.fields.text says container-title lives in `publicationTitle`; a conferencePaper has
    // no such field, only `proceedingsTitle` with `baseField: "publicationTitle"`.
    expect(items[1]).toMatchObject({
      itemType: 'conferencePaper',
      proceedingsTitle: "Taylor's Scientific Memoirs",
      place: 'London',
      publisher: 'Richard and John E. Taylor',
    });
    expect(items[1]!.publicationTitle).toBeUndefined();
  });

  it('does the same for a thesis, whose publisher is called university', () => {
    expect(items[2]).toMatchObject({
      itemType: 'thesis',
      university: 'Princeton University',
      thesisType: 'PhD thesis',
    });
  });

  it('parks a field the item type has no home for in Extra, rather than dropping it', () => {
    // `howpublished` becomes CSL `medium`, and `document` has no medium field.
    expect(String(items[3]!.extra)).toMatch(/medium: https:\/\/example\.org\/thing/);
  });

  it('produces items the schema validator accepts', () => {
    for (const item of items) {
      const result = validateItem(SCHEMA_SLICE, item);
      expect(result.errors, JSON.stringify(item)).toEqual([]);
    }
  });
});

describe('toZoteroItems, mapping from the offline snapshot', () => {
  const { items } = toZoteroItems(bibtexToRecords(BIBTEX_FIXTURE).records, OFFLINE);

  it('still produces the right item types', () => {
    expect(items.map((i) => i.itemType)).toEqual(['journalArticle', 'conferencePaper', 'thesis', 'document']);
  });

  it('takes the first candidate field, which is measurably worse and is why the result says which was used', () => {
    // With no per-type field list, `container-title` lands on the base field name.
    expect(items[1]!.publicationTitle).toBe("Taylor's Scientific Memoirs");
    expect(items[1]!.proceedingsTitle).toBeUndefined();
  });
});

describe('creator roles the item type does not allow', () => {
  it('demotes to the type primary creator and says it did', () => {
    const record = {
      cslType: 'article-journal',
      fields: { title: 'A paper' },
      creators: [{ cslName: 'collection-editor', family: 'Smith', given: 'Jane' }],
      tags: [],
      extra: [],
      label: 'smith',
    };
    const { item, warnings } = toZoteroItem(record, LIVE);
    // journalArticle allows author/contributor/editor/translator/reviewedAuthor, not seriesEditor.
    expect(item.creators).toEqual([{ creatorType: 'author', firstName: 'Jane', lastName: 'Smith' }]);
    expect(warnings.join(' ')).toMatch(/not one Zotero allows on "journalArticle"/);
    expect(validateItem(SCHEMA_SLICE, item).errors).toEqual([]);
  });
});

describe('RIS through the mapper', () => {
  const { items } = toZoteroItems(risToRecords(RIS_FIXTURE).records, LIVE);

  it('maps the journal record completely', () => {
    expect(items[0]).toMatchObject({
      itemType: 'journalArticle',
      publicationTitle: "Taylor's Scientific Memoirs",
      volume: '3',
      issue: '1',
      pages: '666-731',
      ISSN: '0044-2267',
      DOI: '10.1234/analytical.engine',
      date: '1843-09',
    });
  });

  it('keeps the editor on a book, where the type allows one', () => {
    expect(items[1]!.creators).toEqual([
      { creatorType: 'author', firstName: 'Andrew', lastName: 'Hodges' },
      { creatorType: 'editor', firstName: 'Jane', lastName: 'Smith' },
    ]);
  });

  it('produces items the schema validator accepts', () => {
    for (const item of items) expect(validateItem(SCHEMA_SLICE, item).errors).toEqual([]);
  });
});

describe('CSL-JSON through the mapper', () => {
  const { records, warnings } = cslJsonToRecords(CSLJSON_FIXTURE);
  const { items } = toZoteroItems(records, LIVE);

  it('reads both date shapes', () => {
    expect(items[0]!.date).toBe('1978-08');
    expect(items[1]!.date).toBe('2019');
  });

  it('keeps a literal name as a single-field creator', () => {
    expect(items[1]!.creators).toEqual([
      { creatorType: 'author', name: 'International Organization for Standardization' },
    ]);
  });

  it('turns a keyword string into tags', () => {
    expect(items[0]!.tags).toEqual([{ tag: 'concurrency' }, { tag: 'processes' }]);
  });

  it('reports nothing wrong with a well-formed payload', () => {
    expect(warnings).toEqual([]);
  });

  it('refuses a payload that is not a list of objects, naming what it wanted', () => {
    expect(() => cslJsonToRecords('{"title":"not a list"}')).toThrow(/array of item objects/);
    expect(() => cslJsonToRecords('not json at all')).toThrow(/not valid JSON/);
  });

  it('skips a non-object entry and says which', () => {
    const { records: r, warnings: w } = cslJsonToRecords('[3, {"type":"book","title":"Real"}]');
    expect(r).toHaveLength(1);
    expect(w.join(' ')).toMatch(/entry 1 is not an object/);
  });
});

describe('sniffFormat', () => {
  it('recognises each of the three formats from the payload', () => {
    expect(sniffFormat(BIBTEX_FIXTURE)).toBe('bibtex');
    expect(sniffFormat(RIS_FIXTURE)).toBe('ris');
    expect(sniffFormat(CSLJSON_FIXTURE)).toBe('csljson');
  });

  it('returns nothing rather than guessing at something else', () => {
    expect(sniffFormat('Smith, J. (2020). A paper. Journal of Things, 4(2), 1-10.')).toBeUndefined();
    expect(sniffFormat('   ')).toBeUndefined();
  });

  it('sees past a byte-order mark', () => {
    expect(sniffFormat(`\uFEFF${RIS_FIXTURE}`)).toBe('ris');
  });

  it('parseBibliography dispatches to the parser the format names', () => {
    expect(parseBibliography(BIBTEX_FIXTURE, 'bibtex').records).toHaveLength(4);
    expect(parseBibliography(RIS_FIXTURE, 'ris').records).toHaveLength(3);
    expect(parseBibliography(CSLJSON_FIXTURE, 'csljson').records).toHaveLength(2);
  });
});
