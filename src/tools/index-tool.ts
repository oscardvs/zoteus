import { z } from 'zod';
import { indexStatus } from './common-output.js';
import type { ToolContext, ToolDefinition } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { ok } from '../registry/registry.js';
import {
  namedLibrary,
  progressLine,
  startIndexBuild,
  startIndexUpdate,
  statusSummary,
  unaddressableLibrary,
  unreachableLibrary,
  unreachableIndexLibrary,
  updateNotice,
} from '../features/search/build.js';
import { canonicalLibraryToken, describeLibraryToken, type SearchIndex } from '../features/search/backend.js';
import type { IndexedLibrary } from '../features/search/index-registry.js';
import { repairSearchIndex, type RepairReport } from '../features/search/repair.js';
import { DEFAULT_FULLTEXT_MAX_CHARS } from '../features/search/fulltext-source.js';
import { DEFAULT_INDEX_MAX_ITEMS } from '../features/search/limits.js';
import type { LibraryRef } from '../api/web-client.js';

/**
 * Actions that only ever READ an index, and so must never create one to answer. `pause` is
 * one of them: it pauses work that is running, and a library with no index has none.
 */
const READ_ONLY_ACTIONS = new Set(['status', 'stop', 'resume', 'pause']);

/**
 * Which index this call is about.
 *
 * One store holds one library's rows, so `library_type`/`library_id` select the FILE, not
 * just the crawl: naming a group opens that group's own index beside the default library's
 * rather than indexing it over them. `index` is undefined only for a read-only action
 * about a library that has no index in this data directory, because answering "how big is
 * it" by creating an empty one would be a side effect nobody asked for.
 *
 * Falls back to `ctx.search` wherever there is no registry, which is every hand-built test
 * context and the deferred-startup fake: exactly the single-index behaviour from before.
 */
async function targetIndex(
  ctx: ToolContext,
  args: { action?: string; library_type?: 'user' | 'group'; library_id?: number },
): Promise<{
  lib: LibraryRef | undefined;
  library: string;
  /** The library the caller NAMED, undefined when the call fell back to the configured default. */
  named: LibraryRef | undefined;
  index: SearchIndex | undefined;
  refusal?: string;
}> {
  // `resolveLibrary(ctx, args)`, spelled out. This call may be about to WRITE rows and the
  // index stamps the library they belong to, so an omitted library must resolve to the
  // configured default rather than staying undefined: `optionalLibrary` alone stamped
  // "user" while the crawl followed ZOTERO_LIBRARY_TYPE=group, so a group-default install
  // indexed its group under the personal library's token. Naming that same group
  // afterwards was then refused, and an explicit library_type:"user" build passed the
  // guard and erased the group's rows. Resolving the default here is routing-equivalent:
  // the router resolves an omitted library to exactly this.
  //
  // Written with an optional call rather than as `resolveLibrary(ctx, args)` because
  // fixtures drive this handler with a stub router carrying `servesLocally` and
  // `searchItems` and nothing else (tests/features/index-truncation.test.ts). An absent
  // default means what it meant before, the personal library, and `startIndexBuild`
  // applies the same fallback again before it stamps.
  //
  // `ctx.router?` and not `ctx.router.`: this now runs for action:"status" too, and some
  // fixtures drive that path with a context carrying a search index and nothing else.
  //
  // `namedLibrary`, not `optionalLibrary`: a bare `library_type:"user"` means the personal
  // library, and dropping it here sent a personal-library build at the configured group.
  const named = namedLibrary(ctx, args);
  const lib: LibraryRef | undefined = named ?? ctx.router?.defaultLibrary?.();
  const library = canonicalLibraryToken(lib);

  const readOnly = READ_ONLY_ACTIONS.has(args.action ?? '');
  // Validate before opening a file. Cached content must obey the current key's read
  // permissions too, including status calls and the configured default library.
  const refusal = unaddressableLibrary(named) ?? unreachableLibrary(ctx, lib);
  if (refusal) return { lib, library, named, index: undefined, refusal };
  if (!ctx.indexes) return { lib, library, named, index: ctx.search };
  // Look before creating. A write action opens the store, and opening one CREATES it, so
  // the refusal below has to be decided while the file may not exist yet: a store created
  // and then refused would sit there empty, and an empty store is what turns the next
  // plain search into the very crawl the refusal exists to prevent.
  const existing = await ctx.indexes.openIfExists(library);
  if (!readOnly) {
    const stop = secondCrawlRefusal(ctx, named, library, existing);
    if (stop) return { lib, library, named, index: existing, refusal: stop };
  }
  const index = existing ?? (readOnly ? undefined : await ctx.indexes.open(library));
  return { lib, library, named, index, refusal: unreachableIndexLibrary(ctx, index?.buildStatus().library) ?? undefined };
}

