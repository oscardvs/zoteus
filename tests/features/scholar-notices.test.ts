import { describe, it, expect, vi } from 'vitest';
import { CrossrefClient, CrossrefError } from '../../src/features/scholar/crossref.js';
import { OpenAlexClient } from '../../src/features/scholar/openalex.js';
import { ScholarGraph } from '../../src/features/scholar/graph.js';
import { RateLimitedFetcher } from '../../src/api/http.js';

function fetcher(fetchImpl: any) {
  return new RateLimitedFetcher({ fetchImpl, maxConcurrency: 4 });
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

/*
 * Every payload below was captured from the live free APIs while this was written, not
 * invented: the field names, the nesting of `updated`, the `record-id` string and the shape
 * of Crossref's work-LIST envelope are all exactly what the services return.
 */

const WAKEFIELD = '10.1016/s0140-6736(97)11096-0';
const NOTICE = '10.1016/s0140-6736(10)60175-4';
const CLEAN = '10.1038/nature14539';
const LANCET_COMMISSION = '10.1016/s0140-6736(20)30367-6';

const CORRECTION = {
  DOI: '10.1016/s0140-6736(04)15715-2',
  type: 'correction',
  label: 'Correction',
  source: 'retraction-watch',
  updated: { 'date-parts': [[2004, 3, 6]], 'date-time': '2004-03-06T00:00:00Z', timestamp: 1078531200000 },
  'record-id': '17269',
};
const RETRACTION = {
  DOI: NOTICE,
  type: 'retraction',
  label: 'Retraction',
  source: 'retraction-watch',
  updated: { 'date-parts': [[2010, 2, 6]], 'date-time': '2010-02-06T00:00:00Z', timestamp: 1265414400000 },
  'record-id': '4036',
};

const crossrefWork = (message: Record<string, unknown>) => ({
  status: 'ok',
  'message-type': 'work',
  'message-version': '1.0.0',
  message,
});

const CROSSREF_RETRACTED = crossrefWork({
  DOI: WAKEFIELD,
  title: ['RETRACTED: Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children'],
  'updated-by': [CORRECTION, RETRACTION],
});
// The clean work has no `updated-by` key at all, not an empty array. The parser has to
// answer the same way for both, and neither may be reported as anything but "none deposited".
const CROSSREF_CLEAN = crossrefWork({ DOI: CLEAN, title: ['Deep learning'] });
const CROSSREF_NOTICE = crossrefWork({
  DOI: NOTICE,
  title: ['Retraction: Ileal-lymphoid-nodular hyperplasia, non-specific colitis, and pervasive developmental disorder in children'],
  'update-to': [{ ...RETRACTION, DOI: WAKEFIELD }],
});
// The false-positive case: OpenAlex flags this work retracted, Crossref has only a
// publisher-deposited correction against it.
const CROSSREF_DISAGREE = crossrefWork({
  DOI: LANCET_COMMISSION,
  title: ['Dementia prevention, intervention, and care: 2020 report of the Lancet Commission'],
  'updated-by': [
    {
      DOI: '10.1016/s0140-6736(23)01234-5',
      type: 'correction',
      label: 'Correction',
      source: 'publisher',
      updated: { 'date-parts': [[2023, 7, 1]] },
    },
  ],
});

const openalexWork = (doi: string, extra: Record<string, unknown> = {}) => ({
  id: 'https://openalex.org/W2117847125',
  doi: `https://doi.org/${doi}`,
  display_name: 'A work',
  type: 'article',
  ...extra,
});

describe('CrossrefClient.updates', () => {
  it('reads both notices off a retracted work, with source, date and record id', async () => {
    const c = new CrossrefClient(fetcher(vi.fn(async () => json(CROSSREF_RETRACTED))), 'me@example.com');
    const u = await c.updates(WAKEFIELD);
    expect(u.doi).toBe(WAKEFIELD);
    expect(u.updatedBy).toHaveLength(2);
    expect(u.updatedBy[0]).toMatchObject({
      type: 'correction',
      label: 'Correction',
      doi: '10.1016/s0140-6736(04)15715-2',
      date: '2004-03-06',
      source: 'retraction-watch',
      recordId: '17269',
    });
    expect(u.updatedBy[1]).toMatchObject({ type: 'retraction', date: '2010-02-06', recordId: '4036' });
    expect(u.updates).toEqual([]);
  });

  it('answers an absent `updated-by` key the same as an empty one, and never invents a record', async () => {
    const c = new CrossrefClient(fetcher(vi.fn(async () => json(CROSSREF_CLEAN))));
    const absent = await c.updates(CLEAN);
    expect(absent.updatedBy).toEqual([]);
    expect(absent.updates).toEqual([]);
    const withEmpty = new CrossrefClient(
      fetcher(vi.fn(async () => json(crossrefWork({ DOI: CLEAN, 'updated-by': [] })))),
    );
    expect((await withEmpty.updates(CLEAN)).updatedBy).toEqual([]);
  });

  it('reads `update-to` so a notice is recognised as a notice, not as a retracted paper', async () => {
    const c = new CrossrefClient(fetcher(vi.fn(async () => json(CROSSREF_NOTICE))));
    const u = await c.updates(NOTICE);
    expect(u.updatedBy).toEqual([]);
    expect(u.updates).toHaveLength(1);
    expect(u.updates[0]).toMatchObject({ type: 'retraction', doi: WAKEFIELD });
  });

  it('throws with the status rather than returning an empty answer', async () => {
    const down = new CrossrefClient(fetcher(vi.fn(async () => new Response('busy', { status: 503 }))));
    await expect(down.updates(WAKEFIELD)).rejects.toBeInstanceOf(CrossrefError);
    await expect(down.updates(WAKEFIELD)).rejects.toMatchObject({ status: 503 });

    const missing = new CrossrefClient(fetcher(vi.fn(async () => new Response('no', { status: 404 }))));
    await expect(missing.updates(WAKEFIELD)).rejects.toMatchObject({ status: 404 });
  });

  // The bug this guard was written for: `/works/` with no DOI is the works-LIST route and
  // answers 200, and read as one work it is a paper with nothing deposited against it.
  it('refuses a work-LIST envelope instead of reading it as a clean work', async () => {
    const listEnvelope = {
      status: 'ok',
      'message-type': 'work-list',
      message: { facets: {}, 'total-results': 186439611, items: [{ DOI: '10.1/first' }] },
    };
    const c = new CrossrefClient(fetcher(vi.fn(async () => json(listEnvelope))));
    await expect(c.updates('')).rejects.toBeInstanceOf(CrossrefError);
    await expect(c.updates(WAKEFIELD)).rejects.toThrow(/listing rather than one work/);
  });

  it('refuses a 200 whose body is not JSON', async () => {
    const c = new CrossrefClient(fetcher(vi.fn(async () => new Response('<html>maintenance</html>', { status: 200 }))));
    await expect(c.updates(WAKEFIELD)).rejects.toThrow(/not JSON/);
  });
});

describe('CrossrefClient.updatesFor (the batch route)', () => {
  const batchEnvelope = {
    status: 'ok',
    'message-type': 'work-list',
    message: {
      facets: {},
      'total-results': 2,
      items: [
        { DOI: CLEAN, title: ['Deep learning'] },
        { DOI: WAKEFIELD, 'updated-by': [CORRECTION, RETRACTION], title: ['RETRACTED: ...'] },
      ],
    },
  };

  it('parses the work-LIST envelope the single-work reader refuses, and keys by lowercased DOI', async () => {
    const seen: string[] = [];
    const c = new CrossrefClient(
      fetcher(
        vi.fn(async (url: string) => {
          seen.push(url);
          return json(batchEnvelope);
        }),
      ),
      'me@example.com',
    );
    const out = await c.updatesFor([WAKEFIELD.toUpperCase(), `https://doi.org/${CLEAN}`]);
    expect(seen[0]).toContain(`filter=doi:${WAKEFIELD},doi:${CLEAN}`);
    expect(seen[0]).toContain('select=DOI,updated-by,update-to,title');
    expect(seen[0]).toContain('mailto=me%40example.com');
    expect(out.found.get(WAKEFIELD)!.updatedBy).toHaveLength(2);
    expect(out.found.get(CLEAN)!.updatedBy).toEqual([]);
    expect(out.checked).toEqual([WAKEFIELD, CLEAN]);
    expect(out.failures).toEqual([]);
  });

  it('chunks, and reports the DOIs of a failed chunk as unchecked rather than as clean', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('doi:10.1/b') ? new Response('nope', { status: 500 }) : json(batchEnvelope),
    );
    const c = new CrossrefClient(fetcher(fetchImpl));
    const out = await c.updatesFor(['10.1/a', '10.1/b'], 1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(out.checked).toEqual(['10.1/a']);
    expect(out.failures).toHaveLength(1);
    expect(out.failures[0].status).toBe(500);
    // The failed DOI is simply absent. Nothing in the result says anything about it.
    expect(out.found.has('10.1/b')).toBe(false);
  });

  it('refuses a batch answer that is not a list, rather than treating it as an empty one', async () => {
    const c = new CrossrefClient(fetcher(vi.fn(async () => json(crossrefWork({ DOI: CLEAN })))));
    const out = await c.updatesFor([CLEAN]);
    expect(out.checked).toEqual([]);
    expect(out.failures[0].message).toMatch(/no item list/);
  });
});

