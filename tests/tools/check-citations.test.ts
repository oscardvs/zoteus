import { describe, it, expect, vi } from 'vitest';
import checkCitations from '../../src/tools/check-citations.js';
import { parseCitations, parseReferences, findQuotes, attachQuotes, normalizeDoi } from '../../src/features/citecheck/parse.js';
import { matchQuote, normalizeForMatch } from '../../src/features/citecheck/quotes.js';
import { splitDraft } from '../../src/features/citecheck/check.js';

describe('parseCitations', () => {
  it('reads pandoc groups with locators and several keys', () => {
    const [c] = parseCitations('As shown [@smith2020, p. 12; see @jones2019].');
    expect(c!.kind).toBe('pandoc');
    expect(c!.targets).toEqual([{ citekey: 'smith2020', locator: '12' }, { citekey: 'jones2019' }]);
  });

  it('reads Zotero item-key groups with the notes grammar', () => {
    const [c] = parseCitations('Filters [@ABCD2345, p. 12] work.');
    expect(c!.kind).toBe('zotero-key');
    expect(c!.targets).toEqual([{ itemKey: 'ABCD2345', locator: '12' }]);
  });

  it('reads every LaTeX cite command, with the postnote as locator', () => {
    const found = parseCitations(
      'A \\cite{a,b} B \\citep[see][p.~4]{c} C \\citet{d} D \\parencite{e} E \\textcite{f} F \\autocite[12]{g}',
    );
    expect(found.map((f) => f.kind)).toEqual(Array(6).fill('latex'));
    expect(found[0]!.targets.map((t) => t.citekey)).toEqual(['a', 'b']);
    expect(found[5]!.targets[0]).toEqual({ citekey: 'g', locator: '12' });
  });

  it('reads author-year in prose, parenthetical and narrative', () => {
    const found = parseCitations(
      'This holds (Smith, 2020). Others agree (Smith & Jones, 2020, p. 4; Lee 2019). Müller et al. (2018) disagree.',
    );
    expect(found.map((f) => f.targets.map((t) => [t.author, t.author2, t.year, t.locator]))).toEqual([
      [['Smith', undefined, '2020', undefined]],
      [
        ['Smith', 'Jones', '2020', '4'],
        ['Lee', undefined, '2019', undefined],
      ],
      [['Müller', undefined, '2018', undefined]],
    ]);
  });

  it('ignores parentheses that only hold a year or a number', () => {
    expect(parseCitations('In the year (2020) we saw (n = 2019) things.')).toEqual([]);
  });

  it('resolves numeric citations through the reference list and expands ranges', () => {
    const refs = parseReferences('[1] Smith, J. (2020). Kalman filters. doi:10.1000/abc.\n[2] Lee, K. (2019). Particle filters.\n[3] X');
    const [c] = parseCitations('Known [1-2] and [3].', refs);
    expect(c!.targets.map((t) => t.number)).toEqual([1, 2]);
    expect(c!.targets[0]!.doi).toBe('10.1000/abc');
    expect(c!.targets[1]).toMatchObject({ author: 'Lee', year: '2019' });
  });

  it('reads bare DOIs without trailing punctuation, and skips links, footnotes, emails and code', () => {
    const found = parseCitations(
      'See 10.1109/LRA.2023.3243526. Mail me@example.org, [a](http://x) [^1] `[@notacite]` (doi 10.1000/x(1)2).',
    );
    expect(found.map((f) => f.targets[0]!.doi)).toEqual(['10.1109/LRA.2023.3243526', '10.1000/x(1)2']);
    expect(normalizeDoi('https://doi.org/10.1109/LRA.2023.3243526')).toBe('10.1109/lra.2023.3243526');
  });
});