/**
 * What a call addressing the CONFIGURED DEFAULT library owes the caller when the original
 * index in this data directory is stamped some other library and holds rows.
 *
 * That state splits the data directory in two: the default library gets a file of its own
 * beside the original, so a build with no library argument crawls and embeds a whole
 * library again while the original file sits there holding somebody's rows. Two installs
 * reach it and they are indistinguishable once written: one whose index really was built
 * for another library, and a group-default install indexed by a Zoteus older than the
 * library stamp, whose file holds the GROUP's rows under the personal library's token.
 * Saying so here is the difference between a second full embedding bill the user chose and
 * one they were handed.
 */
function stampSplitNotice(ctx: ToolContext, library: string): string {
  const primary = ctx.indexes?.primaryLibrary;
  const fallback = ctx.router?.defaultLibrary?.();
  // No router means no configured default to disagree with: the fixtures that drive this
  // handler with a bare context are not in this state and must not be told they are.
  if (!primary || !fallback || primary === library) return '';
  const configured = canonicalLibraryToken(fallback);
  if (library !== configured || primary === configured) return '';
  let held = 0;
  try {
    held = ctx.search.buildStatus().documents;
  } catch {
    // An index that cannot report itself says nothing about whose rows it holds.
    return '';
  }
  if (!held) return '';
  return (
    ` NOTE: this data directory's original index (${ctx.searchIndexPath}) is stamped ` +
    `${describeLibraryToken(primary)}, which is not this server's default library ` +
    `(${describeLibraryToken(configured)}), so ${describeLibraryToken(configured)} is addressed through an index ` +
    'file of its own beside it. If that original index was in fact built for ' +
    `${describeLibraryToken(configured)} by a Zoteus older than the library stamp, delete it and build again to ` +
    'restamp it, rather than paying for a second crawl of the same library. action:"libraries" lists both.'
  );
}

/**
 * Whether `library`, the configured default, is in the split state `stampSplitNotice`
 * describes: this data directory's original index is stamped another library and holds
 * rows, so the default is addressed through a sibling file of its own.
 */
export function defaultLibrarySplit(ctx: ToolContext, library: string): boolean {
  return stampSplitNotice(ctx, library) !== '';
}

/**
 * The refusal that replaces a crawl the caller did not knowingly choose.
 *
 * `stampSplitNotice` says its sentence AFTER the crawl has started, and for the one install
 * the notice exists for that is the wrong moment: a group-default data directory indexed by
 * a Zoteus older than the library stamp holds the group's complete index under the personal
 * library's token, and a plain action:"update" there, the call this tool recommends, opened
 * the empty sibling, found no version stamp, turned itself into a full build, and crawled
 * and embedded the whole group again while the finished index sat beside it. Zoteus cannot
 * tell that install from one whose original index really was built for another library, so
 * it does what it does everywhere else it cannot tell two files apart: it refuses and names
 * both ways out. A named library is the caller choosing the second, and a sibling that
 * already holds rows is a crawl chosen earlier, so neither is refused.
 */
function secondCrawlRefusal(
  ctx: ToolContext,
  named: LibraryRef | undefined,
  library: string,
  sibling: SearchIndex | undefined,
): string | undefined {
  if (named || !defaultLibrarySplit(ctx, library)) return undefined;
  let documents = 0;
  try {
    documents = sibling?.buildStatus().documents ?? 0;
  } catch {
    // A sibling that cannot report itself is repaired elsewhere; this is not that refusal.
    return undefined;
  }
  if (documents > 0) return undefined;
  const primary = describeLibraryToken(ctx.indexes!.primaryLibrary);
  const configured = describeLibraryToken(library);
  const explicit =
    library === 'user'
      ? 'library_type:"user"'
      : `library_type:"group" library_id:${library.slice('group:'.length)}`;
  return (
    `Not started. ${configured} is this server's default library and has no index of its own here, while this ` +
    `data directory's original index (${ctx.searchIndexPath}) is stamped ${primary} and holds rows. Zoteus cannot ` +
    'tell which of two installs this is, and on one of them this call would pay for a second crawl of the same ' +
    `library: (1) that original index was built for ${configured} by a Zoteus older than the library stamp, in which ` +
    'case delete it and run action:"build" again, which restamps it; or (2) it really is ' +
    `${primary}'s index, in which case run this action again with ${explicit}, which builds ${configured}'s own index ` +
    'beside it. action:"libraries" lists both.'
  );
}

