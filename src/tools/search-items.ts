import { provenance } from './common-output.js';
import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { okLibraryContent, optionalLibrary } from '../registry/registry.js';
import { refuseUnknownCollection } from './collection-guard.js';

const MAX_LIMIT = 100;

export function creatorSummary(creators: Array<{ lastName?: string; name?: string }> = []): string {
  const names = creators.map((c) => c.lastName ?? c.name).filter(Boolean) as string[];
  if (names.length === 0) return '';
  if (names.length <= 2) return names.join(' & ');
  return `${names[0]} et al.`;
}

function project(item: any, detailed: boolean): Record<string, unknown> {
  const d = item.data ?? item;
  const base: Record<string, unknown> = {
    key: item.key ?? d.key,
    itemType: d.itemType,
    title: d.title ?? d.caseName ?? d.subject ?? '(untitled)',
    creatorSummary: creatorSummary(d.creators),
    date: d.date,
  };
  if (detailed) {
    base.version = item.version ?? d.version;
    base.tags = (d.tags ?? []).map((t: any) => t.tag);
    base.collections = d.collections ?? [];
    base.DOI = d.DOI;
    base.url = d.url;
  }
  return base;
}

const searchItems: ToolDefinition = {
  name: 'zotero_search_items',
  title: 'Search Zotero items',
  description:
    'Search or list items in a Zotero library or collection. Quick search via `q` (`qmode`: titleCreatorYear=default, matches title/creator/year only; everything=also searches notes & attachment full text). For presence checks ("is X in my library?"): a default-mode `q` that matches nothing auto-retries once in `everything` mode, so terms appearing only inside PDF text don\'t false-negative — pin `qmode` explicitly to disable. An empty `everything` result is reported as strong-but-not-conclusive, since un-indexed/scanned/un-synced PDFs aren\'t full-text searchable. Also supports boolean `itemType` filters (use `||` for OR, repeat or `&&` for AND, leading `-` to negate, e.g. "journalArticle || book", "-attachment"), boolean `tag` filters (same syntax; escape a literal leading hyphen as "\\-"), `since` (version) for incremental queries, `sort`/`direction`, and `limit`/`start` paging. Set `response_format` to "detailed" to also return technical fields (version, tags, collections, DOI, url) needed before chaining a write; the default "concise" returns high-signal projections (key, itemType, title, creators, date). Reads are served from the fast desktop local API when available, otherwise the cloud Web API. Returns `totalResults` so you can tell when to page rather than assuming you saw everything. For conceptual/"papers about X" queries by meaning rather than exact fields, use zotero_semantic_search instead.',
  inputSchema: {
    q: z.string().optional().describe('Quick/full-text search string.'),
    qmode: z
      .enum(['titleCreatorYear', 'everything'])
      .optional()
      .describe(
        'How `q` is matched: "titleCreatorYear" (default) searches titles, creators and years only; "everything" also searches notes and attachment full text. Unset lets an empty default-mode result retry once in "everything".',
      ),
    itemType: z.string().optional().describe('Boolean itemType filter, e.g. "journalArticle || book".'),
    tag: z.string().optional().describe('Boolean tag filter, e.g. "to-read && 2024".'),
    collectionKey: z
      .string()
      .optional()
      .describe(
        'Restrict to a collection by key. A key this library does not have is refused, never answered with the whole library.',
      ),
    top: z.boolean().optional().describe('Only top-level items (exclude child notes/attachments).'),
    since: z.number().int().optional().describe('Return items modified after this library version.'),
    includeTrashed: z.boolean().optional().describe('Also return items in the trash (default false).'),
    sort: z
      .string()
      .optional()
      .describe(
        'Zotero sort field, e.g. "dateModified" (the default), "dateAdded", "title", "creator", "date", "itemType".',
      ),
    direction: z.enum(['asc', 'desc']).optional().describe('Sort direction; Zotero\'s own default for the chosen `sort` field when unset.'),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe('Max items (default 25, max 100).'),
    start: z.number().int().min(0).optional().describe('Zero-based offset into the result set, for paging (default 0). Page with start += limit while `totalResults` is larger.'),
    response_format: z.enum(['concise', 'detailed']).optional().describe('Detail level of returned items.'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      items: z
        .array(
          z
            .object({
              key: z.string().optional().describe('8-character item key; pass it to zotero_get_item or zotero_bibliography.'),
              itemType: z.string().optional().describe('Zotero item type, e.g. "journalArticle".'),
              title: z.string().optional().describe('Item title, or "(untitled)".'),
              creatorSummary: z.string().optional().describe('Short creator line, e.g. "Kalman & Bucy" or "Smith et al.".'),
              date: z.string().optional().describe('Date as Zotero stores it, e.g. "2019-04" or "1960".'),
              version: z.number().optional().describe('Item version, needed before a write (response_format:"detailed" only).'),
              tags: z.array(z.string()).optional().describe('Tag names (response_format:"detailed" only).'),
              collections: z.array(z.string()).optional().describe('Collection keys the item is in (response_format:"detailed" only).'),
              DOI: z.string().optional().describe('DOI (response_format:"detailed" only).'),
              url: z.string().optional().describe('URL (response_format:"detailed" only).'),
            })
            .passthrough(),
        )
        .describe('The page of matching items, projected: concise by default, with the technical fields when response_format is "detailed".'),
      totalResults: z.number().describe('Matches in the whole result set, not just this page; page with start/limit while it is larger.'),
      libraryVersion: z.number().optional().describe("The library's Last-Modified-Version when the search ran."),
      qmode: z.string().describe('The quick-search mode actually used: "titleCreatorYear" or "everything".'),
      broadened: z.boolean().describe('True when an empty default-mode search was retried once in "everything" mode.'),
      provenance,
    })
    .passthrough(),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const detailed = args.response_format === 'detailed';
    const library = optionalLibrary(args);
    // A collection key the library does not have would otherwise be answered with the whole
    // library by the desktop app, so a scoped search would report every item in the library
    // as the collection's contents. Checked only when a key was given.
    const unknownCollection = await refuseUnknownCollection(
      ctx,
      args.collectionKey,
      library ?? ctx.router.defaultLibrary(),
      'searched',
    );
    if (unknownCollection) return unknownCollection;
    const baseQuery = {
      q: args.q,
      qmode: args.qmode,
      itemType: args.itemType,
      tag: args.tag,
      collectionKey: args.collectionKey,
      top: args.top,
      since: args.since,
      includeTrashed: args.includeTrashed,
      sort: args.sort,
      direction: args.direction,
      limit: args.limit ?? 25,
      start: args.start,
      library,
    };
    let result = await ctx.router.searchItems(baseQuery);

    // Auto-broaden on empty: the default `titleCreatorYear` mode matches only
    // title/creator/year, so "is X in my library" checks false-negative on terms that
    // live only inside PDF text. When the caller didn't pin a mode and the precise
    // first page found nothing, retry once in `everything` mode (notes + attachment
    // full text) before reporting absence. An explicit `qmode` is always respected.
    const broadened =
      Boolean(args.q) && args.qmode === undefined && !args.start && result.totalResults === 0;
    if (broadened) {
      result = await ctx.router.searchItems({ ...baseQuery, qmode: 'everything' });
    }
    const effectiveQmode = broadened ? 'everything' : (args.qmode ?? 'titleCreatorYear');

    const items = result.data.map((i) => project(i, detailed));
    const shown = items.length;
    const more =
      result.totalResults > shown + (args.start ?? 0)
        ? ' More available — narrow with q/tag/itemType or page with start.'
        : '';

    let summary: string;
    if (broadened && result.totalResults > 0) {
      summary =
        `No title/author/year match; found ${result.totalResults} full-text match(es) ` +
        `(searched notes & attachment text); showing ${shown}.` +
        more;
    } else if (effectiveQmode === 'everything' && result.totalResults === 0) {
      // Calibrate the negative: full-text search only covers indexed text, so a miss
      // is strong evidence of absence but never proof.
      summary =
        "No match in titles, authors, or indexed full text. Scanned, un-OCR'd, or " +
        "not-yet-synced PDFs aren't full-text searchable, so this is strong but not " +
        'conclusive evidence of absence.';
    } else {
      summary = `Found ${result.totalResults} item(s); showing ${shown}.` + more;
    }

    return okLibraryContent(
      {
        items,
        totalResults: result.totalResults,
        libraryVersion: result.lastModifiedVersion,
        qmode: effectiveQmode,
        broadened,
      },
      summary,
    );
  },
};

export default searchItems;