describe('OpenAlexClient.retractionFlags', () => {
  it('uses the OR-pipe filter with a retraction-only select, and keys by bare lowercased DOI', async () => {
    const seen: string[] = [];
    const c = new OpenAlexClient(
      fetcher(
        vi.fn(async (url: string) => {
          seen.push(url);
          return json({
            results: [
              openalexWork(CLEAN, { is_retracted: false, display_name: 'Deep learning' }),
              openalexWork(WAKEFIELD, { is_retracted: true, display_name: 'RETRACTED: ...' }),
            ],
          });
        }),
      ),
    );
    const out = await c.retractionFlags([`https://doi.org/${CLEAN.toUpperCase()}`, WAKEFIELD]);
    expect(seen[0]).toContain(`filter=doi:${CLEAN}|${WAKEFIELD}`);
    expect(seen[0]).toContain('select=id,doi,is_retracted,type,display_name');
    expect(out.found.get(WAKEFIELD)).toMatchObject({ isRetracted: true, type: 'article' });
    expect(out.found.get(CLEAN)!.isRetracted).toBe(false);
    expect(out.checked).toEqual([CLEAN, WAKEFIELD]);
  });

  it('chunks at the size it is given and keeps a failed chunk out of `checked`', async () => {
    const urls = new Set<string>();
    const fetchImpl = vi.fn(async (url: string) => {
      urls.add(url);
      return url.includes('10.1/b') ? new Response('rate limited', { status: 429 }) : json({ results: [] });
    });
    const out = await new OpenAlexClient(fetcher(fetchImpl)).retractionFlags(['10.1/a', '10.1/b'], 1);
    // Two chunks, one query each. The call count is higher than two because the shared
    // fetcher retries a 429 once, which is the maxRetries:1 both scholar clients ask for.
    expect(urls.size).toBe(2);
    expect(out.checked).toEqual(['10.1/a']);
    expect(out.failures[0].status).toBe(429);
  });

  it('leaves a DOI carrying a filter separator out of the query rather than mangling it', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).not.toContain('10.1/with,comma');
      return json({ results: [] });
    });
    const out = await new OpenAlexClient(fetcher(fetchImpl)).retractionFlags(['10.1/with,comma', '10.1/ok']);
    expect(out.checked).toEqual(['10.1/ok']);
  });
});

