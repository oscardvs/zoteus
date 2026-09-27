import { describe, it, expect, vi } from 'vitest';
import { OpenAlexClient } from '../../src/features/scholar/openalex.js';
import { ScholarGraph, markInLibrary } from '../../src/features/scholar/graph.js';
import { crossrefDate } from '../../src/features/scholar/crossref.js';
import { RateLimitedFetcher } from '../../src/api/http.js';

function fetcher(fetchImpl: any) {
  return new RateLimitedFetcher({ fetchImpl, maxConcurrency: 4 });
}

const work = {
  id: 'https://openalex.org/W123',
  display_name: 'Deep Learning',
  doi: 'https://doi.org/10.1038/NATURE14539',
  publication_year: 2015,
  cited_by_count: 80000,
  authorships: [{ author: { display_name: 'Yann LeCun' } }],
  referenced_works: ['https://openalex.org/W1', 'https://openalex.org/W2'],
  related_works: ['https://openalex.org/W9'],
  primary_location: { source: { display_name: 'Nature' } },
};

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

describe('OpenAlexClient', () => {
  it('normalizes a work and strips DOI/id prefixes', () => {
    const c = new OpenAlexClient(fetcher(vi.fn()));
    const n = c.normalize(work);
    expect(n.title).toBe('Deep Learning');
    expect(n.doi).toBe('10.1038/NATURE14539');
    expect(n.openalexId).toBe('W123');
    expect(n.authors).toContain('Yann LeCun');
    expect(n.venue).toBe('Nature');
  });

  it('resolves works by id with the OR filter', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('filter=openalex_id:W1|W2');
      return new Response(JSON.stringify({ results: [work] }), { status: 200 });
    });
    const out = await new OpenAlexClient(fetcher(fetchImpl)).worksByIds(['https://openalex.org/W1', 'W2']);
    expect(out[0].title).toBe('Deep Learning');
  });

  // OpenAlex replaced the polite pool with API keys before February 2026 and ignores
  // `mailto=` (#76). The key travels as a bearer header, never in a URL an error would quote.
  it('sends the API key as a bearer header and keeps both key and mailto out of the URL', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).not.toContain('mailto=');
      expect(url).not.toContain('api_key');
      expect(url).not.toContain('sekret');
      expect(headerOf(init, 'authorization')).toBe('Bearer sekret');
      expect(headerOf(init, 'user-agent')).toBe('zoteus (mailto:me@example.com)');
      return new Response(JSON.stringify(work), { status: 200 });
    });
    const c = new OpenAlexClient(fetcher(fetchImpl), { apiKey: 'sekret', contact: 'me@example.com' });
    await c.work('10.1038/nature14539');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('sends no Authorization header without a key, and still works', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(headerOf(init, 'authorization')).toBeNull();
      expect(headerOf(init, 'user-agent')).toBe('zoteus');
      return new Response(JSON.stringify(work), { status: 200 });
    });
    await new OpenAlexClient(fetcher(fetchImpl)).work('W123');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not leak the key when a request fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 429 }));
    const c = new OpenAlexClient(fetcher(fetchImpl), { apiKey: 'sekret' });
    await expect(c.work('W123')).rejects.toThrow(/OpenAlex 429/);
    await expect(c.work('W123')).rejects.not.toThrow(/sekret/);
  });
});

