import type { ToolContext } from '../../registry/registry.js';
import type { LibraryRef } from '../../api/web-client.js';

/**
 * Items one census walks before it stops. A census is a full paged crawl of the library,
 * so it is the expensive half of anything that asks "do I already have this?", and a cap
 * is what keeps that question from turning into a multi-minute scan of a 50k library.
 */
export const MAX_CENSUS_ITEMS = 5000;

/** One item as a census projects it: the identifiers that make two records the same work. */
export interface CensusEntry {
  key: string;
  title?: string;
  doi?: string;
  /** Every ISBN the record carries, normalised; see {@link isbnKeys}. */
  isbns?: string[];
  itemType?: string;
  /** Title reduced to its comparable form; see {@link titleKey}. */
  titleKey?: string;
  year?: string;
  /** Creator surnames, folded the way a title is; see {@link surnameKeys}. */
  surnames?: string[];
}

/**
 * The surnames a record's creators carry, folded the way a title is, so that a title match
 * with no year to check against can at least ask whether the two records share an author.
 *
 * A single-field name (an organisation, or a name a translator could not split) contributes
 * the whole name and its last word, so "Ada Lovelace" in one record still meets "Lovelace"
 * in the other.
 */
export function surnameKeys(creators: unknown): string[] {
  if (!Array.isArray(creators)) return [];
  const out = new Set<string>();
  for (const creator of creators) {
    const rec = creator as Record<string, unknown> | null;
    if (!rec || typeof rec !== 'object') continue;
    const last = typeof rec.lastName === 'string' ? titleKey(rec.lastName) : undefined;
    if (last) out.add(last);
    const name = typeof rec.name === 'string' ? titleKey(rec.name) : undefined;
    if (name) {
      out.add(name);
      const words = name.split(' ');
      if (words.length > 1) out.add(words[words.length - 1]!);
    }
  }
  return [...out];
}

/**
 * Comparable form of a title: lowercased, accents folded, punctuation dropped, runs of
 * whitespace collapsed. Two records of the same paper rarely agree on a colon, a dash or
 * the case of a subtitle, and every one of those differences would otherwise read as a
 * different work.
 *
 * Letters and digits of EVERY script survive. Keeping only `[a-z0-9]` deleted whole writing
 * systems, so two unrelated Chinese papers that each happened to carry one Latin token both
 * reduced to that token and matched each other, while a title with no Latin at all reduced
 * to nothing and could never be compared. Dropping a script is neither case, accent nor
 * punctuation, which is what this normalisation claims to do and now does.
 *
 * Deliberately not a fuzzy match. This is an exact comparison of a normalised string, so
 * it never claims a similarity it cannot show, and a caller that wants near-misses has to
 * ask for them explicitly.
 */
export function titleKey(title?: string): string | undefined {
  if (!title) return undefined;
  const k = title
    .normalize('NFD')
    // Combining Diacritical Marks only, i.e. the accents NFD just split off a Latin letter.
    // Not every Unicode mark: an Indic vowel sign is part of the word, not an accent on it.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return k || undefined;
}

/** A DOI reduced to the bare `10.x/y` form, lowercased, for comparison. */
export function doiKey(doi?: unknown): string | undefined {
  if (!doi) return undefined;
  const bare = String(doi)
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .trim()
    .toLowerCase();
  return bare || undefined;
}

/** The `DOI: 10.…` line a Zotero record can carry in Extra, which is a DOI like any other. */
const EXTRA_DOI_LINE = /^[ \t]*DOI[ \t]*:[ \t]*(\S+)[ \t]*$/im;

/**
 * The DOI a record carries: the `DOI` field, or the `DOI:` line in its Extra.
 *
 * Extra is where a DOI ends up on any record whose item type had no DOI field when it was
 * created, on anything imported from BibTeX or RIS, on anything Better BibTeX wrote, and on
 * anything Zoteus itself mapped from CSL (an unmapped variable is written to Extra as
 * `name: value`). Reading only the field made every one of those look like an item with no
 * DOI at all, which quietly put them outside the retraction sweep and outside the duplicate
 * check while the DOI sat in the record in plain sight.
 *
 * Here rather than in each caller for the same reason the census itself is: two answers to
 * "what DOI is this item" is one answer too many.
 */
export function doiFrom(data?: Record<string, unknown>): string | undefined {
  if (!data) return undefined;
  const field = doiKey(data.DOI ?? data.doi);
  if (field) return field;
  const extra =
    typeof data.extra === 'string' ? data.extra : typeof data.Extra === 'string' ? data.Extra : '';
  return doiKey(extra.match(EXTRA_DOI_LINE)?.[1]);
}

/**
 * The four-digit year inside a Zotero date field, which stores whatever was typed:
 * "2019-03-01", "March 2019", "2019" and "in press, 2019" all yield "2019".
 *
 * Used to keep two different papers that happen to share a title apart. It is deliberately
 * the only part of a date that is compared: Zotero's own dates are too irregular for
 * anything finer to mean much.
 */
export function yearKey(date?: unknown): string | undefined {
  if (typeof date !== 'string') return undefined;
  return date.match(/\b(1[5-9]\d{2}|20\d{2})\b/)?.[1] ?? undefined;
}

/** The ISBN-13 that names the same book as an ISBN-10, so the two printings collapse to one. */
function isbn13From10(isbn10: string): string | undefined {
  const core = `978${isbn10.slice(0, 9)}`;
  if (!/^\d{12}$/.test(core)) return undefined;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 ? 3 : 1);
  return core + String((10 - (sum % 10)) % 10);
}

