import type { RateLimitedFetcher } from '../../api/http.js';

/**
 * Which version of a paper a file is. Green open access is usually NOT the publisher's
 * record: an accepted manuscript has the reviewed text with different pagination, and a
 * submitted one predates review altogether. A citation tool that hides this produces page
 * references to a version of the paper the reader does not have, so the distinction is
 * carried everywhere the file goes rather than flattened into "the PDF".
 */
export type OaVersion = 'published' | 'accepted' | 'submitted';

/** An open-access PDF OpenAlex reports for a work, with the provenance that qualifies it. */
export interface OaPdf {
  /** Direct link to the PDF bytes. */
  url: string;
  /** Who hosts it, as OpenAlex names them ("arXiv", "PubMed Central", "eLife", ...). */
  source?: string;
  /** Which version this copy is, when OpenAlex says; absent when it does not. */
  version?: OaVersion;
  /** The licence the host declares, as OpenAlex reports it (e.g. "cc-by"); absent when none. */
  licence?: string;
  /** The human landing page for this copy, when the location has one. */
  landingPage?: string;
}

export interface ScholarWork {
  title?: string;
  doi?: string;
  year?: number;
  authors: string[];
  citationCount?: number;
  openalexId?: string;
  venue?: string;
  /** OpenAlex's own work type ("article", "book", "conference-paper", ...), when it reports one. */
  type?: string;
  inLibrary?: boolean;
  /** The open-access PDF OpenAlex reports for this work, when it reports one. */
  oa?: OaPdf;
  /**
   * Whether open access was actually checked. False when the record came from the Crossref
   * fallback, which cannot answer the question: an absent `oa` there is silence, not a "no".
   */
  oaChecked?: boolean;
  /**
   * OpenAlex's own `is_retracted` flag, named for its provider because that is all it is.
   *
   * Deliberately NOT called `retracted`. It is true on retraction NOTICES as well as on
   * retracted papers (OpenAlex W4245876183 is `type: "retraction"` and `is_retracted: true`),
   * and it has been observed true on a work whose only trace is a mis-deposited publisher
   * notice naming unrelated DOIs. Read it beside `type`, and treat it as one provider's flag
   * rather than an answer. `zotero_scholar action:"notices"` is the check that puts it next
   * to Crossref's deposited records.
   */
  openalexIsRetracted?: boolean;
  /** The library item key holding this DOI, when a library scan matched it. */
  libraryItemKey?: string;
}

/**
 * What OpenAlex says about one work when it is asked only the retraction question.
 *
 * `type` is here because it is not optional context: `isRetracted` alone cannot tell a
 * retracted paper from the retraction notice about it, and both carry the flag.
 */
export interface RetractionFlag {
  /** The DOI, bare and lowercased. */
  doi?: string;
  /** OpenAlex's `is_retracted`, when it reports one. */
  isRetracted?: boolean;
  /** OpenAlex's work type. "retraction" means this record IS a notice, not a retracted paper. */
  type?: string;
  /** OpenAlex's title for the work. */
  title?: string;
  /** OpenAlex work id, e.g. "W2117847125". */
  openalexId?: string;
}

/**
 * A page of works together with the size of the list it was cut from, so a caller can tell
 * twenty references from twenty of a hundred and fifty (#76).
 */
export interface ScholarList {
  works: ScholarWork[];
  total: number;
}

export interface OpenAlexOptions {
  /**
   * An OpenAlex API key. Optional: keyless requests still work on a small daily budget, and a
   * key raises it. Before February 2026 a `mailto=` parameter selected a faster "polite
   * pool"; OpenAlex has replaced that with keys and now ignores the parameter, so it is no
   * longer sent (#76).
   */
  apiKey?: string;
  /** A contact address, carried in the User-Agent the way the Zotero client carries it. */
  contact?: string;
}

const BASE = 'https://api.openalex.org';

