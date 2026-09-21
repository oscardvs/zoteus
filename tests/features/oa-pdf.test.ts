import { describe, it, expect, vi, afterEach } from 'vitest';
import { bestOaPdf } from '../../src/features/scholar/openalex.js';
import { ScholarGraph } from '../../src/features/scholar/graph.js';
import { RateLimitedFetcher } from '../../src/api/http.js';
import { OaFetchError, fetchOaPdf, setOaHostLookup } from '../../src/features/oa/fetch.js';
import { itemDoi } from '../../src/features/oa/discover.js';
import { oaAttachmentTitle, oaQualifier, versionCaveat } from '../../src/features/oa/provenance.js';
import { textPagePdf } from '../fixtures/pdf.js';

const ARXIV = {
  is_oa: true,
  version: 'submittedVersion',
  license: 'cc-by',
  pdf_url: 'https://arxiv.org/pdf/2501.12345v1',
  landing_page_url: 'https://arxiv.org/abs/2501.12345v1',
  source: { display_name: 'arXiv' },
};

const CLOSED_PUBLISHER = {
  is_oa: false,
  version: 'publishedVersion',
  license: null,
  pdf_url: 'https://publisher.example/paywalled.pdf',
  landing_page_url: 'https://publisher.example/article',
  source: { display_name: 'Journal of Examples' },
};

describe('bestOaPdf precedence', () => {
  it('prefers best_oa_location.pdf_url and carries source, version and licence', () => {
    const oa = bestOaPdf({
      open_access: { is_oa: true, oa_url: 'https://arxiv.org/abs/2501.12345v1' },
      best_oa_location: ARXIV,
      primary_location: CLOSED_PUBLISHER,
      locations: [CLOSED_PUBLISHER, ARXIV],
    });
    expect(oa).toEqual({
      url: 'https://arxiv.org/pdf/2501.12345v1',
      source: 'arXiv',
      version: 'submitted',
      licence: 'cc-by',
      landingPage: 'https://arxiv.org/abs/2501.12345v1',
    });
  });

  it('falls back to open_access.oa_url when no location carries a pdf_url', () => {
    const oa = bestOaPdf({
      open_access: { is_oa: true, oa_url: 'https://europepmc.org/articles/PMC1/pdf' },
      best_oa_location: { ...ARXIV, pdf_url: null, source: { display_name: 'Europe PMC' }, version: 'acceptedVersion' },
      locations: [],
    });
    expect(oa?.url).toBe('https://europepmc.org/articles/PMC1/pdf');
    expect(oa?.source).toBe('Europe PMC');
    expect(oa?.version).toBe('accepted');
  });

  // The failure this rule exists for: oa_url is "the best free link", and for a slice of
  // works that link is an HTML landing page. Stored as the full text it is a web page
  // pretending to be the paper.
  it('returns null rather than the landing page when every pdf_url is null', () => {
    const oa = bestOaPdf({
      open_access: { is_oa: true, oa_url: 'https://repo.example/handle/123' },
      best_oa_location: { is_oa: true, pdf_url: null, landing_page_url: 'https://repo.example/handle/123' },
      primary_location: { is_oa: true, pdf_url: null, landing_page_url: 'https://repo.example/handle/123' },
      locations: [{ is_oa: true, pdf_url: null, landing_page_url: 'https://repo.example/handle/123' }],
    });
    expect(oa).toBeNull();
  });

  it('returns null for a work OpenAlex calls closed, whatever URLs its locations carry', () => {
    const oa = bestOaPdf({
      open_access: { is_oa: false, oa_url: null },
      best_oa_location: null,
      primary_location: CLOSED_PUBLISHER,
      locations: [CLOSED_PUBLISHER, { ...ARXIV, is_oa: true }],
    });
    expect(oa).toBeNull();
  });

  it('takes primary_location only when that location is itself open', () => {
    expect(
      bestOaPdf({ open_access: { is_oa: true }, primary_location: CLOSED_PUBLISHER, locations: [CLOSED_PUBLISHER] }),
    ).toBeNull();
    const open = bestOaPdf({
      open_access: { is_oa: true },
      primary_location: { ...CLOSED_PUBLISHER, is_oa: true, license: 'cc-by-nc' },
      locations: [],
    });
    expect(open?.url).toBe('https://publisher.example/paywalled.pdf');
    expect(open?.version).toBe('published');
    expect(open?.licence).toBe('cc-by-nc');
  });

  it('walks locations past the closed ones to the first open PDF', () => {
    const oa = bestOaPdf({
      open_access: { is_oa: true },
      locations: [
        CLOSED_PUBLISHER,
        { is_oa: true, pdf_url: null, source: { display_name: 'No file here' } },
        { is_oa: true, pdf_url: 'https://pmc.example/PMC42.pdf', source: { display_name: 'PubMed Central' } },
      ],
    });
    expect(oa?.url).toBe('https://pmc.example/PMC42.pdf');
    expect(oa?.source).toBe('PubMed Central');
    // OpenAlex said nothing about the version, and neither does Zoteus.
    expect(oa?.version).toBeUndefined();
    expect(oa?.licence).toBeUndefined();
  });

  it('ignores a pdf_url that is not http(s), and survives junk', () => {
    expect(bestOaPdf({ open_access: { is_oa: true }, best_oa_location: { is_oa: true, pdf_url: 'ftp://old.example/x.pdf' } })).toBeNull();
    expect(bestOaPdf(null)).toBeNull();
    expect(bestOaPdf('not a work')).toBeNull();
    expect(bestOaPdf({})).toBeNull();
  });
});

