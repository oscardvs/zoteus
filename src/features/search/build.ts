import type { ToolContext } from '../../registry/registry.js';
import type { LibraryRef } from '../../api/web-client.js';
import type { EmbedRate, IndexBuildStatus, VersionBackend } from './backend.js';
import { canonicalLibraryToken } from './backend.js';
import { createFulltextSource, type FulltextSource } from './fulltext-source.js';
import { createOwnWordsSource, fetchChildVersions, type OwnWordsSource } from './own-words-source.js';
import {
  DEFAULT_FULLTEXT_CONCURRENCY_CLOUD,
  DEFAULT_FULLTEXT_CONCURRENCY_LOCAL,
  DEFAULT_INDEX_MAX_ITEMS,
} from './limits.js';

/**
 * Default cap on items per build — keeps very large libraries bounded. Re-exported from
 * `limits.ts`; raise it at runtime with `ZOTEUS_INDEX_MAX_ITEMS`.
 *
 * @deprecated Read `ctx.config.indexMaxItems` instead: this is the default, not the cap
 * in force. Kept so existing importers still resolve.
 */
export const MAX_ITEMS = DEFAULT_INDEX_MAX_ITEMS;
/** Both Zotero APIs (cloud Web API and desktop local API) page items 100-at-a-time. */
export const PAGE_SIZE = 100;

/**
 * Page size for the `?format=versions` census an update diffs deletions against. Far larger
 * than PAGE_SIZE because the rows are a key and an integer, not item bodies, and the
 * endpoint commonly answers with the whole library at once. The loop advances by what came
 * back rather than by this number, so a server that caps the page still pages correctly.
 */
export const VERSIONS_PAGE_SIZE = 5000;

/** Ceiling on those pages, so a pathological library cannot page forever. */
const MAX_VERSION_PAGES = 200;

/**
 * One-line progress summary shared by tool messages, status output and the server build
 * log, which must not diverge: a log reading `5000/5000` beside tool output reading
 * `5000 of 12000` invites the conclusion that one of them is wrong. The library total is
 * spelled out rather than appended after a second slash, which made one line carry two
 * different senses of "/".
 */
export function progressLine(s: IndexBuildStatus): string {
  // Suppressed while a build is still on its metadata pass: full text is not being
  // collected yet, and "full text of 0 items (0 passages)" beside a climbing item count
  // reads as a full-text crawl that has stalled rather than one that has not started.
  const showFulltext = s.fulltextEnabled && !(s.operation === 'build' && s.state === 'building' && s.phase === 'metadata');
  const fulltext = showFulltext ? `, full text of ${s.fulltextItems} items (${s.fulltextPassages} passages)` : '';
  // An update's itemsFetched is the size of the delta, not progress through the library, so
  // rendering it as "7 of 5000" would read as a build that stalled on its first page.
  if (s.operation === 'update') {
    return `${s.itemsFetched} changed items re-indexed, ${s.itemsRemoved} removed, ${s.items} items total, ${s.passages} passages, ${s.vectors} vectors${fulltext} (embedder=${s.embedder})`;
  }
  // The full-text pass has finished walking the library, so counting items fetched out of
  // items total would sit at 100% for however long the body crawl runs. Count what is
  // actually moving instead (#23).
  if (s.phase === 'fulltext') {
    return `metadata indexed for ${s.items} items; full text ${s.fulltextItemsScanned} of ${s.fulltextItemsTotal} items scanned (${s.fulltextItems} with text, ${s.fulltextPassages} passages), ${s.passages} passages, ${s.vectors} vectors (embedder=${s.embedder})`;
  }
  const total = s.itemsTotal > 0 ? String(s.itemsTotal) : '?';
  const library = s.itemsAvailable > s.itemsTotal ? ` (${s.itemsAvailable} in library)` : '';
  return `${s.itemsFetched} of ${total} items indexed${library}, ${s.passages} passages, ${s.vectors} vectors${fulltext} (embedder=${s.embedder})`;
}

/**
 * Sentence appended whenever the configured embedder is not the effective one. Without it
 * a keyword-only index is indistinguishable from a healthy one, which is exactly how a
 * missing optional dependency stayed invisible through two clean builds (#7).
 */
