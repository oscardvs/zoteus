import type { RateLimitedFetcher } from '../../api/http.js';
import { encodeDoiForQuery, encodeDoiPath, queryableDoi } from './openalex.js';
import type { ScholarWork } from './openalex.js';

const BASE = 'https://api.crossref.org';

/**
 * DOIs per batched Crossref query. Crossref accepts far more, but each DOI is roughly thirty
 * characters of URL and the answer carries a title per row, so this is a size that keeps the
 * request line ordinary and the failure blast radius small: one failed batch costs forty
 * DOIs of coverage, which the caller then has to report as unchecked.
 */
export const CROSSREF_BATCH = 40;

function stripDoi(doi: string): string {
  return doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
}

/** A DOI in the bare, lowercased form both providers and the library census compare on. */
function doiKey(doi: string): string {
  return stripDoi(doi).toLowerCase();
}

/**
 * Crossref answered, but not with the record that was asked for.
 *
 * Carries the HTTP status so a caller can tell "Crossref has no such DOI" (404) from
 * "Crossref did not answer" (503, a timeout, an unreadable body). Those two are the same
 * silence on the wire and must never be the same sentence in the output: one is a fact
 * about the DOI, the other is a fact about the service. `status` is 0 when there was no
 * HTTP status to report at all, i.e. the request never completed or the body was not the
 * envelope it claimed to be.
 */
export class CrossrefError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CrossrefError';
  }
}

/**
 * One deposited update record: a link between a work and a notice about it.
 *
 * This is a RECORD someone deposited, not a conclusion. Crossref stores what publishers and
 * the Retraction Watch database sent it, and both have been wrong: a publisher notice has
 * been seen naming three unrelated DOIs as retracted. Everything here therefore keeps its
 * provenance (`source`, `date`, the notice's own `doi`) so the reader can go and read the
 * notice instead of taking this tool's word for anything.
 */
export interface UpdateNotice {
  /**
   * Crossref's update type, verbatim: "retraction", "correction", "expression_of_concern",
   * "withdrawal", "removal", "erratum", "new_edition", "partial_retraction", and others it
   * may add. Not narrowed to an enum, because an unknown type must reach the reader rather
   * than be dropped.
   */
  type: string;
  /** The publisher's own label, e.g. "Retraction". Absent when none was deposited. */
  label?: string;
  /** The DOI at the other end of the link: the notice, or the work the notice is about. */
  doi?: string;
  /** The date on the update record, YYYY-MM-DD, or as much of it as was deposited. */
  date?: string;
  /** Who deposited it: "publisher", or "retraction-watch" for the Retraction Watch database. */
  source?: string;
  /** Retraction Watch's own record id, when the record came from there. */
  recordId?: string;
}

/** What Crossref holds about one DOI's update records. */
export interface CrossrefUpdates {
  /** The DOI these records are for, bare and lowercased. */
  doi: string;
  /** Records pointing AT this DOI: notices that update this work (Crossref `updated-by`). */
  updatedBy: UpdateNotice[];
  /**
   * Records this DOI points at (Crossref `update-to`): present when the DOI is itself an
   * update notice about other works. A retraction notice carries this AND is flagged
   * `is_retracted` by OpenAlex, so reading only the flag reports the notice as the offence.
   */
  updates: UpdateNotice[];
  /** Crossref's title for the DOI, when it deposited one. */
  title?: string;
}

/** `{"date-parts": [[2010, 2, 6]]}` as "2010-02-06", padding only the parts that are there. */
function updateDate(updated: any): string | undefined {
  const parts = updated?.['date-parts']?.[0];
  if (Array.isArray(parts) && typeof parts[0] === 'number') {
    return parts
      .filter((n: unknown) => typeof n === 'number')
      .map((n: number, i: number) => (i === 0 ? String(n) : String(n).padStart(2, '0')))
      .join('-');
  }
  const dt = updated?.['date-time'];
  return typeof dt === 'string' && dt.length >= 10 ? dt.slice(0, 10) : undefined;
}