describe('quotations', () => {
  it('attaches a quote to the cite right after it, and not to the next sentence', () => {
    const draft = 'He wrote "the filter is optimal under Gaussian noise" (Smith, 2020, p. 4). Later (Lee, 2019).';
    const cites = parseCitations(draft);
    const map = attachQuotes(draft, findQuotes(draft), cites);
    expect(map.get(0)!.map((q) => q.text)).toEqual(['the filter is optimal under Gaussian noise']);
    expect(map.get(1)).toBeUndefined();
  });

  it('attaches a Markdown block quote ending in its cite', () => {
    const draft = 'Intro.\n\n> The filter is optimal under\n> Gaussian noise. [@ABCD2345, p. 3]\n\nNext.';
    const cites = parseCitations(draft);
    const map = attachQuotes(draft, findQuotes(draft), cites);
    expect(map.get(0)![0]!.text).toBe('The filter is optimal under\nGaussian noise.');
  });

  it('skips scare quotes shorter than four words', () => {
    expect(findQuotes('the so-called "black box" (Smith, 2020)')).toEqual([]);
  });

  it('matches across ligatures, line-break hyphenation, curly quotes and dashes', () => {
    const source = normalizeForMatch('We de\ufb01ne the opti-\nmal \u201cfilter\u201d \u2014 under   Gaussian noise.');
    expect(matchQuote('we define the optimal "filter" - under Gaussian noise', source).status).toBe('found');
  });

  it('matches elided quotations segment by segment', () => {
    const source = normalizeForMatch('The filter is optimal for linear systems under Gaussian noise and known covariances.');
    expect(matchQuote('The filter is optimal [...] under Gaussian noise', source).status).toBe('found');
  });

  it('reports a close match with similarity and the actual words', () => {
    const raw = 'Intro text here. The Kalman filter is the optimal estimator under Gaussian noise assumptions. More text.';
    const m = matchQuote('The Kalman filter is the best estimator under Gaussian noise assumptions', normalizeForMatch(raw));
    expect(m.status).toBe('close_match');
    if (m.status !== 'close_match') return;
    expect(m.similarity).toBeGreaterThanOrEqual(0.85);
    expect(raw.slice(m.start, m.end)).toContain('optimal estimator');
  });

  it('reports not found for an invented quotation', () => {
    const m = matchQuote('deep learning has solved every robotics problem forever', normalizeForMatch('The Kalman filter is optimal.'));
    expect(m.status).toBe('not_found');
  });
});

describe('splitDraft', () => {
  it('reads a trailing References section as the reference list', () => {
    const { body, refs } = splitDraft('Text [1].\n\n## References\n\n1. Smith, J. (2020). A title.');
    expect(body).toBe('Text [1].\n\n');
    expect(parseReferences(refs)).toHaveLength(1);
  });
});

// --- the tool, against a faked library -------------------------------------------------

const item = (key: string, title: string, date: string, creators: string[], extra: Record<string, unknown> = {}) => ({
  key,
  data: {
    key,
    itemType: 'journalArticle',
    title,
    date,
    creators: creators.map((lastName) => ({ creatorType: 'author', lastName, firstName: 'A' })),
    ...extra,
  },
});

const LIB = [
  item('KALMAN01', 'Kalman filters for robots', '2020', ['Smith'], { citationKey: 'smith2020', DOI: '10.1000/KF.1' }),
  item('PARTIC01', 'Particle filters', '2019', ['Lee', 'Park']),
  item('TWINAA01', 'Twin paper about graphs', '2018', ['Ng']),
  item('TWINBB01', 'Twin paper about meshes', '2018', ['Ng']),
];

const FULLTEXT: Record<string, string> = {
  KALMANAT: 'Abstract. The Kalman \ufb01lter is the optimal estimator under Gaussian noise. Conclusion follows here.',
};