export function embedderNotice(s: IndexBuildStatus): string {
  if (s.embedderActive || s.embedderConfigured === 'off') return '';
  return ` Semantic ranking is OFF (embeddings=${s.embedderConfigured} requested but not active): ${s.embedderReason ?? 'unavailable'}`;
}

/**
 * Sentence appended when the reader's own words were asked for and could not be read. Same
 * reasoning as `fulltextNotice`: an index silently missing the one part of a library
 * nobody else wrote looks exactly like one that holds it (#33).
 */
export function ownWordsNotice(s: IndexBuildStatus): string {
  return s.ownWordsReason ? ` ${s.ownWordsReason}` : '';
}

/**
 * Sentence appended when full-text indexing was asked for but produced nothing. Same
 * reasoning as `embedderNotice`: an index that silently fell back to metadata is
 * indistinguishable from a healthy one, and the user would go on believing PDF bodies
 * are searchable.
 */
export function fulltextNotice(s: IndexBuildStatus): string {
  if (!s.fulltextEnabled || !s.fulltextReason) return '';
  return ` Full-text indexing produced nothing: ${s.fulltextReason}`;
}

/**
 * Sentence appended when the vectors an earlier build persisted were produced by a different
 * embedder than the one now configured, and were therefore dropped on load. Same reasoning as
 * `embedderNotice`: without it, switching ZOTEUS_EMBEDDING_MODEL turns a healthy index into a
 * keyword-only one with no explanation, and the fix (one rebuild) is not obvious.
 */
export function staleVectorsNotice(s: IndexBuildStatus): string {
  return s.vectorsStaleReason ? ` ${s.vectorsStaleReason}` : '';
}

/**
 * Sustained tokens per minute above which a build is told to slow itself down.
 *
 * Not a provider's published limit, and deliberately below the lowest one that matters:
 * OpenAI allows 1,000,000 tokens/min for text-embedding-3-small on Tier 2, and #48 shows
 * what happens to a build that sits exactly on it, which is that natural variance in
 * request size puts it over and the whole job dies on the 429. 800k leaves room for that
 * variance and still lets an unthrottled build on a smaller library say nothing at all.
 */
export const EMBED_TPM_HINT = 800_000;

/**
 * Per-request token estimate above which the batch is called out on its own account.
 * OpenAI rejects a request over 300,000 tokens whole, with a 400 no retry can help; this is
 * close enough to say so before the build finds out.
 */
export const EMBED_TOKENS_PER_REQUEST_HINT = 250_000;

