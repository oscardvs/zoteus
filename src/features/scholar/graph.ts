import {
  OpenAlexClient,
  OpenAlexError,
  bestOaPdf,
  pipeableDoi,
  type OaPdf,
  type RetractionFlag,
  type ScholarList,
  type ScholarWork,
} from './openalex.js';
import { CrossrefClient, CrossrefError, batchableDoi, type CrossrefUpdates, type UpdateNotice } from './crossref.js';
import type { RateLimitedFetcher } from '../../api/http.js';

export type { OaPdf, OaVersion, RetractionFlag, ScholarList, ScholarWork } from './openalex.js';
export type { CrossrefUpdates, UpdateNotice } from './crossref.js';

/**
 * Update types that mean the work itself was pulled, as opposed to amended.
 *
 * Used only to decide whether the two providers are saying the same thing. A correction or
 * an expression of concern does not set OpenAlex's `is_retracted`, so counting those as
 * retractions here would manufacture a disagreement on every corrected paper.
 */
const RETRACTION_TYPES = new Set(['retraction', 'partial_retraction', 'withdrawal', 'removal']);

/** Whether any of these deposited records is a retraction rather than a correction. */
function hasRetractionRecord(notices: UpdateNotice[]): boolean {
  return notices.some((n) => RETRACTION_TYPES.has(n.type));
}

/**
 * What one provider did when it was asked, kept next to what it said.
 *
 * The reason this exists at all: a provider that did not answer and a provider that answered
 * "nothing deposited" are the same empty array downstream, and folding the first into the
 * second turns an outage into a clean bill of health for a named researcher's paper. So
 * reachability is reported as data, per provider, and every caller has to render it.
 */
export interface ProviderStatus {
  /** Which provider this row is about. */
  name: 'openalex' | 'crossref';
  /** Whether the provider answered at all. False means nothing was learned from it. */
  reached: boolean;
  /** Only meaningful when reached: whether it holds a record for the DOI that was asked. */
  found?: boolean;
  /** The HTTP status behind `reached: false`, or 404 when the provider has no such record. */
  status?: number;
  /** One sentence naming what happened, for the reader rather than for a branch. */
  note?: string;
  /** Sweep only: how many of the DOIs asked about this provider actually answered for. */
  checked?: number;
  /** Sweep only: how many DOIs it was asked about. */
  asked?: number;
}

/** Everything two providers said about one DOI's update records, with nothing reconciled. */
export interface NoticeReport {
  /** The DOI asked about, bare and lowercased. */
  doi: string;
  /** A title for the DOI, from whichever provider gave one. */
  title?: string;
  /** Deposited records that update this work, from Crossref. */
  notices: UpdateNotice[];
  /**
   * Records showing this DOI is itself an update notice about other works. When this is
   * non-empty, OpenAlex's retraction flag on the same DOI is describing the notice, not a
   * retracted paper.
   */
  isNoticeFor: UpdateNotice[];
  /** OpenAlex's own flag and work type, reported as OpenAlex's and not as the answer. */
  openalex?: { isRetracted?: boolean; workType?: string };
  /** One row per provider: whether it answered, and what it said about having the record. */
  sources: ProviderStatus[];
  /**
   * True when both providers answered with a record, the DOI is not itself a notice, and
   * exactly one of them indicates a retraction. It is a fact about the two sources, never a
   * reason to prefer one.
   */
  disagreement: boolean;
  /** When this check ran, ISO 8601. Both sources change under you. */
  checkedAt: string;
}

/** One library DOI the sweep has something to report about. */
export interface SweepFinding {
  /** The DOI, bare and lowercased. */
  doi: string;
  /** Deposited records that update it. */
  notices: UpdateNotice[];
  /** Records showing this DOI is itself an update notice about other works. */
  isNoticeFor: UpdateNotice[];
  /** OpenAlex's own flag, when OpenAlex answered for this DOI. */
  openalexIsRetracted?: boolean;
  /** OpenAlex's work type. "retraction" means the record IS a notice. */
  openalexType?: string;
}

