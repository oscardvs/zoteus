import { describe, it, expect } from 'vitest';
import {
  setArxivMinGapMs,
  parseIdentifier,
  bareDoi,
  arxivItem,
  fromScholarWork,
  foldSpec,
} from '../../src/features/resolve/resolve.js';
import { validateItem } from '../../src/schema/validate.js';
import { SCHEMA_SLICE } from '../fixtures/zotero-schema.js';

describe('parseIdentifier', () => {
  it('classifies bare DOIs', () => {
    expect(parseIdentifier('10.1109/ICRA.2019.8794293')).toEqual({ type: 'doi', value: '10.1109/ICRA.2019.8794293' });
  });

  it('classifies DOI URLs with and without www/dx prefixes', () => {
    expect(parseIdentifier('https://doi.org/10.1234/abc')).toEqual({ type: 'doi', value: '10.1234/abc' });
    expect(parseIdentifier('https://dx.doi.org/10.1234/abc')).toEqual({ type: 'doi', value: '10.1234/abc' });
  });

  it('classifies a DOI with the "doi:" a reference list prints before it', () => {
    expect(parseIdentifier('doi:10.1038/nature12373')).toEqual({ type: 'doi', value: '10.1038/nature12373' });
    expect(parseIdentifier('DOI: 10.1038/nature12373')).toEqual({ type: 'doi', value: '10.1038/nature12373' });
  });

  it('classifies arXiv new-style ids with and without /abs/ prefix', () => {
    expect(parseIdentifier('2201.00001')).toEqual({ type: 'arxiv', value: '2201.00001' });
    expect(parseIdentifier('https://arxiv.org/abs/2201.00001v2')).toEqual({ type: 'arxiv', value: '2201.00001v2' });
  });

  it('classifies arXiv legacy ids', () => {
    expect(parseIdentifier('math.GT/0309136')).toEqual({ type: 'arxiv', value: 'math.gt/0309136' });
  });

  it('classifies ISBNs', () => {
    expect(parseIdentifier('9783161484100')).toEqual({ type: 'isbn', value: '9783161484100' });
  });

  // The 2026-10-01 stress test: an ISBN-13 as printed, with its hyphens, came back as "Could
  // not parse as a known identifier" from a message that listed ISBN as accepted.
  it('classifies ISBNs as books print them: hyphens, spaces, an ISBN prefix, ISBN-10 with X', () => {
    const isbn13 = { type: 'isbn', value: '9780262033848' };
    expect(parseIdentifier('978-0-262-03384-8')).toEqual(isbn13);
    expect(parseIdentifier('978 0 262 03384 8')).toEqual(isbn13);
    expect(parseIdentifier('ISBN 978-0-262-03384-8')).toEqual(isbn13);
    expect(parseIdentifier('ISBN-13: 978-0-262-03384-8')).toEqual(isbn13);
    expect(parseIdentifier('isbn13 9780262033848')).toEqual(isbn13);
    expect(parseIdentifier('0-8044-2957-x')).toEqual({ type: 'isbn', value: '080442957X' });
    expect(parseIdentifier('ISBN-10: 0-262-03384-4')).toEqual({ type: 'isbn', value: '0262033844' });
  });

  it('does not read a date or a short number run as an ISBN', () => {
    expect(parseIdentifier('2020-01-15')).toBeNull();
    expect(parseIdentifier('978-0-262')).toBeNull();
    expect(parseIdentifier('978--0-262-03384-8')).toBeNull();
  });

  it('classifies PMIDs as PubMed prints and links them', () => {
    const pmid = { type: 'pmid', value: '31452104' };
    expect(parseIdentifier('31452104')).toEqual(pmid);
    expect(parseIdentifier('PMID: 31452104')).toEqual(pmid);
    expect(parseIdentifier('pmid:31452104')).toEqual(pmid);
    expect(parseIdentifier('https://pubmed.ncbi.nlm.nih.gov/31452104/')).toEqual(pmid);
    expect(parseIdentifier('https://www.ncbi.nlm.nih.gov/pubmed/31452104')).toEqual(pmid);
  });

  // The pattern was nineteen digits, which no bibcode is, so every real one fell through.
  it('classifies real ADS bibcodes, bare or as an ADS link, keeping their case', () => {
    expect(parseIdentifier('2019ApJ...882L..24A')).toEqual({ type: 'bibcode', value: '2019ApJ...882L..24A' });
    expect(parseIdentifier('2018A&A...616A...1G')).toEqual({ type: 'bibcode', value: '2018A&A...616A...1G' });
    expect(parseIdentifier('2020arXiv200203839S')).toEqual({ type: 'bibcode', value: '2020arXiv200203839S' });
    expect(parseIdentifier('https://ui.adsabs.harvard.edu/abs/2019ApJ...882L..24A/abstract')).toEqual({
      type: 'bibcode',
      value: '2019ApJ...882L..24A',
    });
  });

  it('returns null for free text and unknown URLs', () => {
    expect(parseIdentifier('the role of metadata')).toBeNull();
    expect(parseIdentifier('https://example.com/page')).toBeNull();
    expect(parseIdentifier('')).toBeNull();
  });
});

