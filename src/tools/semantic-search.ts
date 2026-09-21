import { z } from 'zod';
import { provenance } from './common-output.js';
import type { ToolContext, ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { defaultLibrarySplit } from './index-tool.js';
import { okLibraryContent } from '../registry/registry.js';
import { canonicalLibraryToken, describeLibraryToken, type SearchHit } from '../features/search/backend.js';
import {
  embedderNotice,
  fulltextNotice,
  libraryNotice,
  namedLibrary,
  ownWordsNotice,
  persistNotice,
  progressLine,
  staleVectorsNotice,
  unembeddedNotice,
  startIndexBuild,
  truncationNotice,
  unaddressableLibrary,
  unreachableLibrary,
  unreachableIndexLibrary,
} from '../features/search/build.js';

/** The library-token spellings `libraries` accepts, for the refusal that lists them. */
const LIBRARY_TOKEN_FORMS = '"user", "group:<id>", "group-<id>", or a bare numeric group id';

/**
 * One entry of `libraries` as a canonical token, or undefined when it is not one.
 *
 * Deliberately the same reading `optionalLibrary` gives a bare `library_id`: a number on
 * its own is a group id, because the personal library is never addressed by number here.
 */
function parseLibraryToken(raw: string): string | undefined {
  const t = raw.trim();
  if (t === 'user') return 'user';
  const m = /^(?:group[:-])?(\d+)$/.exec(t);
  const id = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? `group:${id}` : undefined;
}

/** The arguments a combined search reads. The rest of the input schema is not its business. */
interface CombinedArgs {
  q: string;
  limit?: number;
  mode?: 'auto' | 'keyword' | 'semantic';
}

/** What one library contributed to a combined answer, said per library rather than merged. */
interface LibraryOutcome {
  library: string;
  label: string;
  /** False when this library has no index in this data directory at all. */
  indexed: boolean;
  /** How many of the MERGED rows came from here. Filled in after the merge, not before. */
  hits: number;
  /** What this index's own answer held, before the merge dropped anything over `limit`. */
  matched?: number;
  documents: number;
  vectors: number;
  /** Identity of the vectors this index HOLDS, absent when it holds none. */
  vectorEmbedder?: string;
  fulltextEnabled?: boolean;
  ownWordsEnabled?: boolean;
  embedderActive?: boolean;
  rankingNotice?: string;
  /** Why this library contributed nothing, when it did not. */
  note?: string;
}

/**
 * Search several libraries at once and merge what comes back.
 *
 * MERGED BY RANK, and the honesty of that word is the whole design. Each index scores
 * against its own corpus statistics (BM25 is a function of that library's document
 * frequencies) and may hold vectors from a different embedding model, so two scores from
 * two indexes are not on one scale and adding, averaging or sorting them together would
 * invent a comparability that does not exist. What IS comparable is position: rank 1 in
 * one library and rank 1 in another are both "the best this library has", so the merge
 * interleaves by rank and every hit carries the library it came from and its rank there.
 *
 * Nothing here builds anything. A library with no index is reported as such, with the
 * command that would build it, because fanning an automatic build out over several
 * libraries is a large and expensive thing to do to someone who asked a question.
 */
async function combinedSearch(
  args: CombinedArgs,
  ctx: ToolContext,
  wanted: string[],
): Promise<ToolHandlerResult> {
  const limit = args.limit ?? 10;
  const registry = ctx.indexes!;
  // The same refusal the single-index path makes, made once for the whole fan-out: ranking
  // by vectors alone needs an embedder to turn the QUERY into one, and without a provider
  // every index would answer the empty list that reads as "your libraries hold nothing on
  // this" (#7). `embedderId`, not `hasEmbedder`, for the reason the single path documents:
  // it is undefined exactly when there is no provider object, which is what query() keys on.
  if (args.mode === 'semantic' && ctx.search.embedderId === undefined) {
    return {
      content: [
        {
          type: 'text',
          text:
            'mode:"semantic" cannot run: it ranks by vector similarity only, and nothing here can embed the query. ' +
            `${ctx.search.embedderConfigured === 'off' ? 'Embeddings are switched off (ZOTEUS_EMBEDDINGS=off).' : `The configured ${ctx.search.embedderConfigured} embedder is not active: ${ctx.search.embedderReason ?? 'unavailable'}`} ` +
            'Re-run with mode:"keyword" (or the default "auto") to search these libraries right now.',
        },
      ],
      structuredContent: {
        hits: [],
        embedder: ctx.search.embedderName,
        embedderConfigured: ctx.search.embedderConfigured,
        embedderActive: ctx.search.embedderActive,
        ...(ctx.search.embedderReason ? { embedderReason: ctx.search.embedderReason } : {}),
      },
      isError: true,
    };
  }
  const outcomes: LibraryOutcome[] = [];
  const ranked: SearchHit[][] = [];

  for (const library of wanted) {
    const label = describeLibraryToken(library);
    const denied = unreachableIndexLibrary(ctx, library);
    if (denied) {
      outcomes.push({ library, label, indexed: false, hits: 0, documents: 0, vectors: 0, note: denied });
      continue;
    }
    await registry.withIndex(library, async (index) => {
      if (!index) {
        outcomes.push({ library, label, indexed: false, hits: 0, documents: 0, vectors: 0, note: buildHint(library) });
        return;
      }
      const status = index.buildStatus();
      if (status.library && status.library !== library) {
        outcomes.push({ library, label, indexed: true, hits: 0, documents: 0, vectors: 0,
          note: `This index is stamped ${describeLibraryToken(status.library)} and cannot answer for ${label}. Rebuild the correct library index.` });
        return;
      }
      const base = {
        library,
        label,
        indexed: true,
        documents: status.documents,
        vectors: status.vectors,
        ...(index.vectorEmbedderId ? { vectorEmbedder: index.vectorEmbedderId } : {}),
        fulltextEnabled: status.fulltextEnabled,
        ownWordsEnabled: status.ownWordsEnabled,
      };
      if (index.storeFault) {
        outcomes.push({ ...base, hits: 0, note: index.storeFault.message });
        return;
      }
      if (index.isEmpty) {
        outcomes.push({
          ...base,
          hits: 0,
          note: index.isBuilding
            ? `A build is running here: ${progressLine(status)}.`
            : `This index is empty. ${buildHint(library)}`,
        });
        return;
      }
      if (args.mode === 'semantic' && !index.hasVectors) {
        outcomes.push({
          ...base,
          hits: 0,
          note: 'This index holds no vectors, so mode:"semantic" can rank nothing in it. Re-run with mode:"auto" to ' +
            'include it as keyword search, or rebuild it with an embedder configured.',
        });
        return;
      }
      const hits = await index.query(args.q, { limit, mode: args.mode });
      const after = index.buildStatus();
      const rankingNotice = args.mode === 'keyword' ? '' :
        embedderNotice(after) + staleVectorsNotice(after) + unembeddedNotice(after);
      if (args.mode === 'semantic' && (!after.embedderActive || !after.vectors)) {
        outcomes.push({ ...base, vectors: after.vectors, hits: 0, embedderActive: after.embedderActive,
          note: `Semantic ranking could not complete.${rankingNotice} Retry or use mode:"keyword".` });
        return;
      }
      ranked.push(hits.map((h, i) => ({ ...h, library, libraryRank: i + 1 })));
      // `hits` is counted from the MERGED rows below, not from this answer: every index is
      // queried with the full `limit`, so N libraries can return N*limit rows behind a
      // limit-row answer, and reporting those lengths as the merged rows made the per-library
      // numbers sum above the total the same sentence stated.
      outcomes.push({ ...base, vectors: after.vectors, hits: 0, matched: hits.length,
        embedderActive: after.embedderActive, ...(rankingNotice ? { rankingNotice } : {}) });
    }, true);
  }

  const searched = outcomes.filter((o) => o.indexed && !o.note);
  if (!searched.length) {
    return {
      content: [
        {
          type: 'text',
          text:
            `Nothing was searched: none of the ${outcomes.length} librar${outcomes.length === 1 ? 'y' : 'ies'} asked ` +
            'for has an index that can answer right now.\n' +
            outcomes.map((o) => `- ${o.label}: ${o.note ?? 'no index in this data directory.'}`).join('\n'),
        },
      ],
      structuredContent: { hits: [], libraries: outcomes },
      isError: true,
    };
  }

  // Interleave by rank: rank 1 from every library, then rank 2, and so on. `sort` is
  // stable, so within one rank the libraries keep the order they were asked for, which
  // makes the same question give the same answer twice running.
  const merged = ranked
    .flat()
    .sort((a, b) => (a.libraryRank ?? 0) - (b.libraryRank ?? 0))
    .slice(0, limit);

  // Now that the overflow is gone, `hits` can mean what its schema says it means: how many
  // of the rows in this answer came from that library. `matched` keeps the other number,
  // which is the one that says raising `limit` would surface more from there.
  const contributed = new Map<string, number>();
  for (const h of merged) contributed.set(h.library ?? '', (contributed.get(h.library ?? '') ?? 0) + 1);
  for (const o of outcomes) o.hits = contributed.get(o.library) ?? 0;

  // Two indexes whose vectors came from different models. Said out loud rather than fused
  // away: their vector rankings are answers from different models, and no amount of
  // arithmetic on this side makes them one ranking.
  const embedders = [...new Set(searched.map((o) => o.vectorEmbedder).filter((v): v is string => Boolean(v)))];
  const embedderMismatch =
    embedders.length > 1
      ? `These indexes hold vectors from DIFFERENT embedding models (${embedders.join(', ')}). Their vector scores ` +
        'are answers from different models and were not compared: the merge below is by rank within each library, ' +
        'and nothing here makes the two rankings equivalent. Rebuild them with one ZOTEUS_EMBEDDING_MODEL to ' +
        'compare like with like.'
      : undefined;
  const keywordOnly = searched.filter((o) => !o.vectorEmbedder);
  const mixedRanking =
    args.mode !== 'keyword' && keywordOnly.length && keywordOnly.length < searched.length
      ? ` ${keywordOnly.map((o) => o.label).join(' and ')} hold no vectors, so their rows were ranked by keyword ` +
        'alone while the others also used vector similarity.'
      : '';

  const skipped = outcomes.filter((o) => o.note);
  const summary =
    (merged.length
      ? `Top ${merged.length} match(es) for "${args.q}" across ${searched.length} librar${searched.length === 1 ? 'y' : 'ies'} ` +
        `(${searched.map((o) => `${o.label}: ${o.hits}${o.matched !== undefined && o.matched > o.hits ? ` of ${o.matched}` : ''}`).join(', ')}).`
      : `No matches for "${args.q}" in ${searched.map((o) => o.label).join(' or ')}.`) +
    ' MERGED BY RANK, not by score: each index scores against its own library\'s statistics, so the `score` on a ' +
    'hit is only comparable with others from the SAME library. Every hit carries `library` and `libraryRank` (its ' +
    'position within that library\'s own answer).' +
    mixedRanking +
    searched.filter((o) => o.rankingNotice).map((o) => ` ${o.label}:${o.rankingNotice}`).join('') +
    (embedderMismatch ? ` ${embedderMismatch}` : '') +
    (skipped.length
      ? ` Not searched: ${skipped.map((o) => `${o.label} (${o.note})`).join('; ')}`
      : '');

  return okLibraryContent(
    {
      hits: merged,
      libraries: outcomes,
      merge: 'rank',
      ...(embedderMismatch ? { embedderMismatch } : {}),
      // Configuration is shared; failures during query embedding are recorded per index.
      embedder: ctx.search.embedderName,
      embedderConfigured: ctx.search.embedderConfigured,
      embedderActive: searched.some((o) => o.embedderActive),
      ...(ctx.search.embedderReason ? { embedderReason: ctx.search.embedderReason } : {}),
    },
    summary,
  );
}

/** How to build an index for this library, in the caller's own tool vocabulary. */
function buildHint(library: string): string {
  return library === 'user'
    ? 'Build it with zotero_index action:"build" library_type:"user".'
    : `Build it with zotero_index action:"build" library_type:"group" library_id:${library.slice('group:'.length)}.`;
}

const semanticSearch: ToolDefinition = {
  name: 'zotero_semantic_search',
  title: 'Semantic / hybrid library search',
  description:
    'Search the library by meaning, not just keywords. Combines BM25 keyword scoring with vector similarity (when an embedding provider is configured) via reciprocal-rank fusion, and returns the best-matching items with a snippet and score. By default it searches item metadata and abstracts; if the index was built with `fulltext` on (zotero_index fulltext:true, or ZOTEUS_INDEX_FULLTEXT=true) it also searches the body text of attachments, and a hit whose snippet came from a PDF body is marked source:"fulltext". It ALSO searches the words the reader wrote — child notes and PDF annotations (highlight text and comments) — unless that was turned off (ZOTEUS_INDEX_OWN_WORDS=false); a hit from one is marked source:"note" or source:"annotation" and is attributed to the item it hangs off, so an item with forty annotations is one result rather than forty. `mode`: "auto" (hybrid, default), "keyword" (BM25 only), or "semantic" (vector only). "semantic" needs both vectors in the index and a running embedder to turn the query into one: when either is missing (embeddings switched off, or e.g. the on-device model runtime is not installed) it returns an error naming the cause instead of an empty result set, and "auto" keeps working as keyword search while saying so. The index must be built once before first use: when it is empty this tool starts a background build automatically (`auto_build`, on by default) and tells you to poll zotero_index action:"status" and retry — pass `auto_build:false` to opt out. ONE INDEX FILE HOLDS ONE LIBRARY, and a plain call answers from the default library\'s index: which library that is comes back as `library` on the result and is named in the summary (both absent only on an index built before that stamp existed, where the library is genuinely unknown). `library_type`/`library_id` name ONE library: when that library has an index of its own in this data directory, the search answers from THAT index; when it does not, you get an error naming which library the index that IS here holds, rather than a silent answer from rows belonging to a different library (with `auto_build` on, the named library is instead built into a new index of its own in the background). Omitting them searches the default library\'s index, whatever it holds. To search SEVERAL libraries at once, build each one\'s index (zotero_index action:"build" library_type:"group" library_id:<id>), then pass `libraries`: `libraries:"all"` searches every library that has an index here, `libraries:["user","group:4523"]` searches the ones you name, and zotero_index action:"libraries" lists what exists. A combined answer is MERGED BY RANK and never by score, because each index scores against its own library\'s statistics and may hold vectors from a different embedding model: `score` is therefore only comparable between hits from the SAME library, every hit carries `library` and `libraryRank` (its position in that library\'s own answer), and a mix of embedding models is reported as `embedderMismatch` rather than fused away. A library named in `libraries` that has no index is reported with the command that would build it; nothing there starts a build. For exact field/tag/itemType filtering use zotero_search_items instead; use this for conceptual/"papers about X" queries. To read the actual passages of a found item (with page locators) use zotero_get_fulltext.',
  inputSchema: {
    q: z.string().min(1).describe('Natural-language query.'),
    ...libraryArgs,
    libraries: z
      .union([z.literal('all'), z.array(z.string().min(1)).min(1)])
      .optional()
      .describe(
        'Search SEVERAL libraries at once, instead of the one index a plain call answers from. "all" means every ' +
          'library that has an index in this data directory (zotero_index action:"libraries" lists them); an array ' +
          `names them, spelled ${LIBRARY_TOKEN_FORMS}. Each library is searched in its own index and the answers are ` +
          'MERGED BY RANK, not by score: every hit carries `library` and `libraryRank`, and scores from two ' +
          'different indexes are not on the same scale so they are never compared. A named library with no index ' +
          'is reported, not built (nothing here starts a build). Cannot be combined with library_type/library_id, ' +
          'which check the single index instead.',
      ),
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
              library: z
                .string()
                .optional()
                .describe(
                  'Which library this hit came from ("user" or "group:<id>"). Present only on a combined answer ' +
                    '(`libraries`), where it is what tells two items with the same itemKey apart; a single-index ' +
                    'answer names its library once, at the top level.',
                ),
              libraryRank: z
                .number()
                .optional()
                .describe(
                  "This hit's 1-based position within its OWN library's answer. A combined answer is ordered by " +
                    'this rather than by `score`, because two indexes do not score on the same scale.',
                ),
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
      fulltextEnabled: z
        .boolean()
        .optional()
        .describe(
          'Whether attachment body text is in the index that answered. Absent on a combined answer, where it ' +
            'differs per library and is reported in `libraries[]` instead.',
        ),
      fulltextReason: z.string().optional().describe('Why body text is missing or not current, when it was asked for.'),
      ownWordsEnabled: z
        .boolean()
        .optional()
        .describe(
          "Whether the reader's own notes and annotations are in the index that answered. Absent on a combined " +
            'answer, where it differs per library and is reported in `libraries[]` instead.',
        ),
      ownWordsReason: z.string().optional().describe('Why they are missing or not current.'),
      persistError: z.string().optional().describe('The index never reached disk; these results exist only until restart.'),
      library: z
        .string()
        .optional()
        .describe(
          'Which library these hits came from: "user" for the personal library, or "group:<id>". One index file ' +
            'holds one library. Absent on an index built before this stamp existed, where the library is unknown.',
        ),
      libraries: z
        .array(
          z.object({
            library: z.string().describe('Canonical token of this library: "user" or "group:<id>".'),
            label: z.string().describe('The same library in words: "the personal library" or "group 4523".'),
            indexed: z.boolean().describe('False when this library has no search index in this data directory.'),
            hits: z
              .number()
              .describe(
                'How many of the rows in this answer came from this library. Counted from the merged rows, so ' +
                  'these add up to the number of hits returned.',
              ),
            matched: z
              .number()
              .optional()
              .describe(
                "How many rows this library's own index returned before the merge dropped everything past `limit`. " +
                  'Larger than `hits` means a higher `limit` would surface more from here.',
              ),
            documents: z.number().describe('Passages its index holds.'),
            vectors: z.number().describe('Passages of its index that carry an embedding.'),
            vectorEmbedder: z
              .string()
              .optional()
              .describe(
                'Identity of the vectors this index HOLDS, absent when it holds none. Two libraries with different ' +
                  'values were embedded by different models: see `embedderMismatch`.',
              ),
            fulltextEnabled: z.boolean().optional().describe('Whether attachment body text is in this index.'),
            ownWordsEnabled: z.boolean().optional().describe("Whether this index holds the reader's notes and annotations."),
            embedderActive: z.boolean().optional().describe('Whether this library could use its configured embedder.'),
            rankingNotice: z.string().optional().describe('Query-time embedding failures or incomplete vector coverage.'),
            note: z.string().optional().describe('Why this library contributed nothing, when it did not.'),
          }),
        )
        .optional()
        .describe('One row per library a combined search (`libraries`) looked at, including the ones it could not search.'),
      merge: z
        .string()
        .optional()
        .describe(
          'How rows from more than one index were combined. Always "rank": each hit is placed by its position ' +
            "within its own library's answer, because scores from two indexes are not on the same scale and were " +
            'not fused. Absent on a single-index answer, which has nothing to merge.',
        ),
      embedderMismatch: z
        .string()
        .optional()
        .describe(
          'Set when a combined search spanned indexes whose vectors came from DIFFERENT embedding models, naming ' +
            'them. Their vector rankings are answers from different models and were not compared.',
        ),
      requestedLibrary: z
        .string()
        .optional()
        .describe('The library the caller named with library_type/library_id, when it is not the one the index holds.'),
      provenance,
    })
    .passthrough(),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    // Explicit only, and deliberately NOT resolveLibrary: a search reads whatever rows are
    // already there and must not invent a target. The remedy the docs prescribe for a
    // second library is a separate ZOTEUS_DATA_DIR whose index was built for a group while
    // the server's own default library is still the personal one, and a plain query there
    // has to keep answering from the index that exists. Naming a library is the caller
    // asserting which one they mean, and that is the only case worth refusing. A build is
    // the opposite (it is about to write rows), which is why zotero_index resolves the
    // configured default and this does not.
    // `namedLibrary`, not `optionalLibrary`: a bare `library_type:"user"` is the caller
    // saying "my personal library", and dropping it made that search answer from the
    // configured group instead, silently, on a ZOTERO_LIBRARY_TYPE=group install.
    const requested = namedLibrary(ctx, args);
    // Asked before anything derives a path from it: a token that cannot be read back off
    // disk has no index and may never be given one.
    const unaddressable = unaddressableLibrary(requested);
    if (unaddressable) {
      return { content: [{ type: 'text', text: unaddressable }], isError: true };
    }
    // A combined search is a different question with a different answer shape, so it is
    // decided first and never falls through into the single-index path below.
    if (args.libraries !== undefined) {
      if (requested) {
        return {
          content: [
            {
              type: 'text',
              text:
                'Pass `libraries` OR library_type/library_id, not both: `libraries` searches several indexes and ' +
                'labels every hit with the library it came from, while library_type/library_id assert which single ' +
                'library the one index is expected to hold. Drop one of them and re-run.',
            },
          ],
          isError: true,
        };
      }
      if (!ctx.indexes) {
        return {
          content: [
            {
              type: 'text',
              text:
                'This server holds a single search index, so it cannot search several libraries at once. Search ' +
                'without `libraries`, and use zotero_index action:"libraries" to see what it holds.',
            },
          ],
          isError: true,
        };
      }
      let wanted: string[];
      if (args.libraries === 'all') {
        // Every library that HAS an index. Deliberately not "every library you can reach":
        // searching one means opening its index, and there is nothing to open for a library
        // nobody has indexed.
        wanted = (await ctx.indexes.list()).map((r) => r.library);
      } else {
        const raw = args.libraries as string[];
        const parsed = raw.map((r) => ({ raw: r, token: parseLibraryToken(r) }));
        const bad = parsed.filter((pp) => !pp.token);
        if (bad.length) {
          return {
            content: [
              {
                type: 'text',
                text:
                  `Not a library: ${bad.map((pp) => JSON.stringify(pp.raw)).join(', ')}. Each entry of \`libraries\` is ` +
                  `${LIBRARY_TOKEN_FORMS} (zotero_groups lists the group ids you can reach, and zotero_index ` +
                  'action:"libraries" lists the ones that already have an index). Nothing was searched.',
              },
            ],
            isError: true,
          };
        }
        // De-duplicated, because naming the same library twice would put its rows in the
        // merge twice and read as two independent confirmations of one hit.
        wanted = [...new Set(parsed.map((pp) => pp.token as string))];
      }
      if (!wanted.length) {
        return {
          content: [
            {
              type: 'text',
              text:
                'No library in this data directory has a search index yet, so there is nothing to search across. ' +
                'Build one with zotero_index action:"build" (add library_type:"group" library_id:<id> for a group).',
            },
          ],
          structuredContent: { hits: [], libraries: [] },
          isError: true,
        };
      }
      return combinedSearch(args as CombinedArgs, ctx, wanted);
    }

    /**
     * Which index answers.
     *
     * A named library gets its OWN index when it has one, because one store holds one
     * library: "search group 4523" means that group's store, not the default library's
     * rows. Naming a library with NO index falls through to `ctx.search` on purpose, so
     * the mismatch refusal below can say which library the index that IS here holds; the
     * one exception is auto_build, which must create and build the named library's own
     * store rather than stamping the default library's file with someone else's token.
     *
     * An OMITTED library means the DEFAULT library, which is `ctx.search` only while the
     * primary index's stamp agrees with the configured default: where it does not, the
     * default library's index is a sibling file, and it is the one a build with no library
     * argument writes. Resolved through `openIfExists` so a search still creates nothing
     * and still falls back to `ctx.search` when the default library has no index of its
     * own, which is the documented case of a data directory whose index was built for a
     * group while the configured default is still the personal library.
     */
    const denied = unreachableLibrary(ctx, requested);
    if (denied) return { content: [{ type: 'text', text: denied }], isError: true };
    let index = ctx.search;
    if (requested && ctx.indexes) {
      const want = canonicalLibraryToken(requested);
      if (want !== ctx.indexes.primaryLibrary) {
        const own = await ctx.indexes.openIfExists(want);
        if (own) index = own;
        else if (args.auto_build !== false) {
          // Opening a store CREATES it, so the one question that must come first is
          // whether this caller can read that library at all: a group they cannot reach
          // has nothing to index, and leaving a permanent file in the data directory to
          // say so is a write nobody asked for.
          const why = unreachableLibrary(ctx, requested);
          if (why) {
            return {
              content: [{ type: 'text', text: why }],
              structuredContent: { hits: [], requestedLibrary: want },
              isError: true,
            };
          }
          index = await ctx.indexes.open(want);
        }
      }
    } else if (!requested && ctx.indexes) {
      // An omitted library means the DEFAULT library, and once that library has an index
      // file of its own this is the file it is in. `ctx.search` is only the same object
      // while the primary's stamp agrees with the configured default; where it does not,
      // reading `ctx.search` here answered every plain search from one file while
      // zotero_index built and reported another, indefinitely.
      //
      // `openIfExists`, never `open`: a plain search must not create a store. With no
      // sibling for the default library this falls back to `ctx.search` exactly as before,
      // which is what keeps the documented case working (a data directory whose index was
      // built for a group while the configured default is still the personal library).
      const fallback = ctx.router?.defaultLibrary?.();
      if (fallback) {
        const token = canonicalLibraryToken(fallback);
        const own = await ctx.indexes.openIfExists(token);
        // An EMPTY sibling in the split state (the original index stamped another library
        // and holding rows) is not yet anybody's choice: zotero_index refuses to fill it
        // without an explicit library for exactly that reason, and answering from it here
        // would auto-build the second crawl that refusal exists to prevent. Keep answering
        // from the original index, as a plain search did before the sibling existed.
        if (own && !(own.isEmpty && !own.isBuilding && defaultLibrarySplit(ctx, token))) index = own;
      }
    }
    const heldDenied = unreachableIndexLibrary(ctx, index.buildStatus().library);
    if (heldDenied) return { content: [{ type: 'text', text: heldDenied }], isError: true };
    // Which library the messages below are about. Said out loud only when the caller named
    // one, because a plain call has always meant "the index that is here" and adding a
    // library to that sentence would claim more than the stamp may know.
    const about = requested ? ` for ${describeLibraryToken(canonicalLibraryToken(requested))}` : '';
    if (index.isEmpty) {
      // A build is already on its way (started here or via zotero_index): report progress.
      if (index.isBuilding) {
        const s = index.buildStatus();
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
      if (index.isPaused) {
        const s = index.buildStatus();
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
        // Resolved here (explicit library, else the configured default) so the stamp names
        // the library the crawl will actually visit: an automatic first build on a
        // ZOTERO_LIBRARY_TYPE=group install used to crawl the group and stamp the index
        // "user", after which an explicit personal-library build erased the group's rows.
        // The optional call keeps the router-less fixtures that drive this handler directly
        // working; no router means the personal library, exactly as before.
        const s = startIndexBuild(ctx, requested ?? ctx.router?.defaultLibrary?.(), undefined, {}, index);
        return {
          content: [
            {
              type: 'text',
              text:
                `The semantic-search index${about} is empty, so a background build was started automatically ` +
                `(first-time setup; ${progressLine(s)}). Poll zotero_index with action:"status" every few seconds ` +
                'until state is "done", then retry this search. Pass auto_build:false to opt out.' +
                embedderNotice(s),
            },
          ],
          structuredContent: { ...s, autoBuild: true },
          isError: true,
        };
      }
      const s = index.buildStatus();
      return {
        content: [
          {
            type: 'text',
            text:
              `The search index${about} is empty. Run zotero_index with action:"build" first, then retry.` +
              embedderNotice(s),
          },
        ],
        structuredContent: { ...s },
        isError: true,
      };
    }
    const status = index.buildStatus();
    // One index file holds one library. When the caller names a library this index does not
    // hold, there are no rows here that could answer them, and the rows that ARE here are
    // someone else's: a hit carries no library of its own, so a model handed them has no
    // way to notice. Refuse and name both, rather than answer from the wrong library.
    //
    // Only when the index actually carries a stamp: an index built before the stamp existed
    // says nothing about whose rows it holds, and refusing on absent provenance would
    // strand it behind an error no rebuild of this library could clear.
    const held = status.library;
    if (requested && held) {
      const want = canonicalLibraryToken(requested);
      if (want !== held) {
        const build =
          want === 'user'
            ? 'zotero_index action:"build"'
            : `zotero_index action:"build" library_type:"group" library_id:${want.slice('group:'.length)}`;
        return {
          content: [
            {
              type: 'text',
              text:
                `This index holds ${describeLibraryToken(held)}, not ${describeLibraryToken(want)}. One index ` +
                `file holds one library, so there is nothing here to answer a search of ${describeLibraryToken(want)} ` +
                `with, and answering from ${describeLibraryToken(held)} would be the wrong library. Give ` +
                `${describeLibraryToken(want)} an index of its own with ${build}, then search it with ` +
                `libraries:["${want}"] (or libraries:"all" for both at once, merged by rank). To search ` +
                `${describeLibraryToken(held)} instead, re-run this search without library_type/library_id.`,
            },
          ],
          structuredContent: { hits: [], library: held, requestedLibrary: want },
          isError: true,
        };
      }
    }
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
    const canEmbedQuery = index.embedderId !== undefined;
    if (args.mode === 'semantic' && !(index.hasVectors && canEmbedQuery) && !index.storeFault) {
      const noVectors =
        // A model switch is the one cause that names its own remedy, so it wins over the
        // generic "no vectors yet" line.
        status.vectorsStaleReason ??
        (index.embedderActive
          ? 'The index holds no vectors yet. Rebuild it with zotero_index action:"build" (an index built while the embedder was unavailable stays keyword-only until rebuilt).'
          : `No vectors exist because the embedder is not active: ${index.embedderReason ?? 'unavailable'}`);
      // The index knows which provider produced the vectors it is holding, and that
      // survives the switch-off, so name it rather than making the user go and find out.
      const builtWith = index.vectorEmbedderId;
      const noEmbedder =
        status.embedderConfigured === 'off'
          ? 'Embeddings are switched off (ZOTEUS_EMBEDDINGS=off), so the stored vectors have nothing to be ranked ' +
            `against. Set ZOTEUS_EMBEDDINGS back to ${builtWith ? `the provider that built them (${builtWith})` : 'an embedding provider'} to rank by meaning again.`
          : `The configured ${status.embedderConfigured} embedder is not active: ${index.embedderReason ?? 'unavailable'}`;
      const cause = index.hasVectors
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
          embedder: index.embedderName,
          embedderConfigured: status.embedderConfigured,
          embedderActive: status.embedderActive,
          ...(status.embedderReason ? { embedderReason: status.embedderReason } : {}),
          vectors: status.vectors,
        },
        isError: true,
      };
    }
    const answer = async (index: NonNullable<ToolContext['search']>) => {
      const hits = await index.query(args.q, { limit: args.limit ?? 10, mode: args.mode });
      // Re-read: a query-time embedding failure flips the embedder to inactive mid-call.
      const after = index.buildStatus();
      const summary =
        (hits.length
          ? `Top ${hits.length} match(es) for "${args.q}" (${index.embedderName}).`
          : `No matches for "${args.q}".`) +
        // Which library these hits came from, said where a wrong-library answer is actually
        // read. SearchHit carries no library of its own, so without this the caller has no
        // way to tell whose rows they were handed.
        libraryNotice(after) +
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
          embedder: index.embedderName,
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
          ...(after.library ? { library: after.library } : {}),
        },
        summary,
      );
    };
    if (!ctx.indexes) return answer(index);
    const token = index === ctx.search
      ? ctx.indexes.primaryLibrary
      : canonicalLibraryToken(requested ?? ctx.router?.defaultLibrary?.());
    return ctx.indexes.withIndex(token, async (current) => answer(current!));

  },
};

export default semanticSearch;