/** A fetch impl that answers the two providers from per-DOI fixtures. */
function providers(opts: {
  crossref?: (doi: string) => Response;
  openalex?: (doi: string) => Response;
}) {
  return vi.fn(async (url: string) => {
    if (url.includes('crossref.org')) {
      const doi = decodeURIComponent(url.split('/works/')[1]!.split('?')[0]!);
      return opts.crossref ? opts.crossref(doi) : new Response('no handler', { status: 500 });
    }
    const doi = decodeURIComponent(url.split('works/doi:')[1] ?? '');
    return opts.openalex ? opts.openalex(doi) : new Response('no handler', { status: 500 });
  });
}

describe('ScholarGraph.notices', () => {
  it('asks both providers on the happy path, not Crossref only as a fallback', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url.includes('crossref.org') ? 'crossref' : 'openalex');
      return url.includes('crossref.org')
        ? json(CROSSREF_RETRACTED)
        : json(openalexWork(WAKEFIELD, { is_retracted: true }));
    });
    const g = new ScholarGraph({ fetcher: fetcher(fetchImpl) });
    const r = await g.notices(WAKEFIELD);
    expect(seen.sort()).toEqual(['crossref', 'openalex']);
    expect(r.notices.map((n) => n.type)).toEqual(['correction', 'retraction']);
    expect(r.openalex).toEqual({ isRetracted: true, workType: 'article' });
    expect(r.sources).toEqual([
      { name: 'crossref', reached: true, found: true },
      { name: 'openalex', reached: true, found: true },
    ]);
    expect(r.disagreement).toBe(false);
    // No boolean anywhere that a reader could render as a verdict.
    expect(Object.keys(r)).not.toContain('retracted');
  });

  it('reports a clean work as no deposited record, with both sources reached', async () => {
    const g = new ScholarGraph({
      fetcher: fetcher(
        providers({
          crossref: () => json(CROSSREF_CLEAN),
          openalex: () => json(openalexWork(CLEAN, { is_retracted: false })),
        }),
      ),
    });
    const r = await g.notices(CLEAN);
    expect(r.notices).toEqual([]);
    expect(r.openalex!.isRetracted).toBe(false);
    expect(r.sources.every((s) => s.reached && s.found)).toBe(true);
    expect(r.disagreement).toBe(false);
  });

  it('marks a source that did not answer as not reached, with its status', async () => {
    const g = new ScholarGraph({
      fetcher: fetcher(
        providers({
          crossref: () => new Response('busy', { status: 503 }),
          openalex: () => json(openalexWork(CLEAN, { is_retracted: false })),
        }),
      ),
    });
    const r = await g.notices(CLEAN);
    const cr = r.sources.find((s) => s.name === 'crossref')!;
    expect(cr).toMatchObject({ reached: false, status: 503 });
    expect(cr.found).toBeUndefined();
    expect(cr.note).toMatch(/NOT checked/);
    // An unreachable source can never produce a disagreement, because it said nothing.
    expect(r.disagreement).toBe(false);
  });

  it('separates "the source has no such DOI" (404) from "the source did not answer"', async () => {
    const g = new ScholarGraph({
      fetcher: fetcher(
        providers({
          crossref: () => new Response('not found', { status: 404 }),
          openalex: () => json(openalexWork(CLEAN, { is_retracted: false })),
        }),
      ),
    });
    const r = await g.notices(CLEAN);
    const cr = r.sources.find((s) => s.name === 'crossref')!;
    expect(cr).toMatchObject({ reached: true, found: false, status: 404 });
    expect(cr.note).toMatch(/no record for this DOI/);
  });

  it('sets disagreement when OpenAlex flags a retraction and Crossref deposited only a correction', async () => {
    const g = new ScholarGraph({
      fetcher: fetcher(
        providers({
          crossref: () => json(CROSSREF_DISAGREE),
          openalex: () => json(openalexWork(LANCET_COMMISSION, { is_retracted: true })),
        }),
      ),
    });
    const r = await g.notices(LANCET_COMMISSION);
    expect(r.disagreement).toBe(true);
    expect(r.notices.map((n) => n.type)).toEqual(['correction']);
    expect(r.openalex!.isRetracted).toBe(true);
  });

  it('sets disagreement the other way too: a deposited retraction with is_retracted false', async () => {
    const g = new ScholarGraph({
      fetcher: fetcher(
        providers({
          crossref: () => json(CROSSREF_RETRACTED),
          openalex: () => json(openalexWork(WAKEFIELD, { is_retracted: false })),
        }),
      ),
    });
    expect((await g.notices(WAKEFIELD)).disagreement).toBe(true);
  });

  // W4245876183 is `type: "retraction"` AND `is_retracted: true`. Read naively that reports
  // the retraction notice as the retracted paper.
  it('does not call a retraction notice a disagreement, and says what it is instead', async () => {
    const g = new ScholarGraph({
      fetcher: fetcher(
        providers({
          crossref: () => json(CROSSREF_NOTICE),
          openalex: () => json(openalexWork(NOTICE, { is_retracted: true, type: 'retraction' })),
        }),
      ),
    });
    const r = await g.notices(NOTICE);
    expect(r.notices).toEqual([]);
    expect(r.isNoticeFor).toHaveLength(1);
    expect(r.isNoticeFor[0].doi).toBe(WAKEFIELD);
    expect(r.openalex).toEqual({ isRetracted: true, workType: 'retraction' });
    expect(r.disagreement).toBe(false);
  });

  it('never reports a correction as a retraction disagreement', async () => {
    const g = new ScholarGraph({
      fetcher: fetcher(
        providers({
          crossref: () => json(crossrefWork({ DOI: CLEAN, 'updated-by': [CORRECTION] })),
          openalex: () => json(openalexWork(CLEAN, { is_retracted: false })),
        }),
      ),
    });
    const r = await g.notices(CLEAN);
    expect(r.notices.map((n) => n.type)).toEqual(['correction']);
    expect(r.disagreement).toBe(false);
  });
});

