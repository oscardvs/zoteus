import { describe, it, expect, vi } from 'vitest';
import { DuplicateIndex, duplicateIndexFor, findDuplicates, incompleteScanNote } from '../../src/features/dedupe/find.js';
import { doiFrom, isbnKeys, libraryCensusReport, titleKey } from '../../src/features/resolve/library-census.js';

/** A library as the router lists it: one page, or several of 100. */
function routerOf(items: any[], totalResults = items.length): any {
  const searchItems = vi.fn(async ({ start = 0, limit = 100 }: any) => ({
    data: items.slice(start, start + limit),
    totalResults,
    lastModifiedVersion: 1,
  }));
  return { ctx: { router: { searchItems } } as any, searchItems };
}

const item = (key: string, data: Record<string, unknown>) => ({ key, version: 1, data: { key, ...data } });

describe('library census', () => {
  it('reports a complete crawl as complete, and pages until the end', async () => {
    const items = Array.from({ length: 250 }, (_, i) => item(`K${i}`, { title: `Paper ${i}`, itemType: 'journalArticle' }));
    const { ctx, searchItems } = routerOf(items);
    const report = await libraryCensusReport(ctx);
    expect(report.scanned).toBe(250);
    expect(report.complete).toBe(true);
    expect(report.totalResults).toBe(250);
    expect(searchItems).toHaveBeenCalledTimes(3);
    // Child notes and attachments must never enter the census, or a note titled like its
    // parent becomes a duplicate of it.
    expect(searchItems.mock.calls[0]![0].top).toBe(true);
  });

  it('marks a crawl stopped by the cap as incomplete', async () => {
    const items = Array.from({ length: 120 }, (_, i) => item(`K${i}`, { title: `Paper ${i}` }));
    const { ctx } = routerOf(items);
    const report = await libraryCensusReport(ctx, undefined, 50);
    expect(report.scanned).toBe(50);
    expect(report.complete).toBe(false);
    expect(incompleteScanNote(new DuplicateIndex(report))).toMatch(/stopped after 50 of 120/);
  });

  it('is complete when the cap and the library are the same size', async () => {
    const items = Array.from({ length: 40 }, (_, i) => item(`K${i}`, { title: `Paper ${i}` }));
    const { ctx } = routerOf(items);
    const report = await libraryCensusReport(ctx, undefined, 40);
    expect(report.complete).toBe(true);
    expect(incompleteScanNote(new DuplicateIndex(report))).toBeUndefined();
  });

  it('passes the caller\'s library through, so a group import is not cleared against the personal library', async () => {
    const { ctx, searchItems } = routerOf([]);
    await duplicateIndexFor(ctx, { type: 'group', id: 5234875 });
    expect(searchItems.mock.calls[0]![0].library).toEqual({ type: 'group', id: 5234875 });
  });
});