/**
 * A non-OK response from OpenAlex, carrying the status so a caller can tell the two apart:
 * 404 is OpenAlex answering that it has no such work, anything else is the service failing
 * and must never be reported as an absent record. Same idiom as LocalApiError. The URL
 * stays in the message for logs; callers that speak to a model format their own line from
 * the status instead of quoting it.
 */
export class OpenAlexError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OpenAlexError';
  }
}

const OA_VERSIONS: Record<string, OaVersion> = {
  publishedVersion: 'published',
  acceptedVersion: 'accepted',
  submittedVersion: 'submitted',
};

function oaVersion(v: unknown): OaVersion | undefined {
  return typeof v === 'string' ? OA_VERSIONS[v] : undefined;
}

/** The value as an http(s) URL, or undefined: OpenAlex leaves these null more often than not. */
function httpUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return /^https?:\/\//i.test(s) ? s : undefined;
}

function fromLocation(loc: any, url: string): OaPdf {
  const out: OaPdf = { url };
  if (typeof loc?.source?.display_name === 'string') out.source = loc.source.display_name;
  const version = oaVersion(loc?.version);
  if (version) out.version = version;
  if (typeof loc?.license === 'string' && loc.license) out.licence = loc.license;
  const landing = httpUrl(loc?.landing_page_url);
  if (landing) out.landingPage = landing;
  return out;
}

/**
 * The best open-access PDF in a RAW OpenAlex work, or null when there is none to have.
 *
 * The work object is the one `work()` already fetches for every lookup, so this costs no
 * request. Precedence, best first:
 *   1. `best_oa_location.pdf_url` - OpenAlex's own pick of the best free copy.
 *   2. `open_access.oa_url` - the same pick expressed as one URL, taken only when it is not
 *      one of the landing pages this work advertises (see below).
 *   3. `primary_location.pdf_url`, when that location is itself open.
 *   4. the first `locations[]` entry that is open and has a PDF.
 *
 * `oa_url` is "the best free link", which is a PDF for most works and a LANDING PAGE for the
 * rest, and a landing page stored as the full text is an HTML page pretending to be the
 * paper. So it is only accepted when no location claims it as its landing page. A work whose
 * every pdf_url is null therefore yields null rather than a web page.
 *
 * Returns null when OpenAlex says the work is closed, whatever stray URLs the locations
 * carry: its own `is_oa` is the answer to the question being asked.
 */
export function bestOaPdf(work: any): OaPdf | null {
  if (!work || typeof work !== 'object') return null;
  if (work.open_access?.is_oa === false) return null;

  const locations: any[] = Array.isArray(work.locations) ? work.locations : [];
  const best = work.best_oa_location ?? undefined;
  const primary = work.primary_location ?? undefined;

  const bestPdf = httpUrl(best?.pdf_url);
  if (bestPdf) return fromLocation(best, bestPdf);

  const oaUrl = httpUrl(work.open_access?.oa_url);
  if (oaUrl) {
    const landings = new Set(
      [best, primary, ...locations]
        .map((l) => httpUrl(l?.landing_page_url))
        .filter((u): u is string => Boolean(u)),
    );
    if (!landings.has(oaUrl)) return fromLocation(best, oaUrl);
  }

  if (primary?.is_oa === true) {
    const primaryPdf = httpUrl(primary?.pdf_url);
    if (primaryPdf) return fromLocation(primary, primaryPdf);
  }

  for (const loc of locations) {
    if (loc?.is_oa !== true) continue;
    const pdf = httpUrl(loc?.pdf_url);
    if (pdf) return fromLocation(loc, pdf);
  }
  return null;
}

function stripDoi(doi: string): string {
  return doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
}

function bareId(id: string): string {
  return id.replace('https://openalex.org/', '');
}

/**
 * DOIs per batched OpenAlex query. Fifty is what `worksByIds` already uses and what
 * OpenAlex's own OR-filter documentation is written around.
 */
export const OPENALEX_BATCH = 50;