/** One `updated-by` / `update-to` element as a typed record; undefined when it carries nothing. */
function toNotice(raw: any): UpdateNotice | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const type = typeof raw.type === 'string' && raw.type ? raw.type : undefined;
  const doi = typeof raw.DOI === 'string' && raw.DOI ? doiKey(raw.DOI) : undefined;
  // A record with neither a type nor a DOI says nothing at all; reporting it as an untyped
  // notice would put a blank row under a heading that reads as an accusation.
  if (!type && !doi) return undefined;
  const out: UpdateNotice = { type: type ?? 'unspecified' };
  if (doi) out.doi = doi;
  if (typeof raw.label === 'string' && raw.label) out.label = raw.label;
  const date = updateDate(raw.updated);
  if (date) out.date = date;
  if (typeof raw.source === 'string' && raw.source) out.source = raw.source;
  const recordId = raw['record-id'];
  if (recordId !== undefined && recordId !== null) out.recordId = String(recordId);
  return out;
}

/** The `updated-by` and `update-to` arrays of one Crossref message, as typed records. */
function noticesOf(w: any, doi: string): CrossrefUpdates {
  const list = (v: unknown): UpdateNotice[] =>
    (Array.isArray(v) ? v : []).map(toNotice).filter((n): n is UpdateNotice => n !== undefined);
  const out: CrossrefUpdates = {
    doi: typeof w?.DOI === 'string' && w.DOI ? doiKey(w.DOI) : doi,
    updatedBy: list(w?.['updated-by']),
    updates: list(w?.['update-to']),
  };
  const title = Array.isArray(w?.title) ? w.title[0] : w?.title;
  if (typeof title === 'string' && title) out.title = title;
  return out;
}

/**
 * Whether a DOI can ride in a comma-joined Crossref filter without changing its meaning.
 *
 * The rule itself lives in `queryableDoi` and is shared with OpenAlex: it is a statement
 * about URLs, not about either service, and a DOI that voids one provider's batch voids the
 * other's too.
 */
export function batchableDoi(doi: string): boolean {
  return queryableDoi(doi);
}

/**
 * Whether this 200 really is one work, and not a listing that happens to parse.
 *
 * `/works/<doi>` and `/works/` are the same route with and without a DOI, and the second is
 * Crossref's works-LIST endpoint: it answers 200 with `{"message-type":"work-list",
 * message:{facets, total-results: 186 million, items:[...]}}`. Read as a work, that
 * envelope has no title, no DOI and no authors, so an empty DOI came back as a successful
 * lookup of an untitled paper with nothing in it. A 200 from the wrong endpoint is not a
 * result: the envelope has to say `work`, and the payload has to carry the DOI that every
 * indexed work has, before anything is read out of it.
 *
 * `message-type` is checked only when present, so a lenient mirror that omits it still
 * works, and the `items` array catches a list envelope either way.
 */
function isSingleWork(json: any): boolean {
  const type = json['message-type'];
  if (typeof type === 'string' && type !== 'work') return false;
  const w = json.message;
  if (w === null || typeof w !== 'object') return false;
  return !Array.isArray(w.items) && typeof w.DOI === 'string';
}

/** Crossref DOI-metadata fallback. Tolerates non-JSON error responses. */
export class CrossrefClient {
  constructor(
    private readonly fetcher: RateLimitedFetcher,
    private readonly mailto?: string,
  ) {}

