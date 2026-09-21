import type { ToolContext } from '../../registry/registry.js';
import type { LibraryRef } from '../../api/web-client.js';
import {
  MAX_CENSUS_ITEMS,
  doiFrom,
  isbnKeys,
  libraryCensusReport,
  surnameKeys,
  titleKey,
  yearKey,
  type CensusEntry,
  type CensusResult,
} from '../resolve/library-census.js';

/**
 * Finding the items a library already holds for a given record.
 *
 * What this is, said plainly, because the tool descriptions built on it have to say the
 * same thing: it is an EXACT comparison of normalised identifiers, not fuzzy matching. Two
 * records match when their DOIs are the same string once the doi.org prefix is stripped and
 * the case folded (the DOI field, or the `DOI:` line in Extra), or they share any ISBN once
 * hyphens are dropped, or their titles are the same string once case, accents and
 * punctuation are removed and their years are within one of each other (with no year on
 * one side, only when the title runs to four words or the two share a creator surname, and
 * the match then says so). A duplicate whose title differs by a word, or a preprint saved
 * with no DOI, is not found by any of that, and nothing here pretends otherwise.
 *
 * Neither Zotero API can filter on a field (no DOI, ISBN or title filter exists in either
 * client's ItemQuery), so the comparison has to happen here, against a census of the
 * library. That census is the expensive part, which is why every caller opts in.
 */

/** Which identifier made two records look like the same work. */
export type MatchedOn = 'doi' | 'isbn' | 'title';

/** The record being checked: a resolved import payload, or an item's `data` object. */
export interface DuplicateCandidate {
  key?: unknown;
  title?: unknown;
  DOI?: unknown;
  ISBN?: unknown;
  date?: unknown;
  itemType?: unknown;
  /** Read for a `DOI:` line, so a candidate whose DOI lives in Extra is compared on it too. */
  extra?: unknown;
  /** Zotero creators, read for surnames when a title match has no year to check against. */
  creators?: unknown;
}

/** One library item that matches a candidate, and what matched. */
export interface DuplicateMatch {
  item_key: string;
  title?: string;
  itemType?: string;
  year?: string;
  matchedOn: MatchedOn;
  /** The normalised value both records share: the bare DOI, the bare ISBN, or the folded title. */
  value: string;
  /**
   * Present on a title match that could not be checked against a year: says which side had
   * none and what the match rests on instead, because it is a weaker claim than the others.
   */
  caveat?: string;
}

/** A candidate and the library items it matched. */
export interface CandidateDuplicates {
  /** Position of the candidate in the array that was checked. */
  candidateIndex: number;
  /** The candidate's own title, so a caller can tell which of several was matched. */
  candidateTitle?: string;
  matches: DuplicateMatch[];
}

/**
 * How far apart two years may be and still describe the same work.
 *
 * One, because the ordinary same-title duplicate is a preprint in one year and the journal
 * version in the next. Two papers that share a normalised title a decade apart are far more
 * likely to be different works (a recurring report, a chapter title, "Introduction"), and
 * calling those duplicates would cost a caller a real item.
 */
const YEAR_TOLERANCE = 1;

function sameishYear(a: string, b: string): boolean {
  return Math.abs(Number(a) - Number(b)) <= YEAR_TOLERANCE;
}

/**
 * How many words a title needs before it can match on its own, with no year to check.
 *
 * A missing year proves nothing either way, so it used to rule nothing out, and that let a
 * year-less record titled "Introduction" match every "Introduction" in the library and
 * refuse the save. Four words is where a title stops being a chapter heading and starts
 * being the name of a work.
 */
const MIN_YEARLESS_TITLE_WORDS = 4;

/**
 * Whether a title match that cannot be checked against a year is worth reporting, and, when
 * it is, the sentence that says what it rests on.
 *
 * The match needs either a title long enough to be distinctive or a creator surname the two
 * records share. Either way the caller is being handed a weaker claim than title plus year,
 * so the answer says which side had no year and what carried the match instead.
 */
function yearlessBasis(
  title: string,
  candidateYear: string | undefined,
  candidateSurnames: string[],
  entry: CensusEntry,
): string | undefined {
  const missing =
    !candidateYear && !entry.year
      ? 'Neither record carries a year'
      : !candidateYear
        ? 'The candidate carries no year'
        : 'The library item carries no year';
  const shared = candidateSurnames.find((s) => entry.surnames?.includes(s));
  if (shared) return `${missing}, so this match rests on the title and the shared creator surname "${shared}".`;
  const words = title.split(' ').length;
  if (words >= MIN_YEARLESS_TITLE_WORDS) return `${missing}, so this match rests on the title alone (${words} words).`;
  return undefined;
}

function matchOf(entry: CensusEntry, matchedOn: MatchedOn, value: string): DuplicateMatch {
  return {
    item_key: entry.key,
    title: entry.title,
    itemType: entry.itemType,
    year: entry.year,
    matchedOn,
    value,
  };
}

/**
 * A census turned into the three lookup tables a duplicate check reads, so that checking N
 * candidates costs one crawl rather than N.
 */