/** The result of checking a list of DOIs against both providers. */
export interface SweepReport {
  /** Only the DOIs something was reported about; a DOI with nothing is not here. */
  findings: SweepFinding[];
  /** Per provider: whether every batch answered, and how many DOIs it covered. */
  sources: ProviderStatus[];
  /** DOIs left out of the batch queries because they carry a filter separator. */
  unqueryable: string[];
  /** When this check ran, ISO 8601. */
  checkedAt: string;
}

export interface ScholarGraphOptions {
  fetcher: RateLimitedFetcher;
  /**
   * A contact address. Crossref's polite pool still reads it from `mailto=`; OpenAlex ignores
   * that parameter since early 2026 and gets the address in the User-Agent instead.
   */
  mailto?: string;
  /** An OpenAlex API key, sent as a bearer header (#76). */
  openalexApiKey?: string;
}

/** Orchestrates scholarly providers (OpenAlex primary, Crossref fallback). */
export class ScholarGraph {
  readonly openalex: OpenAlexClient;
  readonly crossref: CrossrefClient;

  constructor(opts: ScholarGraphOptions) {
    this.openalex = new OpenAlexClient(opts.fetcher, { apiKey: opts.openalexApiKey, contact: opts.mailto });
    this.crossref = new CrossrefClient(opts.fetcher, opts.mailto);
  }

  /**
   * Metadata for a DOI, and the open-access PDF OpenAlex knows of, from ONE request.
   *
   * The OA block rides along rather than costing a second round trip: `work()` already
   * fetches the whole work object and `normalize()` used to drop the open-access half of it
   * on the floor. `oaChecked` says whether the question was asked at all, because this
   * method keeps its Crossref fallback and Crossref cannot answer it: reporting no `oa`
   * after an OpenAlex failure would be "no open-access copy" said in a voice that never
   * looked.
   */
  async lookup(doi: string): Promise<ScholarWork | null> {
    try {
      const w = await this.openalex.work(doi);
      const oa = bestOaPdf(w);
      return { ...this.openalex.normalize(w), oaChecked: true, ...(oa ? { oa } : {}) };
    } catch {
      const fallback = await this.crossref.work(doi);
      return fallback ? { ...fallback, oaChecked: false } : null;
    }
  }

  /**
   * The open-access PDF OpenAlex reports for this DOI, or null when it reports none.
   *
   * Deliberately WITHOUT lookup()'s Crossref fallback. Crossref has no open-access verdict
   * to give, so swallowing an OpenAlex failure here would turn "the provider did not answer"
   * into "there is no open-access copy", and a caller about to tell a user their paper is
   * paywalled needs to be able to tell those two apart. The OpenAlexError, status and all,
   * reaches the caller instead.
   */
  async oaPdf(doi: string): Promise<OaPdf | null> {
    return bestOaPdf(await this.openalex.work(doi));
  }

  /**
   * The update notices two independent sources hold for one DOI, with nothing reconciled.
   *
   * Both providers are asked IN PARALLEL, on the happy path. `lookup()` only reaches Crossref
   * when OpenAlex throws, which means Crossref's `updated-by` is unreachable on any DOI
   * OpenAlex knows, and `updated-by` is where the deposited notices actually live. So this is
   * one deliberate extra request, not a fallback.
   *
   * Nothing here is collapsed into a verdict. Crossref's deposited records and OpenAlex's own
   * flag are reported side by side with their provenance, `sources` says whether each
   * provider answered at all, and `disagreement` says when they do not match. A caller that
   * wants a boolean has to invent it, and should not.
   */
  async notices(doi: string): Promise<NoticeReport> {
    const [crossref, openalex] = await Promise.all([
      this.crossref.updates(doi).then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      ),
      this.openalex.work(doi).then(
        (v) => ({ ok: true as const, v }),
        (e: unknown) => ({ ok: false as const, e }),
      ),
    ]);