/** What a read-only action says about a library that has no index here yet. */
function noIndexYet(ctx: ToolContext, library: string): string {
  const build =
    library === 'user'
      ? 'zotero_index action:"build" library_type:"user"'
      : `zotero_index action:"build" library_type:"group" library_id:${library.slice('group:'.length)}`;
  return (
    `No search index exists for ${describeLibraryToken(library)} in this data directory. ` +
    `Run ${build} to create one, or action:"libraries" to see which libraries do have one.` +
    stampSplitNotice(ctx, library)
  );
}

/**
 * A listed index, plus why this key cannot read the library it holds when it cannot.
 *
 * Listed rather than dropped: the action promises every index in this data directory, and an
 * index whose library the current key can no longer reach is exactly the one a user cannot
 * otherwise find out about. The combined-search path already reports such an index with a
 * note; the listing says the same.
 */
type LibraryRow = IndexedLibrary & { unreachable?: string };

/** One line per indexed library, for the summary `action:"libraries"` returns. */
function librariesSummary(rows: LibraryRow[], configured?: string): string {
  const lines = rows.map((r) => {
    const counts = `${r.documents} passage(s) over ${r.items} item(s), ${r.vectors} with vectors`;
    const stamp = r.stamp ? '' : ' (built before the library stamp existed, so it guards nothing)';
    const busy = r.state === 'building' ? ', a job is running' : r.state === 'error' ? ', last job ended in an error' : '';
    const fault = (r.fault ? ` UNREADABLE: ${r.fault}` : '') + (r.unreachable ? ` NOT READABLE WITH THIS KEY: ${r.unreachable}` : '');
    // The primary is "the default library" only while its stamp agrees with the configured
    // one. Calling a file stamped the personal library "the default library" on a
    // ZOTERO_LIBRARY_TYPE=group install is how a mis-stamped index stays invisible.
    const role = r.primary
      ? configured && r.library !== configured
        ? ` (this data directory's original index; the default library here is ${describeLibraryToken(configured)}, whose index is listed separately once it exists)`
        : ' (the default library)'
      : '';
    return `- ${r.label}${role}: ${counts}${busy}${stamp}.${fault}`;
  });
  return (
    `${rows.length} librar${rows.length === 1 ? 'y has' : 'ies have'} a search index in this data directory. ` +
    'One index file holds one library, and a search answers from one of them unless you ask ' +
    'zotero_semantic_search for several.\n' +
    lines.join('\n')
  );
}

/**
 * Run a build starter, and when its cross-library refusal lands on the one install where
 * the stamp itself may be wrong, say so.
 *
 * zotero_index used to resolve an omitted library with `optionalLibrary`, which stamped
 * "user" while the crawl followed a configured group, so an index built on a
 * ZOTERO_LIBRARY_TYPE=group install holds the GROUP's rows under the personal library's
 * token. Now that the stamp names the library actually crawled, that index refuses the
 * very group it holds: the generic remedy ("delete the index file and rebuild") is exactly
 * right, while the sentence above it ("this index holds the personal library") is exactly
 * wrong, and a user who never indexed a personal library has no way to make sense of it.
 *
 * This only ever ADDS an explanation. It never bypasses the guard: an explicit
 * `library_type:"user"` build on the same install produces a genuine personal index, and
 * the two are indistinguishable once written, so erasing on a guess is not an option.
 */
function startGuarded<T>(
  start: () => T,
  ctx: ToolContext,
  lib: LibraryRef | undefined,
  held: string | undefined,
): T {
  try {
    return start();
  } catch (e) {
    const misstamped =
      e instanceof Error &&
      e.message.includes('would erase it') &&
      held === 'user' &&
      lib?.type === 'group' &&
      ctx.config.libraryType === 'group' &&
      ctx.config.libraryId === lib.id;
    if (!misstamped) throw e;
    throw new Error(
      `${(e as Error).message}\n\n` +
        'One more possibility, specific to this install: older Zoteus versions stamped an index built on a ' +
        'group-default install (ZOTERO_LIBRARY_TYPE=group) as the personal library even though they crawled the ' +
        `configured group. If this index was built by one of those, its rows are group ${lib.id}'s rather than the ` +
        'personal library\'s, and deleting the index file and running action:"build" again restamps it correctly. ' +
        'Zoteus cannot tell the two apart once written, so it refuses rather than erase the wrong one.',
    );
  }
}