/** Thousands separators, without a locale: the same string on every machine and in tests. */
function grouped(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * The pacing a build is embedding at, in one line, for the server log at the start of the
 * full-text pass and for anything else that has to explain the rate.
 *
 * This is the arithmetic the reporter of #48 had to do by hand, from the provider's
 * dashboard and a reading of `dist/config.js`, to discover that their build was sitting on
 * OpenAI's tokens-per-minute ceiling. It costs one log line to hand it over.
 */
export function embedRateLine(r: EmbedRate): string {
  const pace =
    r.delayMs > 0
      ? `a ${r.delayMs} ms pause between requests`
      : 'no pause between requests (ZOTEUS_EMBED_BATCH_DELAY_MS=0), so the rate is set only by how fast the provider answers';
  const measured = r.tokensPerMinute ? `; measured at ${grouped(r.tokensPerMinute)} tokens/min so far` : '';
  return (
    `${r.batchSize} passages per request (ZOTEUS_EMBED_BATCH_SIZE), about ${grouped(r.tokensPerRequest)} ` +
    `tokens each, with ${pace}${measured}`
  );
}

/**
 * Sentence appended when a build is embedding fast enough to be throttled, or in batches
 * large enough to be rejected outright.
 *
 * Only when there is something to act on. A build well under the limits should not be
 * lectured about rate limits it will never meet, which is why the plain arithmetic goes to
 * the log and only the verdict comes here.
 */
export function embedRateNotice(s: IndexBuildStatus): string {
  const r = s.embedRate;
  if (!r) return '';
  const parts: string[] = [];
  if (r.tokensPerRequest > EMBED_TOKENS_PER_REQUEST_HINT) {
    parts.push(
      `Each embedding request carries about ${grouped(r.tokensPerRequest)} tokens, near the 300,000 OpenAI ` +
        'rejects outright with a 400 that no retry can help: lower ZOTEUS_EMBED_BATCH_SIZE.',
    );
  }
  if (r.tokensPerMinute && r.tokensPerMinute >= EMBED_TPM_HINT) {
    parts.push(
      `This build is embedding at about ${grouped(r.tokensPerMinute)} tokens/min, at or near the ` +
        '1,000,000 tokens/min OpenAI allows text-embedding-3-small on Tier 2, where a build gets rate-limited ' +
        'whatever its tier, because request sizes vary around the ceiling. Pace it with ' +
        'ZOTEUS_EMBED_BATCH_DELAY_MS (8000, with ZOTEUS_EMBED_BATCH_SIZE=256, holds a large full-text build ' +
        'near 400,000 tokens/min).',
    );
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

/**
 * Sentence appended when the index holds passages nothing has embedded yet.
 *
 * The half of #48 that no existing notice covered. When an embedder failed partway through
 * a full-text build, status reported `embedder=none` and nothing else, which reads as an
 * index with no vectors when in fact it had 53,000 of the 87,000 it wanted; and the obvious
 * next move, `action:"refresh"`, is the one that throws all 53,000 away and buys them
 * again. So this says the number, and names the action that finishes the job instead.
 *
 * Suppressed while a build is running: a healthy build always has a batch or two queued,
 * and reporting that as a shortfall would put a warning on every progress poll.
 */
export function unembeddedNotice(s: IndexBuildStatus): string {
  if (!s.passagesWithoutVectors || s.state === 'building') return '';
  return (
    ` ${s.passagesWithoutVectors} indexed passage(s) carry no vector yet, so semantic ranking cannot see them` +
    ' (keyword search can). Run zotero_index action:"build" again to fill them in: when a build is what left' +
    ' them, that RESUMES it, embedding exactly those passages and re-fetching nothing. Do NOT use' +
    ' action:"refresh", which starts the whole crawl over and pays for every vector a second time. If an API' +
    ' rate limit is what stopped it, pace the next run with ZOTEUS_EMBED_BATCH_SIZE and' +
    ' ZOTEUS_EMBED_BATCH_DELAY_MS.'
  );
}

/**
 * Sentence appended when the build limit stopped the crawl short of the library. Same
 * reasoning as `embedderNotice` and `fulltextNotice`: without it a capped build reports
 * complete coverage, so a search that finds nothing in the unindexed remainder is
 * indistinguishable from a search over a library that holds nothing on the subject.
 *
 * The advice names both dials because the limit in force is min(the caller's `limit`,
 * ZOTEUS_INDEX_MAX_ITEMS) and a status snapshot cannot tell which one bit: telling a
 * caller whose own `limit` truncated the build to raise the environment variable sends
 * them to a setting that is already high enough.
 */
export function truncationNotice(s: IndexBuildStatus): string {
  if (s.itemsAvailable <= s.itemsTotal) return '';
  const missing = s.itemsAvailable - s.itemsTotal;
  return (
    ` Only the first ${s.itemsTotal} of ${s.itemsAvailable} items were indexed, so ${missing} are NOT searchable.` +
    ' A build stops at the lower of the `limit` argument and ZOTEUS_INDEX_MAX_ITEMS: raise whichever one bound this build, then rebuild to cover them.'
  );
}

/**
 * Sentence appended when the index could not be written to its store. Same reasoning as
 * `embedderNotice`: a build whose artifact never reached disk still reports state:"done",
 * and until #10 the only trace was a stderr warning, so the loss surfaced on the next
 * startup as an empty index nobody had touched.
 */
export function persistNotice(s: IndexBuildStatus): string {
  if (!s.persistError) return '';
  return (
    ` The index could NOT be saved (${s.persistError}), so everything indexed here is held in memory only and is` +
    ' lost when the server restarts. On the JSON backend this is usually the size ceiling of a single' +
    ' JSON.stringify (~512 MB): set ZOTEUS_INDEX_BACKEND=sqlite (Node 22.13+) to store the index in SQLite' +
    ' instead. Otherwise check free disk space and write permission on ZOTEUS_DATA_DIR.'
  );
}

/**
 * Sentence appended when opening the store needed saying: a JSON index imported into
 * SQLite, or one too large to import at all. Migration must never be something a user
 * discovers by noticing their searches went quiet.
 */
export function storageNotice(s: IndexBuildStatus): string {
  return s.storageNotice ? ` ${s.storageNotice}` : '';
}

/**
 * Sentence appended when an incremental update ran, or when one could not and a full
 * rebuild took its place. Same reasoning as `embedderNotice`: an `action:"update"` that
 * silently became a ten-minute rebuild with real embedding spend, or one that skipped its
 * deletion pass, must not be indistinguishable from the cheap update that was asked for.
 */
export function updateNotice(s: IndexBuildStatus): string {
  return s.updateNotice ? ` ${s.updateNotice}` : '';
}

/**
 * Sentence appended when the crawl saturated Zotero's local API and the session fell back
 * to the Web API. Same reasoning as `embedderNotice`, and the direct complaint in #39: the
 * fallback works, so nothing fails and nothing is reported, and all the user sees is a
 * build that is suddenly taking hours for no visible reason. It is also the one notice
 * here with a cause the user can act on immediately, so it says what to do.
 */
export function localApiNotice(s: IndexBuildStatus): string {
  if (!s.localApiDegradedAt) return '';
  // The throttle only exists on the full-text pass, which is also the only pass heavy
  // enough to have caused this; claiming it on a metadata-only build would be a fiction.
  const backedOff = s.fulltextEnabled
    ? ' The full-text crawl backed off to one attachment at a time to let the app recover, so the rest of this' +
      ' job is slower again.'
    : '';
  return (
    ` Zotero's local API stopped answering at ${s.localApiDegradedAt}, while this job was reading from it, so the` +
    ' session fell back to the Zotero Web API: slower, rate-limited, and needing a cloud API key.' +
    `${backedOff} Zotero usually answers again once the build eases off. If it keeps happening, lower` +
    ' ZOTEUS_INDEX_FULLTEXT_CONCURRENCY, or index in smaller passes with `limit`.'
  );
}

/** Human summary of a build/status snapshot. */
export function statusSummary(s: IndexBuildStatus): string {
  const job = s.operation === 'update' ? 'update' : 'build';
  const pause = s.paused
    ? ' Index work is paused; queries remain available. Call zotero_index action:"resume" before starting more work.'
    : '';
  const notice =
    embedderNotice(s) +
    staleVectorsNotice(s) +
    unembeddedNotice(s) +
    embedRateNotice(s) +
    fulltextNotice(s) +
    ownWordsNotice(s) +
    truncationNotice(s) +
    persistNotice(s) +
    storageNotice(s) +
    localApiNotice(s) +
    updateNotice(s);
  switch (s.state) {
    case 'building': {
      // The payoff of indexing metadata first is worth stating outright: during the
      // full-text pass the library is ALREADY searchable, and a caller who does not know
      // that will sit and wait for a crawl that can run for days on a large library.
      const searchable =
        s.phase === 'fulltext'
          ? ' Every item\'s metadata is already indexed and searchable — this pass only adds the body text of attachments.'
          : '';
      return `Index ${job} in progress: ${progressLine(s)}.${searchable} Poll zotero_index action:"status" again shortly.${pause}${notice}`;
    }
    case 'error': {
      // A failed build keeps what it got; a failed update keeps nothing of its own, because
      // a half-applied delta is a wrong index rather than a partial one.
      const kept = job === 'update' ? 'Index unchanged' : 'Partial data kept';
      return `Index ${job} failed: ${s.lastError ?? 'unknown error'}. ${kept}: ${progressLine(s)}.${pause}${notice}`;
    }
    case 'done': {
      const ft = s.fulltextEnabled
        ? `, including attachment full text for ${s.fulltextItems} of them (${s.fulltextPassages} passages)`
        : '';
      // Reported apart from the passage total because it answers a different question: how
      // much of what is searchable is the reader's own writing rather than the library's.
      const own = s.ownWordsItems
        ? `, and the notes and annotations of ${s.ownWordsItems} of them (${s.ownWordsPassages} passages)`
        : '';
      return `Index ready — ${s.documents} passages over ${s.items} items${ft}${own} (embedder=${s.embedder}). Run zotero_semantic_search to search by meaning.${pause}${notice}`;
    }
    default:
      return `Index: ${s.documents} passages over ${s.items} items; embedder=${s.embedder}.${pause}${notice}`;
  }
}

export interface BuildFulltextOptions {
  /** Index attachment full text as extra passages (defaults to ZOTEUS_INDEX_FULLTEXT). */
  fulltext?: boolean;
  /**
   * Index the library's child notes and PDF annotations as extra passages (defaults to
   * ZOTEUS_INDEX_OWN_WORDS, on).
   */
  ownWords?: boolean;
  /** Cap on indexed full-text characters per item, 0 = no cap (defaults to config). */
  fulltextMaxChars?: number;
  /**
   * Sentence to carry on the resulting status, e.g. why an update fell back to this
   * rebuild. Passed into the build rather than set beforehand because the build's own
   * prologue resets the status it would otherwise be written on.
   */
  note?: string;
  /**
   * Start the crawl over rather than resume an interrupted build. `action:"refresh"` is
   * what asks for it; `action:"build"` deliberately does not, because throwing away work
   * already committed and paid for is the complaint behind #24.
   */
  fresh?: boolean;
}

/**
 * Kick off the incremental background index build used by zotero_index and by
 * zotero_semantic_search's auto-build. Fire-and-forget: the build runs on the
 * server event loop; callers poll `ctx.search.buildStatus()` for progress.
 * Throws if a build is already running.
 *
 * Whether a page came from the desktop app or the cloud never changes the identity of
 * what is indexed: item keys are the same in both APIs, and the index store is keyed by
 * the context (dataDir, plus the authenticated user in multi-tenant mode — see
 * `searchIndexPath`), never by the routed library id. So neither the local `users/0`
 * addressing of the personal library nor a group served locally under its own id can
 * split the index from the one built against the cloud, and a build that switched
 * backends between runs stays coherent.
 *
 * The other face of that rule is enforced here too: one index file holds ONE library's
 * rows. The index stamps the canonical library it holds (`canonicalLibraryToken`), and a
 * build for a different one refuses up front — naming both — instead of reaching the
 * clearStore() that would silently erase the first library's index.
 *
 * A completed build also stamps the library's real Last-Modified-Version and the API that
 * issued it, which is what `startIndexUpdate` later diffs against. The two sequences are
 * never mixed: the stamp is only usable while the routing that produced it still holds, and
 * a mismatch sends the update back through this function. `builtFromVersion` keeps its
 * older, unrelated meaning (the item count the crawl fetched); the version stamp lives in
 * `libraryVersion` / `libraryBackend`.
 *
 * A build that finds an interrupted one's checkpoint carries on from it rather than
 * crawling from 0 again, on either API. That is deliberately NOT keyed on the version
 * stamp: a stopped build has none by design (it covers an unknown prefix of the library),
 * and the desktop app frequently issues no version at all, so keying resume on the stamp
 * meant an interrupted local-API build could only ever start over (#24). `opts.fresh`
 * asks for the old behaviour, and `action:"refresh"` is what passes it.
 */
export function startIndexBuild(
  ctx: ToolContext,
  lib?: LibraryRef,
  maxItems?: number,
  opts: BuildFulltextOptions = {},
): IndexBuildStatus {
  if (ctx.search.isPaused) {
    throw new Error('Index work is paused. Call zotero_index action:"resume" before build, refresh, or update.');
  }
  // Synchronously, before the fire-and-forget job below: a refusal thrown inside the job
  // would only reach the logger, and the tool caller would see a build that "started".
  const library = canonicalLibraryToken(lib);
  ctx.search.assertLibrary(library);
  // No Electron gate here any more. 1.12.0 refused a full-text build under Electron because
  // the pass took the process down with no error at all; the cause turned out to be the
  // local embedder asking Chromium's allocator for a block it will not serve, and capping
  // the batch it embeds in one call fixes it at the source (#37, see search/electron.ts).
  // The configured limit is the ceiling; an explicit `maxItems` may only lower it.
  const configured = ctx.config.indexMaxItems;
  const cap = maxItems === undefined ? configured : Math.min(maxItems, configured);
  // Decided once, here, and then forced on every page below. The routing rule is
  // re-evaluated per request and the desktop app can appear or vanish while a crawl runs,
  // so letting it decide each page would splice two independently-versioned APIs into one
  // index under a single stamp. If the API chosen here goes away mid-crawl the page fetch
  // fails and the build ends in `error` with no stamp written, which is the right outcome.
  const backend: VersionBackend = ctx.router.servesLocally(lib) ? 'local' : 'cloud';
  const fetchPage = async (start: number) => {
    // Page through the router, not the Web API directly: a running desktop app serves the
    // personal library key-free (users/0), and from Zotero 10 any group it holds too, so
    // indexing needs no cloud key for either. The router sends the rest to the cloud: a
    // group this desktop does not hold, and everything once the app is closed.
    // `lib` stays undefined for the default library so the router resolves it itself.
    const page = await ctx.router.searchItems({ library: lib, limit: PAGE_SIZE, start, top: true, backend });
    return { items: page.data, totalResults: page.totalResults, lastModifiedVersion: page.lastModifiedVersion };
  };

  // The index persists itself (JSON file or SQLite commit), and a failure to do so is
  // recorded on the build status rather than swallowed here: see persistNotice.
  const job = ctx.search.buildIncremental(fetchPage, {
    maxItems: cap,
    versionBackend: backend,
    ...(opts.fresh ? { fresh: true } : {}),
    library,
    ...crawlOptions(ctx, lib, opts, backend),
  });
  watchLocalApi(ctx, backend, job);
  job.catch((e) => ctx.logger.error(`Index build crashed: ${e instanceof Error ? e.message : String(e)}`));
  return ctx.search.buildStatus();
}

/**
 * Tell the running job if the desktop app it is crawling stops answering.
 *
 * Only for a job pinned to the local API: a cloud crawl cannot saturate Zotero and is not
 * slowed by its absence, so reporting the outage on its status would be noise. The
 * subscription lasts exactly as long as the job, so an app closed between builds is nobody's
 * degradation, and the index's own guard (`noteLocalApiDegraded` ignores an idle index)
 * covers the moment between the last row and the promise settling.
 *
 * `ctx.localStatus` is what actually notices, because the probe on the way in to every tool
 * call is what re-establishes reachability. A user polling `action:"status"` while their
 * build runs is therefore also what makes this fire, which is a happy coincidence rather
 * than a dependency: any tool call does it.
 */
function watchLocalApi(ctx: ToolContext, backend: VersionBackend, job: Promise<unknown>): void {
  if (backend !== 'local' || !ctx.localStatus) return;
  const search = ctx.search;
  const off = ctx.localStatus.onDegraded((at) => search.noteLocalApiDegraded(at));
  void job.then(off, off);
}

/**
 * Kick off an incremental UPDATE: re-index only what the library changed since the stored
 * version stamp, and drop what it no longer holds. Same contract as `startIndexBuild`
 * (fire-and-forget, poll `buildStatus()`), and the same fallback in every case where a
 * delta would be wrong rather than merely stale: no stamp, a different serving backend, a
 * different embedder, or a store that cannot delete. The fallback is a full rebuild with
 * the reason attached to the status, never a silent one.
 */
export function startIndexUpdate(
  ctx: ToolContext,
  lib?: LibraryRef,
  maxItems?: number,
  opts: BuildFulltextOptions = {},
): IndexBuildStatus {
  if (ctx.search.isPaused) {
    throw new Error('Index work is paused. Call zotero_index action:"resume" before build, refresh, or update.');
  }
  const backend: VersionBackend = ctx.router.servesLocally(lib) ? 'local' : 'cloud';
  // Same synchronous guard as startIndexBuild, and for the same reason: the version stamp
  // this update would diff against belongs to the library the index holds, not to `lib`.
  const library = canonicalLibraryToken(lib);
  ctx.search.assertLibrary(library);
  const blocker = ctx.search.updateBlocker(backend);
  if (blocker) {
    return startIndexBuild(ctx, lib, maxItems, {
      ...opts,
      note:
        `An incremental update was not possible (${blocker}), so a full build is running instead. It picks up ` +
        'where an interrupted build left off when one is on disk, and records a version stamp, so the next ' +
        'action:"update" is a cheap delta.',
    });
  }

  const configured = ctx.config.indexMaxItems;
  const cap = maxItems === undefined ? configured : Math.min(maxItems, configured);
  const since = ctx.search.buildStatus().libraryVersion;
  const fetchChanged = async (start: number) => {
    // The same routed, top-level crawl a build does, narrowed by `?since=`: on a library
    // where nothing moved this is a single request that returns an empty page.
    const page = await ctx.router.searchItems({ library: lib, limit: PAGE_SIZE, start, top: true, since, backend });
    return { items: page.data, totalResults: page.totalResults, lastModifiedVersion: page.lastModifiedVersion };
  };
  const liveKeys = async (): Promise<Set<string>> => {
    // `?format=versions` with no `since`: the whole key set, keys and versions only, which
    // is the only way to find deletions on the desktop app (`/deleted` is cloud-only).
    const keys = new Set<string>();
    let start = 0;
    for (let page = 0; page < MAX_VERSION_PAGES; page++) {
      const res = await ctx.router.itemVersions({ library: lib, top: true, limit: VERSIONS_PAGE_SIZE, start, backend });
      const batch = Object.keys(res.versions ?? {});
      for (const k of batch) keys.add(k);
      // Advance by what actually came back, not by the requested page size: the endpoint
      // may answer with the whole library at once, or cap the page at its own limit.
      if (!batch.length) break;
      start += batch.length;
      if (res.totalResults && start >= res.totalResults) break;
    }
    return keys;
  };

  const job = ctx.search.updateIncremental({
    backend,
    fetchChanged,
    liveKeys,
    maxItems: cap,
    library,
    ...crawlOptions(ctx, lib, opts, backend),
  });
  watchLocalApi(ctx, backend, job);
  job.catch((e) => ctx.logger.error(`Index update crashed: ${e instanceof Error ? e.message : String(e)}`));
  return ctx.search.buildStatus();
}

/**
 * The options a build and an update share: full text (resolved lazily, because both
 * starters are synchronous by contract and must return a status for the caller to poll),
 * the two full-text cursors of #26, and the embedding batch dials.
 *
 * `fulltextCatchUp` is an update's option alone; a build has no cursor to catch up from,
 * having just consumed the whole census. It rides along here because it needs the same
 * memoized source as everything else, and `buildIncremental` ignores what it is not asked
 * about.
 */
function crawlOptions(
  ctx: ToolContext,
  lib: LibraryRef | undefined,
  opts: BuildFulltextOptions,
  backend: VersionBackend,
) {
  const wantFulltext = opts.fulltext ?? ctx.config.indexFulltext;
  const wantOwnWords = opts.ownWords ?? ctx.config.indexOwnWords;
  const maxChars = opts.fulltextMaxChars ?? ctx.config.indexFulltextMaxChars;
  let source: Promise<FulltextSource> | undefined;
  let opened: FulltextSource | undefined;
  // One memoized source behind all three entry points: the key set, the text and the
  // failure count come from the same attachment crawl, and building it twice would double
  // the cost of starting the full-text pass.
  const openSource = (): Promise<FulltextSource> =>
    (source ??= createFulltextSource(ctx, lib, { maxChars, backend }).then((src) => {
      opened = src;
      if (src.unavailable) ctx.search.noteFulltextUnavailable(src.unavailable);
      else ctx.logger.info(`Full-text indexing: ${src.attachments} attachment(s) over ${src.items} item(s).`);
      return src;
    }));
  const fulltextFor = wantFulltext ? async (itemKey: string) => (await openSource()).textFor(itemKey) : undefined;
  const fulltextKeys = wantFulltext ? async () => (await openSource()).itemKeys : undefined;
  // Read straight off the resolved source. Both are set by the time anything asks: the only
  // caller is the end of the full-text pass, which got there by awaiting `fulltextFor`.
  const fulltextFailures = wantFulltext ? () => opened?.readFailures() ?? 0 : undefined;
  const fulltextVersion = wantFulltext ? () => opened?.maxVersion ?? 0 : undefined;
  /**
   * What Zotero's full-text sequence has extracted since the cursor this index stored, and
   * which indexed items that text belongs to (#26).
   *
   * The probe comes first and on its own: on a library where nothing has been extracted
   * since, that one request answers with nothing and the update stops there, having cost
   * no attachment crawl at all. Only a non-empty answer is worth the map behind
   * `fulltextFor`, and by then the map is usually open anyway, because the delta's own
   * items went through it.
   */
  const fulltextCatchUp = wantFulltext
    ? async (since: number) => {
        const extracted = (await ctx.router.fullTextSince(since, { library: lib, backend })) ?? {};
        const keys = Object.keys(extracted);
        if (!keys.length) return { itemKeys: new Set<string>(), version: since };
        const version = Object.values(extracted).reduce((hi, v) => (v > hi ? v : hi), since);
        return { itemKeys: (await openSource()).itemsFor(keys), version };
      }
    : undefined;
  /**
   * The census behind the reader's own words, memoized exactly like the full-text source
   * and for the same reason: a build asks it once per item and an update asks it once per
   * refreshed item, and it must be crawled once for all of them.
   */
  let ownSource: Promise<OwnWordsSource> | undefined;
  const openOwnWords = (): Promise<OwnWordsSource> =>
    (ownSource ??= createOwnWordsSource(ctx, lib, { backend }).then((src) => {
      if (src.unavailable) ctx.search.noteOwnWordsUnavailable(src.unavailable);
      else ctx.logger.info(`Own words: ${src.notes} note(s) and ${src.annotations} annotation(s) over ${src.items} item(s).`);
      return src;
    }));
  // The keys-only question is answered straight from the router, NOT through the census:
  // that is what lets an update over a library nobody has annotated since cost one request
  // rather than a crawl of every note in it (#33).
  const ownWords = wantOwnWords
    ? {
        childVersions: () => fetchChildVersions(ctx, lib, backend),
        itemsFor: async (keys: Iterable<string>) => (await openOwnWords()).itemsFor(keys),
        textsFor: async (itemKey: string) => (await openOwnWords()).textsFor(itemKey),
      }
    : undefined;
  return {
    fulltextFor,
    fulltextKeys,
    fulltextFailures,
    fulltextVersion,
    fulltextCatchUp,
    ...(ownWords ? { ownWords } : {}),
    ...(opts.note ? { note: opts.note } : {}),
    // Passages per embedding request, and the pause between requests: the dials an API
    // provider's per-request token cap and per-minute rate limit are tuned against.
    embedBatchSize: ctx.config.embedBatchSize,
    embedBatchDelayMs: ctx.config.embedBatchDelayMs,
    // How hard the full-text pass is allowed to lean on whichever Zotero API is serving it.
    // Decided here rather than inside the index because only this layer knows which one
    // that is, and the two tolerate load in completely different ways: the desktop app is a
    // single process with no rate limiter that can be driven into the ground (#39), the
    // Web API is a fleet that answers a burst with a 429 and a Backoff header. An explicit
    // ZOTEUS_INDEX_FULLTEXT_CONCURRENCY overrides both.
    fulltextConcurrency:
      ctx.config.indexFulltextConcurrency ??
      (backend === 'local' ? DEFAULT_FULLTEXT_CONCURRENCY_LOCAL : DEFAULT_FULLTEXT_CONCURRENCY_CLOUD),
    // A full-text index is far bigger, and on the JSON backend persisting means
    // re-serializing all of it. Save less often so the write does not dominate the build.
    // (On SQLite a persist is a commit, so this only costs a slightly longer transaction.)
    //
    // Scoped to the full-text pass alone. Slowing the metadata pass down to match would
    // undo the point of running it first: its results are exactly the ones worth making
    // durable early, and its rows are small enough that saving often costs little.
    ...(wantFulltext ? { persistEveryItemsFulltext: 500, persistEveryMsFulltext: 60_000 } : {}),
  };
}