/**
 * Characters a DOI must never carry into a provider query.
 *
 * `,` and `|` are the two batch separators (Crossref joins with commas, OpenAlex with
 * pipes), `&` starts the next query parameter, `#` starts the URL fragment, `?` starts the
 * query string on the single-DOI path routes, whitespace cannot be in a URL at all, `%` can
 * form an escape that decodes into one of the others, and `+` decodes to a space wherever
 * the server form-decodes a query value.
 *
 * A DOI carrying one of these is left out of the batch and reported as unchecked. That is
 * the honest outcome, and it is the one the sweep's `unqueryable` list was written for: a
 * '#' in a single library DOI used to cut the batch URL off at that DOI, so every later DOI
 * in the same group was never sent and yet came back counted as checked and clean.
 */
const QUERY_UNSAFE_DOI = /[,&|#?%+\s]/;

/**
 * Whether a DOI can ride in a batched provider filter without changing the query.
 *
 * Shared by both providers (Crossref imports it as `batchableDoi`) because the rule is about
 * URLs, not about either service: a character that breaks one filter breaks the other.
 */
export function queryableDoi(doi: string): boolean {
  if (doi.length === 0 || QUERY_UNSAFE_DOI.test(doi)) return false;
  // Control characters are refused too. They are kept out of the character class above
  // because a literal control character inside one is unreadable, and spelling them as
  // escapes is what the no-control-regex rule exists to discourage.
  for (const ch of doi) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** Whether a DOI can ride in a pipe-joined OpenAlex filter without changing the query. */
export function pipeableDoi(doi: string): boolean {
  return queryableDoi(doi);
}

/**
 * A DOI as one query-string value, with everything that could change the request escaped.
 *
 * `/` and `:` are left literal: every DOI carries a slash, both are legal in a query value,
 * and encoding them would rewrite every URL this server sends for no gain. Everything else
 * `encodeURIComponent` escapes stays escaped, so a character nobody anticipated cannot
 * truncate the URL or split the filter. Belt and braces beside {@link queryableDoi}: the
 * guard is what makes an unaskable DOI report as unchecked, this is what stops a surprising
 * one from voiding its neighbours.
 */
export function encodeDoiForQuery(doi: string): string {
  return encodeURIComponent(doi).replace(/%2F/gi, '/').replace(/%3A/gi, ':');
}

/**
 * A DOI as path segments. The same rule, except the `/` still has to split segments: a
 * `%2F` in a path is rewritten or refused by a good many servers, so each segment is encoded
 * on its own and the slashes are left alone. Without this a `10.1234/abc#page=3` pasted into
 * a DOI field was fetched as `/works/10.1234/abc`, and the answer was about another work.
 */
export function encodeDoiPath(doi: string): string {
  return doi.split('/').map(encodeURIComponent).join('/');
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export class OpenAlexClient {
  private readonly headers: Record<string, string>;

  constructor(
    private readonly fetcher: RateLimitedFetcher,
    opts: OpenAlexOptions = {},
  ) {
    this.headers = { 'User-Agent': opts.contact ? `zoteus (mailto:${opts.contact})` : 'zoteus' };
    // A header rather than `?api_key=`: every error this client throws quotes the URL, and
    // those messages reach logs and tool output. A header does not.
    if (opts.apiKey) this.headers.Authorization = `Bearer ${opts.apiKey}`;
  }

  private async getJson(url: string): Promise<any> {
    const res = await this.fetcher.fetch(url, { method: 'GET', headers: this.headers }, { maxRetries: 1 });
    if (!res.ok) throw new OpenAlexError(res.status, `OpenAlex ${res.status} for ${url}`);
    return res.json();
  }

  normalize(w: any): ScholarWork {
    return {
      title: w.display_name ?? w.title,
      doi: w.doi ? stripDoi(w.doi) : undefined,
      year: w.publication_year,
      authors: (w.authorships ?? [])
        .map((a: any) => a.author?.display_name)
        .filter(Boolean)
        .slice(0, 10),
      citationCount: w.cited_by_count,
      openalexId: w.id ? bareId(w.id) : undefined,
      venue: w.primary_location?.source?.display_name ?? w.host_venue?.display_name,
      type: w.type,
      // Already on every work object this client fetches, and dropped on the floor until now.
      // Carried under a name that says whose flag it is; see ScholarWork.openalexIsRetracted.
      openalexIsRetracted: typeof w.is_retracted === 'boolean' ? w.is_retracted : undefined,
    };
  }

  /** {@link RetractionFlag} for one RAW work object, with no further request. */
  retractionFlag(w: any): RetractionFlag {
    return {
      doi: w?.doi ? stripDoi(w.doi).toLowerCase() : undefined,
      isRetracted: typeof w?.is_retracted === 'boolean' ? w.is_retracted : undefined,
      type: typeof w?.type === 'string' ? w.type : undefined,
      title: w?.display_name ?? w?.title,
      openalexId: w?.id ? bareId(w.id) : undefined,
    };
  }

  /**
   * The retraction flag for many DOIs at once, in chunks, using the same OR-pipe filter
   * `worksByIds` uses and a `select` that asks for nothing else.
   *
   * A DOI missing from the answer means OpenAlex returned no row for it, which is "OpenAlex
   * does not know this DOI", not "OpenAlex says it is fine". The two are told apart by the
   * caller, from `checked`: a DOI in a batch that failed is not in `checked` at all.
   */
  async retractionFlags(
    dois: string[],
    chunkSize = OPENALEX_BATCH,
  ): Promise<{ found: Map<string, RetractionFlag>; checked: string[]; failures: OpenAlexError[] }> {
    const found = new Map<string, RetractionFlag>();
    const checked: string[] = [];
    const failures: OpenAlexError[] = [];
    // A DOI carrying the filter's own separators cannot ride in it without changing the
    // query, so it is left out here and reported as unchecked rather than silently mangled.
    const usable = [...new Set(dois.map((d) => stripDoi(d).toLowerCase()).filter(pipeableDoi))];
    for (let i = 0; i < usable.length; i += chunkSize) {
      const group = usable.slice(i, i + chunkSize);
      const url = `${BASE}/works?filter=doi:${group.map(encodeDoiForQuery).join('|')}&select=id,doi,is_retracted,type,display_name&per-page=${group.length}`;
      try {
        const json = await this.getJson(url);
        for (const w of json.results ?? []) {
          const flag = this.retractionFlag(w);
          if (flag.doi) found.set(flag.doi, flag);
        }
        checked.push(...group);
      } catch (e) {
        failures.push(e instanceof OpenAlexError ? e : new OpenAlexError(0, (e as Error)?.message ?? 'request failed'));
      }
    }
    return { found, checked, failures };
  }

  /** Fetch a work by DOI or OpenAlex id. Returns the raw work object. */
  async work(doiOrId: string): Promise<any> {
    const path = /^10\./.test(doiOrId) || /doi\.org/i.test(doiOrId)
      ? `works/doi:${encodeDoiPath(stripDoi(doiOrId))}`
      : `works/${encodeURIComponent(bareId(doiOrId))}`;
    return this.getJson(`${BASE}/${path}`);
  }

  /** Resolve many OpenAlex ids to normalized works. */
  async worksByIds(ids: string[]): Promise<ScholarWork[]> {
    const out: ScholarWork[] = [];
    for (const group of chunk(ids.map(bareId), 50)) {
      if (!group.length) continue;
      const json = await this.getJson(
        `${BASE}/works?filter=openalex_id:${group.map(encodeURIComponent).join('|')}&per-page=50`,
      );
      for (const w of json.results ?? []) out.push(this.normalize(w));
    }
    return out;
  }

  /** Works that cite the given OpenAlex id. */
  async citedBy(openalexId: string, perPage = 25): Promise<ScholarWork[]> {
    const json = await this.getJson(
      `${BASE}/works?filter=cites:${encodeURIComponent(bareId(openalexId))}&per-page=${Math.min(perPage, 200)}&sort=cited_by_count:desc`,
    );
    return (json.results ?? []).map((w: any) => this.normalize(w));
  }
}