describe('duplicate detection', () => {
  const library = [
    item('DOIONE1', { itemType: 'journalArticle', title: 'Deep learning', DOI: 'https://doi.org/10.1038/NATURE14539', date: '2015-05-27' }),
    item('ISBNONE', { itemType: 'book', title: 'Pattern recognition and machine learning', ISBN: '978-0-387-31073-2', date: '2006' }),
    item('TITLEON', { itemType: 'preprint', title: 'Attention Is All You Need!', date: '2017' }),
    item('OTHER01', { itemType: 'journalArticle', title: 'Something else entirely', DOI: '10.1/other' }),
  ];

  async function index() {
    const { ctx } = routerOf(library);
    return duplicateIndexFor(ctx);
  }

  it('matches on the DOI regardless of case and doi.org prefix', async () => {
    const matches = (await index()).matchesFor({ DOI: '10.1038/nature14539', title: 'A completely different title' });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ item_key: 'DOIONE1', matchedOn: 'doi', value: '10.1038/nature14539' });
  });

  it('matches on the ISBN regardless of hyphenation', async () => {
    const matches = (await index()).matchesFor({ ISBN: '9780387310732' });
    expect(matches[0]).toMatchObject({ item_key: 'ISBNONE', matchedOn: 'isbn' });
  });

  it('matches on the normalised title, ignoring case and punctuation', async () => {
    const matches = (await index()).matchesFor({ title: 'attention is all you need', date: '2017' });
    expect(matches[0]).toMatchObject({ item_key: 'TITLEON', matchedOn: 'title', value: 'attention is all you need' });
  });

  it('accepts a one-year gap on a title match (preprint then journal), but not a decade', async () => {
    const idx = await index();
    expect(idx.matchesFor({ title: 'Attention is all you need', date: '2018-06' })).toHaveLength(1);
    expect(idx.matchesFor({ title: 'Attention is all you need', date: '2029' })).toEqual([]);
  });

  it('prefers the DOI over the title, so one candidate never reports two kinds of claim', async () => {
    const matches = (await index()).matchesFor({
      DOI: '10.1038/nature14539',
      title: 'Attention is all you need',
      date: '2017',
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]!.matchedOn).toBe('doi');
  });

  it('reports nothing for a work the library does not hold', async () => {
    const matches = (await index()).matchesFor({ DOI: '10.5555/unknown', title: 'A brand new paper', date: '2026' });
    expect(matches).toEqual([]);
  });

  it('never matches an item against itself', async () => {
    const matches = (await index()).matchesFor({ key: 'DOIONE1', DOI: '10.1038/nature14539', title: 'Deep learning' });
    expect(matches).toEqual([]);
  });

  it('checks every candidate against one crawl of the library', async () => {
    const { ctx, searchItems } = routerOf(library);
    const idx = await duplicateIndexFor(ctx);
    const found = findDuplicates(idx, [
      { title: 'Deep learning', DOI: '10.1038/nature14539' },
      { title: 'Nothing like it', DOI: '10.9/none' },
    ]);
    expect(searchItems).toHaveBeenCalledTimes(1);
    expect(found[0]!.matches[0]!.item_key).toBe('DOIONE1');
    expect(found[0]!.candidateTitle).toBe('Deep learning');
    expect(found[1]!.matches).toEqual([]);
  });
});

describe('title normalisation', () => {
  it('keeps letters of every script, so two unrelated titles do not collide on one Latin token', () => {
    // Both of these used to reduce to "bert", because every CJK codepoint was deleted.
    expect(titleKey('基于BERT的中文文本分类研究')).not.toBe(titleKey('BERT模型在问答系统中的应用'));
    expect(titleKey('深層学習')).toBe('深層学習');
    expect(titleKey('Анализ данных 2019')).not.toBe(titleKey('Заключение 2019'));
  });

  it('still folds case, accents and punctuation, which is all it ever claimed to do', () => {
    expect(titleKey('Attention Is All You Need!')).toBe('attention is all you need');
    expect(titleKey('Théorie des ensembles')).toBe('theorie des ensembles');
    expect(titleKey('Kalman filters: a re-introduction')).toBe('kalman filters a re introduction');
    expect(titleKey('   ')).toBeUndefined();
  });

  it('refuses a match between two unrelated non-Latin papers end to end', async () => {
    const { ctx } = routerOf([
      item('CJK0001', { itemType: 'journalArticle', title: '基于BERT的中文文本分类研究', date: '2020' }),
    ]);
    const idx = await duplicateIndexFor(ctx);
    expect(idx.matchesFor({ title: 'BERT模型在问答系统中的应用', date: '2021' })).toEqual([]);
    // And a non-Latin title can now be matched against itself, which it never could before.
    expect(idx.matchesFor({ title: '基于BERT的中文文本分类研究', date: '2020' })[0]).toMatchObject({
      item_key: 'CJK0001',
      matchedOn: 'title',
    });
  });
});