export class DuplicateIndex {
  private readonly byDoi = new Map<string, CensusEntry[]>();
  private readonly byIsbn = new Map<string, CensusEntry[]>();
  private readonly byTitle = new Map<string, CensusEntry[]>();
  readonly scanned: number;
  readonly totalResults?: number;
  /** False when the census stopped at its cap, which makes "no match" unreliable. */
  readonly complete: boolean;

  constructor(census: CensusResult) {
    this.scanned = census.scanned;
    this.totalResults = census.totalResults;
    this.complete = census.complete;
    for (const entry of census.entries) {
      if (entry.doi) push(this.byDoi, entry.doi, entry);
      // Under every one of its ISBNs: the two printings of a book are the same book, and
      // which of them a given record lists first is an accident of the translator.
      for (const isbn of entry.isbns ?? []) push(this.byIsbn, isbn, entry);
      if (entry.titleKey) push(this.byTitle, entry.titleKey, entry);
    }
  }

  /**
   * The library items that look like `candidate`, strongest identifier first.
   *
   * DOI, then ISBN, then title: the first of those that matches anything decides the
   * answer, because a DOI match is an identity and a title match is a guess that happens to
   * be right most of the time. Reporting both would put two different claims in one list
   * with nothing to tell them apart.
   */
  matchesFor(candidate: DuplicateCandidate): DuplicateMatch[] {
    const self = typeof candidate.key === 'string' ? candidate.key : undefined;
    const notSelf = (e: CensusEntry): boolean => e.key !== self;

    const doi = doiFrom(candidate as Record<string, unknown>);
    const title = titleKey(typeof candidate.title === 'string' ? candidate.title : undefined);
    const compatibleDoi = (entry: CensusEntry): boolean => !doi || !entry.doi || doi === entry.doi;
    if (doi) {
      const hits = (this.byDoi.get(doi) ?? []).filter(notSelf);
      if (hits.length) return hits.map((e) => matchOf(e, 'doi', doi));
    }
    // Any ISBN in common is a match; one library item is reported once even when both of
    // its ISBNs are shared, and the key reported is the one that matched.
    const isbnHits = new Map<string, DuplicateMatch>();
    for (const isbn of isbnKeys(candidate.ISBN)) {
      for (const e of (this.byIsbn.get(isbn) ?? []).filter((entry) => notSelf(entry) && compatibleDoi(entry))) {
        // A chapter's ISBN identifies its containing book, not the chapter itself.
        if (candidate.itemType === 'bookSection' || e.itemType === 'bookSection') {
          if (candidate.itemType !== e.itemType || !title || title !== e.titleKey) continue;
        }
        if (!isbnHits.has(e.key)) isbnHits.set(e.key, matchOf(e, 'isbn', isbn));
      }
    }
    if (isbnHits.size) return [...isbnHits.values()];
    if (title) {
      const year = yearKey(candidate.date);
      const surnames = surnameKeys(candidate.creators);
      const hits: DuplicateMatch[] = [];
      for (const e of this.byTitle.get(title) ?? []) {
        if (!notSelf(e) || !compatibleDoi(e)) continue;
        if (year && e.year) {
          if (sameishYear(year, e.year)) hits.push(matchOf(e, 'title', title));
          continue;
        }
        const caveat = yearlessBasis(title, year, surnames, e);
        if (caveat) hits.push({ ...matchOf(e, 'title', title), caveat });
      }
      if (hits.length) return hits;
    }
    return [];
  }
}

function push(map: Map<string, CensusEntry[]>, key: string, entry: CensusEntry): void {
  const list = map.get(key);
  if (list) list.push(entry);
  else map.set(key, [entry]);
}

/**
 * Crawl `lib` once and build the index. One call per tool invocation: the census is up to
 * fifty requests against a 5000-item library, so it is memoised by being built once and
 * handed to every candidate, never re-run per candidate.
 */
export async function duplicateIndexFor(
  ctx: Pick<ToolContext, 'router'>,
  lib?: LibraryRef,
  maxItems = MAX_CENSUS_ITEMS,
): Promise<DuplicateIndex> {
  return new DuplicateIndex(await libraryCensusReport(ctx, lib, maxItems));
}

/** Every candidate's matches, in the order the candidates were given. */
export function findDuplicates(
  index: DuplicateIndex,
  candidates: DuplicateCandidate[],
): CandidateDuplicates[] {
  return candidates.map((candidate, candidateIndex) => ({
    candidateIndex,
    candidateTitle: typeof candidate.title === 'string' ? candidate.title : undefined,
    matches: index.matchesFor(candidate),
  }));
}

/**
 * How much of the library the check actually covered, as a sentence a caller can act on.
 * Returns undefined when the crawl reached the end, because then there is nothing to warn
 * about.
 */
export function incompleteScanNote(index: DuplicateIndex): string | undefined {
  if (index.complete) return undefined;
  const of = index.totalResults ? ` of ${index.totalResults}` : '';
  return (
    `The duplicate check stopped after ${index.scanned}${of} top-level items, so a match it did not ` +
    'find may still exist further down the library. A match it DID find is still a real match.'
  );
}