    const cr: ProviderStatus = { name: 'crossref', reached: true, found: true };
    let updates: CrossrefUpdates | undefined;
    if (crossref.ok) {
      updates = crossref.v;
    } else {
      const e = crossref.e;
      const status = e instanceof CrossrefError ? e.status : 0;
      if (status === 404) {
        cr.found = false;
        cr.status = 404;
        cr.note = 'Crossref has no record for this DOI, so it has no update records to report either.';
      } else {
        cr.reached = false;
        cr.found = undefined;
        cr.status = status || undefined;
        cr.note =
          `Crossref did not answer${status ? ` (HTTP ${status})` : ''}. ` +
          'Its update notices, including the Retraction Watch records it carries, were NOT checked.';
      }
    }

    const oa: ProviderStatus = { name: 'openalex', reached: true, found: true };
    let flag: RetractionFlag | undefined;
    if (openalex.ok) {
      flag = this.openalex.retractionFlag(openalex.v);
    } else {
      const e = openalex.e;
      const status = e instanceof OpenAlexError ? e.status : 0;
      if (status === 404) {
        oa.found = false;
        oa.status = 404;
        oa.note = 'OpenAlex has no record for this DOI, so it has no retraction flag to report.';
      } else {
        oa.reached = false;
        oa.found = undefined;
        oa.status = status || undefined;
        oa.note = `OpenAlex did not answer${status ? ` (HTTP ${status})` : ''}. Its retraction flag was NOT checked.`;
      }
    }

    const notices = updates?.updatedBy ?? [];
    const isNoticeFor = updates?.updates ?? [];
    // Only comparable when both actually answered with a record. A DOI that is itself a
    // notice is excluded because OpenAlex flags notices `is_retracted` too, so it would
    // register as a disagreement on every correctly recorded retraction notice.
    const comparable = cr.reached && cr.found === true && oa.reached && oa.found === true && isNoticeFor.length === 0;
    const retractedHere = hasRetractionRecord(notices);
    const disagreement =
      comparable &&
      ((flag?.isRetracted === true && !retractedHere) || (flag?.isRetracted === false && retractedHere));