describe('the DOI a record carries', () => {
  it('reads the DOI: line in Extra, which is where imported and legacy records keep it', () => {
    expect(doiFrom({ extra: 'DOI: 10.1101/2020.01.01.900001' })).toBe('10.1101/2020.01.01.900001');
    expect(doiFrom({ extra: 'tex.ids: smith2020\nDOI: 10.1/inextra\nPMID: 1234' })).toBe('10.1/inextra');
    // The field still wins when both are present, and neither is invented.
    expect(doiFrom({ DOI: '10.1/field', extra: 'DOI: 10.1/extra' })).toBe('10.1/field');
    expect(doiFrom({ extra: 'no doi here' })).toBeUndefined();
    expect(doiFrom(undefined)).toBeUndefined();
  });

  it('puts an Extra-DOI item in the census, so nothing downstream reads it as having no DOI', async () => {
    const { ctx } = routerOf([
      item('RPT0001', { itemType: 'report', title: 'A grey report', extra: 'DOI: 10.1101/2020.01.01.900001' }),
    ]);
    const report = await libraryCensusReport(ctx);
    expect(report.entries[0]!.doi).toBe('10.1101/2020.01.01.900001');
  });

  it('matches a candidate on an Extra DOI, in both directions', async () => {
    const { ctx } = routerOf([
      item('RPT0001', { itemType: 'report', title: 'A grey report', extra: 'DOI: 10.1101/2020.01.01.900001' }),
    ]);
    const idx = await duplicateIndexFor(ctx);
    expect(idx.matchesFor({ DOI: '10.1101/2020.01.01.900001', title: 'Quite another title' })[0]).toMatchObject({
      item_key: 'RPT0001',
      matchedOn: 'doi',
    });
    expect(idx.matchesFor({ extra: 'DOI: 10.1101/2020.01.01.900001', title: 'Quite another title' })[0]).toMatchObject({
      item_key: 'RPT0001',
      matchedOn: 'doi',
    });
  });
});

describe('ISBN normalisation', () => {
  it('keeps every ISBN in the field, and the ISBN-13 form of each ISBN-10', () => {
    expect(isbnKeys('0-262-03384-4 978-0-262-03384-8').sort()).toEqual(['0262033844', '9780262033848']);
    expect(isbnKeys('978-0-262-03384-8, 0-262-03384-4').sort()).toEqual(['0262033844', '9780262033848']);
    // A field written with a label yields the ISBN, not the empty remains of the word.
    expect(isbnKeys('ISBN 978-0-262-03384-8')).toEqual(['9780262033848']);
    expect(isbnKeys('0262033844')).toEqual(['0262033844', '9780262033848']);
    expect(isbnKeys('not an isbn')).toEqual([]);
    expect(isbnKeys(undefined)).toEqual([]);
  });

  it('matches one book against itself whichever order the two records list its ISBNs in', async () => {
    const { ctx } = routerOf([
      item('BOOK001', {
        itemType: 'book',
        title: 'Deep learning',
        ISBN: '0-262-03384-4 978-0-262-03384-8',
        date: '2016',
      }),
    ]);
    const idx = await duplicateIndexFor(ctx);
    const reversed = idx.matchesFor({ ISBN: '978-0-262-03384-8, 0-262-03384-4', title: 'Deep learning: adaptive computation' });
    expect(reversed).toHaveLength(1);
    expect(reversed[0]).toMatchObject({ item_key: 'BOOK001', matchedOn: 'isbn' });
    // One printing on each side is still one book, and still reported once.
    expect(idx.matchesFor({ ISBN: '9780262033848', title: 'Anything else' })).toHaveLength(1);
  });
});


describe('different works sharing bibliographic fields', () => {
  it('does not classify different book chapters sharing an ISBN as duplicates', async () => {
    const { ctx } = routerOf([item('CHAPTER1', {
      itemType: 'bookSection', title: 'Introduction', ISBN: '978-0-387-31073-2',
    })]);
    const idx = await duplicateIndexFor(ctx);
    expect(idx.matchesFor({ itemType: 'bookSection', title: 'Conclusions', ISBN: '9780387310732' })).toEqual([]);
    expect(idx.matchesFor({ itemType: 'book', title: 'The whole book', ISBN: '9780387310732' })).toEqual([]);
    expect(idx.matchesFor({ itemType: 'bookSection', title: 'Introduction', ISBN: '9780387310732' })[0]?.item_key).toBe('CHAPTER1');
  });

  it('does not let a weaker title or ISBN match override conflicting DOIs', async () => {
    const { ctx } = routerOf([item('WORK1', {
      itemType: 'book', title: 'Same title', ISBN: '978-0-387-31073-2', DOI: '10.1234/first',
    })]);
    const idx = await duplicateIndexFor(ctx);
    expect(idx.matchesFor({ title: 'Same title', DOI: '10.1234/second' })).toEqual([]);
    expect(idx.matchesFor({ ISBN: '9780387310732', DOI: '10.1234/second' })).toEqual([]);
  });
});