describe('bareDoi', () => {
  it('strips URL prefixes', () => {
    expect(bareDoi('https://dx.doi.org/10.1/abc')).toBe('10.1/abc');
    expect(bareDoi('10.1/abc')).toBe('10.1/abc');
  });
});

describe('fromScholarWork', () => {
  it('maps a scholar work with a venue to a journalArticle', () => {
    const item = fromScholarWork(
      { title: 'A', authors: ['Ada Lovelace'], year: 2021, venue: 'Nature' },
      '10.1234/abc',
    );
    expect(item).toMatchObject({
      itemType: 'journalArticle',
      title: 'A',
      creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' }],
      date: '2021',
      DOI: '10.1234/abc',
      publicationTitle: 'Nature',
    });
    expect(item.extra).toContain('source:scholar');
  });

  // `generic` is not one of Zotero's 40 item types, so this used to be a save Zotero
  // refused with 400 "Unknown itemType 'generic'" (#77). Every replacement below has to be
  // a real type or the write fails the same way.
  it('falls back to document, a real Zotero type, without a venue or a mappable type', () => {
    const item = fromScholarWork({ title: 'B', authors: [], year: 2020 }, '10.9/x');
    expect(item.itemType).toBe('document');
  });

  it("maps OpenAlex's own work type when it has a Zotero counterpart", () => {
    const cases: [string, string][] = [
      ['conference-paper', 'conferencePaper'],
      ['book', 'book'],
      ['book-chapter', 'bookSection'],
      ['dataset', 'dataset'],
      ['dissertation', 'thesis'],
      ['preprint', 'preprint'],
      ['report', 'report'],
      ['article', 'journalArticle'],
    ];
    for (const [openalex, zotero] of cases) {
      const item = fromScholarWork({ title: 'B', authors: [], type: openalex }, '10.9/x');
      expect(item.itemType, `OpenAlex type ${openalex}`).toBe(zotero);
    }
  });

  // OpenAlex reports no venue for most conference papers, which is why the broken fallback
  // was the common path rather than the rare one.
  it('prefers the declared type over the venue heuristic', () => {
    const item = fromScholarWork(
      { title: 'B', authors: [], venue: 'Some Proceedings', type: 'conference-paper' },
      '10.9/x',
    );
    expect(item.itemType).toBe('conferencePaper');
  });

  it('falls back to journalArticle when a venue is all we have', () => {
    const item = fromScholarWork({ title: 'B', authors: [], venue: 'Nature' }, '10.9/x');
    expect(item.itemType).toBe('journalArticle');
  });

  it('does not invent a type for an OpenAlex type it does not know', () => {
    const item = fromScholarWork({ title: 'B', authors: [], type: 'peer-review' }, '10.9/x');
    expect(item.itemType).toBe('document');
  });

  // #89: the lookup had these and the item kept only the year and the journal.
  it('carries volume, issue, pages, the full date and the ISSN onto a journal article', () => {
    const item = fromScholarWork(
      {
        title: 'Highly accurate protein structure prediction with AlphaFold',
        authors: ['John Jumper'],
        year: 2021,
        venue: 'Nature',
        type: 'article',
        biblio: { date: '2021-07-15', volume: '596', issue: '7873', pages: '583-589', ISSN: '0028-0836, 1476-4687' },
      },
      '10.1038/s41586-021-03819-2',
    );
    expect(item).toMatchObject({
      itemType: 'journalArticle',
      publicationTitle: 'Nature',
      date: '2021-07-15',
      volume: '596',
      issue: '7873',
      pages: '583-589',
      ISSN: '0028-0836, 1476-4687',
    });
    expect(item.url).toBeUndefined();
  });

  it("files the venue under each type's own container field", () => {
    const venueOf = (type: string) => fromScholarWork({ title: 'B', authors: [], venue: 'V', type }, '10.9/x');
    expect(venueOf('conference-paper')).toMatchObject({ proceedingsTitle: 'V' });
    expect(venueOf('conference-paper').publicationTitle).toBeUndefined();
    expect(venueOf('book-chapter')).toMatchObject({ bookTitle: 'V' });
    expect(venueOf('preprint')).toMatchObject({ repository: 'V' });
    expect(venueOf('book').publicationTitle).toBeUndefined();
  });

  // Zotero refuses the whole item over one field its type does not have (#77), so every
  // field this can emit is checked against the real schema, for every type the slice holds.
  it('emits only fields the item type accepts, whatever the provider sent', () => {
    const everything = {
      date: '2021-07-15',
      volume: '1',
      issue: '2',
      pages: '3-4',
      ISSN: '1234-5678',
      url: 'https://example.org/paper',
    };
    const types = ['article', 'book', 'book-chapter', 'conference-paper', 'dissertation', 'preprint', 'standard', 'peer-review'];
    for (const type of types) {
      const item = fromScholarWork({ title: 'B', authors: ['Ada Lovelace'], venue: 'V', type, biblio: everything }, '10.9/x');
      const inSlice = (SCHEMA_SLICE as any).itemTypes.some((t: any) => t.itemType === item.itemType);
      expect(inSlice, `${type} maps to ${item.itemType}, which the schema slice does not hold`).toBe(true);
      expect(validateItem(SCHEMA_SLICE as any, item).errors, `OpenAlex type ${type}`).toEqual([]);
      expect(item.date).toBe('2021-07-15');
      expect(item.url).toBe('https://example.org/paper');
    }
  });
});