    const report: NoticeReport = {
      doi: updates?.doi ?? flag?.doi ?? doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim().toLowerCase(),
      notices,
      isNoticeFor,
      sources: [cr, oa],
      disagreement,
      checkedAt: new Date().toISOString(),
    };
    const title = updates?.title ?? flag?.title;
    if (title) report.title = title;
    if (flag && (flag.isRetracted !== undefined || flag.type !== undefined)) {
      report.openalex = {
        ...(flag.isRetracted !== undefined ? { isRetracted: flag.isRetracted } : {}),
        ...(flag.type !== undefined ? { workType: flag.type } : {}),
      };
    }
    return report;
  }

  /**
   * The same two-source check over many DOIs, batched.
   *
   * Only DOIs something was reported about come back in `findings`; the rest are silent by
   * design, because a list of several thousand clean rows is not an answer anyone reads. What
   * makes that safe is `sources`: it says how many DOIs each provider actually answered for,
   * so "nothing found" can be read against "and we asked about all of them" rather than
   * against a failed batch nobody mentioned.
   */
  async noticeSweep(dois: string[]): Promise<SweepReport> {
    const wanted = [...new Set(dois.map((d) => d.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim().toLowerCase()).filter(Boolean))];
    const unqueryable = wanted.filter((d) => !pipeableDoi(d) || !batchableDoi(d));
    const [crossref, openalex] = await Promise.all([
      this.crossref.updatesFor(wanted),
      this.openalex.retractionFlags(wanted),
    ]);

    const crChecked = new Set(crossref.checked);
    const oaChecked = new Set(openalex.checked);
    const findings: SweepFinding[] = [];
    for (const doi of wanted) {
      const upd = crossref.found.get(doi);
      const flag = openalex.found.get(doi);
      const notices = upd?.updatedBy ?? [];
      const isNoticeFor = upd?.updates ?? [];
      // A row earns its place only when a source actually said something about it. A clean
      // row and an unchecked row look identical here, which is exactly why `sources` carries
      // the counts rather than this list carrying a "clean" flag it cannot justify.
      if (!notices.length && !isNoticeFor.length && flag?.isRetracted !== true) continue;
      findings.push({
        doi,
        notices,
        isNoticeFor,
        ...(flag?.isRetracted !== undefined ? { openalexIsRetracted: flag.isRetracted } : {}),
        ...(flag?.type !== undefined ? { openalexType: flag.type } : {}),
      });
    }

    const status = (
      name: 'openalex' | 'crossref',
      checked: Set<string>,
      failures: Array<{ status: number }>,
    ): ProviderStatus => {
      const asked = wanted.length;
      const done = checked.size;
      const row: ProviderStatus = { name, reached: failures.length === 0, checked: done, asked };
      if (failures.length) {
        const first = failures.find((f) => f.status) ?? failures[0]!;
        row.status = first.status || undefined;
        row.note =
          `${name} answered for ${done} of ${asked} DOIs` +
          `${first.status ? ` (HTTP ${first.status} on the rest)` : ''}. ` +
          `The other ${asked - done} were NOT checked against ${name}, so nothing here says anything about them.`;
      }
      return row;
    };

    return {
      findings,
      sources: [status('crossref', crChecked, crossref.failures), status('openalex', oaChecked, openalex.failures)],
      unqueryable,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Works this paper cites, at most `limit` of them, with the full count beside them. A
   * review with 150 references used to answer `limit` works and nothing else, so a
   * citation-gap pass had no way to know it saw a seventh of the list (#76).
   */
  async references(doi: string, limit = 20): Promise<ScholarList> {
    const work = await this.openalex.work(doi);
    const all: string[] = work.referenced_works ?? [];
    const ids = all.slice(0, limit);
    return { works: ids.length ? await this.openalex.worksByIds(ids) : [], total: all.length };
  }

  async related(doi: string, limit = 20): Promise<ScholarList> {
    const work = await this.openalex.work(doi);
    const all: string[] = work.related_works ?? [];
    const ids = all.slice(0, limit);
    return { works: ids.length ? await this.openalex.worksByIds(ids) : [], total: all.length };
  }

  /**
   * Works that cite this paper, most-cited first. `total` is OpenAlex's `cited_by_count` for
   * the work, the size of the list this one page was taken from.
   */
  async citations(doi: string, limit = 20): Promise<ScholarList> {
    const work = await this.openalex.work(doi);
    if (!work.id) return { works: [], total: 0 };
    const works = await this.openalex.citedBy(work.id, limit);
    const counted = typeof work.cited_by_count === 'number' ? work.cited_by_count : 0;
    return { works, total: Math.max(counted, works.length) };
  }
}

/**
 * Tag works that are already in the library (by lowercased DOI).
 *
 * A Map of DOI to library item key also carries the key through onto each matched work, so a
 * caller that has just been handed "these forty papers cite the one you asked about, and you
 * already hold nine of them" can go straight to `zotero_get_fulltext` on those nine and read
 * what they actually say, instead of searching the library again for a title it already has.
 * A plain Set still works and simply yields no keys.
 */
export function markInLibrary(works: ScholarWork[], libraryDois: Set<string> | Map<string, string>): ScholarWork[] {
  return works.map((w) => {
    const key = w.doi ? w.doi.toLowerCase() : undefined;
    const itemKey = key && libraryDois instanceof Map ? libraryDois.get(key) : undefined;
    return {
      ...w,
      inLibrary: key ? libraryDois.has(key) : false,
      ...(itemKey ? { libraryItemKey: itemKey } : {}),
    };
  });
}