  async work(doi: string): Promise<ScholarWork | null> {
    const m = this.mailto ? `?mailto=${encodeURIComponent(this.mailto)}` : '';
    try {
      const res = await this.fetcher.fetch(`${BASE}/works/${encodeDoiPath(stripDoi(doi))}${m}`, { method: 'GET' }, { maxRetries: 1 });
      if (!res.ok) return null;
      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        return null;
      }
      const w = json.message;
      if (!w || !isSingleWork(json)) return null;
      return {
        title: Array.isArray(w.title) ? w.title[0] : w.title,
        doi: w.DOI,
        year: w.issued?.['date-parts']?.[0]?.[0],
        authors: (w.author ?? [])
          .map((a: any) => [a.given, a.family].filter(Boolean).join(' '))
          .filter(Boolean)
          .slice(0, 10),
        citationCount: w['is-referenced-by-count'],
        venue: Array.isArray(w['container-title']) ? w['container-title'][0] : w['container-title'],
      };
    } catch {
      return null;
    }
  }

  /**
   * The update records Crossref holds for one DOI: notices about this work, and, when the
   * DOI is itself a notice, the works it is a notice about.
   *
   * Unlike {@link work}, this THROWS rather than returning null. A null here would collapse
   * "Crossref has no such DOI", "Crossref is down" and "there is nothing deposited" into one
   * value, and the whole point of an update check is that those three must read differently:
   * the first two are silence, and only the third is an absence of records. The
   * {@link CrossrefError} carries the status that tells them apart.
   */
  async updates(doi: string): Promise<CrossrefUpdates> {
    const bare = stripDoi(doi);
    if (!bare) throw new CrossrefError(0, 'No DOI was given, so Crossref was not asked.');
    const m = this.mailto ? `?mailto=${encodeURIComponent(this.mailto)}` : '';
    let res: Response;
    try {
      res = await this.fetcher.fetch(`${BASE}/works/${encodeDoiPath(bare)}${m}`, { method: 'GET' }, { maxRetries: 1 });
    } catch (e) {
      throw new CrossrefError(0, `Crossref could not be reached: ${(e as Error)?.message ?? 'request failed'}`);
    }
    if (!res.ok) throw new CrossrefError(res.status, `Crossref answered HTTP ${res.status}`);
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new CrossrefError(res.status, 'Crossref answered with a body that is not JSON');
    }
    // The same guard `work()` uses, for the same reason: `/works/` with no DOI is the
    // works-LIST route and answers 200, and read as one work it is an untitled paper with
    // nothing deposited against it, which is exactly the false all-clear this must not emit.
    if (!isSingleWork(json)) {
      throw new CrossrefError(res.status, 'Crossref answered with a listing rather than one work record');
    }
    return noticesOf(json.message, doiKey(bare));
  }

  /**
   * Update records for many DOIs, in batches, keyed by bare lowercased DOI.
   *
   * A separate path from {@link updates} on purpose. Crossref's batch route is
   * `/works?filter=doi:a,doi:b`, which answers with the work-LIST envelope that
   * {@link isSingleWork} exists to refuse, so reusing the single-work reader here would mean
   * weakening that guard and resurrecting the bug it was written for. This parses the list
   * envelope explicitly instead, and refuses anything that is not one.
   *
   * A DOI absent from the answer is absent from the map: the caller must not read a missing
   * key as "nothing deposited", because a batch that failed leaves every one of its DOIs
   * missing too. `asked` says which DOIs a successful batch actually covered.
   */
  async updatesFor(
    dois: string[],
    chunkSize = CROSSREF_BATCH,
  ): Promise<{ found: Map<string, CrossrefUpdates>; checked: string[]; failures: CrossrefError[] }> {
    const found = new Map<string, CrossrefUpdates>();
    const checked: string[] = [];
    const failures: CrossrefError[] = [];
    const usable = [...new Set(dois.map(doiKey).filter(batchableDoi))];
    const m = this.mailto ? `&mailto=${encodeURIComponent(this.mailto)}` : '';
    for (let i = 0; i < usable.length; i += chunkSize) {
      const group = usable.slice(i, i + chunkSize);
      // Every DOI is escaped on the way in. `usable` has already dropped anything carrying a
      // separator, so this is the second line of defence, and it is the one that matters
      // most here: `select` and `rows` sit AFTER the filter in this URL, so a single DOI
      // able to end the query string would take the whole rest of the batch with it.
      const filter = group.map((d) => `doi:${encodeDoiForQuery(d)}`).join(',');
      // `update-to` is asked for because a library holds retraction notices as well as
      // retracted papers: it is the only field that says "this DOI IS the notice". Crossref's
      // `select` returns exactly the fields named, so leaving it out made `isNoticeFor`
      // structurally empty in every sweep, and a notice the user deliberately saved came back
      // under a heading that reads as an accusation against it.
      const url = `${BASE}/works?filter=${filter}&select=DOI,updated-by,update-to,title&rows=${group.length}${m}`;
      try {
        const res = await this.fetcher.fetch(url, { method: 'GET' }, { maxRetries: 1 });
        if (!res.ok) throw new CrossrefError(res.status, `Crossref answered HTTP ${res.status}`);
        const json = JSON.parse(await res.text());
        const items = json?.message?.items;
        if (!Array.isArray(items)) {
          throw new CrossrefError(res.status, 'Crossref answered the batch route with no item list');
        }
        for (const it of items) {
          const rec = noticesOf(it, '');
          if (rec.doi) found.set(rec.doi, rec);
        }
        checked.push(...group);
      } catch (e) {
        failures.push(e instanceof CrossrefError ? e : new CrossrefError(0, (e as Error)?.message ?? 'request failed'));
      }
    }
    return { found, checked, failures };
  }
}