const indexTool: ToolDefinition = {
  name: 'zotero_index',
  title: 'Build the semantic search index',
  description:
    `Manage the local hybrid-search index used by zotero_semantic_search. Every job runs in the background on the server, so this tool returns immediately and never blocks on large libraries. THREE write actions, and picking the right one matters: \`action: "update"\` is the cheap one and should be the default for a library that is already indexed; \`action: "build"\` and \`action: "refresh"\` both rebuild the WHOLE index, which on a large library means many minutes and, with an API embedding provider, real spend (they differ in one thing: build resumes an interrupted build, refresh always starts over). \`action: "build"\`/"refresh" pages the library's top-level items (100-at-a-time, stopping at the server's item cap, ZOTEUS_INDEX_MAX_ITEMS, default ${DEFAULT_INDEX_MAX_ITEMS}, or at a smaller \`limit\` if one is given), indexes their text (title, abstract, creators, tags) for BM25 keyword search and, if an embedding provider is configured, for vector search, persisting partial progress atomically as it goes; use it for the first build, after changing the embedding model, or to widen a previously capped build. It is ALSO the repair: if the index cannot be read at all, only \`action:"build"\` clears it, by deleting the unreadable file and opening a fresh one before rebuilding (nothing repairs it at startup or inside a query). \`action: "update"\` instead fetches only the items changed since the version the index recorded (Zotero's \`?since=\`), re-chunks and re-embeds just those, and removes items the library no longer holds (diffed from a cheap keys-only \`?format=versions\` census, since the deletion log is cloud-only); untouched items are never re-embedded, so adding a handful of items costs seconds instead of a full rebuild. Update falls back to a full rebuild by itself, and says so in \`updateNotice\`, when a delta would be wrong: no version stamp recorded yet, the library is now served by a different Zotero API (the desktop app and the cloud number their versions independently), or the embedding model changed. An update ALSO asks Zotero's full-text index what it has extracted since the build (that is a separate version sequence from item versions, so a PDF Zotero extracted when it was first opened changes no item version and appears in no delta) and indexes the new body text for items nothing else touched; on a library where nothing was extracted, that costs one request. A build or update interrupted by \`action:"stop"\`, a crash or a restart leaves a checkpoint, and \`action: "build"\` RESUMES from it: the items already committed stay searchable and are never re-fetched or re-embedded, and only work since the last save is redone (\`resumedFrom\` on the status reports how many were inherited). \`action: "refresh"\` is the one that always starts over. A build also indexes the reader's OWN words by default: every child note, and every PDF annotation (its highlighted passage and its comment), as extra passages carrying the parent item's key — so \`zotero_annotate\` writes text that search can then find, an item with forty annotations still takes one result slot, and a hit whose snippet came from one is marked source:"note" or source:"annotation". That corpus is one paged crawl of hand-written text, orders of magnitude smaller than attachment bodies; turn it off with \`own_words:false\` or ZOTEUS_INDEX_OWN_WORDS=false. An \`action:"update"\` keeps it current for the cost of one request when nothing was written: notes and annotations are ordinary items carrying ordinary versions, so an edit, an addition and a deletion are all found by comparing the library's note/annotation keys against the ones the index holds — which is also how an index built before this existed fills its gap, once, on its first update. Set \`fulltext:true\` to ALSO index the body text Zotero extracted from each item's attachments, which is what makes semantic search match a claim buried in a PDF rather than only its title and abstract; it is off by default because it multiplies build time and index size (default cap: ${DEFAULT_FULLTEXT_MAX_CHARS} characters per item, tunable with \`fulltext_max_chars\`), and only attachments Zotero has already extracted are available. That pass used to be refused inside Claude Desktop, where a build that reached it killed the server process partway through with no error at all (#37); the cause was the on-device embedding model asking Electron's allocator for a block it will not serve, so the server now embeds fewer passages per call there and the build runs to completion. It is somewhat slower inside the app than in a terminal and produces exactly the same index, so a user who wants the fastest possible first build can still run one headlessly against the same ZOTEUS_DATA_DIR and let Desktop read the result. A build runs in TWO passes and reports which one it is on as \`phase\`: every item's metadata is indexed first, across the whole library, and only then are attachment bodies crawled (\`fulltextItemsScanned\` of \`fulltextItemsTotal\`). So the library is fully searchable on titles, abstracts, creators and tags long before a full-text crawl that can run for hours finishes — tell the user they can search already rather than asking them to wait for state:"done". Start a job, then POLL \`action: "status"\` every few seconds until \`state\` is "done" (or "error"); calling build or update again while one is running just returns current progress. \`action: "status"\` reports \`state\` (idle|building|done|error), \`operation\` (build|update), \`phase\` (metadata|fulltext), fetch/embed progress, \`itemsRemoved\`, index size, the active embedder, \`libraryVersion\`/\`libraryBackend\` (the version stamp an update diffs from), \`fulltextVersion\` (how far into Zotero's separate full-text sequence the index has read), \`fulltextPartial\` (present when the index's body text was gathered over an attachment map that never reached the end of the library, which is usually why that cursor is 0, though a delta can damage coverage an earlier pass had already earned a cursor for: an item holding body passages may still be missing an attachment's text, and the next update asked for full text re-reads every item Zotero's full-text census names, once, which on a large library costs a whole body crawl), \`resumedFrom\` (items inherited when a build resumed an interrupted one), \`itemsTotal\`/\`itemsAvailable\` (which differ, with a warning, when the cap stopped the crawl short of the library), \`ownWordsItems\`/\`ownWordsPassages\` (the notes and annotations indexed, with \`ownWordsReason\` if they could not be read), and (when full text was requested) \`fulltextItems\`/\`fulltextPassages\` plus \`fulltextReason\` if it produced nothing, or if an update could not read part of the body text and therefore withheld its version stamp (or its full-text cursor) so the next update retries. It also reports \`localApiDegradedAt\` when the job saturated Zotero's local API and the whole session fell back to the Zotero Web API: that fallback works, so nothing errors, but the Web API is slower and rate-limited and the rest of the build takes far longer than its start suggested, so tell the user rather than letting them watch an unexplained slowdown (the crawl also backs off to one attachment at a time by itself, to let the app recover). It reports where the index is stored (\`storage\`: sqlite or memory, set by ZOTEUS_INDEX_BACKEND), \`storageNotice\` when opening that store imported or refused an older JSON index, \`persistError\` when the index could not be written to disk at all, and how the last semantic query ranked vectors (\`vectorScan\`: "codes" for the two-stage path, "exact" for a full scan of every vector, with \`vectorScanNotice\` when that needs explaining). When the embedding provider is a paid API with a tokens-per-minute limit (ZOTEUS_EMBEDDINGS=openai or gemini), status also reports \`embedRate\`: the batch size, the pause between requests, the estimated tokens per request and the tokens per minute the build is actually sustaining, plus \`passagesWithoutVectors\` when the index holds passages nothing has embedded yet. A build whose embedder was rate-limited to a standstill keeps every passage it indexed and stays RESUMABLE: tell the user to run \`action:"build"\` again, which embeds only the passages that have no vector and re-fetches nothing, and NOT \`action:"refresh"\`, which starts the whole crawl over and pays for every vector a second time. A rate-limited request already backs off and retries by itself; if a build reports it is riding the provider's tokens-per-minute limit, the fix is ZOTEUS_EMBED_BATCH_DELAY_MS (with ZOTEUS_EMBED_BATCH_SIZE), not a smaller library. \`action: "stop"\` cancels a running job (partial data is kept and stays searchable; a stopped update leaves the version stamp untouched so the next one repeats the delta, and a stopped build leaves a checkpoint the next \`action:"build"\` resumes from). \`stop\` is a one-shot cancel: the next \`action:"build"\` picks the checkpoint straight back up. \`action: "pause"\` is the durable form: it stops a running job the same way AND persists a hold that survives restarts, so \`build\`, \`refresh\`, \`update\` and zotero_semantic_search's automatic first build all refuse until \`action: "resume"\` clears it (queries keep working on what is indexed). \`resume\` clears the hold and starts nothing by itself, so follow it with \`build\` to continue a checkpoint or \`update\` for a delta; \`status\` reports \`paused\`. A partially built index is always usable for keyword search. Local embeddings are CPU-bound (see ZOTEUS_EMBEDDINGS), so large builds take a while: poll status rather than retrying build. ONE INDEX FILE HOLDS ONE LIBRARY, and \`library_type\`/\`library_id\` therefore pick the FILE, not just the crawl: naming a group builds, updates and reports THAT group's own index, kept beside the personal library's, and the two never mix (passage ids carry no library and Zotero item keys repeat across libraries, so one store holding two would alias them). Omitting them means the library this server is configured for. \`action: "libraries"\` lists every library that has an index in this data directory with its passage/item/vector counts, its stamp and where its file is; it starts nothing and creates nothing, and neither does \`action:"status"\` for a library that has no index yet (it says so instead). Only a bounded number of indexes are held open at once (ZOTEUS_INDEX_MAX_OPEN, default 4); the least recently used is saved and closed to make room, which costs a reopen and nothing else. To search across several libraries at once, use zotero_semantic_search's \`libraries\` argument, which fans out over their indexes and labels each hit with the library it came from.`,
  inputSchema: {
    action: z
      .enum(['build', 'refresh', 'update', 'status', 'stop', 'pause', 'resume', 'libraries'])
      .describe(
        'What to do. "update" is the cheap delta and the right default for an indexed library; "build" rebuilds (resuming an interrupted build) and "refresh" always starts over; "status" polls progress; "stop" cancels a running job; "pause"/"resume" hold index work across restarts; "libraries" lists which libraries have an index here, with their sizes (it starts nothing, and reports every library rather than the one library_type/library_id would name).',
      ),
    ...libraryArgs,
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Max items to index. Lowers the configured cap for this build only; it cannot raise it. ' +
          `The cap defaults to ${DEFAULT_INDEX_MAX_ITEMS} and is set by ZOTEUS_INDEX_MAX_ITEMS.`,
      ),
    own_words: z
      .boolean()
      .optional()
      .describe(
        "Also index the reader's OWN words — child notes and PDF annotations (highlight text and comments) — as " +
          "passages carrying the parent item's key. On by default (ZOTEUS_INDEX_OWN_WORDS); the whole corpus is one " +
          'paged crawl of hand-written text, so it costs a fraction of what fulltext does.',
      ),
    fulltext: z
      .boolean()
      .optional()
      .describe(
        'Also index the full text Zotero extracted from each item\'s attachments, so searches match the body of a PDF. ' +
          'Resource-intensive (slower build, much larger index); defaults to ZOTEUS_INDEX_FULLTEXT (off unless set).',
      ),
    fulltext_max_chars: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .optional()
      .describe(
        `Cap on indexed full-text characters per item; 0 means no cap (default ${DEFAULT_FULLTEXT_MAX_CHARS}). Only used with fulltext.`,
      ),
  },
  outputSchema: z
    .object({
      ...indexStatus,
      repaired: z
        .unknown()
        .optional()
        .describe('What an unreadable index had to have removed before this build could start.'),
      libraries: z
        .array(
          z.object({
            library: z.string().describe('Canonical token of the library this index holds: "user" or "group:<id>".'),
            label: z.string().describe('The same library in words: "the personal library" or "group 4523".'),
            path: z.string().describe('Absolute path of the index file (the SQLite database sits beside it).'),
            primary: z
              .boolean()
              .describe('True for the default library\'s index, the one a call that names no library uses.'),
            stamp: z
              .string()
              .optional()
              .describe(
                "The store's own library stamp. Absent on an index built before the stamp existed, which guards nothing.",
              ),
            documents: z.number().describe('Passages held for keyword search.'),
            items: z.number().describe('Library items represented in this index.'),
            vectors: z.number().describe('Passages that also carry an embedding.'),
            state: z.string().describe('Lifecycle of this index\'s own job: "idle", "building", "done" or "error".'),
            vectorEmbedder: z
              .string()
              .optional()
              .describe(
                'Identity of the vectors this index HOLDS, absent when it holds none. Two indexes with different ' +
                  'values were embedded by different models, so their scores are not comparable.',
              ),
            libraryVersion: z.number().describe('Zotero library version it was last built or updated from (0 = none).'),
            fault: z.string().optional().describe('Why this index could not be opened or read at all.'),
          }),
        )
        .optional()
        .describe('Every library with an index in this data directory (action:"libraries").'),
    })
    .passthrough(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    if (args.action === 'libraries') {
      // Without a registry there is exactly one index and it is `ctx.search`, so report
      // that one rather than pretending the question cannot be answered.
      if (!ctx.indexes) {
        const s = ctx.search.buildStatus();
        const library = s.library ?? 'user';
        const denied = unreachableIndexLibrary(ctx, library);
        if (denied) return { content: [{ type: 'text', text: denied }], isError: true };
        const row = {
          library,
          label: describeLibraryToken(library),
          path: ctx.searchIndexPath,
          primary: true,
          ...(s.library ? { stamp: s.library } : {}),
          documents: s.documents,
          items: s.items,
          vectors: s.vectors,
          state: s.state,
          ...(ctx.search.vectorEmbedderId ? { vectorEmbedder: ctx.search.vectorEmbedderId } : {}),
          libraryVersion: s.libraryVersion,
          ...(ctx.search.storeFault ? { fault: ctx.search.storeFault.message } : {}),
        };
        return ok({ libraries: [row] }, librariesSummary([row]));
      }
      const rows: LibraryRow[] = (await ctx.indexes.list()).map((row) => {
        const why = unreachableIndexLibrary(ctx, row.library) ?? unreachableIndexLibrary(ctx, row.stamp);
        return why ? { ...row, unreachable: why } : row;
      });
      const fallback = ctx.router?.defaultLibrary?.();
      return ok({ libraries: rows }, librariesSummary(rows, fallback ? canonicalLibraryToken(fallback) : undefined));
    }

    // Which index this call is about. `library_type`/`library_id` pick the FILE: one store
    // holds one library's rows, so a group has its own index beside the default library's.
    const { lib, library, index, refusal } = await targetIndex(ctx, args);
    if (refusal) {
      return {
        content: [{ type: 'text' as const, text: refusal }],
        structuredContent: { library },
        isError: true,
      };
    }
    if (!index) {
      // A read-only action about a library with no index here. Answering by creating an
      // empty one would leave a file behind for a question.
      return {
        content: [{ type: 'text' as const, text: noIndexYet(ctx, library) }],
        structuredContent: { library },
        isError: true,
      };
    }

    if (args.action === 'status') {
      const s = index.buildStatus();
      return ok({ ...s }, statusSummary(s));
    }
    if (args.action === 'stop') {
      const stopped = index.requestStop();
      if (stopped) {
        return ok(
          { ...index.buildStatus() },
          'Stop requested — the build halts after the current page/batch and keeps the partial index. Poll action:"status".',
        );
      }
      return ok({ ...index.buildStatus() }, 'No build is currently running.');
    }
    if (args.action === 'pause') {
      // Set the in-memory hold before asking the running loop to stop, then persist it.
      // This also works while idle, which requestStop() alone deliberately cannot do.
      const persistence = index.setPaused(true);
      const stopped = index.requestStop();
      await persistence;
      return ok(
        { ...index.buildStatus() },
        stopped
          ? 'Index work is paused. The running job will stop after its current page or batch; the hold survives restarts.'
          : 'Index work is paused. The hold survives restarts; build, refresh, and update will refuse until resumed.',
      );
    }
    if (args.action === 'resume') {
      await index.setPaused(false);
      return ok(
        { ...index.buildStatus() },
        'Index work is no longer paused. No job was started; call action:"build" or action:"update" explicitly.',
      );
    }

    if (index.isPaused) {
      const s = index.buildStatus();
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Index work is paused. Call zotero_index action:"resume" before build, refresh, or update.',
          },
        ],
        structuredContent: { ...s },
        isError: true,
      };
    }

    // build / refresh / update: kick off a background job and return immediately.
    //
    // An unreadable index is repaired here and nowhere else. `action:"build"` is consent:
    // the caller has asked for the whole library to be re-read, so deleting the derived
    // cache first is part of what they asked for. `action:"update"` is not — it is the
    // cheap call, and it cannot run against a store it cannot read anyway (#21).
    const fault = index.storeFault;
    if (fault && args.action === 'update') {
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `${fault.message}\n\nAn incremental update cannot repair this: it needs the existing index to diff ` +
              'against. Call zotero_index with action:"build" instead, which replaces the index and rebuilds it.',
          },
        ],
        isError: true,
      };
    }
    let repaired: RepairReport | undefined;
    if (fault) {
      // The in-product repair replaces the index the CONTEXT holds, which is the default
      // library's. A second library's unreadable index is not repaired here: deleting the
      // wrong file would be worse than refusing, so say which file to remove and stop.
      if (index !== ctx.search) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `${fault.message}\n\nThis is ${describeLibraryToken(library)}'s own index file, and zotero_index ` +
                'repairs only the default library\'s automatically. Delete the file(s) named above by hand and run ' +
                'this build again, which opens a fresh index in their place.',
            },
          ],
          structuredContent: { library },
          isError: true,
        };
      }
      try {
        repaired = await repairSearchIndex(ctx);
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }],
          isError: true,
        };
      }
    }
    // A repair replaces the object the context holds, so re-read it rather than going on
    // with the faulted one this handler opened with.
    const store = repaired ? ctx.search : index;

    if (store.isBuilding) {
      const s = store.buildStatus();
      return ok(
        { ...s },
        `A build is already in progress — ${progressLine(s)}. Poll action:"status" instead of starting another build.`,
      );
    }
    const maxItems = Math.min(args.limit ?? ctx.config.indexMaxItems, ctx.config.indexMaxItems);
    const fulltext = args.fulltext ?? ctx.config.indexFulltext;
    const ownWords = args.own_words ?? ctx.config.indexOwnWords;
    // `refresh` is the one that starts over. `build` resumes an interrupted build where one
    // is on disk, because discarding committed, already-embedded work is what #24 is about.
    const opts = { fulltext, ownWords, fulltextMaxChars: args.fulltext_max_chars, fresh: args.action === 'refresh' };
    // Read before either starter runs, because a build's prologue clears the store
    // synchronously: this is both the stamp the guard is about to compare against and the
    // size of the index a rebuild replaces.
    const before = store.buildStatus();
    if (args.action === 'update') {
      const s = startGuarded(() => startIndexUpdate(ctx, lib, maxItems, opts, store), ctx, lib, before.library);
      // The status already says whether this became a rebuild, and why, so the summary
      // must not promise a delta the update path may have refused: report what started.
      const kind =
        s.operation === 'update' ? 'Index update' : s.resumedFrom ? 'Interrupted index build resumed' : 'Full index rebuild';
      return ok(
        { ...s },
        `${kind} started in the background.${updateNotice(s)} ` +
          'Poll zotero_index action:"status" every few seconds until state is "done"; use action:"stop" to cancel.' +
          // Said where the second crawl is started, not only in the search that reads the
          // other file: this is the moment it can still be stopped.
          stampSplitNotice(ctx, library),
      );
    }
    // `before` (read above) is what makes the next sentence possible: a build over an index
    // that already holds rows is a rebuild, and it replaces them at its first commit. Said
    // here, when it can still be stopped, rather than learned the way #59 learned it: from
    // a build that aborted and left a 1,300-item partial index where a complete
    // 97,000-passage one had been.
    const s = startGuarded(() => startIndexBuild(ctx, lib, maxItems, opts, store), ctx, lib, before.library);
    const replaces =
      !s.resumedFrom && before.documents > 0
        ? ` This REPLACES the existing index (${before.documents} passages over ${before.items} items) from its` +
          ' first commit: the library is searchable on what the new build has indexed so far, and a build that' +
          ' stops or fails leaves that partial index plus a checkpoint the next action:"build" resumes from.' +
          ' For an index that is already complete, action:"update" is the incremental path and leaves it in place.'
        : '';
    const ftNote = fulltext
      ? ' Attachment full text is included, so expect a noticeably longer build and a larger index; every item\'s' +
        ' metadata is indexed first, so the library becomes searchable well before the full-text pass finishes.'
      : '';
    // Said outright rather than left for the user to infer from a build that suddenly works:
    // files were deleted on their behalf, and they should know which.
    // `removed` can legitimately be empty: every file the fault named was already gone, so
    // there was nothing to delete and the reopen alone was the repair. Saying "removed ()"
    // there would be both ugly and untrue.
    const repairNote = repaired
      ? repaired.removed.length
        ? `The unreadable index was removed first (${repaired.removed.join(', ')}) and a fresh ${repaired.storage} index opened in its place. `
        : `The unreadable index was replaced with a fresh ${repaired.storage} one (its files were already gone). `
      : '';
    // A resume is decided in the build's synchronous prologue, so the status this starter
    // returns already knows. Saying "build started (up to 5000 items)" over a build that
    // is continuing 3200 already-indexed ones is the report #24 was filed against.
    const started = s.resumedFrom
      ? `Interrupted index build RESUMED in the background: ${s.resumedFrom} items were already indexed and are ` +
        'kept, not re-embedded.'
      : `Index build started in the background (up to ${maxItems} items).`;
    return ok(
      { ...s, ...(repaired ? { repaired: repaired.removed } : {}) },
      `${repairNote}${started}${replaces}${ftNote} ` +
        'Poll zotero_index action:"status" every few seconds until state is "done"; use action:"stop" to cancel.' +
        stampSplitNotice(ctx, library),
    );
  },
};

export default indexTool;