describe('ScholarGraph', () => {
  const okFetch = vi.fn(async (url: string) => {
    if (url.includes('/works/doi:')) return new Response(JSON.stringify(work), { status: 200 });
    return new Response(JSON.stringify({ results: [work] }), { status: 200 });
  });

  it('returns references resolved from referenced_works with the full count', async () => {
    const g = new ScholarGraph({ fetcher: fetcher(okFetch) });
    const refs = await g.references('10.1038/nature14539', 10);
    expect(refs.works.length).toBeGreaterThan(0);
    expect(refs.total).toBe(2);
  });

  // A review with 150 references answered `limit` works and nothing else; the count the
  // list was cut from now rides along (#76).
  it('reports the untruncated total when limit cuts the list', async () => {
    const g = new ScholarGraph({ fetcher: fetcher(okFetch) });
    const refs = await g.references('10.1038/nature14539', 1);
    expect(refs.total).toBe(2);
    const rel = await g.related('10.1038/nature14539', 5);
    expect(rel.total).toBe(1);
  });

  it('uses cited_by_count as the total for citations', async () => {
    const g = new ScholarGraph({ fetcher: fetcher(okFetch) });
    const cites = await g.citations('10.1038/nature14539', 5);
    expect(cites.works.length).toBe(1);
    expect(cites.total).toBe(80000);
  });

  it('passes the OpenAlex key through and keeps mailto for Crossref only', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: headerOf(init, 'authorization') });
      if (url.includes('openalex.org')) return new Response('err', { status: 500 });
      return new Response(JSON.stringify({ message: { title: ['Crossref Title'], DOI: '10.1/x', author: [] } }), { status: 200 });
    });
    const g = new ScholarGraph({ fetcher: fetcher(fetchImpl), mailto: 'me@example.com', openalexApiKey: 'sekret' });
    const r = await g.lookup('10.1/x');
    expect(r?.title).toBe('Crossref Title');
    const openalex = seen.find((s) => s.url.includes('openalex.org'))!;
    const crossref = seen.find((s) => s.url.includes('crossref.org'))!;
    expect(openalex.auth).toBe('Bearer sekret');
    expect(openalex.url).not.toContain('mailto=');
    expect(crossref.auth).toBeNull();
    expect(crossref.url).toContain('mailto=me%40example.com');
  });

  it('falls back to Crossref when OpenAlex lookup throws', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('openalex.org')) return new Response('err', { status: 500 });
      return new Response(JSON.stringify({ message: { title: ['Crossref Title'], DOI: '10.1/x', author: [] } }), { status: 200 });
    });
    const g = new ScholarGraph({ fetcher: fetcher(fetchImpl) });
    const r = await g.lookup('10.1/x');
    expect(r?.title).toBe('Crossref Title');
  });

  // `/works/` with no DOI is Crossref's works-LIST route and answers 200. Read as a work,
  // that envelope was an untitled paper with no authors, which is how an empty DOI came
  // back as a successful lookup.
  it('refuses a Crossref work-LIST payload instead of reading it as one work', async () => {
    const workList = {
      status: 'ok',
      'message-type': 'work-list',
      message: { facets: {}, 'total-results': 186439611, items: [{ DOI: '10.1/first' }] },
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('openalex.org')) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(workList), { status: 200 });
    });
    const g = new ScholarGraph({ fetcher: fetcher(fetchImpl) });
    expect(await g.lookup('')).toBeNull();
  });

  it('refuses a 200 that carries no work at all', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('openalex.org')) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({ status: 'ok', 'message-type': 'journal', message: { title: 'Nature' } }), { status: 200 });
    });
    const g = new ScholarGraph({ fetcher: fetcher(fetchImpl) });
    expect(await g.lookup('1234-5678')).toBeNull();
  });
});

/**
 * The AlphaFold paper as OpenAlex and Crossref really return it (10.1038/s41586-021-03819-2,
 * fetched 2026-09-27), trimmed to the fields the lookup reads. #89 reported the volume,
 * issue, pages, full date and ISSN all dropped on the way to the imported item.
 */
const ALPHAFOLD_OPENALEX = {
  id: 'https://openalex.org/W3177828909',
  doi: 'https://doi.org/10.1038/s41586-021-03819-2',
  display_name: 'Highly accurate protein structure prediction with AlphaFold',
  publication_year: 2021,
  publication_date: '2021-07-15',
  type: 'article',
  authorships: [{ author: { display_name: 'John Jumper' } }],
  biblio: { volume: '596', issue: '7873', first_page: '583', last_page: '589' },
  primary_location: {
    landing_page_url: 'https://doi.org/10.1038/s41586-021-03819-2',
    source: { display_name: 'Nature', type: 'journal', issn_l: '0028-0836', issn: ['0028-0836', '1476-4687'] },
  },
};

