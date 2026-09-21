import { describe, it, expect } from 'vitest';
import { parseRis, risToRecords } from '../../src/features/import/ris.js';
import { RIS_FIXTURE } from '../fixtures/bibliographies/index.js';

describe('parseRis', () => {
  const parsed = parseRis(RIS_FIXTURE);

  it('reads each record between TY and ER', () => {
    expect(parsed.records.map((r) => r.ty)).toEqual(['JOUR', 'BOOK', 'AGGR']);
  });

  it('joins a value that continues on the next line', () => {
    expect(parsed.records[0]!.tags.TI).toEqual([
      'Notes on the Analytical Engine and the Mechanical Computation of Bernoulli Numbers',
    ]);
    expect(parsed.records[0]!.tags.AB).toEqual(['A long abstract that runs across two lines in the file.']);
  });

  it('keeps every repeat of a tag that repeats', () => {
    expect(parsed.records[0]!.tags.AU).toEqual(['Lovelace, Ada', 'Babbage, Charles']);
    expect(parsed.records[0]!.tags.KW).toEqual(['computing history', 'analytical engine']);
  });

  it('reports the record that has no ER, and reads it anyway', () => {
    expect(parsed.records[2]!.tags.TI).toEqual(['A record whose type RIS has and Zotero does not']);
    expect(parsed.warnings.join(' ')).toMatch(/has no ER line/);
  });

  it('accepts a single space before the dash, which exporters emit', () => {
    const loose = parseRis('TY - JOUR\nTI - One space\nER - \n');
    expect(loose.records[0]!.tags.TI).toEqual(['One space']);
  });

  it('starts a new record when a second TY arrives without an ER', () => {
    const run = parseRis('TY  - JOUR\nTI  - First\nTY  - BOOK\nTI  - Second\nER  - \n');
    expect(run.records.map((r) => r.ty)).toEqual(['JOUR', 'BOOK']);
    expect(run.warnings.join(' ')).toMatch(/has no ER line/);
  });

  it('says so when the payload looks like RIS but holds no record', () => {
    const none = parseRis('XX  - only a tag that is not TY and never terminates');
    expect(none.records).toHaveLength(1); // read as an untyped record rather than discarded
    expect(none.warnings.join(' ')).toMatch(/has no ER line/);
  });
});

describe('risToRecords', () => {
  const { records, warnings } = risToRecords(RIS_FIXTURE);

  it('maps TY to a CSL type', () => {
    expect(records.map((r) => r.cslType)).toEqual(['article-journal', 'book', 'document']);
  });

  it('names the record whose TY has no Zotero equivalent', () => {
    expect(warnings.join(' ')).toMatch(/RIS type "TY {2}- AGGR" has no Zotero equivalent/);
  });

  it('splits every author, and reads A2 as an editor', () => {
    expect(records[0]!.creators).toEqual([
      { cslName: 'author', family: 'Lovelace', given: 'Ada' },
      { cslName: 'author', family: 'Babbage', given: 'Charles' },
    ]);
    expect(records[1]!.creators).toEqual([
      { cslName: 'author', family: 'Hodges', given: 'Andrew' },
      { cslName: 'editor', family: 'Smith', given: 'Jane' },
    ]);
  });

  it('joins SP and EP into one page span', () => {
    expect(records[0]!.fields.page).toBe('666-731');
  });

  it('reduces a slash-padded RIS date to its ISO prefix', () => {
    expect(records[0]!.fields.issued).toBe('1843-09');
    expect(records[1]!.fields.issued).toBe('2014');
  });

  it('tells an ISSN from an ISBN in SN', () => {
    expect(records[0]!.fields.ISSN).toBe('0044-2267');
    expect(records[0]!.fields.ISBN).toBeUndefined();
    expect(records[1]!.fields.ISBN).toBe('9780691164724');
  });

  it('turns every KW into a tag', () => {
    expect(records[0]!.tags).toEqual(['computing history', 'analytical engine']);
  });

  it('keeps a tag with no field of its own in Extra, under a readable label', () => {
    expect(records[0]!.extra).toContain('Notes: Transcribed from the 1843 printing.');
  });

  it('says a linked local file was not fetched rather than silently ignoring it', () => {
    const { warnings: w } = risToRecords('TY  - JOUR\nTI  - T\nL1  - internal-pdf://1234/paper.pdf\nER  - \n');
    expect(w.join(' ')).toMatch(/points at a local file .* which is not fetched/);
  });
});
