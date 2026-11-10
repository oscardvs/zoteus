import type { ToolContext } from '../../registry/registry.js';
import type { LibraryRef } from '../../api/web-client.js';
import { yearKey } from '../resolve/library-census.js';

/**
 * One crawl of a collection's top-level records, the population every screening view
 * counts. Both APIs list `/collections/<key>/items/top` the same way and leave trashed
 * items out by default; the `deleted` check below is a second guard, not the filter.
 *
 * Tag filters are deliberately NOT pushed to the API: the desktop runs a tag filter as a
 * sub-search that ignores `top`, and neither API reads a "has no tag starting with" filter
 * at all. Reading the whole collection once and deciding here gives the same answer on both.
 */

export const MAX_REVIEW_RECORDS = 5000;
const PAGE = 100;

export interface ReviewRecord {
  key: string;
  version?: number;
  itemType: string;
  title: string;
  abstract?: string;
  year?: string;
  date?: string;
  authors: string[];
  tags: string[];
  dateAdded?: string;
  dateModified?: string;
  numChildren?: number;
  /** The raw `data` object, for the duplicate check (DOI, ISBN, extra, creators). */
  data: Record<string, unknown>;
}

export interface CollectionCrawl {
  name: string;
  records: ReviewRecord[];
  /** Top-level rows the API said the collection holds (notes and attachments included). */
  totalResults?: number;
  /** False when the crawl stopped at MAX_REVIEW_RECORDS. */
  complete: boolean;
  /** Standalone notes and attachments in the collection, which are not records to screen. */
  skipped: number;
}

const NOT_RECORDS = new Set(['note', 'attachment', 'annotation']);

export function authorsOf(creators: unknown): string[] {
  if (!Array.isArray(creators)) return [];
  return creators
    .map((c: any) => {
      if (!c || typeof c !== 'object') return '';
      if (typeof c.name === 'string' && c.name.trim()) return c.name.trim();
      const last = typeof c.lastName === 'string' ? c.lastName.trim() : '';
      const first = typeof c.firstName === 'string' ? c.firstName.trim() : '';
      return last && first ? `${last}, ${first}` : last || first;
    })
    .filter(Boolean);
}

export function toReviewRecord(item: any): ReviewRecord | undefined {
  const data = (item?.data ?? item) as Record<string, any> | undefined;
  if (!data || typeof data !== 'object') return undefined;
  const key = String(data.key ?? item?.key ?? '');
  if (!key) return undefined;
  const tags = Array.isArray(data.tags)
    ? data.tags.map((t: any) => (typeof t === 'string' ? t : t?.tag)).filter((t: unknown): t is string => typeof t === 'string')
    : [];
  return {
    key,
    version: item?.version ?? data.version,
    itemType: String(data.itemType ?? ''),
    title: typeof data.title === 'string' ? data.title : '',
    abstract: typeof data.abstractNote === 'string' && data.abstractNote.trim() ? data.abstractNote : undefined,
    year: yearKey(data.date) ?? (typeof item?.meta?.parsedDate === 'string' ? item.meta.parsedDate.slice(0, 4) : undefined),
    date: typeof data.date === 'string' && data.date ? data.date : undefined,
    authors: authorsOf(data.creators),
    tags,
    dateAdded: typeof data.dateAdded === 'string' ? data.dateAdded : undefined,
    dateModified: typeof data.dateModified === 'string' ? data.dateModified : undefined,
    numChildren: typeof item?.meta?.numChildren === 'number' ? item.meta.numChildren : undefined,
    data,
  };
}

/** The collection's records, or a problem sentence when the collection does not exist. */
export async function crawlCollection(
  ctx: Pick<ToolContext, 'router'>,
  lib: LibraryRef,
  collectionKey: string,
  maxRecords = MAX_REVIEW_RECORDS,
): Promise<CollectionCrawl | { problem: string }> {
  let collection: any;
  try {
    collection = await ctx.router.getCollection(collectionKey, { library: lib });
  } catch {
    collection = null;
  }
  if (!collection) {
    const where = lib.type === 'group' ? `group ${lib.id}` : 'this library';
    return { problem: `No collection ${collectionKey} in ${where}. Call zotero_list_collections and use the \`key\` it returns.` };
  }
  const records: ReviewRecord[] = [];
  let start = 0;
  let totalResults: number | undefined;
  let skipped = 0;
  let complete = true;
  for (;;) {
    const page = await ctx.router.searchItems({ collectionKey, top: true, limit: PAGE, start, library: lib });
    if (totalResults === undefined && typeof page.totalResults === 'number') totalResults = page.totalResults;
    for (const item of page.data) {
      const rec = toReviewRecord(item);
      if (!rec || rec.data.deleted || NOT_RECORDS.has(rec.itemType)) {
        skipped++;
        continue;
      }
      records.push(rec);
    }
    start += page.data.length;
    if (!page.data.length || (totalResults !== undefined && start >= totalResults)) break;
    if (start >= maxRecords) {
      complete = false;
      break;
    }
  }
  return {
    name: String(collection?.data?.name ?? collection?.name ?? collectionKey),
    records,
    totalResults,
    complete,
    skipped,
  };
}

/** The sentence every view adds when the crawl did not reach the end of the collection. */
export function incompleteCrawlNote(crawl: CollectionCrawl): string | undefined {
  if (crawl.complete) return undefined;
  return (
    `Only the first ${MAX_REVIEW_RECORDS} rows of ${crawl.totalResults ?? 'the'} in this collection were read, ` +
    'so every count here covers that part only. Split the collection into subcollections to screen it whole.'
  );
}