const ALPHAFOLD_CROSSREF = {
  status: 'ok',
  'message-type': 'work',
  message: {
    DOI: '10.1038/s41586-021-03819-2',
    title: ['Highly accurate protein structure prediction with AlphaFold'],
    author: [{ given: 'John', family: 'Jumper' }],
    'container-title': ['Nature'],
    volume: '596',
    issue: '7873',
    page: '583-589',
    ISSN: ['0028-0836', '1476-4687'],
    URL: 'https://doi.org/10.1038/s41586-021-03819-2',
    issued: { 'date-parts': [[2021, 7, 15]] },
  },
};

const ALPHAFOLD_BIBLIO = {
  date: '2021-07-15',
  volume: '596',
  issue: '7873',
  pages: '583-589',
  ISSN: '0028-0836, 1476-4687',
};

describe('the citation details a DOI lookup carries (#89)', () => {
  it('reads volume, issue, pages, the full date and the ISSNs off the OpenAlex work', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(ALPHAFOLD_OPENALEX), { status: 200 }));
    const r = await new ScholarGraph({ fetcher: fetcher(fetchImpl) }).lookup('10.1038/s41586-021-03819-2');
    // No url: the landing page OpenAlex has for this work is the DOI resolver, which is the
    // DOI field a second time.
    expect(r?.biblio).toEqual(ALPHAFOLD_BIBLIO);
  });

  it('reads the same details off Crossref when OpenAlex does not answer', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('openalex.org')
        ? new Response('err', { status: 500 })
        : new Response(JSON.stringify(ALPHAFOLD_CROSSREF), { status: 200 }),
    );
    const r = await new ScholarGraph({ fetcher: fetcher(fetchImpl) }).lookup('10.1038/s41586-021-03819-2');
    expect(r?.oaChecked).toBe(false);
    expect(r?.biblio).toEqual(ALPHAFOLD_BIBLIO);
  });

  it("does not file a work under a repository's ISSN, and keeps a real landing page", () => {
    const c = new OpenAlexClient(fetcher(vi.fn()));
    const b = c.biblio({
      publication_year: 2020,
      biblio: { first_page: '12', last_page: '12' },
      primary_location: {
        landing_page_url: 'https://www.biorxiv.org/content/10.1101/2020.01.01.000001v1',
        source: { display_name: 'bioRxiv', type: 'repository', issn_l: '2692-8205', issn: ['2692-8205'] },
      },
    });
    expect(b).toEqual({ date: '2020', pages: '12', url: 'https://www.biorxiv.org/content/10.1101/2020.01.01.000001v1' });
  });

  it('reports nothing rather than empty strings when the provider has nothing', () => {
    const c = new OpenAlexClient(fetcher(vi.fn()));
    expect(c.biblio({ biblio: { volume: null, issue: '', first_page: null, last_page: null } })).toBeUndefined();
  });

  it('keeps a Crossref date to the precision Crossref has', () => {
    expect(crossrefDate({ 'date-parts': [[2013, 8]] })).toBe('2013-08');
    expect(crossrefDate({ 'date-parts': [[2013]] })).toBe('2013');
    expect(crossrefDate({ 'date-parts': [[null]] })).toBeUndefined();
  });

  it('leaves search results without the details, as before', () => {
    expect(new OpenAlexClient(fetcher(vi.fn())).normalize(ALPHAFOLD_OPENALEX).biblio).toBeUndefined();
  });
});

describe('markInLibrary', () => {
  it('flags works whose DOI is in the library set (case-insensitive)', () => {
    const set = new Set(['10.1038/nature14539']);
    const marked = markInLibrary([{ doi: '10.1038/NATURE14539', authors: [] }, { doi: '10.9/zzz', authors: [] }], set);
    expect(marked[0].inLibrary).toBe(true);
    expect(marked[1].inLibrary).toBe(false);
  });
});
