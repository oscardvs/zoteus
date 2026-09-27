import { z } from 'zod';
import type { ToolContext, ToolHandlerResult } from '../registry/registry.js';
import { ok, optionalLibrary } from '../registry/registry.js';

/** Rows one listing returns unless the caller asks for another page size. */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/** `q`, `start` and `limit`, shared by zotero_list_collections and zotero_manage_collections list. */
export const listingArgs = {
  q: z
    .string()
    .optional()
    .describe(
      'Only collections whose name contains this text (case-insensitive), searched over the whole library, not one page. Use it to find a collection by name.',
    ),
  start: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Zero-based offset into the listing, for paging (default 0). Page with start += limit while `totalResults` is larger.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Collections to return (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}).`),
};

/** The output fields a listing adds beside `collections`. */
export const listingOutput = {
  totalResults: z
    .number()
    .optional()
    .describe('Collections matching in total (every collection when there is no `q`), not just this page. Page with start/limit while it is larger.'),
  start: z.number().optional().describe('The offset this page starts at.'),
  complete: z
    .boolean()
    .optional()
    .describe('False when the library holds more collections than Zoteus reads in one listing (10,000); the page then comes from those read.'),
};

/**
 * The collections of a library, sorted by name, filtered by `q`, one `start`/`limit` page
 * of them, and the counts that say whether there is more.
 *
 * Every collection is read before the filter and the page are applied, because a name
 * lookup that searched one page was how a library of 1,460 collections got a duplicate of
 * a collection that sat on page two (#90). The listing is sorted by name then key so that
 * a second page follows the first whichever API served it: the desktop app and the cloud
 * do not return collections in the same order.
 */
export async function collectionListing(
  ctx: ToolContext,
  args: any,
): Promise<ToolHandlerResult> {
  const all = await ctx.router.listAllCollections({ top: args.top, library: optionalLibrary(args, ctx) });
  const rows = all.data
    .map((c: any) => ({
      key: c.key ?? c.data?.key,
      name: c.data?.name,
      parentCollection: c.data?.parentCollection ?? false,
      numItems: c.meta?.numItems,
    }))
    .sort(
      (a, b) =>
        String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, { sensitivity: 'base' }) ||
        String(a.key).localeCompare(String(b.key)),
    );
  const needle = args.q?.trim().toLowerCase();
  const matching = needle ? rows.filter((r) => String(r.name ?? '').toLowerCase().includes(needle)) : rows;
  const start = args.start ?? 0;
  const collections = matching.slice(start, start + (args.limit ?? DEFAULT_LIMIT));
  const totalResults = needle ? matching.length : all.totalResults;

  const what = needle ? `collection(s) named like "${args.q!.trim()}"` : 'collection(s)';
  let summary =
    collections.length === 0
      ? `No ${what} at offset ${start}; ${totalResults} in total.`
      : collections.length === totalResults
        ? `${totalResults} ${what}.`
        : `Showing ${start + 1}-${start + collections.length} of ${totalResults} ${what}.`;
  if (start + collections.length < matching.length) {
    summary += ` Page with start=${start + collections.length}${needle ? '' : ', or pass `q` to find one by name'}.`;
  }
  if (!all.complete) {
    summary +=
      ` The library reports ${all.totalResults} collections and only the first ${all.data.length} were read,` +
      ' so a collection missing here may still exist; a tool given its key (zotero_search_items collectionKey,' +
      ' zotero_manage_collections) still finds it.';
  }
  return ok({ collections, totalResults, start, complete: all.complete }, summary);
}