/**
 * Every ISBN a record carries, reduced to digits and a trailing X, so neither hyphenation
 * nor ordering splits two copies of one book.
 *
 * A Zotero ISBN field routinely holds both printings ("0-262-03384-4 978-0-262-03384-8"),
 * and translators disagree about which comes first, so keeping only the first value made the
 * same book fail to match itself whenever the two records listed theirs the other way round.
 * Comparing all of them cannot confuse two books: two different books never share an ISBN,
 * and several values in one field are forms of the same work.
 *
 * Tokens that are not ISBN-shaped are dropped rather than normalised, so a field written
 * "ISBN 978-0-262-03384-8" yields the ISBN instead of the empty remains of the word "ISBN".
 * Every ISBN-10 also contributes its ISBN-13 form, so a record holding one printing still
 * matches a record holding the other.
 */
export function isbnKeys(isbn?: unknown): string[] {
  if (!isbn) return [];
  const out = new Set<string>();
  for (const token of String(isbn).split(/[\s,;]+/)) {
    const bare = token.replace(/[^0-9Xx]/g, '').toUpperCase();
    if (/^\d{13}$/.test(bare)) out.add(bare);
    else if (/^\d{9}[\dX]$/.test(bare)) {
      out.add(bare);
      const thirteen = isbn13From10(bare);
      if (thirteen) out.add(thirteen);
    }
  }
  return [...out];
}

/**
 * A census and what it is worth: how much of the library it actually saw.
 *
 * The count matters because the two answers a census gives are not equally reliable. A
 * match FOUND is a fact. A match NOT found is only a fact when the crawl reached the end of
 * the library, and a crawl stopped by {@link MAX_CENSUS_ITEMS} did not. Anything that
 * refuses a write on the strength of "no match" has to be able to tell those apart.
 */
export interface CensusResult {
  entries: CensusEntry[];
  /** Items actually projected into `entries`. */
  scanned: number;
  /** Top-level items the library says it holds, when the API reported a total. */
  totalResults?: number;
  /** True only when the crawl reached the end of the library rather than the cap. */
  complete: boolean;
}

/** One listing row projected to the identifiers a duplicate check compares. */
function project(it: unknown): CensusEntry | undefined {
  const data = ((it as any)?.data ?? it) as Record<string, unknown> | undefined;
  if (!data) return undefined;
  const key = String(data.key ?? (it as any)?.key ?? '');
  if (!key) return undefined;
  const title = typeof data.title === 'string' ? data.title : undefined;
  return {
    key,
    title,
    titleKey: titleKey(title),
    doi: doiFrom(data),
    isbns: isbnKeys(data.ISBN),
    itemType: typeof data.itemType === 'string' ? data.itemType : undefined,
    year: yearKey(data.date),
    surnames: surnameKeys(data.creators),
  };
}

/**
 * One paged crawl of a library's top-level items, projected to the identifiers that decide
 * whether two records are the same work, plus how far the crawl got.
 *
 * This exists once, here, rather than in each caller, because the answer to "is this
 * already in my library?" must not differ between the tool that flags scholarly results and
 * the tool that refuses a duplicate import. Two censuses would be two answers.
 *
 * `top: true` matters: without it every child note and attachment is an entry, and a note
 * whose title happens to match a paper becomes a duplicate of it.
 */
export async function libraryCensusReport(
  ctx: Pick<ToolContext, 'router'>,
  lib?: LibraryRef,
  maxItems = MAX_CENSUS_ITEMS,
): Promise<CensusResult> {
  const entries: CensusEntry[] = [];
  let start = 0;
  let totalResults: number | undefined;
  let stoppedAtCap = false;
  for (;;) {
    const page = await ctx.router.searchItems({ limit: 100, start, top: true, library: lib });
    if (totalResults === undefined && typeof page.totalResults === 'number') {
      totalResults = page.totalResults;
    }
    // Counted separately from `entries`, because a row with no key is consumed by the crawl
    // without being projected, and `start` addresses the listing, not the projection.
    let consumed = 0;
    for (const it of page.data) {
      consumed++;
      const entry = project(it);
      if (entry) entries.push(entry);
      if (entries.length >= maxItems) {
        stoppedAtCap = true;
        break;
      }
    }
    start += consumed;
    if (stoppedAtCap || !page.data.length) break;
    if (totalResults !== undefined && start >= totalResults) break;
    if (start >= maxItems) {
      stoppedAtCap = true;
      break;
    }
  }
  // Complete means the crawl saw everything the library said it holds. A crawl that simply
  // ran out of pages earlier than the reported total did not, whatever stopped it: the whole
  // value of this flag is that a caller can tell a real "no match" from an unfinished one.
  const complete = totalResults !== undefined ? start >= totalResults : !stoppedAtCap;
  return { entries, scanned: entries.length, totalResults, complete };
}

/** {@link libraryCensusReport} for the callers that only want the rows. */
export async function libraryCensus(
  ctx: Pick<ToolContext, 'router'>,
  lib?: LibraryRef,
  maxItems = MAX_CENSUS_ITEMS,
): Promise<CensusEntry[]> {
  return (await libraryCensusReport(ctx, lib, maxItems)).entries;
}

/**
 * The library's DOIs, for the one caller that only needs to ask "do I hold this DOI?".
 * Built from the same census so it can never disagree with the fuller one.
 */
export async function libraryDoiSet(
  ctx: Pick<ToolContext, 'router'>,
  lib?: LibraryRef,
  maxItems = MAX_CENSUS_ITEMS,
): Promise<Set<string>> {
  const set = new Set<string>();
  for (const e of await libraryCensus(ctx, lib, maxItems)) if (e.doi) set.add(e.doi);
  return set;
}