function ctxFor(): any {
  const byKey = new Map(LIB.map((i) => [i.key, i]));
  const searchItems = vi.fn(async ({ q, qmode }: { q: string; qmode: string }) => {
    const words = q.toLowerCase().split(/\s+/);
    const data = LIB.filter((i) => {
      const hay = [i.data.title, i.data.date, ...i.data.creators.map((c) => c.lastName), (i.data as any).citationKey ?? '']
        .concat(qmode === 'everything' ? [String((i.data as any).DOI ?? '')] : [])
        .join(' ')
        .toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    return { data, totalResults: data.length };
  });
  return {
    config: {},
    remoteCaller: true,
    capabilities: { cloud: null, localApi: false },
    router: {
      defaultLibrary: () => ({ type: 'user', id: 1 }),
      searchItems,
      getItem: vi.fn(async (key: string) => {
        const i = byKey.get(key);
        if (!i) throw Object.assign(new Error('404'), { status: 404 });
        return i;
      }),
      getItemChildren: vi.fn(async (key: string) => ({
        data: key === 'KALMAN01' ? [{ key: 'KALMANAT', data: { itemType: 'attachment', contentType: 'application/pdf', filename: 'k.pdf', parentItem: key } }] : [],
        totalResults: key === 'KALMAN01' ? 1 : 0,
      })),
      getFullText: vi.fn(async (key: string) => (FULLTEXT[key] ? { content: FULLTEXT[key], totalPages: 10 } : null)),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

describe('zotero_check_citations', () => {
  it('is read-only and carries no $schema key', () => {
    expect(checkCitations.annotations?.readOnlyHint).toBe(true);
    expect(JSON.stringify(checkCitations.inputSchema)).not.toContain('$schema');
  });

  it('resolves by item key, citation key, DOI and author-year, and flags the invented one', async () => {
    const ctx = ctxFor();
    const draft =
      'A [@KALMAN01]. B \\cite{smith2020}. C 10.1000/kf.1. D (Lee & Park, 2019). E (Ng, 2018). F [@nobody1999]. G (Ghost, 2021).';
    const res: any = await checkCitations.handler({ draft }, ctx);
    const works = res.structuredContent.citations.map((c: any) => [c.works[0].status, c.works[0].matchedBy, c.works[0].item?.key]);
    expect(works).toEqual([
      ['matched', 'item_key', 'KALMAN01'],
      ['matched', 'citation_key', 'KALMAN01'],
      ['matched', 'doi', 'KALMAN01'],
      ['matched', 'author_year', 'PARTIC01'],
      ['ambiguous', undefined, undefined],
      ['not_in_library', undefined, undefined],
      ['not_in_library', undefined, undefined],
    ]);
    expect(res.structuredContent.citations[4].works[0].candidates).toHaveLength(2);
    expect(res.structuredContent.summary).toMatchObject({ matched: 4, ambiguous: 1, notInLibrary: 2 });
    expect(res.structuredContent.verdict).toMatch(/Needs attention: 2 cited work\(s\) are not in the library/);
    expect(res.structuredContent.verdict).toMatch(/paraphrased claim was not checked/);
    expect(res.structuredContent.unquotedClaims).toMatch(/zotero_get_fulltext/);
  });

  it('settles an author-year tie with title words from the reference list', async () => {
    const draft = 'Graphs matter (Ng, 2018).\n\nReferences\n\nNg, A. (2018). Twin paper about meshes. Journal.';
    const res: any = await checkCitations.handler({ draft }, ctxFor());
    expect(res.structuredContent.citations[0].works[0]).toMatchObject({ status: 'matched', matchedBy: 'author_year_title' });
    expect(res.structuredContent.citations[0].works[0].item.key).toBe('TWINBB01');
  });

  it('verifies quotations: found with a page estimate, close match, not found, no full text', async () => {
    const draft =
      'He says "The Kalman filter is the optimal estimator under Gaussian noise" [@KALMAN01, p. 3]. ' +
      'Also "The Kalman filter is the best estimator under Gaussian noise" [@KALMAN01]. ' +
      'And "robots will replace every single scientist soon" [@KALMAN01]. ' +
      'Then "particle methods beat everything in all cases" (Lee & Park, 2019).';
    const res: any = await checkCitations.handler({ draft }, ctxFor());
    const quotes = res.structuredContent.citations.map((c: any) => c.quotes[0]);
    expect(quotes[0]).toMatchObject({ status: 'found', itemKey: 'KALMAN01' });
    expect(quotes[0].pageApprox).toBeGreaterThanOrEqual(1);
    expect(quotes[1]).toMatchObject({ status: 'close_match' });
    expect(quotes[1].sourceText).toContain('optimal estimator');
    expect(quotes[2].status).toBe('not_found');
    expect(quotes[3].status).toBe('no_fulltext');
    expect(res.structuredContent.fulltextsRead).toBe(2);
  });

  it('pages the work by citation count and full-text budget', async () => {
    const draft = '"one two three four five" [@KALMAN01]. "six seven eight nine ten" (Lee & Park, 2019). (Ng, 2018).';
    const ctx = ctxFor();
    const first: any = await checkCitations.handler({ draft, max_fulltexts: 1 }, ctx);
    expect(first.structuredContent.citations).toHaveLength(1);
    expect(first.structuredContent.nextStart).toBe(1);
    const second: any = await checkCitations.handler({ draft, start: 1, max_citations: 1 }, ctx);
    expect(second.structuredContent.citations[0].index).toBe(1);
    expect(second.structuredContent.nextStart).toBe(2);
    expect(second.content[0].text).toMatch(/start:2/);
  });

  it('reports numeric citations with no reference list as unresolved', async () => {
    const res: any = await checkCitations.handler({ draft: 'As shown [4].' }, ctxFor());
    expect(res.structuredContent.citations[0].works[0].status).toBe('unresolved');
  });
});