describe('ScholarGraph.noticeSweep', () => {
  const batch = (items: unknown[]) => json({ 'message-type': 'work-list', message: { items } });

  it('returns only the DOIs something was reported about, and counts what it checked', async () => {
    const g = new ScholarGraph({
      fetcher: fetcher(
        vi.fn(async (url: string) =>
          url.includes('crossref.org')
            ? batch([{ DOI: WAKEFIELD, 'updated-by': [RETRACTION] }, { DOI: CLEAN }])
            : json({
                results: [
                  openalexWork(WAKEFIELD, { is_retracted: true }),
                  openalexWork(CLEAN, { is_retracted: false }),
                ],
              }),
        ),
      ),
    });
    const r = await g.noticeSweep([WAKEFIELD, CLEAN]);
    expect(r.findings.map((f) => f.doi)).toEqual([WAKEFIELD]);
    expect(r.findings[0].notices[0]).toMatchObject({ type: 'retraction', source: 'retraction-watch' });
    expect(r.findings[0].openalexIsRetracted).toBe(true);
    expect(r.sources).toEqual([
      { name: 'crossref', reached: true, checked: 2, asked: 2 },
      { name: 'openalex', reached: true, checked: 2, asked: 2 },
    ]);
  });

  it('reports a provider outage as a coverage gap with a count, not as an empty result', async () => {
    const g = new ScholarGraph({
      fetcher: fetcher(
        vi.fn(async (url: string) =>
          url.includes('crossref.org')
            ? new Response('busy', { status: 503 })
            : json({ results: [openalexWork(CLEAN, { is_retracted: false })] }),
        ),
      ),
    });
    const r = await g.noticeSweep([WAKEFIELD, CLEAN]);
    expect(r.findings).toEqual([]);
    const cr = r.sources.find((s) => s.name === 'crossref')!;
    expect(cr).toMatchObject({ reached: false, status: 503, checked: 0, asked: 2 });
    expect(cr.note).toMatch(/NOT checked/);
  });

  it('flags a DOI OpenAlex alone calls retracted, even when Crossref deposited nothing', async () => {
    const g = new ScholarGraph({
      fetcher: fetcher(
        vi.fn(async (url: string) =>
          url.includes('crossref.org')
            ? batch([{ DOI: LANCET_COMMISSION }])
            : json({ results: [openalexWork(LANCET_COMMISSION, { is_retracted: true })] }),
        ),
      ),
    });
    const r = await g.noticeSweep([LANCET_COMMISSION]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].notices).toEqual([]);
    expect(r.findings[0].openalexIsRetracted).toBe(true);
  });

  it('names DOIs it could not put in a batch query instead of dropping them silently', async () => {
    const g = new ScholarGraph({
      fetcher: fetcher(vi.fn(async (url: string) => (url.includes('crossref.org') ? batch([]) : json({ results: [] })))),
    });
    const r = await g.noticeSweep(['10.1/comma,inside', CLEAN]);
    expect(r.unqueryable).toEqual(['10.1/comma,inside']);
  });
});

