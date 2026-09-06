import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { ok } from '../registry/registry.js';
import {
  progressLine,
  startIndexBuild,
  startIndexUpdate,
  statusSummary,
  updateNotice,
} from '../features/search/build.js';
import { repairSearchIndex, type RepairReport } from '../features/search/repair.js';
import { DEFAULT_FULLTEXT_MAX_CHARS } from '../features/search/fulltext-source.js';
import { DEFAULT_INDEX_MAX_ITEMS } from '../features/search/limits.js';
import type { LibraryRef } from '../api/web-client.js';

const indexTool: ToolDefinition = {
  name: 'zotero_index',
  title: 'Build the semantic search index',
  description:
    `Manage the local hybrid-search index used by zotero_semantic_search. Every job runs in the background on the server, so this tool returns immediately and never blocks on large libraries. THREE write actions, and picking the right one matters: \`action: "update"\` is the cheap one and should be the default for a library that is already indexed; \`action: "build"\` and \`action: "refresh"\` both rebuild the WHOLE index, which on a large library means many minutes and, with an API embedding provider, real spend (they differ in one thing: build resumes an interrupted build, refresh always starts over). \`action: "build"\`/"refresh" pages the library's top-level items (100-at-a-time, stopping at the server's item cap, ZOTEUS_INDEX_MAX_ITEMS, default ${DEFAULT_INDEX_MAX_ITEMS}, or at a smaller \`limit\` if one is given), indexes their text (title, abstract, creators, tags) for BM25 keyword search and, if an embedding provider is configured, for vector search, persisting partial progress atomically as it goes; use it for the first build, after changing the embedding model, or to widen a previously capped build. It is ALSO the repair: if the index cannot be read at all, only \`action:"build"\` clears it, by deleting the unreadable file and opening a fresh one before rebuilding (nothing repairs it at startup or inside a query). \`action: "update"\` instead fetches only the items changed since the version the index recorded (Zotero's \`?since=\`), re-chunks and re-embeds just those, and removes items the library no longer holds (diffed from a cheap keys-only \`?format=versions\` census, since the deletion log is cloud-only); untouched items are never re-embedded, so adding a handful of items costs seconds instead of a full rebuild. Update falls back to a full rebuild by itself, and says so in \`updateNotice\`, when a delta would be wrong: no version stamp recorded yet, the library is now served by a different Zotero API (the desktop app and the cloud number their versions independently), or the embedding model changed. An update ALSO asks Zotero's full-text index what it has extracted since the build (that is a separate version sequence from item versions, so a PDF Zotero extracted when it was first opened changes no item version and appears in no delta) and indexes the new body text for items nothing else touched; on a library where nothing was extracted, that costs one request. A build or update interrupted by \`action:"stop"\`, a crash or a restart leaves a checkpoint, and \`action: "build"\` RESUMES from it: the items already committed stay searchable and are never re-fetched or re-embedded, and only work since the last save is redone (\`resumedFrom\` on the status reports how many were inherited). \`action: "refresh"\` is the one that always starts over. A build also indexes the reader's OWN words by default: every child note, and every PDF annotation (its highlighted passage and its comment), as extra passages carrying the parent item's key — so \`zotero_annotate\` writes text that search can then find, an item with forty annotations still takes one result slot, and a hit whose snippet came from one is marked source:"note" or source:"annotation". That corpus is one paged crawl of hand-written text, orders of magnitude smaller than attachment bodies; turn it off with \`own_words:false\` or ZOTEUS_INDEX_OWN_WORDS=false. An \`action:"update"\` keeps it current for the cost of one request when nothing was written: notes and annotations are ordinary items carrying ordinary versions, so an edit, an addition and a deletion are all found by comparing the library's note/annotation keys against the ones the index holds — which is also how an index built before this existed fills its gap, once, on its first update. Set \`fulltext:true\` to ALSO index the body text Zotero extracted from each item's attachments, which is what makes semantic search match a claim buried in a PDF rather than only its title and abstract; it is off by default because it multiplies build time and index size (default cap: ${DEFAULT_FULLTEXT_MAX_CHARS} characters per item, tunable with \`fulltext_max_chars\`), and only attachments Zotero has already extracted are available. That pass used to be refused inside Claude Desktop, where a build that reached it killed the server process partway through with no error at all (#37); the cause was the on-device embedding model asking Electron's allocator for a block it will not serve, so the server now embeds fewer passages per call there and the build runs to completion. It is somewhat slower inside the app than in a terminal and produces exactly the same index, so a user who wants the fastest possible first build can still run one headlessly against the same ZOTEUS_DATA_DIR and let Desktop read the result. A build runs in TWO passes and reports which one it is on as \`phase\`: every item's metadata is indexed first, across the whole library, and only then are attachment bodies crawled (\`fulltextItemsScanned\` of \`fulltextItemsTotal\`). So the library is fully searchable on titles, abstracts, creators and tags long before a full-text crawl that can run for hours finishes — tell the user they can search already rather than asking them to wait for state:"done". Start a job, then POLL \`action: "status"\` every few seconds until \`state\` is "done" (or "error"); calling build or update again while one is running just returns current progress. \`action: "status"\` reports \`state\` (idle|building|done|error), \`operation\` (build|update), \`phase\` (metadata|fulltext), fetch/embed progress, \`itemsRemoved\`, index size, the active embedder, \`libraryVersion\`/\`libraryBackend\` (the version stamp an update diffs from), \`fulltextVersion\` (how far into Zotero's separate full-text sequence the index has read), \`resumedFrom\` (items inherited when a build resumed an interrupted one), \`itemsTotal\`/\`itemsAvailable\` (which differ, with a warning, when the cap stopped the crawl short of the library), \`ownWordsItems\`/\`ownWordsPassages\` (the notes and annotations indexed, with \`ownWordsReason\` if they could not be read), and (when full text was requested) \`fulltextItems\`/\`fulltextPassages\` plus \`fulltextReason\` if it produced nothing. It also reports \`localApiDegradedAt\` when the job saturated Zotero's local API and the whole session fell back to the Zotero Web API: that fallback works, so nothing errors, but the Web API is slower and rate-limited and the rest of the build takes far longer than its start suggested, so tell the user rather than letting them watch an unexplained slowdown (the crawl also backs off to one attachment at a time by itself, to let the app recover). It reports where the index is stored (\`storage\`: sqlite or memory, set by ZOTEUS_INDEX_BACKEND), \`storageNotice\` when opening that store imported or refused an older JSON index, \`persistError\` when the index could not be written to disk at all, and how the last semantic query ranked vectors (\`vectorScan\`: "codes" for the two-stage path, "exact" for a full scan of every vector, with \`vectorScanNotice\` when that needs explaining). When the embedding provider is an API (ZOTEUS_EMBEDDINGS=openai or gemini), status also reports \`embedRate\`: the batch size, the pause between requests, the estimated tokens per request and the tokens per minute the build is actually sustaining, plus \`passagesWithoutVectors\` when the index holds passages nothing has embedded yet. A build whose embedder was rate-limited to a standstill keeps every passage it indexed and stays RESUMABLE: tell the user to run \`action:"build"\` again, which embeds only the passages that have no vector and re-fetches nothing, and NOT \`action:"refresh"\`, which starts the whole crawl over and pays for every vector a second time. A rate-limited request already backs off and retries by itself; if a build reports it is riding the provider's tokens-per-minute limit, the fix is ZOTEUS_EMBED_BATCH_DELAY_MS (with ZOTEUS_EMBED_BATCH_SIZE), not a smaller library. \`action: "stop"\` cancels a running job (partial data is kept and stays searchable; a stopped update leaves the version stamp untouched so the next one repeats the delta, and a stopped build leaves a checkpoint the next \`action:"build"\` resumes from). \`stop\` is a one-shot cancel: the next \`action:"build"\` picks the checkpoint straight back up. \`action: "pause"\` is the durable form: it stops a running job the same way AND persists a hold that survives restarts, so \`build\`, \`refresh\`, \`update\` and zotero_semantic_search's automatic first build all refuse until \`action: "resume"\` clears it (queries keep working on what is indexed). \`resume\` clears the hold and starts nothing by itself, so follow it with \`build\` to continue a checkpoint or \`update\` for a delta; \`status\` reports \`paused\`. A partially built index is always usable for keyword search. Local embeddings are CPU-bound (see ZOTEUS_EMBEDDINGS), so large builds take a while: poll status rather than retrying build.`,
  inputSchema: {
    action: z.enum(['build', 'refresh', 'update', 'status', 'stop', 'pause', 'resume']),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
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
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    if (args.action === 'status') {
      const s = ctx.search.buildStatus();
      return ok({ ...s }, statusSummary(s));
    }
    if (args.action === 'stop') {
      const stopped = ctx.search.requestStop();
      if (stopped) {
        return ok(
          { ...ctx.search.buildStatus() },
          'Stop requested — the build halts after the current page/batch and keeps the partial index. Poll action:"status".',
        );
      }
      return ok({ ...ctx.search.buildStatus() }, 'No build is currently running.');
    }
    if (args.action === 'pause') {
      // Set the in-memory hold before asking the running loop to stop, then persist it.
      // This also works while idle, which requestStop() alone deliberately cannot do.
      const persistence = ctx.search.setPaused(true);
      const stopped = ctx.search.requestStop();
      await persistence;
      return ok(
        { ...ctx.search.buildStatus() },
        stopped
          ? 'Index work is paused. The running job will stop after its current page or batch; the hold survives restarts.'
          : 'Index work is paused. The hold survives restarts; build, refresh, and update will refuse until resumed.',
      );
    }
    if (args.action === 'resume') {
      await ctx.search.setPaused(false);
      return ok(
        { ...ctx.search.buildStatus() },
        'Index work is no longer paused. No job was started; call action:"build" or action:"update" explicitly.',
      );
    }

    if (ctx.search.isPaused) {
      const s = ctx.search.buildStatus();
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
    const fault = ctx.search.storeFault;
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
      try {
        repaired = await repairSearchIndex(ctx);
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }],
          isError: true,
        };
      }
    }

    if (ctx.search.isBuilding) {
      const s = ctx.search.buildStatus();
      return ok(
        { ...s },
        `A build is already in progress — ${progressLine(s)}. Poll action:"status" instead of starting another build.`,
      );
    }
    const lib: LibraryRef | undefined = args.library_id
      ? { type: (args.library_type ?? 'group') as 'user' | 'group', id: args.library_id }
      : undefined;
    const maxItems = Math.min(args.limit ?? ctx.config.indexMaxItems, ctx.config.indexMaxItems);
    const fulltext = args.fulltext ?? ctx.config.indexFulltext;
    const ownWords = args.own_words ?? ctx.config.indexOwnWords;
    // `refresh` is the one that starts over. `build` resumes an interrupted build where one
    // is on disk, because discarding committed, already-embedded work is what #24 is about.
    const opts = { fulltext, ownWords, fulltextMaxChars: args.fulltext_max_chars, fresh: args.action === 'refresh' };
    if (args.action === 'update') {
      const s = startIndexUpdate(ctx, lib, maxItems, opts);
      // The status already says whether this became a rebuild, and why, so the summary
      // must not promise a delta the update path may have refused: report what started.
      const kind =
        s.operation === 'update' ? 'Index update' : s.resumedFrom ? 'Interrupted index build resumed' : 'Full index rebuild';
      return ok(
        { ...s },
        `${kind} started in the background.${updateNotice(s)} ` +
          'Poll zotero_index action:"status" every few seconds until state is "done"; use action:"stop" to cancel.',
      );
    }
    const s = startIndexBuild(ctx, lib, maxItems, opts);
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
      `${repairNote}${started}${ftNote} ` +
        'Poll zotero_index action:"status" every few seconds until state is "done"; use action:"stop" to cancel.',
    );
  },
};

export default indexTool;