function fetcher(fetchImpl: any) {
  return new RateLimitedFetcher({ fetchImpl, maxConcurrency: 4 });
}

const OA_WORK = {
  id: 'https://openalex.org/W123',
  display_name: 'Deep Learning',
  doi: 'https://doi.org/10.1038/NATURE14539',
  publication_year: 2015,
  cited_by_count: 80000,
  authorships: [],
  open_access: { is_oa: true, oa_url: 'https://arxiv.org/pdf/2501.12345v1' },
  best_oa_location: ARXIV,
};

describe('ScholarGraph open access', () => {
  it('attaches the open-access block to a lookup without a second request', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(OA_WORK), { status: 200 }));
    const g = new ScholarGraph({ fetcher: fetcher(fetchImpl) });
    const w = await g.lookup('10.1038/nature14539');
    expect(w?.oa?.url).toBe('https://arxiv.org/pdf/2501.12345v1');
    expect(w?.oa?.version).toBe('submitted');
    expect(w?.oaChecked).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // Crossref has no open-access verdict. Silence must not read as "no free copy".
  it('says open access was NOT checked when the record came from Crossref', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('openalex.org')) return new Response('err', { status: 503 });
      return new Response(JSON.stringify({ message: { title: ['Crossref Title'], DOI: '10.1/x', author: [] } }), { status: 200 });
    });
    const g = new ScholarGraph({ fetcher: fetcher(fetchImpl) });
    const w = await g.lookup('10.1/x');
    expect(w?.title).toBe('Crossref Title');
    expect(w?.oaChecked).toBe(false);
    expect(w?.oa).toBeUndefined();
  });

  it('oaPdf reports null for a closed work and throws the provider status rather than falling back', async () => {
    const closed = vi.fn(async () => new Response(JSON.stringify({ open_access: { is_oa: false } }), { status: 200 }));
    expect(await new ScholarGraph({ fetcher: fetcher(closed) }).oaPdf('10.1/closed')).toBeNull();

    const failing = vi.fn(async (url: string) => {
      if (url.includes('openalex.org')) return new Response('err', { status: 503 });
      return new Response(JSON.stringify({ message: { title: ['Crossref Title'], DOI: '10.1/x', author: [] } }), { status: 200 });
    });
    const g = new ScholarGraph({ fetcher: fetcher(failing) });
    await expect(g.oaPdf('10.1/x')).rejects.toThrow(/OpenAlex 503/);
    // Crossref was never asked: it cannot answer this question.
    expect(failing.mock.calls.every((c) => String(c[0]).includes('openalex.org'))).toBe(true);
  });
});

describe('itemDoi', () => {
  it('reads the DOI field, normalised', () => {
    expect(itemDoi({ data: { DOI: 'https://doi.org/10.1038/NATURE14539' } })).toBe('10.1038/nature14539');
    expect(itemDoi({ DOI: '10.1/x' })).toBe('10.1/x');
  });

  // bookSection, report, thesis and manuscript have no DOI field in Zotero at all.
  it('reads a DOI: line out of Extra for the item types with no DOI field', () => {
    const item = { data: { itemType: 'bookSection', extra: 'Citation Key: smith2020\nDOI: 10.1007/978-3-030-12345-6_7' } };
    expect(itemDoi(item)).toBe('10.1007/978-3-030-12345-6_7');
  });

  it('is undefined when there is no DOI anywhere', () => {
    expect(itemDoi({ data: { itemType: 'book', extra: 'Citation Key: smith2020' } })).toBeUndefined();
    expect(itemDoi({})).toBeUndefined();
  });
});