/*
 * A DOI that cannot go into a query.
 *
 * The batch routes build their URL by concatenation, so a '#' in one library DOI used to end
 * the URL there: everything after it (the other DOIs, `select`, `rows`) went into the
 * fragment, which no browser or fetch implementation ever sends. Both providers answer that
 * truncated request with 200 and an empty list, so no error was raised and the whole group
 * was pushed into `checked`. Up to 39 (Crossref) or 49 (OpenAlex) other DOIs were never
 * asked about and were then counted as checked and clean.
 *
 * The fetch impls below drop the fragment exactly as the network does, so these tests fail
 * against the old code for the real reason rather than a simulated one.
 */
describe('a DOI that cannot ride in a batch query is reported as unchecked, never as clean', () => {
  const HASHED = '10.1234/abc#page=3';
  /** What actually leaves the machine: everything from the '#' onwards is dropped. */
  const onWire = (url: string) => url.split('#')[0]!;

  it('keeps a fragment DOI out of the Crossref batch and still asks about its neighbours', async () => {
    const sent: string[] = [];
    const c = new CrossrefClient(
      fetcher(
        vi.fn(async (url: string) => {
          const wire = onWire(url);
          sent.push(wire);
          const asked = wire.includes(`doi:${WAKEFIELD}`);
          return json({
            'message-type': 'work-list',
            message: { items: asked ? [{ DOI: WAKEFIELD, 'updated-by': [RETRACTION] }] : [] },
          });
        }),
      ),
    );
    const out = await c.updatesFor([HASHED, WAKEFIELD]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(`doi:${WAKEFIELD}`);
    expect(sent[0]).not.toContain('10.1234/abc');
    expect(sent[0]).toContain('rows=1');
    // The neighbour was really asked, and really answered.
    expect(out.found.get(WAKEFIELD)!.updatedBy).toHaveLength(1);
    // And the DOI nobody could ask about is NOT claimed as checked.
    expect(out.checked).toEqual([WAKEFIELD]);
  });

  it('keeps a fragment DOI out of the OpenAlex batch and still asks about its neighbours', async () => {
    const sent: string[] = [];
    const c = new OpenAlexClient(
      fetcher(
        vi.fn(async (url: string) => {
          const wire = onWire(url);
          sent.push(wire);
          return json({
            results: wire.includes(WAKEFIELD)
              ? [openalexWork(WAKEFIELD, { is_retracted: true, display_name: 'RETRACTED: ...' })]
              : [],
          });
        }),
      ),
    );
    const out = await c.retractionFlags([HASHED, WAKEFIELD]);
    expect(sent[0]).toContain(WAKEFIELD);
    expect(sent[0]).toContain('select=id,doi,is_retracted');
    expect(out.found.get(WAKEFIELD)!.isRetracted).toBe(true);
    expect(out.checked).toEqual([WAKEFIELD]);
  });

  it('names it in `unqueryable` and still finds the retraction sharing its batch', async () => {
    const g = new ScholarGraph({
      fetcher: fetcher(
        vi.fn(async (raw: string) => {
          const url = onWire(raw);
          if (url.includes('crossref.org')) {
            return json({
              'message-type': 'work-list',
              message: { items: url.includes(WAKEFIELD) ? [{ DOI: WAKEFIELD, 'updated-by': [RETRACTION] }] : [] },
            });
          }
          return json({ results: url.includes(WAKEFIELD) ? [openalexWork(WAKEFIELD, { is_retracted: true })] : [] });
        }),
      ),
    });
    const r = await g.noticeSweep([HASHED, WAKEFIELD]);
    expect(r.unqueryable).toEqual([HASHED]);
    // The retraction is found rather than swallowed by its neighbour.
    expect(r.findings.map((f) => f.doi)).toEqual([WAKEFIELD]);
    expect(r.findings[0].notices[0]).toMatchObject({ type: 'retraction' });
    // One of the two DOIs was asked about, and the counts say so rather than claiming both.
    expect(r.sources.map((s) => [s.name, s.checked, s.asked])).toEqual([
      ['crossref', 1, 2],
      ['openalex', 1, 2],
    ]);
  });

  it('escapes the single-DOI route rather than silently asking about a different work', async () => {
    const sent: string[] = [];
    const c = new CrossrefClient(
      fetcher(
        vi.fn(async (url: string) => {
          sent.push(onWire(url));
          return json(CROSSREF_CLEAN);
        }),
      ),
    );
    await c.updates(HASHED).catch(() => undefined);
    // Not `/works/10.1234/abc`, which is a different DOI and would have answered about it.
    // The slash still separates path segments; everything else that could steer the request
    // is escaped.
    expect(sent[0]).toContain('/works/10.1234/abc%23page%3D3');
    expect(sent[0]).not.toMatch(/works\/10\.1234\/abc$/);
  });

  it('leaves a DOI carrying a percent or a plus out of the batch too', async () => {
    const fetchImpl = vi.fn(async () => json({ 'message-type': 'work-list', message: { items: [] } }));
    const out = await new CrossrefClient(fetcher(fetchImpl)).updatesFor(['10.1/a%2Cb', '10.1/c+d', CLEAN]);
    // '%' can spell a separator once the server decodes it, and '+' decodes to a space.
    expect(out.checked).toEqual([CLEAN]);
  });
});

/*
 * `select` returns EXACTLY the fields it names. The batch asked for DOI, updated-by and
 * title, and then read `update-to` off the answer, so `isNoticeFor` was structurally empty in
 * every sweep: a retraction notice the user deliberately saved came back as a row with an
 * OpenAlex retraction flag and nothing to say it is the notice rather than the offence.
 */
describe('the Crossref batch asks for the fields the sweep reports', () => {
  /** A Crossref that honours `select` the way the live one does. */
  function selecting(records: Array<Record<string, unknown>>) {
    return vi.fn(async (url: string) => {
      const select = new URL(url).searchParams.get('select')?.split(',');
      const items = records.map((rec) =>
        select ? Object.fromEntries(Object.entries(rec).filter(([k]) => select.includes(k))) : rec,
      );
      return json({ 'message-type': 'work-list', message: { items } });
    });
  }

  const SAVED_NOTICE = {
    DOI: NOTICE,
    title: ['Retraction: Ileal-lymphoid-nodular hyperplasia...'],
    'update-to': [{ ...RETRACTION, DOI: WAKEFIELD }],
  };

  it('reads update-to off a batch row, because it asked for it', async () => {
    const out = await new CrossrefClient(fetcher(selecting([SAVED_NOTICE]))).updatesFor([NOTICE]);
    expect(out.found.get(NOTICE)!.updates.map((u) => u.doi)).toEqual([WAKEFIELD]);
    expect(out.found.get(NOTICE)!.updatedBy).toEqual([]);
  });

  it('reports a library-held notice as a notice, not only as a flagged work', async () => {
    const crossref = selecting([SAVED_NOTICE]);
    const g = new ScholarGraph({
      fetcher: fetcher(
        vi.fn(async (url: string) =>
          url.includes('crossref.org')
            ? crossref(url)
            : json({ results: [openalexWork(NOTICE, { is_retracted: true, type: 'retraction' })] }),
        ),
      ),
    });
    const r = await g.noticeSweep([NOTICE]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].isNoticeFor.map((n) => n.doi)).toEqual([WAKEFIELD]);
    expect(r.findings[0].openalexIsRetracted).toBe(true);
    expect(r.findings[0].openalexType).toBe('retraction');
  });
});
