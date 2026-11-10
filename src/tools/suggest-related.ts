import { z } from 'zod';
import type { ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { okLibraryContent, resolveLibrary } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { provenance } from './common-output.js';
import { citationPairs, gatherScope, type ScopeItem } from '../features/related/suggest.js';

export const DEFAULT_RELATED_SCAN = 500;
export const MAX_RELATED_SCAN = 2000;

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const end = z
  .object({
    item_key: z.string().describe('Library item key.'),
    title: z.string().optional().describe('Its title.'),
    year: z.string().optional().describe('Its year.'),
    doi: z.string().optional().describe('The DOI it was matched by.'),
  })
  .passthrough();

const brief = (i: ScopeItem) => ({
  item_key: i.key,
  ...(i.title ? { title: i.title } : {}),
  ...(i.year ? { year: i.year } : {}),
  ...(i.doi ? { doi: i.doi } : {}),
});

const suggestRelated: ToolDefinition = {
  name: 'zotero_suggest_related',
  title: 'Suggest Related links between library items that cite each other',
  description:
    'Find pairs of items IN THE LIBRARY where one cites the other, as candidates for Zotero\'s "Related" links. Read-only: nothing is written; add the links you accept with zotero_relate_items. Citations come from OpenAlex reference lists, matched to library items by DOI, so an item with no DOI (in the DOI field or a "DOI:" line in Extra), or one OpenAlex does not know, cannot be paired, and the counts say how many that was. OpenAlex reference lists are incomplete for some publishers, so a missing pair is not proof that one paper does not cite the other. Scope: `item_keys`, a `collection_key` (pairs among the items filed there), or the whole library (top-level items, the first `max_items`). Pairs already linked as Related are left out unless `include_existing:true`, which marks them.',
  inputSchema: {
    collection_key: z.string().optional().describe('Look for pairs among the top-level items in this collection.'),
    item_keys: z.array(z.string()).max(MAX_RELATED_SCAN).optional().describe('Look for pairs among these items only.'),
    max_items: z
      .number()
      .int()
      .min(1)
      .max(MAX_RELATED_SCAN)
      .optional()
      .describe(`Items to scan when no item_keys are given (default ${DEFAULT_RELATED_SCAN}, at most ${MAX_RELATED_SCAN}). OpenAlex is asked 50 DOIs per request.`),
    include_existing: z.boolean().optional().describe('Also list pairs already linked as Related, marked `alreadyRelated` (default false).'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      suggestions: z
        .array(
          z
            .object({
              citing: end.describe('The item whose reference list names the other.'),
              cited: end.describe('The item it cites.'),
              mutual: z.boolean().describe('True when each cites the other.'),
              alreadyRelated: z.boolean().describe('True when Zotero already links the two as Related.'),
            })
            .passthrough(),
        )
        .describe('Candidate pairs. Pass item_key/related_key pairs to zotero_relate_items to link them.'),
      counts: z
        .object({
          scanned: z.number().describe('Library items considered.'),
          withDoi: z.number().describe('Of those, items carrying a DOI.'),
          foundInOpenAlex: z.number().describe('DOIs OpenAlex returned a record for.'),
          unchecked: z.number().describe('DOIs not checked: a failed OpenAlex request, or characters a batched query cannot carry.'),
          alreadyRelated: z.number().describe('Citation pairs already linked as Related.'),
        })
        .passthrough()
        .describe('How much of the scope could actually be checked.'),
      truncated: z.boolean().optional().describe('True when the library or collection holds more items than were scanned.'),
      notice: z.string().optional().describe('What could not be checked, in one sentence.'),
      provenance,
    })
    .passthrough(),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    if (args.collection_key && args.item_keys?.length) return err('Pass `collection_key` or `item_keys`, not both.');
    const lib = resolveLibrary(ctx, args);
    const scope = await gatherScope(ctx, lib, {
      itemKeys: args.item_keys,
      collectionKey: args.collection_key,
      maxItems: args.max_items ?? DEFAULT_RELATED_SCAN,
    });
    const withDoi = scope.items.filter((i) => i.doi);
    const dois = [...new Set(withDoi.map((i) => i.doi!))];
    const links = dois.length ? await ctx.scholar.referenceLinks(dois) : { found: new Map(), checked: [], failures: [] };
    const pairs = citationPairs(scope.items, links.found);
    const existing = pairs.filter((p) => p.alreadyRelated).length;
    const shown = args.include_existing ? pairs : pairs.filter((p) => !p.alreadyRelated);
    const unchecked = dois.length - links.checked.length;
    const truncated = !scope.complete;
    const notice =
      [
        unchecked ? `${unchecked} DOI(s) were not checked (${links.failures[0]?.message ?? 'not queryable in a batch'}).` : '',
        scope.items.length - withDoi.length ? `${scope.items.length - withDoi.length} item(s) carry no DOI and could not be matched.` : '',
        truncated
          ? `Only the first ${args.max_items ?? DEFAULT_RELATED_SCAN}${scope.totalResults !== undefined ? ` of ${scope.totalResults}` : ''} top-level entries were scanned; raise max_items or scope to a collection.`
          : '',
      ]
        .filter(Boolean)
        .join(' ') || undefined;
    const summary =
      `${shown.length} citation pair(s) to suggest as Related among ${scope.items.length} item(s)` +
      (existing && !args.include_existing ? ` (${existing} more already linked)` : '') +
      `. ${links.found.size} of ${dois.length} DOI(s) were found in OpenAlex.` +
      (notice ? ` ${notice}` : '');
    return okLibraryContent(
      {
        suggestions: shown.map((p) => ({ citing: brief(p.citing), cited: brief(p.cited), mutual: p.mutual, alreadyRelated: p.alreadyRelated })),
        counts: {
          scanned: scope.items.length,
          withDoi: withDoi.length,
          foundInOpenAlex: links.found.size,
          unchecked,
          alreadyRelated: existing,
        },
        ...(truncated ? { truncated } : {}),
        ...(notice ? { notice } : {}),
      },
      summary,
    );
  },
};

export default suggestRelated;