describe('open-access provenance wording', () => {
  it('names the source, the version and the licence, and says so when they are missing', () => {
    expect(oaQualifier({ url: 'u', source: 'arXiv', version: 'submitted', licence: 'cc-by' })).toBe(
      'arXiv, submitted manuscript, cc-by',
    );
    expect(oaQualifier({ url: 'u' })).toBe('an unnamed repository, version not stated, licence not stated');
    expect(oaAttachmentTitle({ url: 'u', source: 'PubMed Central', version: 'published' })).toBe(
      'Open-access PDF (PubMed Central, published version, licence not stated)',
    );
  });

  it('caveats every version that is not the publisher record, and only those', () => {
    expect(versionCaveat('published')).toBeUndefined();
    expect(versionCaveat('accepted')).toMatch(/version of record/);
    expect(versionCaveat('submitted')).toMatch(/preprint/);
    expect(versionCaveat(undefined)).toMatch(/did not say/);
  });
});

const PDF = textPagePdf();

function ctxWith(fetchImpl: any) {
  return { fetcher: { fetch: vi.fn(fetchImpl) } } as any;
}

describe('fetchOaPdf', () => {
  afterEach(() => setOaHostLookup(null));

  it('fetches over https from a public host and reports the served type', async () => {
    setOaHostLookup(async () => ['93.184.216.34']);
    const ctx = ctxWith(async () => new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } }));
    const out = await fetchOaPdf(ctx, 'https://arxiv.org/pdf/2501.12345v1');
    expect(out.bytes.length).toBe(PDF.length);
    expect(out.servedType).toBe('application/pdf');
    expect(ctx.fetcher.fetch.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('refuses a plain-http link without fetching anything', async () => {
    const ctx = ctxWith(async () => new Response(PDF, { status: 200 }));
    await expect(fetchOaPdf(ctx, 'http://repo.example/x.pdf')).rejects.toThrow(OaFetchError);
    await expect(fetchOaPdf(ctx, 'http://repo.example/x.pdf')).rejects.toThrow(/only fetches over https/);
    expect(ctx.fetcher.fetch).not.toHaveBeenCalled();
  });

  it('refuses a host inside the deployment, by literal address and by resolution', async () => {
    const ctx = ctxWith(async () => new Response(PDF, { status: 200 }));
    await expect(fetchOaPdf(ctx, 'https://169.254.169.254/latest/meta-data/')).rejects.toThrow(/non-public address/);
    setOaHostLookup(async () => ['10.1.2.3']);
    await expect(fetchOaPdf(ctx, 'https://repo.example/x.pdf')).rejects.toThrow(/non-public address/);
    expect(ctx.fetcher.fetch).not.toHaveBeenCalled();
  });

  it('checks every redirect hop, not only the one the provider named', async () => {
    setOaHostLookup(async (host: string) => (host === 'repo.example' ? ['93.184.216.34'] : ['127.0.0.1']));
    const ctx = ctxWith(async () => new Response(null, { status: 302, headers: { location: 'https://inside.example/secret' } }));
    await expect(fetchOaPdf(ctx, 'https://repo.example/x.pdf')).rejects.toThrow(/non-public address/);
    // The first hop ran; the second was refused before any request left.
    expect(ctx.fetcher.fetch).toHaveBeenCalledTimes(1);
  });

  it('follows a redirect to another public host and reports where the bytes came from', async () => {
    setOaHostLookup(async () => ['93.184.216.34']);
    const ctx = ctxWith(async (url: string) =>
      url.includes('cdn')
        ? new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } })
        : new Response(null, { status: 301, headers: { location: 'https://cdn.example/file.pdf' } }),
    );
    const out = await fetchOaPdf(ctx, 'https://repo.example/x.pdf');
    expect(out.url).toBe('https://cdn.example/file.pdf');
    expect(out.bytes.length).toBe(PDF.length);
  });

  it('refuses an oversized file by its declared length, without reading the body', async () => {
    setOaHostLookup(async () => ['93.184.216.34']);
    const ctx = ctxWith(
      async () => new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': String(999_999_999) } }),
    );
    await expect(fetchOaPdf(ctx, 'https://repo.example/x.pdf')).rejects.toThrow(/larger than/);
  });

  it('refuses an oversized file that declares no length, while streaming it', async () => {
    setOaHostLookup(async () => ['93.184.216.34']);
    const ctx = ctxWith(async () => new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } }));
    await expect(fetchOaPdf(ctx, 'https://repo.example/x.pdf', { maxBytes: 10 })).rejects.toThrow(/larger than/);
  });

  it('turns a non-2xx into one sentence naming the status', async () => {
    setOaHostLookup(async () => ['93.184.216.34']);
    const ctx = ctxWith(async () => new Response('gone', { status: 404 }));
    await expect(fetchOaPdf(ctx, 'https://repo.example/x.pdf')).rejects.toThrow(/answered HTTP 404/);
  });
});