describe('foldSpec', () => {
  it('lets an explicit non-generic itemType win', () => {
    const item = { itemType: 'preprint', title: 'T', creators: [] as any[] };
    foldSpec({ itemType: 'report' }, item as any, 'test');
    expect(item.itemType).toBe('report');
  });

  it('demotes preprint to journalArticle when a venue is present', () => {
    const item = { itemType: 'preprint', title: 'T', creators: [] as any[], publicationTitle: 'JACM' };
    foldSpec({}, item as any, 'test');
    expect(item.itemType).toBe('journalArticle');
  });

  it('keeps generic with no extra fields -> fetch default', () => {
    const item = { itemType: 'preprint', title: 'T', creators: [] as any[] };
    foldSpec({ itemType: 'generic' }, item as any, 'test');
    expect(item.itemType).toBe('preprint');
  });

  it('adds resolved: source and merges extra', () => {
    const item = { itemType: 'preprint', title: 'T', creators: [] as any[], extra: 'arXiv:2201.00001' };
    foldSpec({ extra: 'note' }, item as any, 'arxiv');
    expect(item.extra).toContain('arXiv:2201.00001');
    expect(item.extra).toContain('note');
    expect(item.extra).toContain('resolved:arxiv');
  });
});

describe('arxivItem', () => {
  // No polite-pacing waits in unit tests (production keeps the 3s gap).
  setArxivMinGapMs(0);

  const entryXml = (id: string, title: string) => `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <id>http://arxiv.org/abs/${id}</id>
      <published>2022-01-01T00:00:00Z</published>
      <title>${title}</title>
      <summary>None.</summary>
      <author><name>Only Author</name></author>
    </entry></feed>`;

  it('parses the Atom feed into a preprint', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2201.00001v2</id>
    <updated>2022-01-02T00:00:00Z</updated>
    <published>2022-01-01T00:00:00Z</published>
    <title>A Test &amp; Paper</title>
    <summary>A short abstract.</summary>
    <author><name>Ada Lovelace</name></author>
    <author><name>Charles Babbage</name></author>
    <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.1234/arxiv.1</arxiv:doi>
    <arxiv:journal_ref xmlns:arxiv="http://arxiv.org/schemas/atom">J. ACM</arxiv:journal_ref>
  </entry>
</feed>`;
    const fetcher = async () => new Response(xml, { status: 200 });
    const item = await arxivItem('2201.00001', fetcher as any);
    expect(item).toMatchObject({
      itemType: 'journalArticle', // journal_ref present
      title: 'A Test & Paper',
      creators: [
        { creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' },
        { creatorType: 'author', firstName: 'Charles', lastName: 'Babbage' },
      ],
      DOI: '10.1234/arxiv.1',
      publicationTitle: 'J. ACM',
      date: '2022-01-01',
    });
    expect(item!.extra).toContain('arXiv:2201.00001');
    expect(item!.abstractNote).toBe('A short abstract.');
  });

  it('types as preprint without a journal_ref', async () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <id>http://arxiv.org/abs/2201.00002</id>
      <published>2022-01-01T00:00:00Z</published>
      <title>No Journal</title>
      <summary>None.</summary>
      <author><name>Only Author</name></author>
    </entry></feed>`;
    const fetcher = async () => new Response(xml, { status: 200 });
    const item = await arxivItem('2201.00002', fetcher as any);
    expect(item?.itemType).toBe('preprint');
    expect(item?.publicationTitle).toBeUndefined();
  });

  it('returns null on HTTP error', async () => {
    const fetcher = async () => new Response('nope', { status: 500 });
    expect(await arxivItem('2201.00003', fetcher as any)).toBeNull();
  });

  it('backs off and succeeds when arXiv throttles once (429 then 200)', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      if (calls === 1) return new Response('slow down', { status: 429, headers: { 'retry-after': '0.01' } });
      return new Response(entryXml('2201.00004', 'Throttled Then Fine'), { status: 200 });
    };
    const item = await arxivItem('2201.00004', fetcher as any);
    expect(calls).toBe(2);
    expect(item?.title).toBe('Throttled Then Fine');
  });

  it('throws a rate-limit error instead of reporting "no record" when throttling persists', async () => {
    const fetcher = async () => new Response('slow down', { status: 429, headers: { 'retry-after': '0.01' } });
    await expect(arxivItem('2201.00005', fetcher as any)).rejects.toThrow(/rate-limiting/i);
  });
});
