import { z } from 'zod';
import { provenance } from './common-output.js';
import type { ToolDefinition } from '../registry/registry.js';
import { okLibraryContent } from '../registry/registry.js';
import {
  embedderNotice,
  fulltextNotice,
  ownWordsNotice,
  persistNotice,
  progressLine,
  staleVectorsNotice,
  unembeddedNotice,
  startIndexBuild,
  truncationNotice,
} from '../features/search/build.js';

const semanticSearch: ToolDefinition = {
  name: 'zotero_semantic_search',
  title: 'Semantic / hybrid library search',
  description:
    'Search the library by meaning, not just keywords. Combines BM25 keyword scoring with vector similarity (when an embedding provider is configured) via reciprocal-rank fusion, and returns the best-matching items with a snippet and score. By default it searches item metadata and abstracts; if the index was built with `fulltext` on (zotero_index fulltext:true, or ZOTEUS_INDEX_FULLTEXT=true) it also searches the body text of attachments, and a hit whose snippet came from a PDF body is marked source:"fulltext". It ALSO searches the words the reader wrote — child notes and PDF annotations (highlight text and comments) — unless that was turned off (ZOTEUS_INDEX_OWN_WORDS=false); a hit from one is marked source:"note" or source:"annotation" and is attributed to the item it hangs off, so an item with forty annotations is one result rather than forty. `mode`: "auto" (hybrid, default), "keyword" (BM25 only), or "semantic" (vector only). "semantic" needs both vectors in the index and a running embedder to turn the query into one: when either is missing (embeddings switched off, or e.g. the on-device model runtime is not installed) it returns an error naming the cause instead of an empty result set, and "auto" keeps working as keyword search while saying so. The index must be built once before first use: when it is empty this tool starts a background build automatically (`auto_build`, on by default) and tells you to poll zotero_index action:"status" and retry — pass `auto_build:false` to opt out. For exact field/tag/itemType filtering use zotero_search_items instead; use this for conceptual/"papers about X" queries. To read the actual passages of a found item (with page locators) use zotero_get_fulltext.',
  inputSchema: {
    q: z.string().min(1).describe('Natural-language query.'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10).'),
    mode: z
      .enum(['auto', 'keyword', 'semantic'])
      .optional()
      .describe(
        'How to rank: "auto" (default) fuses keyword and vector scores, "keyword" is BM25 only, "semantic" is vector only and errors when no embedder or no vectors are available.',
      ),
    auto_build: z
      .boolean()
      .optional()
      .describe('Start building the index automatically in the background when it is empty (default true).'),
  },
  outputSchema: z
    .object({
      hits: z
        .array(
          z
            .object({
              itemKey: z.string().describe('8-character item key; read the full record with zotero_get_item.'),
              title: z.string().describe('Title of the item the passage belongs to.'),
              snippet: z.string().describe('The matching passage.'),
              score: z.number().describe('Fused relevance score; higher is better, and only comparable within one answer.'),
              source: z
                .string()
                .optional()
                .describe('Where the snippet came from when it was not the item\'s own metadata: "fulltext", "note" or "annotation".'),
            })
            .passthrough(),
        )
        .describe('Best-matching items, one row per item, in rank order.'),
      embedder: z.string().describe('The embedder that ranked this query, or "none (...)" with the reason.'),
      embedderConfigured: z.string().describe('The requested ZOTEUS_EMBEDDINGS value, whether or not it works.'),
      embedderActive: z.boolean().describe('True only while that provider is genuinely producing vectors.'),
      embedderReason: z.string().optional().describe('Why it is not active, and what to do about it.'),
      vectorsStaleReason: z.string().optional().describe('Set when stored vectors were discarded because another embedder had produced them.'),
      passagesWithoutVectors: z.number().optional().describe('Indexed passages nothing has embedded yet: the gap between what keyword search covers and what meaning can rank.'),
      fulltextEnabled: z.boolean().describe('Whether attachment body text is in the index.'),
      fulltextReason: z.string().optional().describe('Why body text is missing or not current, when it was asked for.'),
      ownWordsEnabled: z.boolean().describe("Whether the reader's own notes and annotations are in the index."),
      ownWordsReason: z.string().optional().describe('Why they are missing or not current.'),
      persistError: z.string().optional().describe('The index never reached disk; these results exist only until restart.'),
      provenance,
    })
    .passthrough(),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    if (ctx.search.isEmpty) {
      // A build is already on its way (started here or via zotero_index): report progress.
      if (ctx.search.isBuilding) {
        const s = ctx.search.buildStatus();
        return {
          content: [
            {
              type: 'text',
              text:
                `The semantic-search index is being built right now — ${progressLine(s)}. ` +
                'Poll zotero_index with action:"status" until state is "done", then retry this search.' +
                embedderNotice(s),
            },
          ],
          structuredContent: { ...s, autoBuild: true },
          isError: true,
        };
      }
      if (ctx.search.isPaused) {
        const s = ctx.search.buildStatus();
        return {
          content: [
            {
              type: 'text',
              text:
                'The semantic-search index is empty and index work is paused. Call zotero_index with ' +
                'action:"resume", then explicitly start a build; this search will not resume it automatically.',
            },
          ],
          structuredContent: { ...s, autoBuild: false },
          isError: true,
        };
      }
      if (args.auto_build !== false) {
        // First use: populate the index on the fly instead of leaving the user stranded.
        const s = startIndexBuild(ctx);
        return {
          content: [
            {
              type: 'text',
              text:
                'The semantic-search index is empty, so a background build was started automatically ' +
                `(first-time setup; ${progressLine(s)}). Poll zotero_index with action:"status" every few seconds ` +
                'until state is "done", then retry this search. Pass auto_build:false to opt out.' +
                embedderNotice(s),
            },
          ],
          structuredContent: { ...s, autoBuild: true },
          isError: true,
        };
      }
      const s = ctx.search.buildStatus();
      return {
        content: [
          {
            type: 'text',
            text: 'The search index is empty. Run zotero_index with action:"build" first, then retry.' + embedderNotice(s),
          },
        ],
        structuredContent: { ...s },
        isError: true,
      };
    }
    const status = ctx.search.buildStatus();
    // Semantic mode ranks by vectors alone, and that needs both ends of the comparison:
    // vectors in the index, and an embedder to turn the query into one. Missing either,
    // every query returns an empty list, which reads exactly like "your library has
    // nothing on this": the failure mode reported in #7. Refuse instead, and name the
    // cause. The embedder half is the quieter one, because an index built with vectors
    // and reopened with ZOTEUS_EMBEDDINGS=off keeps them (they are unusable, not
    // known-wrong) — so the 0-vector test alone lets it through, and `embedderNotice` is
    // deliberately silent about a provider switched off on purpose.
    // A store that could not be opened explains itself; this branch would otherwise tell
    // the caller their index holds no vectors and to rebuild it, which is true and beside
    // the point. Falling through lets query() refuse with the file and the command.
    //
    // `embedderId`, not `hasEmbedder`, is the right test for the second half, and the
    // difference is load-bearing. `embedderId` is undefined exactly when there is no
    // provider object — which is what query() itself keys on (`this.opts.embedder`), so it
    // is precisely the case where no query can ever be embedded. `hasEmbedder` is
    // `embedderActive`, which ALSO goes false on the first query-time failure and stays
    // false until the next build/update (noteEmbedFailure records the first edge;
    // embedderError is cleared only by an index job). query() keeps trying the provider
    // regardless and ranks again the moment it recovers, so refusing on `hasEmbedder`
    // would turn one rate-limit blip into a mode that stays dead until the user rebuilds
    // — while `auto` went on embedding the same query successfully. A transient failure is
    // reported by embedderNotice on the query that hit it, which is the existing contract.
    const canEmbedQuery = ctx.search.embedderId !== undefined;
    if (args.mode === 'semantic' && !(ctx.search.hasVectors && canEmbedQuery) && !ctx.search.storeFault) {
      const noVectors =
        // A model switch is the one cause that names its own remedy, so it wins over the
        // generic "no vectors yet" line.
        status.vectorsStaleReason ??
        (ctx.search.embedderActive
          ? 'The index holds no vectors yet. Rebuild it with zotero_index action:"build" (an index built while the embedder was unavailable stays keyword-only until rebuilt).'
          : `No vectors exist because the embedder is not active: ${ctx.search.embedderReason ?? 'unavailable'}`);
      // The index knows which provider produced the vectors it is holding, and that
      // survives the switch-off, so name it rather than making the user go and find out.
      const builtWith = ctx.search.vectorEmbedderId;
      const noEmbedder =
        status.embedderConfigured === 'off'
          ? 'Embeddings are switched off (ZOTEUS_EMBEDDINGS=off), so the stored vectors have nothing to be ranked ' +
            `against. Set ZOTEUS_EMBEDDINGS back to ${builtWith ? `the provider that built them (${builtWith})` : 'an embedding provider'} to rank by meaning again.`
          : `The configured ${status.embedderConfigured} embedder is not active: ${ctx.search.embedderReason ?? 'unavailable'}`;
      const cause = ctx.search.hasVectors
        ? `this index holds ${status.vectors} vectors but nothing can embed the query. ${noEmbedder}`
        : `this index has 0 vectors. ${noVectors}`;
      return {
        content: [
          {
            type: 'text',
            text:
              `mode:"semantic" cannot run: it ranks by vector similarity only, and ${cause} ` +
              'Re-run with mode:"keyword" (or the default "auto") to search this library right now.',
          },
        ],
        structuredContent: {
          hits: [],
          embedder: ctx.search.embedderName,
          embedderConfigured: status.embedderConfigured,
          embedderActive: status.embedderActive,
          ...(status.embedderReason ? { embedderReason: status.embedderReason } : {}),
          vectors: status.vectors,
        },
        isError: true,
      };
    }
    const hits = await ctx.search.query(args.q, { limit: args.limit ?? 10, mode: args.mode });
    // Re-read: a query-time embedding failure flips the embedder to inactive mid-call.
    const after = ctx.search.buildStatus();
    const summary =
      (hits.length
        ? `Top ${hits.length} match(es) for "${args.q}" (${ctx.search.embedderName}).`
        : `No matches for "${args.q}".`) +
      (args.mode === 'keyword' ? '' : embedderNotice(after) + staleVectorsNotice(after) + unembeddedNotice(after)) +
      fulltextNotice(after) +
      // Same reasoning: a search that cannot see the reader's own notes must say so where
      // the empty result is read, not only in zotero_index status.
      ownWordsNotice(after) +
      // A search over a truncated index must say so here, not only in zotero_index status:
      // this is where "no matches" would otherwise be read as "the library holds nothing".
      truncationNotice(after) +
      // Same for an index that never reached disk: these results exist only until restart.
      persistNotice(after);
    return okLibraryContent(
      {
        hits,
        embedder: ctx.search.embedderName,
        embedderConfigured: after.embedderConfigured,
        embedderActive: after.embedderActive,
        ...(after.embedderReason ? { embedderReason: after.embedderReason } : {}),
        ...(after.vectorsStaleReason ? { vectorsStaleReason: after.vectorsStaleReason } : {}),
        // The size of the gap between what is searchable by keyword and what is rankable by
        // meaning, so "no matches" over a half-embedded index is not read as an empty library.
        ...(after.passagesWithoutVectors ? { passagesWithoutVectors: after.passagesWithoutVectors } : {}),
        fulltextEnabled: after.fulltextEnabled,
        ...(after.fulltextReason ? { fulltextReason: after.fulltextReason } : {}),
        ownWordsEnabled: after.ownWordsEnabled,
        ...(after.ownWordsReason ? { ownWordsReason: after.ownWordsReason } : {}),
        ...(after.persistError ? { persistError: after.persistError } : {}),
      },
      summary,
    );
  },
};

export default semanticSearch;
