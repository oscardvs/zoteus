import { statSync } from 'node:fs';
import { BM25Index } from './bm25.js';
import { VectorStore } from './vector-store.js';
import { chunkText } from './chunker.js';
import { pruneTerms, type TermPredicate } from './query-terms.js';
import { accentKey, normalizeForSearch, tokenize } from './tokenize.js';
import { batchPause, embedderIdentity } from './embeddings.js';
import type { EmbedKind } from './embeddings.js';
import {
  DEFAULT_EMBED_BATCH_SIZE,
  DEFAULT_FULLTEXT_CONCURRENCY_CLOUD,
  SATURATED_FULLTEXT_CONCURRENCY,
} from './limits.js';
import { Semaphore } from '../../lib/semaphore.js';
import { embedRateLine, progressLine } from './build.js';
import { describeLibraryToken } from './backend.js';
import { saveIndex } from './persistence.js';
import type {
  BuildCheckpoint,
  BuildOptions,
  BuildState,
  ChunkRecord,
  OwnWordsEntry,
  IncrementalBuildOptions,
  IncrementalUpdateOptions,
  EmbedRate,
  IndexBuildStatus,
  IndexCounts,
  IndexSnapshot,
  PageFetcher,
  PageResult,
  QueryOptions,
  RankedId,
  SearchHit,
  SearchIndex,
  SearchIndexOptions,
  SearchIndexStatus,
  StorageBackend,
  VersionBackend,
} from './backend.js';

// The contract and its types live in backend.ts (two implementations share them); they are
// re-exported here because this module was their home and every caller still imports it.
export type {
  BuildCheckpoint,
  BuildOptions,
  BuildState,
  ChunkRecord,
  FulltextCatchUp,
  OwnWordsAccess,
  OwnWordsEntry,
  IncrementalBuildOptions,
  IncrementalUpdateOptions,
  IndexBuildStatus,
  IndexCounts,
  IndexSnapshot,
  PageFetcher,
  PageResult,
  QueryOptions,
  RankedId,
  SearchHit,
  SearchIndex,
  SearchIndexOptions,
  SearchIndexStatus,
  StorageBackend,
  VersionBackend,
} from './backend.js';

/**
 * Passage size for attachment full text. Deliberately larger than the metadata chunk
 * (512): a body of prose needs more surrounding context per passage to embed usefully,
 * and at 512 a single paper would explode into hundreds of vectors.
 */
export const FULLTEXT_CHUNK_SIZE = 1200;
export const FULLTEXT_CHUNK_OVERLAP = 150;

/** The chunker's own default, named here so the rate arithmetic can quote it. */
export const METADATA_CHUNK_SIZE = 512;

/** One sentence for the status fields that have room only to say the index is unusable. */
export const UNREADABLE_STORE = 'the search index cannot be read';

/**
 * How many items the full-text pass fetches text for before it embeds, logs and may save.
 * Matches the item page size the metadata pass works in, so both passes report progress at
 * the same granularity and one commit covers a comparable amount of work.
 */
const PAGE_GROUP = 100;

/**
 * Passages a resumed build pulls out of the store per vector-backfill round. Bounded so a
 * build that has to embed 30,000 orphaned passages never holds 30,000 passage texts at
 * once; large enough that the round trip to the store is amortized over several embedding
 * batches at the default batch size of 32.
 */
const VECTOR_BACKFILL_GROUP = 500;

/**
 * How many whole-census recovery passes may be paid over a complete map before the index
 * stops paying them (#78).
 *
 * The recovery a truncated attachment map owes is one full body crawl: every indexed item
 * Zotero's full-text census names is re-read, because over such a map "this item holds
 * passages" does not mean "this item holds all of its body text". Read failures are caught
 * per item, so one attachment that can never be read (its file was moved, a linked file the
 * server will not serve, a 403) leaves the pass incomplete however often it runs, and
 * without a bound that is a full body crawl on every single update, forever, on precisely
 * the libraries big enough for the map to have truncated in the first place.
 *
 * Three, because the failure this is meant to survive is a transient one (the desktop app
 * restarting mid-pass, a file on a volume that was not mounted yet) and three updates is
 * generous for that, while a permanent one is answered before its cost is paid a fourth
 * time. What is NOT traded away is honesty: the mark stays standing and the cursor stays
 * withheld past the bound, so the index never claims coverage it does not have. It only
 * stops re-buying a crawl that cannot finish. A `action:"refresh"` (a build with
 * `fresh:true`), or any build that starts the coverage over, clears the count with the mark.
 */
const FULLTEXT_RECOVERY_ATTEMPTS = 3;

/**
 * Characters per token, for the rate arithmetic on `IndexBuildStatus.embedRate`. The rule
 * of thumb every provider publishes for English prose; a real count would need this side to
 * ship a tokenizer per model, and the answer is being compared against limits quoted in
 * round millions, so the third significant figure buys nothing.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Characters embedded before the observed tokens-per-minute figure is reported at all. Below
 * it the measurement is one or two requests' latency, which says more about the first
 * connection than about the rate this build will sustain.
 */
const RATE_SAMPLE_CHARS = 200_000;

function itemText(d: any): string {
  const creators = (d.creators ?? []).map((c: any) => c.lastName ?? c.name).filter(Boolean).join(' ');
  const tags = (d.tags ?? []).map((t: any) => t.tag).filter(Boolean).join(' ');
  return [d.title, d.abstractNote, creators, tags, d.date, d.publicationTitle, d.bookTitle, d.note]
    .filter(Boolean)
    .join('. ');
}

/**
 * An item's key, from either shape the APIs return it in (a wrapped item, or the `data`
 * object alone). Empty when it has none, which every caller reads as "not indexable".
 */
function itemKeyOf(item: any): string {
  const d = item?.data ?? item;
  return item?.key ?? d?.key ?? '';
}

/**
 * Passage id for one chunk of one note or annotation.
 *
 * Namespaced `#w` so it can collide with neither a metadata passage (`#<n>`) nor a body
 * one (`#f<n>`), and it names the CHILD rather than a running counter: an item's own words
 * are then addressable one note at a time, which is what makes a deleted note detectable
 * (see ownWordsPassageIds). Zotero keys are `[A-Z0-9]{8}`, so neither separator can appear
 * inside one.
 */
function ownWordsId(itemKey: string, childKey: string, chunk: number): string {
  return `${itemKey}#w${childKey}.${chunk}`;
}

/** The item and child an own-words passage id names, or undefined when it names neither. */
function parseOwnWordsId(id: string): { itemKey: string; childKey: string } | undefined {
  const hash = id.indexOf('#w');
  if (hash <= 0) return undefined;
  const dot = id.indexOf('.', hash + 2);
  if (dot < 0) return undefined;
  return { itemKey: id.slice(0, hash), childKey: id.slice(hash + 2, dot) };
}

/**
 * First sentence of a reason, for the one-line embedder label. Reasons are written to be
 * actionable, which makes them paragraph-length; the label needs the cause only, and the
 * full text still travels in `embedderReason`.
 */
function shortCause(reason: string): string {
  const first = reason.split(/(?<=\.)\s/)[0] ?? reason;
  const trimmed = first.replace(/\.$/, '').trim();
  return trimmed.length > 90 ? `${trimmed.slice(0, 89).trimEnd()}...` : trimmed;
}

/** How a version stamp's origin reads inside a sentence. */
function labelFor(backend: VersionBackend | undefined): string {
  if (backend === 'local') return 'desktop app';
  if (backend === 'cloud') return 'cloud Web API';
  return 'unrecorded';
}

/** Reciprocal Rank Fusion of multiple ranked lists. */
function rrf(lists: Array<Array<{ id: string }>>, k = 60): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((hit, rank) => scores.set(hit.id, (scores.get(hit.id) ?? 0) + 1 / (k + rank + 1)));
  }
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

/**
 * Build a readable, query-centred snippet trimmed to word boundaries.
 *
 * `highDf` is the index's droplist, and passing it is not optional polish. This function
 * centres on the EARLIEST query term it finds, so a term the corpus is saturated with is
 * found at or near character 0 of almost every passage and every snippet becomes the
 * passage's opening words. With the 29-word stoplist gone from `tokenize()`, that is what
 * `the theory of games` would do to every result it returned.
 */
export function makeSnippet(text: string, query: string, max = 240, highDf?: TermPredicate): string {
  // NFC changes no character the reader sees, and it is what the token comparison below
  // normalizes to.
  const clean = text.replace(/\s+/g, ' ').trim().normalize('NFC');
  if (clean.length <= max) return clean;
  // Walk the passage's own tokens and normalize each one, rather than normalizing the whole
  // passage and searching inside the result. The offset then comes from `clean` itself and
  // needs no assumption at all about whether normalizing preserved length.
  //
  // An earlier version did assume that — "stripping a mark from precomposed text is
  // length-preserving" — and it is false twice over. `foldMarks` shortens any base+mark pair
  // that has no precomposed form (`n̈` is two codepoints and folds to one), and lowercasing
  // can lengthen (`İ` becomes `i` plus a combining dot). Either way the position found in
  // one string was being sliced out of another, and the snippet came back centred hundreds
  // of characters from the match, without it.
  //
  // The stripped form is compared too, because query expansion lets an unaccented query
  // reach an accented document: a passage spelling `théorie` answers a query for
  // `theorie`, and the snippet must be able to find what the search found.
  const wanted = new Set(pruneTerms(tokenize(query), highDf, 'raw'));
  let pos = -1;
  for (const m of clean.matchAll(/[\p{L}\p{N}]+/gu)) {
    const token = normalizeForSearch(m[0]);
    if (wanted.has(token) || wanted.has(accentKey(token))) {
      pos = m.index;
      break;
    }
  }
  let start = pos < 0 ? 0 : Math.max(0, pos - Math.floor(max / 3));
  if (start > 0) {
    const sp = clean.indexOf(' ', start);
    start = sp >= 0 ? sp + 1 : start;
  }
  let end = Math.min(start + max, clean.length);
  if (end < clean.length) {
    const sp = clean.lastIndexOf(' ', end);
    if (sp > start) end = sp;
  }
  let snip = clean.slice(start, end).trim();
  if (start > 0) snip = `… ${snip}`;
  if (end < clean.length) snip = `${snip} …`;
  return snip;
}

/**
 * Everything a hybrid index does that is independent of where the passages are kept:
 * chunking, the embedder lifecycle and its degradation reporting, the incremental build
 * loop, fusion and snippets. A backend supplies only storage primitives (the abstract
 * members below), so both implementations answer identically at the tool boundary and a
 * behaviour fix cannot land in one and miss the other.
 */
export abstract class SearchIndexBase implements SearchIndex {
  /** Whether the running/last build was asked for full text, and why it may not deliver. */
  protected fulltextEnabled = false;
  protected fulltextUnavailable: string | undefined = undefined;
  /**
   * Whether this index holds the reader's own words — child notes and PDF annotations —
   * and why it may not. On by default, unlike full text: the whole corpus is one paged
   * crawl of hand-written text, orders of magnitude smaller than the attachment bodies
   * beside it, and it is the only text in a library nobody else wrote (#33).
   */
  protected ownWordsEnabled = false;
  protected ownWordsUnavailable: string | undefined = undefined;
  protected builtFromVersion = 0;
  /**
   * Zotero's Last-Modified-Version this index was built or updated from, and the API that
   * issued it. Persisted together because neither is meaningful alone: a local version
   * number read as a cloud one asks for a delta that spans the wrong sequence entirely.
   */
  protected libraryVersion = 0;
  protected libraryBackend: VersionBackend | undefined = undefined;
  /**
   * How far into Zotero's FULL-TEXT sequence this index has read. A second cursor because
   * it counts a second sequence: Zotero numbers extracted text independently of item
   * versions, so text extracted after a build moves no item version, appears in no
   * `?since=` delta, and was invisible to every later update (#26).
   */
  protected fulltextVersion = 0;
  /**
   * Whether the body text this index holds was gathered over an attachment map that never
   * reached the end of the library, which makes its full-text coverage partial in a way no
   * cursor can describe: an item may hold the text of one attachment and not of another
   * that sat on a page the map never listed (Zotero lists attachments newest-modified
   * first, so an item's own attachments are not adjacent in that crawl).
   *
   * Persisted, because it is what the recovery depends on: while it is set, a catch-up that
   * is asked for full text, still holds no cursor, and runs against a map that reaches the
   * end of the library re-reads the body text of every item that census names instead of
   * skipping the ones that already hold passages. Nothing less clears it: a pass that read
   * a delta of the sequence, missed a read, or ran against a map that stopped short again
   * leaves it standing, and the last of those falls back to filling the coverage gap alone.
   * Without it the recovering update sealed the gap it was supposed to close, stamping a
   * census-wide cursor over items it had skipped (#78).
   */
  protected fulltextPartial = false;
  /**
   * Recovery passes that were paid in full over a map reaching the end of the library and
   * still ended on body text they could not read. Persisted beside the mark, because what
   * it bounds spans updates: at FULLTEXT_RECOVERY_ATTEMPTS the whole-census re-read stops
   * being paid and each update fills only the items holding no body text at all, with the
   * mark and the withheld cursor still standing and the status saying so (#78).
   */
  protected fulltextRecoveryAttempts = 0;
  /**
   * Where an interrupted build stopped, or undefined when there is nothing to resume.
   * Written in the same commit as the rows it describes, which is what bounds the work a
   * resume redoes to a single persistence interval (#24).
   */
  protected checkpoint: BuildCheckpoint | undefined = undefined;
  /** Durable operator hold. Unlike requestStop(), this survives restarts and idle periods. */
  protected paused = false;
  protected pauseTransition: Promise<void> | undefined;
  /**
   * Canonical identity of the library whose rows this store holds (canonicalLibraryToken;
   * undefined until a stamped build writes rows, or for indexes persisted before the
   * stamp existed). Written with the first rows rather than at completion: a half-built
   * index is already somebody's index, and assertLibrary must protect it too.
   */
  protected library: string | undefined = undefined;
  /** What the last update did, or why a rebuild replaced it (see IndexBuildStatus). */
  protected updateNotice: string | undefined = undefined;
  /**
   * When Zotero's local API stopped answering during the running (or last) job, if it did.
   * See `noteLocalApiDegraded`.
   */
  protected localApiDegradedAt: number | undefined = undefined;
  /**
   * The live full-text fetch limiter of the running job, so the degradation signal can
   * lower it without the build loop having to poll for one.
   */
  private fulltextLimit: Semaphore | undefined = undefined;
  /**
   * Embedder identity that produced the vectors currently held (persisted with them).
   * Public because the update path compares it against the live embedder before deciding
   * whether a delta is even meaningful.
   */
  vectorEmbedderId: string | undefined = undefined;
  /** Set when a load discarded vectors another embedder had produced. */
  protected vectorsStale: string | undefined = undefined;
  /**
   * How the last semantic query ranked vectors, and anything that path had to say. Written
   * by whichever backend has a choice to make (today the SQLite one, which ranks through
   * binary codes and falls back to a full scan); left unset by a backend that has only one
   * way to search, since reporting a choice nobody made would be noise.
   */
  protected vectorScan: 'exact' | 'codes' | undefined = undefined;
  protected vectorScanNotice: string | undefined = undefined;
  /** What opening the store had to do or refused to do (JSON migration; see #10). */
  protected storeNotice: string | undefined = undefined;

  /**
   * The reason this index's store cannot be used, once something has found one.
   *
   * A fault is never cleared in place, and that is what makes refusing on it safe rather
   * than a deadlock: it is cleared by replacing the whole index object (see
   * `reopenSearchIndex` on the tool context). So `build()` may refuse on a faulted index
   * without trapping the user, because the repair happens above the index, not inside it.
   */
  protected fault: Error | undefined = undefined;

  get storeFault(): Error | undefined {
    return this.fault;
  }

  /**
   * Record that the store is unusable. First fault wins: once the diagnosis is made, a
   * later symptom of the same damage must not overwrite it with something less useful.
   */
  protected noteStoreFault(e: Error): void {
    if (this.fault) return;
    this.fault = e;
    // The channel the store already uses to explain what opening it did or refused to do,
    // so this reaches status().storageNotice the same way a refused JSON migration does.
    this.storeNotice = e.message;
    this.opts.logger?.error(e.message);
  }

  /** Refuse rather than answer from a store that is known to be unreadable. */
  protected refuseIfFaulted(): void {
    if (this.fault) throw this.fault;
  }

  /**
   * The guard on the single-library assumption startIndexBuild documents: one index
   * file, one library. A build or update for another library would reach clearStore()
   * and erase this one's rows, so it refuses instead, naming both. An empty store or a
   * pre-stamp index guards nothing — there is either nothing to lose, or no way to know
   * whose rows these are.
   */
  assertLibrary(library: string): void {
    const held = this.library;
    if (!held || held === library) return;
    if (this.counts().documents === 0) return;
    throw new Error(
      `This index holds ${describeLibraryToken(held)}; building for ${describeLibraryToken(library)} ` +
        `would erase it. One index file holds one library. To index ${describeLibraryToken(library)}, ` +
        'run Zoteus with its own data directory (ZOTEUS_DATA_DIR), or delete the index file and rebuild.',
    );
  }

  /**
   * Mark this index unusable from outside the class. The factory needs it: whether the
   * JSON artifact could be read is decided there, after construction, and there is no
   * other legitimate writer.
   */
  markStoreFault(e: Error): void {
    this.noteStoreFault(e);
  }

  // Asynchronous build lifecycle (see buildIncremental / requestStop / buildStatus).
  private buildState: BuildState = 'idle';
  private operation: 'build' | 'update' = 'build';
  private itemsFetched = 0;
  private itemsRemoved = 0;
  protected itemsTotal = 0;
  protected itemsAvailable = 0;
  /** Which pass of a build is running; see IndexBuildStatus.phase (#23). */
  private phase: 'metadata' | 'fulltext' = 'metadata';
  private fulltextItemsScanned = 0;
  private fulltextItemsTotal = 0;
  /** Items a resumed build inherited from the run it is continuing (see IndexBuildStatus). */
  private resumedFrom: number | undefined = undefined;
  private lastBuildError: string | undefined = undefined;
  private cancelToken: { cancelled: boolean } | null = null;
  /**
   * Set the first time the provider throws. Kept on the instance (rather than in a build's
   * local scope) precisely so status can report it: a failure that only ever reached a
   * stderr log line is invisible to a desktop-extension user, whose client discards it.
   */
  private embedderError: string | undefined = undefined;
  /**
   * Passages the running (or last) build was handed a second time and stored once. Reset by
   * each build and reported by it at the end; see `storePassage` for where they come from.
   */
  private duplicatePassages = 0;
  /**
   * Last failure to write the index out. Same reasoning as `embedderError`: a build that
   * could not persist its artifact used to report state:"done" with only a stderr warning
   * to show for it, so the loss was discovered on the next startup (#10).
   */
  private persistError: string | undefined = undefined;
  /**
   * The pacing this job is embedding at, and what it has actually achieved: enough to
   * answer "will this build be rate-limited?", which is the question #48 turned out to be.
   * `embedChars` and `embedMs` cover the time inside the provider plus the configured
   * pauses, i.e. the wall clock the embedding pass owns, so their ratio is the sustained
   * rate rather than a peak.
   */
  private embedBatchInUse: number | undefined = undefined;
  private embedDelayInUse = 0;
  private embedChars = 0;
  private embedMs = 0;

  constructor(protected readonly opts: SearchIndexOptions) {}

  /** Which store backs this index. */
  abstract readonly storage: StorageBackend;
  /** Live sizes of the store. Must not walk the passages: status() is called per progress tick. */
  protected abstract counts(): IndexCounts;
  /**
   * Adopt anything another process has committed to the same store since this handle read
   * it, where the backend can tell. Called before a decision that turns on the index's own
   * state rather than on the library's, and a no-op for a store nobody else can be writing
   * (the JSON one is rewritten whole, so there is nothing to merge in). See #68.
   */
  protected refreshFromStore(): void {}
  /** Drop every passage and vector. */
  protected abstract clearStore(): void;
  /** Register an indexed item. Called for every item, including ones with no text at all. */
  protected abstract putItem(itemKey: string, title: string): void;
  /**
   * Store one passage (also updating item and full-text bookkeeping). Answers false, and
   * stores nothing, when the store already holds a passage with this id: the caller decides
   * what a duplicate means, and a store must never abort a build over one (#59).
   */
  protected abstract putPassage(rec: ChunkRecord): boolean;
  /**
   * Run one item's writes as a unit the store either keeps whole or not at all.
   *
   * The default is no unit: the JSON backend has nothing that can refuse an insert partway
   * through an item. The SQLite backend wraps this in a savepoint, so an insert that fails
   * after an item's first passage rolls the item back entirely instead of leaving it
   * committed with some of its chunks. That matters because a resumed build steps over
   * items by key, and would take a half-written item for a finished one (#59).
   */
  protected atomically<T>(fn: () => T): T {
    return fn();
  }
  /**
   * Remove one item: its passages, their vectors and their keyword-index rows. Must be
   * exact, not best-effort. A passage left behind stays rankable, so a deleted item goes
   * on being returned by search with no way for the caller to fetch it.
   */
  protected abstract deleteItem(itemKey: string): void;
  /**
   * Every item key in the store. Bounded by ITEMS (thousands), never by passages, which is
   * why this may be materialized: the deletion diff needs the whole set at once anyway.
   */
  protected abstract listItemKeys(): string[];
  /**
   * Every item in the store as the key and title a full-text pass needs to come back to
   * it, in the order the crawl added them. Same bound as `listItemKeys`, and the reason a
   * resumed build can rebuild its worklist without re-crawling the library or reading a
   * single stored passage (#24).
   */
  protected abstract listItems(): Array<{ key: string; title: string }>;
  /** The title recorded for an indexed item (undefined when the store does not hold it). */
  protected abstract itemTitle(itemKey: string): string | undefined;
  /** True when the store already holds attachment body passages for this item. */
  protected abstract hasFulltext(itemKey: string): boolean;
  /**
   * Ids of one item's body passages. Asked per item rather than for the whole index, unlike
   * the own-words twin below, because there are orders of magnitude more of these: it is
   * only ever called for the handful of items whose attachments an update could not read,
   * and what it finds is put straight back after the upsert (#67).
   */
  protected abstract fulltextPassageIds(itemKey: string): string[];
  /**
   * Ids of the passages that came from the reader's own words. Bounded by those passages
   * (thousands) rather than by the index (which is full-text passages in their hundreds of
   * thousands), and it is what lets an update notice a note that was DELETED: deleting one
   * of an item's five notes moves no version anywhere in Zotero, so nothing in a `?since=`
   * delta would ever mention it. The child key each id names is what the census is
   * compared against.
   */
  protected abstract ownWordsPassageIds(): string[];
  /**
   * The own-words half of `deleteItem`, so an item's notes and annotations can be replaced
   * without touching its metadata passages or the item row.
   */
  protected abstract clearOwnWords(itemKey: string): void;
  /**
   * Remove only this item's body passages, leaving its metadata ones. What a full-text
   * catch-up needs: the item itself did not change, so re-fetching and re-chunking its
   * metadata would be waste, but its `#f<n>` passage ids have to be free before new ones
   * are written under them.
   */
  protected abstract clearFulltext(itemKey: string): void;
  /** False when this store cannot delete rows, which makes an update impossible. */
  abstract readonly supportsDelete: boolean;
  /** Attach a vector to an already-stored passage. */
  protected abstract putVector(id: string, vector: number[]): void;
  /**
   * Give the store a chance to answer a passage's vector from something it already holds,
   * before the embedder is asked for one. True means the passage now carries a vector and
   * must not be queued for embedding.
   *
   * The one implementation today is the SQLite backend reading an index a schema change
   * moved aside: an embedding is a function of the text and the model, so a rebuild forced
   * by a table-layout change would otherwise re-buy vectors it already owns (#34). Default
   * false, because a backend with nothing to reuse must not be made to pretend otherwise.
   */
  protected adoptVector(_rec: ChunkRecord): boolean {
    return false;
  }
  /**
   * Up to `limit` committed passages that carry no vector, so a resumed build can buy the
   * embeddings an interrupted one never got to.
   *
   * A page rather than the whole set, and deliberately: after a provider failure partway
   * through a full-text build there can be tens of thousands of these, and materializing
   * them all would hold every passage's text in memory at once. The caller loops until the
   * store answers with none.
   *
   * `pendingPassages` on the checkpoint does not cover this. That names the handful an
   * interruption caught between `putPassage` and the embedding call; this is the far larger
   * set an embedder that DIED mid-build left behind, which until #48 nothing ever came back
   * for, because the failed build cleared its own checkpoint and the next one started over.
   */
  protected abstract passagesMissingVectors(limit: number): ChunkRecord[];
  /** Discard every stored vector, keeping the passages. */
  protected abstract clearVectors(): void;
  /**
   * Bring whatever a store derives from its vectors level with them, once a build or an
   * update has finished writing and before the final persist, so the derived rows commit
   * with the rows they were derived from. The SQLite backend rebuilds its binary search
   * codes here; a store that derives nothing does nothing, which is why this is not
   * abstract. Must not throw: a derived cache that could not be built is a slower index,
   * never a failed build.
   */
  protected finalizeVectors(): void {}
  /**
   * Bring this index's droplist level with the passages it is derived from.
   *
   * Called beside `finalizeVectors` and for the same reason — after the writing, before the
   * persist, so a derived fact commits with the rows it was derived from. `force` says a
   * full build has just walked the whole corpus, which is the declared recompute point; an
   * update passes false and the store decides for itself whether the corpus has drifted far
   * enough to be worth rescanning.
   *
   * Must not throw, on the same rule as `finalizeVectors`: a droplist that could not be
   * derived is a slower index, never a failed build.
   */
  protected refreshDroplist(_force: boolean): void {}
  /**
   * The terms this index's corpus cannot discriminate on, or undefined where the store has
   * no droplist — which must mean "prune nothing", never "prune everything".
   */
  protected highDf(): TermPredicate | undefined {
    return undefined;
  }
  /** Width of the stored vectors (undefined when none are stored). Their embedder's fingerprint. */
  protected abstract vectorDimension(): number | undefined;
  /** Keyword candidates, best first. */
  protected abstract keywordSearch(q: string, topK: number): RankedId[];
  /** Vector candidates, best first. */
  protected abstract vectorSearch(query: number[], topK: number): RankedId[];
  /** One passage by id, for snippets and attribution. */
  protected abstract passage(id: string): ChunkRecord | undefined;
  abstract save(): Promise<void>;
  abstract close(): Promise<void>;

  /**
   * Discard everything written since the last save and reload the store's own view of
   * itself. Returns false where the store cannot: an update that fails on one of those is
   * left partially applied in memory, never on disk, since nothing is persisted until the
   * update succeeds. Callers must report the difference rather than claim a rollback.
   */
  protected rollback(): boolean {
    return false;
  }

  /** What ZOTEUS_EMBEDDINGS asked for. */
  get embedderConfigured(): string {
    return this.opts.configured ?? this.opts.embedder?.name ?? 'off';
  }

  /** True only while vectors are genuinely being produced. */
  get embedderActive(): boolean {
    return Boolean(this.opts.embedder) && !this.embedderError;
  }

  /**
   * Identity of the vectors this index would produce now, or undefined with no provider.
   * Stored alongside the vectors so a model switch cannot go unnoticed: vectors from two
   * models differ in dimension and in space, so ranking one against the other is nonsense.
   */
  get embedderId(): string | undefined {
    return this.opts.embedder ? embedderIdentity(this.opts.embedder) : undefined;
  }

  /** Why the configured embedder is not active (undefined when nothing is wrong). */
  get embedderReason(): string | undefined {
    if (this.embedderActive) return undefined;
    return this.embedderError ?? this.opts.unavailable;
  }

  /**
   * The *effective* embedder, for humans. Reporting the configured value here regardless
   * of whether it worked is what made a missing optional dependency look like an empty
   * library, so a degraded provider names itself and its reason instead.
   */
  get embedderName(): string {
    if (this.embedderActive) return this.opts.embedder!.name;
    const configured = this.embedderConfigured;
    if (configured === 'off') return 'none (keyword-only)';
    const reason = this.embedderReason;
    return `none (${configured} requested; ${reason ? shortCause(reason) : 'unavailable'})`;
  }

  get hasEmbedder(): boolean {
    return this.embedderActive;
  }

  /** True when the index actually holds vectors, i.e. semantic-only ranking can work. */
  get hasVectors(): boolean {
    return this.counts().vectors > 0;
  }

  /**
   * Explain why an opt-in full-text build is not producing passages (nothing extracted in
   * Zotero yet, unreachable full-text endpoints). Mirrors the embedder's reporting: a
   * metadata-only index that was ASKED for full text must say so, not look complete.
   */
  /**
   * Why this job could not read all of the library's notes and annotations, from the source
   * that could not serve them: the cause alone. The remedy is named here, because it depends
   * on the job. A build's gap is closed by another build. An update's is closed by the next
   * update, which repeats this delta because the stamp is withheld (#63): the update keeps
   * the cause as it stands and composes its own sentence when it ends.
   */
  noteOwnWordsUnavailable(reason: string): void {
    this.ownWordsUnavailable =
      this.operation === 'update' && this.isBuilding
        ? reason
        : `${reason}, so the index holds each item's metadata but not all of the reader's ` +
          'own words. Re-run zotero_index action:"build" to try again.';
    this.opts.logger?.warn(reason);
  }

  noteFulltextUnavailable(reason: string): void {
    this.fulltextUnavailable = reason;
  }

  /**
   * Zotero's local API stopped answering while this job was reading from it.
   *
   * Two things follow, and they are the whole of #39. The crawl backs off to one full-text
   * read at a time for the rest of the job, because it is the load that caused this and it
   * is the only load here that can yield. And the fact is recorded on the status, because
   * until now the only trace was one INFO line: a user saw a build take far longer than it
   * should, over the Web API's rate limits rather than the desktop app, with nothing
   * anywhere to say why.
   *
   * First edge wins. A single outage is the story; a second one twenty minutes later does
   * not change the advice, and re-timestamping would make a build look like it degraded
   * long after it actually did. Ignored when nothing is running, so an app closed between
   * builds is not reported as this build's problem.
   */
  noteLocalApiDegraded(at: number): void {
    if (!this.isBuilding || this.localApiDegradedAt !== undefined) return;
    this.localApiDegradedAt = at;
    this.fulltextLimit?.setMax(SATURATED_FULLTEXT_CONCURRENCY);
    this.opts.logger?.warn(
      "Zotero's local API stopped answering while the index was reading from it. Attachment full text is now " +
        'being fetched one at a time to let the app recover; the rest of this job will be slower. ' +
        'zotero_index action:"status" reports this as localApiDegradedAt.',
    );
  }

  /**
   * Drop vectors this embedder did not produce, and remember why. Ranking them would not
   * fail, it would return plausible nonsense, which is the whole reason to be strict here.
   */
  protected dropStaleVectors(cause: string): void {
    this.vectorsStale =
      `${cause} They were discarded (vectors from different embedders are not comparable, even ` +
      'where the model is the same). Keyword search is unaffected: run zotero_index ' +
      'action:"build" to re-embed the library with the current one.';
    this.clearVectors();
    this.vectorEmbedderId = undefined;
    this.opts.logger?.warn(this.vectorsStale);
  }

  /**
   * Reconcile stored vectors with the active embedder after a load/open. Files (and
   * databases) written before the identity was persisted carry none, and are kept: their
   * provenance is unknown, not known-wrong. Nothing to reconcile without an active provider
   * either, since a query that cannot be embedded never touches these vectors.
   */
  protected reconcileVectorProvenance(): void {
    const current = this.embedderId;
    if (current && this.vectorEmbedderId && this.vectorEmbedderId !== current && this.counts().vectors > 0) {
      this.dropStaleVectors(
        `The stored vectors were built with ${this.vectorEmbedderId}, but this server now embeds with ${current}.`,
      );
    }
  }

  /**
   * The rate arithmetic for this job, or undefined when it does not apply: no API provider
   * (a local pipeline answers to no tokens-per-minute limit), or nothing embedded yet.
   */
  private embedRate(): EmbedRate | undefined {
    const name = this.opts.embedder?.name;
    if (name !== 'openai' && name !== 'gemini') return undefined;
    const batchSize = this.embedBatchInUse;
    if (!batchSize) return undefined;
    // The chunk size this job is actually producing: body passages are more than twice the
    // size of metadata ones, so quoting one figure for both would be wrong by that much on
    // whichever build it did not describe.
    const chunk = this.fulltextEnabled ? FULLTEXT_CHUNK_SIZE : METADATA_CHUNK_SIZE;
    const rate: EmbedRate = {
      batchSize,
      delayMs: this.embedDelayInUse,
      tokensPerRequest: Math.round((batchSize * chunk) / CHARS_PER_TOKEN),
    };
    if (this.embedChars >= RATE_SAMPLE_CHARS && this.embedMs > 0) {
      rate.tokensPerMinute = Math.round((this.embedChars / CHARS_PER_TOKEN / this.embedMs) * 60_000);
    }
    return rate;
  }

  /** Record the first provider failure so status, not just the log, can report it. */
  private noteEmbedFailure(e: unknown): void {
    if (this.embedderError) return;
    this.embedderError = e instanceof Error ? e.message : String(e);
    this.opts.logger?.warn(`Embedding failed; falling back to keyword-only. ${this.embedderError}`);
  }

  /** True while a background build is running. */
  get isBuilding(): boolean {
    return this.buildState === 'building';
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Change the durable hold independently of the running-job cancellation token. Setting
   * it while idle is the important case: requestStop() deliberately has nothing to save
   * then, whereas a user must still be able to prevent the next explicit build.
   */
  async setPaused(paused: boolean): Promise<void> {
    this.refuseIfFaulted();
    if (this.pauseTransition) throw new Error('An index pause/resume transition is already in progress.');
    if (this.paused === paused) return;
    const previous = this.paused;
    // A hold takes effect before its write so no work can enter during persistence. A
    // resume does the inverse: keep the live hold until the clear is safely on disk.
    if (paused) this.paused = true;
    const transition = (async () => {
      try {
        await this.persistPaused(paused);
        this.paused = paused;
      } catch (e) {
        this.paused = previous;
        throw e;
      }
    })();
    this.pauseTransition = transition;
    try {
      await transition;
    } finally {
      if (this.pauseTransition === transition) this.pauseTransition = undefined;
    }
  }

  /** Persist a requested pause value without requiring it to be live first. */
  protected async persistPaused(paused: boolean): Promise<void> {
    if (paused !== this.paused) throw new Error('This index backend cannot persist a pending resume.');
    await this.save();
  }

  private refuseIfPaused(): void {
    if (!this.paused) return;
    throw new Error('Index work is paused. Call zotero_index action:"resume" before build, refresh, or update.');
  }

  /** Full live status: index size + build progress. Backward compatible with status(). */
  buildStatus(): IndexBuildStatus {
    const base = this.status();
    const s: IndexBuildStatus = {
      ...base,
      passages: base.documents,
      state: this.buildState,
      operation: this.operation,
      itemsFetched: this.itemsFetched,
      itemsRemoved: this.itemsRemoved,
      itemsTotal: this.itemsTotal,
      itemsAvailable: this.itemsAvailable,
      phase: this.phase,
      fulltextItemsScanned: this.fulltextItemsScanned,
      fulltextItemsTotal: this.fulltextItemsTotal,
    };
    if (this.resumedFrom !== undefined) s.resumedFrom = this.resumedFrom;
    if (this.localApiDegradedAt !== undefined) {
      s.localApiDegradedAt = new Date(this.localApiDegradedAt).toISOString();
    }
    // Only with a provider in hand: with ZOTEUS_EMBEDDINGS=off, or a key that is unset,
    // every passage lacks a vector by design and reporting a shortfall would be a fiction.
    // Withheld too when the vectors were dropped as another model's, since that has its own
    // notice naming its own remedy and two would be one too many.
    if (this.embedderId && !this.vectorsStale) {
      const missing = base.documents - base.vectors;
      if (missing > 0) s.passagesWithoutVectors = missing;
    }
    const rate = this.embedRate();
    if (rate) s.embedRate = rate;
    if (this.fault) {
      s.state = 'error';
      s.lastError = UNREADABLE_STORE;
    }
    if (this.buildState === 'error' && this.lastBuildError) s.lastError = this.lastBuildError;
    if (this.persistError) s.persistError = this.persistError;
    if (this.updateNotice) s.updateNotice = this.updateNotice;
    return s;
  }

  /**
   * Cooperatively cancel the running build. Returns false if nothing is building.
   * The build halts between pages/batches and keeps whatever was already indexed.
   */
  requestStop(): boolean {
    if (!this.isBuilding || !this.cancelToken) return false;
    this.cancelToken.cancelled = true;
    return true;
  }

  /**
   * Embed arbitrary texts with the configured provider (empty array if none). `kind` says
   * which side of a search they are, which is what an asymmetric model needs to be told.
   */
  async embed(texts: string[], kind: EmbedKind = 'passage'): Promise<number[][]> {
    if (!this.opts.embedder) return [];
    return this.opts.embedder.embed(texts, kind);
  }

  status(): SearchIndexStatus {
    const c = this.counts();
    const s: SearchIndexStatus = {
      documents: c.documents,
      paused: this.paused,
      vectors: c.vectors,
      items: c.items,
      storage: this.storage,
      embedder: this.embedderName,
      embedderConfigured: this.embedderConfigured,
      embedderActive: this.embedderActive,
      fulltextEnabled: this.fulltextEnabled,
      fulltextItems: c.fulltextItems,
      fulltextPassages: c.fulltextPassages,
      ownWordsEnabled: this.ownWordsEnabled,
      ownWordsItems: c.ownWordsItems,
      ownWordsPassages: c.ownWordsPassages,
      builtFromVersion: this.builtFromVersion,
      libraryVersion: this.libraryVersion,
      fulltextVersion: this.fulltextVersion,
    };
    if (this.libraryBackend) s.libraryBackend = this.libraryBackend;
    if (this.library) s.library = this.library;
    const reason = this.embedderReason;
    if (reason) s.embedderReason = reason;
    if (this.opts.embedder?.model) s.embedderModel = this.opts.embedder.model;
    if (this.vectorsStale) s.vectorsStaleReason = this.vectorsStale;
    if (this.vectorScan) s.vectorScan = this.vectorScan;
    if (this.vectorScanNotice) s.vectorScanNotice = this.vectorScanNotice;
    if (this.storeNotice) s.storageNotice = this.storeNotice;
    // The one piece of full-text state that outlives the job that recorded it, so it is
    // reported as a fact about the index rather than as a job's reason: an index holding
    // partial coverage still holds it after a restart, when `fulltextReason` (set by a pass,
    // never persisted) has gone (#78). Absent, not false, on the indexes that are whole:
    // this is a flag for the rare damaged one, not a field every caller has to read.
    if (this.fulltextPartial) s.fulltextPartial = true;
    if (this.fulltextEnabled && this.fulltextUnavailable) s.fulltextReason = this.fulltextUnavailable;
    // And a sentence to go with it when no pass in this process has left one. It has to say
    // what the mark costs as well as what it means: the next full-text update may pay a
    // whole body crawl, which on a large library is the thing a caller wants to know before
    // starting one.
    else if (this.fulltextPartial) s.fulltextReason = this.partialCoverageNotice();
    if (this.ownWordsUnavailable) s.ownWordsReason = this.ownWordsUnavailable;
    return s;
  }

  /**
   * What the status says about partial coverage when no pass in this process has said
   * anything: after a restart, or on any status poll between updates (#78).
   *
   * Two sentences, because the mark is two facts. What the index holds (body text gathered
   * over a map that never reached the end of the library, so an item holding passages may
   * still be missing an attachment's text, and no cursor was stamped), and what the next
   * full-text update will do about it (one whole body re-read, or, past the bound, only the
   * items holding no body text at all).
   */
  protected partialCoverageNotice(): string {
    const stuck = this.fulltextRecoveryAttempts >= FULLTEXT_RECOVERY_ATTEMPTS;
    return (
      "This index's attachment full text is PARTIAL: it was gathered over an attachment map that never " +
      'reached the end of the library, so an item holding body passages may still be missing the text of an ' +
      'attachment on a page that map never listed, and nothing in either of Zotero\'s version sequences will ' +
      'ever name it. ' +
      // Which of the two shapes this index is in. A build over a truncated map earned no
      // cursor at all; a delta that rewrote an item's body text over one damaged coverage an
      // earlier pass had already stamped a cursor for, and that cursor stands (#78). Saying
      // "fulltextVersion 0" on the second shape would contradict the number printed beside it.
      (this.fulltextVersion === 0
        ? 'No full-text cursor was recorded because of it (fulltextVersion 0). '
        : `This index still holds the cursor it earned before the gap (fulltextVersion ${this.fulltextVersion}), ` +
          'which is why the next full-text update asks the sequence from the start rather than from there. ') +
      (stuck
        ? `The re-read that would make this coverage whole has failed ${this.fulltextRecoveryAttempts} time(s) on ` +
          'body text that could not be read, so it is no longer attempted: each zotero_index action:"update" now ' +
          'fills in only the items holding no body text at all. Run zotero_index action:"refresh" with ' +
          'fulltext:true to rebuild this index and clear the mark.'
        : 'The next zotero_index action:"update" asked for full text re-reads the body text of every indexed ' +
          "item Zotero's full-text census names, once, as soon as its own attachment map reaches the end of the " +
          'library: one whole body crawl, which on a large library takes as long as the full-text pass of a ' +
          'build. zotero_index action:"refresh" with fulltext:true rebuilds instead, though a library whose ' +
          'attachment map cannot reach the end at all will be marked again by that build.')
    );
  }

  get isEmpty(): boolean {
    // Never "empty" while faulted: an empty index invites a helpful automatic first build
    // (zotero_semantic_search's auto_build does exactly that), and building into a store
    // that cannot be read is not help.
    if (this.fault) return false;
    return this.counts().documents === 0;
  }

  protected reset(): void {
    this.clearStore();
    // The vectors are gone, so their provenance and any staleness verdict go with them.
    this.vectorEmbedderId = undefined;
    this.vectorsStale = undefined;
    // So is the version stamp: an emptied index is a delta from nothing, and a stamp left
    // behind would make the next update fetch `?since=` against passages that are gone.
    this.libraryVersion = 0;
    this.libraryBackend = undefined;
    // Both cursors go for the same reason: the full-text one names text that is no longer
    // indexed, and the checkpoint names a crawl whose committed rows have just been erased.
    this.fulltextVersion = 0;
    // An emptied store holds no body text at all, so it holds no partial coverage either:
    // whatever build follows this defines its coverage from nothing. The recovery count
    // goes with it: it counts attempts at a debt this store no longer owes, and an index
    // that kept it would arrive at its bound having never re-read anything (#78). This is
    // what makes action:"refresh" (a build with fresh:true), and any other build that does
    // not resume a checkpoint, the way out of a recovery that keeps failing.
    this.fulltextPartial = false;
    this.fulltextRecoveryAttempts = 0;
    this.checkpoint = undefined;
    // And the library stamp: an emptied store holds nobody's rows. The build that called
    // this restamps its own library immediately after (the guard already ran before it).
    this.library = undefined;
  }

  async build(libraryItems: any[], opts: BuildOptions = {}): Promise<SearchIndexStatus> {
    this.refuseIfFaulted();
    this.refuseIfPaused();
    this.reset();
    // A rebuild is the retry: clear a previous runtime failure so a provider that has since
    // been fixed (model downloaded, package installed) reports healthy again.
    this.embedderError = undefined;
    // Whatever this build embeds carries the current embedder's identity.
    this.vectorEmbedderId = this.embedderId;
    // This path indexes metadata (plus any caller-supplied extraText), never attachment
    // full text, so it must not inherit a previous incremental build's verdict.
    this.fulltextEnabled = false;
    this.fulltextUnavailable = undefined;
    const records: ChunkRecord[] = [];
    for (const item of libraryItems) {
      const d = item.data ?? item;
      const key = item.key ?? d.key;
      if (!key) continue;
      this.putItem(key, d.title ?? '(untitled)');
      const base = itemText(d);
      const extra = opts.extraText?.get(key);
      const text = extra ? `${base}. ${extra}` : base;
      for (const ch of chunkText(text)) {
        const rec: ChunkRecord = { id: `${key}#${ch.index}`, itemKey: key, title: d.title ?? '(untitled)', text: ch.text };
        if (!this.storePassage(rec)) continue;
        // Same rule as the incremental path: a vector the store can produce for itself is
        // never bought from the embedder a second time (#34).
        if (this.hasEmbedder && this.adoptVector(rec)) continue;
        records.push(rec);
      }
    }
    if (this.opts.embedder && records.length) {
      try {
        const vecs = await this.opts.embedder.embed(records.map((r) => r.text), 'passage');
        records.forEach((r, i) => {
          if (vecs[i]) this.putVector(r.id, vecs[i]!);
        });
      } catch (e) {
        this.noteEmbedFailure(e);
      }
    }
    this.builtFromVersion = opts.version ?? 0;
    this.finalizeVectors();
    this.refreshDroplist(true);
    return this.status();
  }

  /**
   * Whether this build can carry on from where an interrupted one stopped, and from where.
   *
   * The checkpoint alone is not enough: it describes rows this index still has to be
   * holding, embedded by the model it still has to be using. A resume under another
   * embedder would leave two vector spaces in one index, which is the very thing
   * `updateBlocker` refuses a delta over.
   */
  private resumeFrom(opts: IncrementalBuildOptions): BuildCheckpoint | undefined {
    if (opts.fresh) return undefined;
    const cp = this.checkpoint;
    if (!cp) return undefined;
    // Nothing committed: a resume would be a build with extra steps, and its "no version
    // stamp" report would be misleading rather than merely redundant.
    if (this.counts().documents === 0) return undefined;
    if ((cp.embedderId ?? undefined) !== this.embedderId) return undefined;
    return cp;
  }

  /**
   * Whether a checkpoint's crawl OFFSET can still be trusted, judged from the first page
   * the resumed crawl read.
   *
   * Only the offset: the committed rows are kept either way, since they are keyed by item
   * key, which means the same thing on both APIs and at any offset. What can go stale is
   * the position: Zotero pages items newest-modified first, so one item touched while the
   * build was stopped shifts every later item down by one, and resuming at the old offset
   * would step over an item that was never indexed. The library's own totals are what
   * detect that, and they are the only identity the desktop app offers: it commonly serves
   * no Last-Modified-Version at all, which is precisely why the version stamp could never
   * be the resume cursor (#24).
   */
  private offsetStillHolds(cp: BuildCheckpoint, page: PageResult, backend: VersionBackend | undefined): boolean {
    if (cp.backend !== backend) return false;
    if (cp.itemsAvailable && page.totalResults && cp.itemsAvailable !== page.totalResults) return false;
    if (cp.crawlVersion && page.lastModifiedVersion && cp.crawlVersion !== page.lastModifiedVersion) return false;
    return true;
  }

  /**
   * Asynchronous, incremental, resumable index build.
   *
   * Pages items via `fetchPage`, chunks/keyword-indexes them as they arrive, embeds in
   * small batches, and atomically persists partial progress along the way — so a
   * timeout, crash, or `requestStop()` never leaves a corrupt index and whatever was
   * saved stays queryable. Returns the final build status; the caller should kick this
   * off without awaiting (fire-and-forget) and poll `buildStatus()`.
   *
   * A build that finds a checkpoint from an interrupted run carries on from it instead of
   * clearing the store and crawling from 0: the committed passages stay searchable and are
   * never re-chunked or re-embedded, and only the work since the last commit is redone
   * (#24). `opts.fresh` is how a caller asks for the old behaviour outright.
   */
  async buildIncremental(fetchPage: PageFetcher, opts: IncrementalBuildOptions = {}): Promise<IndexBuildStatus> {
    this.refuseIfFaulted();
    this.refuseIfPaused();
    // Before anything is cleared: a build for a different library than the rows held must
    // refuse here rather than reach reset() below (startIndexBuild also asserts this
    // synchronously, so tool callers see the refusal rather than a logged rejection).
    if (opts.library) this.assertLibrary(opts.library);
    if (this.isBuilding) throw new Error('Index build already in progress; poll action:"status".');
    // Read before anything is reset, and in the synchronous prologue, so the status the
    // fire-and-forget caller returns to its user already says a resume is what started.
    const resume = this.resumeFrom(opts);
    this.buildState = 'building';
    this.operation = 'build';
    this.lastBuildError = undefined;
    this.embedderError = undefined;
    this.persistError = undefined;
    // A rebuild is the retry for full text too: clear the previous run's verdict so a
    // library that has since been extracted in Zotero stops reporting the old reason.
    this.fulltextUnavailable = undefined;
    // Same rule: this job reports on itself. Zotero having fallen over during the LAST
    // build says nothing about this one, and leaving the stamp would make a healthy build
    // look degraded for as long as the index lives.
    this.localApiDegradedAt = undefined;
    this.itemsRemoved = 0;
    // This job reports its own rate, like everything else here: the pacing of the last
    // build says nothing about whether this one will be throttled.
    this.embedBatchInUse = undefined;
    this.embedDelayInUse = 0;
    this.embedChars = 0;
    this.embedMs = 0;
    this.phase = 'metadata';
    this.fulltextItemsScanned = 0;
    this.fulltextItemsTotal = 0;
    this.resumedFrom = undefined;
    // Carried from the caller, e.g. the reason an update fell back to this rebuild, so it
    // must survive the reset below rather than being cleared with the rest of the state.
    this.updateNotice = opts.note;
    const token = { cancelled: false };
    this.cancelToken = token;
    this.duplicatePassages = 0;
    /**
     * Items already in the store when a resumed build began, so its crawl can step over
     * them: an item committed by the run being continued is already chunked, already
     * embedded and already searchable, and re-indexing it would pay for it twice and (on
     * a re-crawl from the top) risk writing its passages a second time. Bounded by items,
     * not by passages, so finding the resume point never walks the index.
     */
    let known: Set<string> | undefined;
    /**
     * Items THIS crawl has indexed, so a page that serves one of them again is stepped over.
     * Both Zotero APIs page newest-modified first, and the crawl asks for no other order, so
     * an item anyone edits while the library is being paged (another client's annotation, a
     * tag edit, a sync) moves to the front and shifts every item behind it down by one: the
     * item at the last page boundary is then served again at the top of the next page. Left
     * to the insert, that second copy aborted the whole build with `UNIQUE constraint
     * failed: passages.id` some 1,300 items into a 10,500-item library (#59).
     */
    const indexed = new Set<string>();
    let duplicateItems = 0;
    /** Passages this run embedded on behalf of the interrupted one (see backfillVectors). */
    let backfilled = 0;
    if (resume) {
      // The store is kept exactly as it is, so what it holds keeps answering queries
      // throughout, and the counters it was committed with come back with it.
      this.itemsTotal = resume.itemsTotal;
      this.itemsAvailable = resume.itemsAvailable;
      known = new Set(this.listItemKeys());
      this.itemsFetched = known.size;
      this.resumedFrom = known.size;
    } else {
      this.itemsFetched = 0;
      this.itemsTotal = 0;
      this.itemsAvailable = 0;
      this.reset();
    }
    // A resumed build inherits the body passages the interrupted one committed, so it is a
    // full-text index whether or not this run was asked to crawl any more of them.
    this.fulltextEnabled = Boolean(opts.fulltextFor) || (resume ? this.counts().fulltextPassages > 0 : false);
    this.ownWordsEnabled = Boolean(opts.ownWords) || (resume ? this.counts().ownWordsPassages > 0 : false);
    // Same rule as full text: a rebuild is the retry, so a library whose children have
    // since become listable stops reporting the old reason.
    this.ownWordsUnavailable = undefined;
    // Stamped before the first row, not at completion: every partial persist carries the
    // identity of the library it belongs to, so even an interrupted build stays guarded.
    // After the resume branch above, so a continued build restamps the identity it was
    // already asserted against rather than leaving a resumed store unstamped.
    //
    // Only when one was given, which is what updateIncremental already does. A bare
    // assignment wrote `undefined` over an existing stamp, so a caller that omitted the
    // option both skipped assertLibrary above AND disarmed the guard (and the vector
    // salvage refusal, which reads the same stamp) for everyone after it. Every caller in
    // src supplies one; leaving the stamp alone is the safe reading of "not stated".
    if (opts.library) this.library = opts.library;
    this.vectorEmbedderId = this.embedderId;

    const embedBatchSize = opts.embedBatchSize ?? DEFAULT_EMBED_BATCH_SIZE;
    const embedBatchDelayMs = opts.embedBatchDelayMs ?? 0;
    const persistEveryItems = opts.persistEveryItems ?? 200;
    const persistEveryMs = opts.persistEveryMs ?? 10_000;
    // The full-text pass writes far bulkier rows than the metadata pass, and on the JSON
    // backend a persist re-serializes the whole index, so it saves on its own slower
    // cadence. Keeping the two apart is what lets the metadata pass stay durable early.
    const persistEveryItemsFt = opts.persistEveryItemsFulltext ?? persistEveryItems;
    const persistEveryMsFt = opts.persistEveryMsFulltext ?? persistEveryMs;
    const progressEveryItems = opts.progressEveryItems ?? 500;
    const progressEveryMs = opts.progressEveryMs ?? 10_000;
    const maxItems = opts.maxItems;
    // Kept on the instance as well as in scope so `noteLocalApiDegraded` can lower it
    // mid-crawl. `startIndexBuild` always supplies a value, chosen by the API serving
    // this job; the fallback is for callers that drive the index directly.
    const fulltextLimit = (this.fulltextLimit = new Semaphore(
      Math.max(1, opts.fulltextConcurrency ?? DEFAULT_FULLTEXT_CONCURRENCY_CLOUD),
    ));
    // Without an explicit hook the index persists itself: the SQLite backend commits its
    // open transaction here, so "persist" and "make the last N items durable" are one act.
    const persist = opts.persist ?? (() => this.save());

    const pending: ChunkRecord[] = []; // passages awaiting embedding
    /**
     * Items to come back to in the full-text pass, in crawl order. Only allocated when
     * full text was asked for, and holds a key and a title rather than the item, so it
     * costs a couple of hundred bytes per item and is bounded by `maxItems` rather than by
     * the library. Re-crawling the library instead would be free of this, but items added
     * or removed between the passes shift the pagination under it, so the second crawl
     * would fetch text for items this index does not hold and miss ones it does.
     */
    const worklist: Array<{ key: string; title: string }> | undefined = opts.fulltextFor ? [] : undefined;
    // A resume's crawl never re-reads the items it inherited, so their place in the
    // full-text worklist comes from the store instead, in the order they were indexed.
    // Appended one by one rather than spread: the list is as long as the library, and a
    // spread that long is an argument list long enough to overflow the stack.
    if (worklist && resume) for (const entry of this.listItems()) worklist.push(entry);
    /** Set when the full-text pass could not read anything at all; see where it is used. */
    let fulltextPassFailed = false;
    let fulltextFailures = 0;
    /** Set when the attachment map behind that pass covered only part of the library. */
    let fulltextMapIncomplete = false;
    // Where the crawl reads next, and the one number a resume needs: it was committed with
    // the rows, so what a resume redoes is bounded by the last persistence interval.
    let start = resume ? resume.crawlOffset : 0;
    // A resumed build stamps the version the INTERRUPTED crawl began from, not the one it
    // sees now. Everything modified in between then sorts after the stamp and is still
    // waiting for the next update, exactly as it would have been had the build run through.
    let crawlVersion = resume?.crawlVersion ?? 0;
    // Cleared by the first page a resume reads, which is where the stored offset is either
    // confirmed or abandoned in favour of a walk from the top.
    let offsetUnverified = Boolean(resume);
    /** Set when that verification failed and the crawl went back to the top. */
    let recrawled = false;
    /**
     * Say outright that this build is continuing an interrupted one rather than starting
     * over. Written in the prologue, so a caller polling status while the crawl runs is
     * told what it is watching, and again at the end, once whether the offset held is
     * known. Without it, a resume and the rebuild-from-0 it replaced look identical from
     * the outside, which is how #24 was reported in the first place.
     */
    const noteResumed = (): void => {
      const how = recrawled
        ? 'The library had moved on since, so the crawl walked the whole library again to be sure of covering it, ' +
          'but nothing already indexed was re-chunked or re-embedded.'
        : `The crawl picked up at item ${resume!.crawlOffset}, so nothing already indexed was re-fetched or re-embedded.`;
      // Said outright because it is the expensive part and the part that used to be
      // repeated: an embedder that failed mid-build leaves passages committed without
      // vectors, and buying only those is the whole difference between a resume and a
      // rebuild on a library whose full-text pass costs tens of dollars (#48).
      const filled = backfilled
        ? ` ${backfilled} passage(s) the interrupted build committed without vectors were embedded here, and only those.`
        : '';
      const resumed = `This build RESUMED an interrupted one: ${this.resumedFrom} items were already indexed. ${how}${filled}`;
      this.updateNotice = opts.note ? `${opts.note} ${resumed}` : resumed;
    };
    if (resume) noteResumed();
    let itemsSincePersist = 0;
    let lastPersistAt = Date.now();
    let itemsSinceLog = 0;
    let lastLogAt = Date.now();

    /**
     * Record where a resume would pick this build up. Called immediately before every
     * persist, so the checkpoint and the rows it describes reach disk in the same write
     * (on SQLite, the same transaction): a checkpoint ahead of the rows would skip items
     * that were never committed.
     */
    const noteCheckpoint = (): void => {
      this.checkpoint = {
        phase: this.phase,
        crawlOffset: start,
        itemsAvailable: this.itemsAvailable,
        itemsTotal: this.itemsTotal,
        maxItems: maxItems ?? 0,
        crawlVersion,
        fulltext: Boolean(opts.fulltextFor),
        ...(opts.versionBackend ? { backend: opts.versionBackend } : {}),
        ...(this.vectorEmbedderId ? { embedderId: this.vectorEmbedderId } : {}),
        ...(pending.length ? { pendingPassages: pending.map((r) => r.id) } : {}),
      };
    };

    const persistNow = async (): Promise<void> => {
      itemsSincePersist = 0;
      lastPersistAt = Date.now();
      try {
        await persist();
        this.persistError = undefined;
      } catch (e) {
        // Recorded, not only logged: the status this build reports has to carry the fact
        // that its artifact is memory-only, or "done" is a lie (#10).
        this.persistError = e instanceof Error ? e.message : String(e);
        this.opts.logger?.warn(`Could not persist index: ${this.persistError}`);
      }
    };
    const maybePersist = async (): Promise<void> => {
      const everyItems = this.phase === 'fulltext' ? persistEveryItemsFt : persistEveryItems;
      const everyMs = this.phase === 'fulltext' ? persistEveryMsFt : persistEveryMs;
      if (itemsSincePersist < everyItems && Date.now() - lastPersistAt < everyMs) return;
      noteCheckpoint();
      await persistNow();
    };
    const forceLog = (): void => {
      itemsSinceLog = 0;
      lastLogAt = Date.now();
      const s = this.buildStatus();
      this.opts.logger?.info(`index build: ${progressLine(s)}`);
      opts.onProgress?.(s);
    };
    const maybeLog = (): void => {
      if (itemsSinceLog < progressEveryItems && Date.now() - lastLogAt < progressEveryMs) return;
      forceLog();
    };
    const embedPending = (force: boolean): Promise<void> =>
      this.embedPending(pending, token, embedBatchSize, embedBatchDelayMs, force);

    /**
     * Embed the committed passages that carry no vector, a page at a time.
     *
     * A page rather than one list, because after a provider failure partway through a
     * full-text build there can be tens of thousands, and holding every passage's text in
     * memory at once would trade one failure mode for another. The loop ends when the store
     * answers with none, when the embedder dies again (`hasEmbedder` goes false and there
     * is nothing more to be bought), or when a round fails to reduce the shortfall, which
     * is the guard against asking forever for rows nothing can fill.
     */
    const backfillVectors = async (): Promise<number> => {
      if (!this.hasEmbedder) return 0;
      const shortfall = (): number => {
        const c = this.counts();
        return c.documents - c.vectors;
      };
      let remaining = shortfall();
      let embedded = 0;
      while (remaining > 0 && this.hasEmbedder && !token.cancelled) {
        const batch = this.passagesMissingVectors(VECTOR_BACKFILL_GROUP);
        if (!batch.length) break;
        if (!embedded) {
          this.opts.logger?.info(
            `index build: embedding ${remaining} passage(s) an interrupted build committed without vectors.`,
          );
        }
        for (const rec of batch) pending.push(rec);
        await embedPending(true);
        const left = shortfall();
        if (left >= remaining) break;
        embedded += remaining - left;
        remaining = left;
        itemsSinceLog += batch.length;
        itemsSincePersist += batch.length;
        maybeLog();
        await maybePersist();
      }
      return embedded;
    };

    try {
      // The passages the interrupted run had written but not yet embedded, re-queued
      // through the same path everything else takes. They are committed and searchable on
      // keywords already; this is what stops a resumed index from settling a batch of
      // vectors short of the one an uninterrupted build produces.
      if (resume?.pendingPassages?.length && this.hasEmbedder) {
        for (const id of resume.pendingPassages) {
          const rec = this.passage(id);
          if (rec) pending.push(rec);
        }
      }
      for (;;) {
        if (token.cancelled) break;
        if (maxItems !== undefined && this.itemsFetched >= maxItems) break;
        const page = await fetchPage(start);
        if (offsetUnverified) {
          offsetUnverified = false;
          if (!this.offsetStillHolds(resume!, page, opts.versionBackend)) {
            // The library moved while this build was stopped, so the stored offset points
            // somewhere else now. Walk from the top instead: the committed rows are kept
            // and stepped over by key, so this costs pages, never re-chunking or re-embedding.
            start = 0;
            recrawled = true;
            // The totals came back with the checkpoint and are exactly what just failed to
            // match, so let the next page re-derive them.
            this.itemsTotal = 0;
            this.itemsAvailable = 0;
            continue;
          }
        }
        // The library as it stood when the crawl began: recorded once, from the first page,
        // so a change made mid-crawl stays after the stamp and the next update still sees it.
        if (!crawlVersion && page.lastModifiedVersion) crawlVersion = page.lastModifiedVersion;
        const pageItems = page.items ?? [];
        if (pageItems.length === 0) break;
        if (!this.itemsTotal && page.totalResults) {
          this.itemsAvailable = page.totalResults;
          this.itemsTotal = maxItems !== undefined ? Math.min(page.totalResults, maxItems) : page.totalResults;
        }
        /**
         * Items of this page the crawl actually got through, which is what `start` may
         * advance by. Not the page's length: a stop lands between two items, and counting
         * the whole page would put the checkpoint's offset past items nothing indexed, and
         * a resume would then step over them and they would never be indexed at all.
         */
        let consumed = 0;
        for (const item of pageItems) {
          if (token.cancelled) break;
          // Only the items that still fit under the cap are worth indexing at all. Checked
          // per item rather than by slicing the page, because an item a resume already
          // holds costs nothing against the cap and must not consume one of its places.
          if (maxItems !== undefined && this.itemsFetched >= maxItems) break;
          consumed++;
          const key = itemKeyOf(item);
          // Already committed by the run this one is resuming: it is indexed, embedded and
          // searchable, and its place in the full-text worklist came from the store.
          if (known?.has(key)) continue;
          // Served a second time by a page boundary that moved under the crawl (see
          // `indexed`): the first copy is what the index holds, and the edit that moved it
          // is after the crawl's version stamp, so the next update sees it.
          if (key && indexed.has(key)) {
            duplicateItems++;
            continue;
          }
          // In the metadata pass, not a pass of its own: the census behind this is already
          // resident by the first item, so an item's own words cost no request here, and
          // writing them with the item means one commit covers the item entirely — which
          // is what lets a resume step over an item by key and know it is complete. Read
          // before the item's writes begin, so those writes can be one synchronous unit.
          const words = key && opts.ownWords ? await opts.ownWords.textsFor(key) : undefined;
          const entry = this.indexItem(item, words, pending);
          if (key) indexed.add(key);
          // Recorded now, crawled in the second pass. Truncating here rather than there is
          // what keeps the item cap honest without re-checking it against a moving count.
          if (entry && worklist) worklist.push(entry);
          this.itemsFetched++;
          itemsSincePersist++;
          itemsSinceLog++;
        }
        start += consumed;
        await embedPending(false);
        maybeLog();
        await maybePersist();
        if (start >= page.totalResults) break;
      }

      // The boundary between the two passes. Everything the library holds is now indexed on
      // its own text, so the drain and the save are forced rather than left to the cadence:
      // this is the moment the whole change exists to create, and a metadata pass whose last
      // partial embedding batch or last few hundred rows never left memory has not really
      // reached it. Without the forced drain those passages stay vector-less for the length
      // of the full-text crawl and semantic search silently misses them; without the forced
      // save nothing survives a restart, and a second process sharing the data dir sees
      // nothing at all.
      if (!token.cancelled) await embedPending(true);
      noteCheckpoint();
      await persistNow();

      if (worklist && !token.cancelled) {
        // Flipped BEFORE the attachment crawl, not after it. Listing a library's attachments
        // is itself a paged crawl that can take a while on a large library, and reporting the
        // metadata phase throughout it would tell a caller that pass was still running when
        // in fact it had finished and the library was already searchable. Forced through the
        // logger too, so the change shows up on the very next status poll rather than
        // whenever the progress cadence next comes round.
        this.phase = 'fulltext';
        this.fulltextItemsTotal = worklist.length;
        forceLog();
        // Said once, at the start of the pass that does the spending, because this is the
        // pass where an API provider's tokens-per-minute limit decides whether the build
        // finishes. The metadata pass is over in minutes and never reaches a rate that
        // matters; the body crawl runs for hours at whatever pace these two dials set, and
        // until #48 nothing anywhere printed what that pace was.
        const plan = this.embedRate();
        if (plan) this.opts.logger?.info(`index build: embedding through ${this.opts.embedder!.name} at ${embedRateLine(plan)}.`);
        // Items whose attachments Zotero has no extracted text for are dropped here rather
        // than awaited one by one: on a library where a minority of items have PDFs that is
        // most of the worklist, and each would otherwise cost a round trip to learn nothing.
        const servable = await opts.fulltextKeys?.().catch(() => undefined);
        const wanted = servable ? worklist.filter((e) => servable.has(e.key)) : worklist;
        this.fulltextItemsTotal = wanted.length;
        // A resumed pass skips the items whose body text is already in the store, which is
        // both the resume point and the reason no body is ever fetched or embedded twice.
        // Position in the worklist could not do this job: which items are servable is
        // decided by a census taken now, and Zotero may have extracted more since.
        const todo = resume ? wanted.filter((e) => !this.hasFulltext(e.key)) : wanted;
        this.fulltextItemsScanned = wanted.length - todo.length;
        for (let i = 0; i < todo.length && !token.cancelled; i += PAGE_GROUP) {
          const group = todo.slice(i, i + PAGE_GROUP);
          const texts = await this.fulltextForKeys(group, opts, token, fulltextLimit);
          for (let j = 0; j < group.length; j++) {
            if (token.cancelled) break;
            const text = texts?.[j];
            if (text) this.indexFulltext(group[j]!.key, group[j]!.title, text, pending);
            this.fulltextItemsScanned++;
            itemsSincePersist++;
            itemsSinceLog++;
          }
          await embedPending(false);
          maybeLog();
          await maybePersist();
        }
        if (!token.cancelled) await embedPending(true);

        // Every full-text read failure is caught per item, so that one unreadable PDF
        // cannot abort a build. The consequence is that this pass ALWAYS reaches its end,
        // including when the desktop app it was reading from quit halfway through and every
        // remaining read failed. Left there, the build would report `done`, stamp itself
        // complete, and be silently missing most of its body text for good: the items it
        // never read are unchanged in Zotero, so no `?since=` delta will ever revisit them.
        const failures = opts.fulltextFailures?.() ?? 0;
        fulltextFailures = failures;
        // The other half of the same question, and it cannot be derived from the count
        // above. `servable` narrowed the worklist to the keys the attachment map reached,
        // so the attachments on the pages that map never listed were never asked for and
        // never failed: from in here a build over a sixth of a library is indistinguishable
        // from a complete one (#78).
        fulltextMapIncomplete = opts.fulltextMapIncomplete?.() ?? false;
        if (failures > 0 && !token.cancelled) {
          fulltextPassFailed = failures >= todo.length;
          this.fulltextUnavailable =
            `The body text of ${failures} of ${todo.length} item(s) could not be read (the Zotero app or the ` +
            'Web API stopped answering during the full-text pass), so those items are indexed from metadata only.' +
            (fulltextPassFailed
              ? ' No version stamp was recorded, so the next zotero_index action:"update" rebuilds rather than' +
                ' treating this index as current.'
              : ' Re-run zotero_index action:"build" with fulltext:true to fill them in.');
          this.opts.logger?.warn(this.fulltextUnavailable);
        }
        // Folded onto whatever sentence stands rather than replacing it: the cause is
        // already there (the source's own "the attachment map stopped early after N/M", or
        // the read failures just described) and what it does not say is the consequence.
        // A caller reading the status needs both, because this is the one thing about this
        // build that outlives it.
        if (fulltextMapIncomplete && !token.cancelled) {
          const cause = (this.fulltextUnavailable ?? '').trim();
          const lead = cause ? (/[.!?]$/.test(cause) ? `${cause} ` : `${cause}. `) : '';
          this.fulltextUnavailable =
            `${lead}No full-text cursor was recorded, because the version it would carry is the whole ` +
            "library's and this map is not. A later zotero_index action:\"update\" asked for full text " +
            "therefore starts from the beginning of Zotero's full-text sequence: the first one whose own " +
            'attachment map reaches the end of the library re-reads the body text of every indexed item that ' +
            'sequence names, including the ones whose attachments this map reached only some of. Until then ' +
            'each update fills in only the items holding no body text at all, and this notice stands.';
          this.opts.logger?.warn(this.fulltextUnavailable);
        }
      }

      // The last thing a resumed build does, and the half of #48 the checkpoint alone does
      // not fix. An embedder that died mid-build left thousands of passages committed,
      // keyword-searchable and vector-less; the crawl above steps over their items by key
      // and the full-text pass steps over them with `hasFulltext`, precisely because they
      // ARE indexed. Only this comes back for them, and only for the embedding: no page is
      // re-fetched, no PDF is re-read, no passage is re-chunked.
      if (resume && !token.cancelled) backfilled = await backfillVectors();

      this.builtFromVersion = this.itemsFetched;
      // A cancelled crawl covers an unknown prefix of the library, so it gets no stamp: an
      // update against one would treat every item it never reached as unchanged forever.
      //
      // This has to stay AFTER the full-text pass, and that is the one thing the two-pass
      // split must not get wrong. A stamp asserts that the index is complete in every
      // dimension the build was asked for, as of version V. Stamping after the metadata
      // pass would make a build interrupted partway through a days-long full-text crawl
      // indistinguishable from a finished one: the next action:"update" would find a valid
      // stamp, a matching backend and a matching embedder, run a `?since=V` delta, and see
      // nothing — the items whose attachments were never crawled are unchanged in Zotero,
      // so they appear in no delta, ever. Their body text would be missing permanently and
      // nothing would say so, because `fulltextEnabled` is true and `fulltextReason` unset.
      //
      // An embedder that failed is withheld from the stamp on the same grounds. The index
      // is complete on text and incomplete on vectors, and a stamp would let the next
      // action:"update" run a `?since=V` delta that finds nothing to do: the passages
      // missing vectors belong to items Zotero has not touched, so they appear in no delta,
      // ever, and the index would sit half-embedded for good. Without the stamp the update
      // falls back to a build, and that build resumes and finishes the embedding (#48).
      if (!token.cancelled && crawlVersion && !fulltextPassFailed && !this.embedderError) {
        this.libraryVersion = crawlVersion;
        this.libraryBackend = opts.versionBackend;
      }
      // The other sequence's cursor, and it is withheld one notch more strictly than the
      // stamp: an item whose body could not be read holds no passages, and leaving the
      // cursor where it was is exactly what sends the next update back for it (#26).
      //
      // An attachment map that stopped early withholds it for the same reason one notch
      // earlier (#78). The version this would stamp is the high-water mark of the WHOLE
      // full-text census, taken before the map was walked, so a build that mapped 1696 of
      // 8953 attachments would claim the other 7257 as covered, and they are then named by
      // no `?since=` on either sequence, because their items never changed. It is
      // exactly the silent gap #26 and #67 closed on the update path, reached by the one
      // door the build path left open.
      //
      // Only this cursor is withheld: `libraryVersion` above is stamped as usual. The
      // metadata pass really did finish, and withholding the item stamp would turn every
      // subsequent action:"update" into a full rebuild on precisely the libraries too big
      // to finish one. It is not needed either: with no cursor a later update asked for full
      // text asks `/fulltext?since=0`, which names every attachment Zotero has extracted, and
      // the flag set just below is what makes the first such update whose own map reaches the
      // end of the library read all of them rather than only the items holding no passages at
      // all. An update over a map that stops short again fills that gap and no more.
      if (!token.cancelled && worklist && fulltextFailures === 0 && !fulltextMapIncomplete) {
        this.fulltextVersion = opts.fulltextVersion?.() ?? this.fulltextVersion;
      }
      // Withholding the cursor is only half of it. An update with no cursor asks `?since=0`
      // and gets the whole census back, but it narrows that to the index's coverage GAP (the
      // items holding no body passages at all), and an item whose attachments straddled the
      // cut holds passages already, so it would be skipped and then stamped past. What the
      // recovery needs to know is that this build's coverage cannot be read off the
      // passages it left behind, and that is what this records, durably (#78).
      if (!token.cancelled && worklist && fulltextMapIncomplete) this.fulltextPartial = true;
      // A finished build has nothing left to resume; a stopped one is the whole point of
      // keeping this, and its checkpoint has to reach disk in the same write as its rows.
      //
      // A build the embedder died in counts as unfinished, and dropping its checkpoint is
      // exactly how #48 turned six transient 429s into six full rebuilds: the pass carried
      // on writing passages BM25-only, reached the end, reported `done`, and cleared the
      // one record that would have let the next build pick up the un-embedded remainder.
      // It kept everything except the ability to continue.
      if (token.cancelled || this.embedderError) noteCheckpoint();
      else this.checkpoint = undefined;
      // Before the persist, so the codes derived from these vectors are committed by the
      // same transaction that makes the vectors durable. A cancelled build gets them too:
      // its partial index stays searchable, and it would otherwise pay for them on the
      // first query instead.
      this.finalizeVectors();
      // A stopped build gets one too, for the same reason its codes are built: its partial
      // index stays queryable, and a droplist derived from most of the corpus is a far
      // better answer for it than none at all.
      this.refreshDroplist(true);
      await persistNow();
      this.buildState = 'done';
      if (resume) noteResumed();
      // Said once, with the numbers, because the same condition used to end the build with
      // a constraint error and no explanation: a library edited while it is being paged
      // serves some rows twice, and the edited items themselves belong to the next update.
      if (duplicateItems || this.duplicatePassages) {
        this.opts.logger?.warn(
          `index build: the library changed while it was being paged, so ${duplicateItems} item(s) and ` +
            `${this.duplicatePassages} passage(s) were served twice and indexed once. Anything edited during ` +
            'the crawl is picked up by the next zotero_index action:"update".',
        );
      }
      const final = this.buildStatus();
      this.opts.logger?.info(`index build ${token.cancelled ? 'stopped' : 'complete'}: ${progressLine(final)}`);
      opts.onProgress?.(final);
      return final;
    } catch (e) {
      this.buildState = 'error';
      this.lastBuildError = e instanceof Error ? e.message : String(e);
      this.opts.logger?.error(`index build failed: ${this.lastBuildError}`);
      // Keep whatever partial data we already indexed, and persist it best-effort, with the
      // checkpoint that says where to pick it up: a build that died on page 400 of a crawl
      // must not send the next one back to page 0.
      noteCheckpoint();
      await persistNow().catch(() => {});
      opts.onProgress?.(this.buildStatus());
      return this.buildStatus();
    } finally {
      this.cancelToken = null;
    }
  }

  /**
   * Why a delta update cannot run against this index, or undefined when it can. Every
   * refusal here is a correctness one, not a heuristic: each would otherwise produce an
   * index that looks fresh and is not.
   */
  updateBlocker(backend: VersionBackend): string | undefined {
    if (this.fault) return UNREADABLE_STORE;
    // Every refusal below is read out of this object's memory, and on a shared data dir
    // that memory can be older than the file: a handle held open across another process's
    // headless build still holds the empty, unstamped state it opened on, and every
    // refusal here sends the caller to a full build that clears the store (#68).
    this.refreshFromStore();
    if (!this.supportsDelete) {
      return `the ${this.storage} index cannot remove rows, so deleted items could never leave it`;
    }
    if (this.isEmpty) return 'the index is empty';
    if (!this.libraryVersion) {
      // Two different situations behind one missing stamp, and only one of them means the
      // committed rows are about to be thrown away: an interrupted build left a checkpoint,
      // so the rebuild this refusal sends the caller to carries on from it (#24).
      return this.checkpoint
        ? 'this index carries no library version stamp because the build that would have written one was ' +
            'interrupted; the full build below RESUMES that one rather than starting over'
        : 'this index carries no library version stamp (it predates incremental updates, or its last build was cancelled)';
    }
    if (this.libraryBackend && this.libraryBackend !== backend) {
      return (
        `the stamp came from the ${labelFor(this.libraryBackend)} and this update would be served by the ` +
        `${labelFor(backend)}, whose version sequences are unrelated`
      );
    }
    if (this.embedderId !== this.vectorEmbedderId) {
      return (
        `the stored vectors were produced by ${this.vectorEmbedderId ?? 'no embedder'} and this server now embeds ` +
        `with ${this.embedderId ?? 'no embedder'}, so only the changed items would carry usable vectors`
      );
    }
    return undefined;
  }

  /**
   * Apply a delta update: re-index the items the library changed since the stored version
   * stamp, drop the ones it no longer holds, and leave everything else exactly as it is.
   * Unchanged passages are never re-chunked and never re-embedded, which is the entire
   * point: a seven-item change costs seven items of API spend, not a whole library.
   *
   * Nothing is persisted until the update has fully succeeded, and the version stamp only
   * advances then. A failure rolls the store back (where it can) and leaves the previous
   * stamp in place, so the same delta is simply retried next time.
   */
  async updateIncremental(opts: IncrementalUpdateOptions): Promise<IndexBuildStatus> {
    this.refuseIfFaulted();
    this.refuseIfPaused();
    // Same guard as the full build: a delta for a different library would splice its
    // changes into — and delete "missing" items from — rows that were never its own.
    if (opts.library) this.assertLibrary(opts.library);
    if (this.isBuilding) throw new Error('Index build already in progress; poll action:"status".');
    const fromVersion = this.libraryVersion;
    this.buildState = 'building';
    this.operation = 'update';
    // An update has no two-pass structure, and nothing resets `phase` when a build ends, so
    // without this an update after any fulltext:true build reports the pass it is not in.
    this.phase = 'metadata';
    this.fulltextItemsScanned = 0;
    this.fulltextItemsTotal = 0;
    this.lastBuildError = undefined;
    this.embedderError = undefined;
    this.persistError = undefined;
    this.updateNotice = undefined;
    this.localApiDegradedAt = undefined;
    this.itemsFetched = 0;
    this.itemsRemoved = 0;
    if (opts.fulltextFor) {
      // An update is the retry for full text as well, but only upwards: an index that
      // already holds body passages does not stop being a full-text index when a metadata
      // update runs over it.
      this.fulltextEnabled = true;
      this.fulltextUnavailable = undefined;
    }
    if (opts.ownWords) {
      this.ownWordsEnabled = true;
      this.ownWordsUnavailable = undefined;
    }
    const token = { cancelled: false };
    this.cancelToken = token;

    const embedBatchSize = opts.embedBatchSize ?? DEFAULT_EMBED_BATCH_SIZE;
    const embedBatchDelayMs = opts.embedBatchDelayMs ?? 0;
    const progressEveryItems = opts.progressEveryItems ?? 500;
    const progressEveryMs = opts.progressEveryMs ?? 10_000;
    const maxItems = opts.maxItems;
    // Kept on the instance as well as in scope so `noteLocalApiDegraded` can lower it
    // mid-crawl. `startIndexBuild` always supplies a value, chosen by the API serving
    // this job; the fallback is for callers that drive the index directly.
    const fulltextLimit = (this.fulltextLimit = new Semaphore(
      Math.max(1, opts.fulltextConcurrency ?? DEFAULT_FULLTEXT_CONCURRENCY_CLOUD),
    ));
    const persist = opts.persist ?? (() => this.save());

    const pending: ChunkRecord[] = [];
    // The keys the index holds, which the upsert loop keeps current: it is both the cap
    // check ("is this item already indexed?") and, at the end, the left side of the
    // deletion diff, so the store is walked once rather than per item.
    const known = new Set(this.listItemKeys());
    /** Items this delta re-indexed, which therefore already carry their newest body text. */
    const refreshed = new Set<string>();
    let start = 0;
    let crawlVersion = 0;
    let itemsSinceLog = 0;
    let lastLogAt = Date.now();
    let skippedByCap = 0;
    let reconciled = false;
    let fulltextCursor = this.fulltextVersion;
    let caughtUp = 0;
    let ownWordsRefreshed = 0;
    /**
     * Why this update could not compare, read or attribute every note and annotation, once
     * it could not. Set anywhere own-words work fails and read where the stamp is written:
     * a gap here withholds the stamp, so the next update repeats this delta (#63).
     */
    let ownWordsGap: string | undefined;
    /**
     * Why this update could not read the attachment body text of items the DELTA carried,
     * once it could not. Same rule and same remedy as the own-words gap: the stamp stays
     * where it was, so the next update carries those items again (#67).
     */
    let fulltextGap: string | undefined;
    /**
     * The same, for text the catch-up could not read. That work is on the other sequence
     * (#26), so it withholds the other cursor: these items are in no item delta, and only
     * `/fulltext?since=` will ever offer them again.
     */
    let fulltextStale: string | undefined;
    /** Items either of the two could not read, for the sentence that reports the gap. */
    let fulltextFailed = 0;
    /** Set when this delta indexed body text off a map that stopped short of the library. */
    let fulltextPartialWrite = false;
    /**
     * Set when the catch-up re-read every item the census named, so the index's body text
     * is no longer the partial thing an incomplete map left behind (#78).
     */
    let fulltextRecovered = false;
    /**
     * Set when such a re-read was paid for and still ended on body text it could not read.
     * Counted on the index, because it is what stops a permanently unreadable attachment
     * from buying that crawl again on every update, forever (#78).
     */
    let fulltextRecoveryFailed = false;
    /**
     * A sentence for the status that stands on its own: nothing failed and nothing was
     * withheld, there is simply something the caller has to know (an index holding no body
     * text will never gain any from an update). Kept apart from the gaps above so it is
     * never folded into a "NOT fully updated" report that would then be false.
     */
    let fulltextNotice: string | undefined;

    const maybeLog = (): void => {
      if (itemsSinceLog < progressEveryItems && Date.now() - lastLogAt < progressEveryMs) return;
      itemsSinceLog = 0;
      lastLogAt = Date.now();
      const s = this.buildStatus();
      this.opts.logger?.info(`index update: ${progressLine(s)}`);
      opts.onProgress?.(s);
    };

    try {
      for (;;) {
        if (token.cancelled) break;
        const page = await opts.fetchChanged(start);
        if (!crawlVersion && page.lastModifiedVersion) crawlVersion = page.lastModifiedVersion;
        const pageItems = page.items ?? [];
        if (pageItems.length === 0) break;
        // The items on this page whose body text could NOT be read, which is not the answer
        // an item with no extracted text gives. The upsert below would replace their body
        // passages with that nothing, and the stamp would move past them although their
        // attachments never change in Zotero, so no later delta would ever revisit them
        // (#67). Their indexed body text is read back here and put back after the upsert,
        // and the gap withholds the stamp so the next update reads them again.
        const failedText = new Map<string, string>();
        const texts = await this.fulltextForPage(pageItems, opts, token, fulltextLimit, failedText);
        if (failedText.size) {
          fulltextFailed += failedText.size;
          fulltextGap ??= `the attachment text of the changed items could not be read (${[...failedText.values()][0]})`;
        }
        const keptText = failedText.size ? this.fulltextRecords(failedText.keys()) : undefined;
        // Body text read off a map that never reached the end of the library may be only
        // part of an item's: the map answers for the attachments it listed and knows
        // nothing of the rest, and no read failed to say so. The item is written here all
        // the same (some of its text beats none), and the index records that its full-text
        // coverage is partial, so nothing later mistakes the passages it holds for the whole
        // of its body text: the flag stands until a catch-up over a complete map re-reads
        // the census from the start, whenever this index next has no cursor to work from
        // (#78).
        if (texts?.some((t) => t) && opts.fulltextMapIncomplete?.()) fulltextPartialWrite = true;
        // This page's own words, or undefined when they cannot be trusted: the read threw, or
        // the census opened degraded under it (see noteOwnWordsUnavailable). A degraded
        // census answers "no own words" for an item exactly as it would for a reader who
        // deleted them, so nothing it says may replace what the index holds. The items below
        // are then refreshed with the own words they already carry, and the gap withholds
        // the stamp so the next update reads them again (#63).
        let own: Array<OwnWordsEntry[]> | undefined;
        try {
          own = await this.ownWordsForPage(pageItems, opts, token);
        } catch (e) {
          ownWordsGap ??=
            'the notes and annotations of the changed items could not be read ' +
            `(${e instanceof Error ? e.message : String(e)})`;
        }
        if (this.ownWordsUnavailable) {
          ownWordsGap ??= this.ownWordsUnavailable;
          own = undefined;
        }
        const kept =
          opts.ownWords && !own && !token.cancelled
            ? this.ownWordsRecords(pageItems.map(itemKeyOf))
            : undefined;
        for (let i = 0; i < pageItems.length; i++) {
          if (token.cancelled) break;
          const item = pageItems[i];
          const d = item?.data ?? item;
          const key = item?.key ?? d?.key;
          if (!key) continue;
          // The cap bounds the index, not the delta: an item already in it is refreshed
          // however full the index is, a new one only while there is room under the cap.
          if (!known.has(key) && maxItems !== undefined && known.size >= maxItems) {
            skippedByCap++;
            continue;
          }
          // Upsert. The old passages carry the old text and the old vectors, and their ids
          // are only mostly stable (a shorter abstract yields fewer chunks), so replacing
          // the item wholesale is the only way to leave no orphans behind.
          this.deleteItem(key);
          this.addOneItem(item, pending, texts?.[i], own?.[i]);
          // The own words the upsert took out come back as they were, re-titled after the
          // item and re-embedded only where the store cannot answer their vector: the
          // changed items' notes, once, against a note that stops being findable because a
          // request about something else failed.
          this.restorePassages(kept?.get(key), key, pending);
          // And the body text, on the same terms, when this item's attachments could not be
          // read: an item whose PDF the desktop app was too busy to serve keeps the body
          // passages it has rather than being reduced to its metadata (#67).
          this.restorePassages(keptText?.get(key), key, pending);
          known.add(key);
          refreshed.add(key);
          this.itemsFetched++;
          itemsSinceLog++;
        }
        start += pageItems.length;
        await this.embedPending(pending, token, embedBatchSize, embedBatchDelayMs, false);
        maybeLog();
        if (start >= page.totalResults) break;
      }
      if (!token.cancelled) await this.embedPending(pending, token, embedBatchSize, embedBatchDelayMs, true);

      if (!token.cancelled && opts.fulltextCatchUp && opts.fulltextFor) {
        const catchUp = await this.fulltextCatchUp(opts, known, refreshed, pending, token, fulltextLimit);
        fulltextCursor = catchUp.version;
        caughtUp = catchUp.items;
        fulltextStale ??= catchUp.gap;
        fulltextFailed += catchUp.failed;
        fulltextRecovered = catchUp.recovered;
        fulltextRecoveryFailed = catchUp.recoveryFailed;
        fulltextNotice ??= catchUp.notice;
      }


      if (!token.cancelled) {
        const live = await opts.liveKeys();
        if (live.size === 0 && known.size > 0) {
          // A library reporting no items at all, against an index holding thousands, is a
          // failed read far more often than an emptied library, and acting on it would
          // erase the index. Skip the pass and withhold the stamp so the next update retries.
          this.updateNotice =
            'Deletions were NOT reconciled: the library reported no items at all, which is treated as a failed ' +
            'read rather than an emptied library. The version stamp was left where it was, so the next ' +
            'action:"update" repeats this delta.';
          this.opts.logger?.warn(this.updateNotice);
        } else {
          for (const key of known) {
            if (live.has(key)) continue;
            this.deleteItem(key);
            // Out of the surviving set too: what follows this pass reads `known` as the
            // items the index still holds, and a removed key there would resurrect rows.
            known.delete(key);
            this.itemsRemoved++;
          }
          // The versions scan is a free, exact census of the library, so the truncation
          // counters are re-derived from it rather than left at the last build's figures.
          this.itemsAvailable = live.size;
          this.itemsTotal = maxItems === undefined ? live.size : Math.min(live.size, maxItems);
          this.builtFromVersion = this.counts().items;
          reconciled = true;
        }
      }

      // After the deletion pass, deliberately: an item this update has just removed must
      // not have its notes re-indexed on the way out, and `known` is only the surviving
      // set once that pass has taken its keys out of it.
      if (!token.cancelled && opts.ownWords) {
        const catchUp = await this.ownWordsCatchUp(
          opts,
          fromVersion,
          known,
          refreshed,
          pending,
          token,
        );
        ownWordsRefreshed = catchUp.items;
        ownWordsGap ??= catchUp.gap;
      }
      if (ownWordsGap && !token.cancelled) {
        // The same rule the deletion pass applies to a failed key census, for the same
        // reason: the stamp says "everything up to here is indexed", and the children this
        // update could not compare, read or attribute are not. Stamped past them, they are
        // older than the stamp by the next update, so an edited note would keep its old text
        // and an added one would never arrive until a rebuild (#63). What this update did
        // index stays; the stamp stays where it was; the next update repeats the delta.
        this.ownWordsUnavailable =
          `Notes and annotations were NOT fully caught up: ${ownWordsGap}. The own words already ` +
          'indexed were left as they were, and the version stamp stayed at ' +
          `${opts.backend} library version ${fromVersion} so that the next action:"update" ` +
          'repeats this delta and retries them.';
        this.opts.logger?.warn(this.ownWordsUnavailable);
      }
      if ((fulltextGap || fulltextStale) && !token.cancelled) {
        // The full-text half of the same rule, split over the two sequences it has to
        // withhold. An item the DELTA carried is offered again only by another delta, so
        // its gap holds the stamp; text the CATCH-UP could not read is offered again only
        // by `/fulltext?since=`, so its gap holds that cursor instead (#26). Either way the
        // body text already indexed stays exactly where it is (#67).
        const parts: string[] = [];
        if (fulltextGap) {
          parts.push(
            `${fulltextGap}, so the version stamp stayed at ${opts.backend} library version ${fromVersion} and ` +
              'the next action:"update" repeats this delta',
          );
        }
        if (fulltextStale) {
          parts.push(
            `${fulltextStale}, so the full-text cursor stayed at ${fulltextCursor} and the next action:"update" ` +
              'asks Zotero for that text again',
          );
        }
        // The count is left out when nothing was read at all (a map that could not be
        // opened fails before any item is asked), rather than reported as zero items.
        const scope = fulltextFailed ? ` for ${fulltextFailed} item(s)` : '';
        this.fulltextUnavailable =
          `Attachment full text was NOT fully updated${scope}: ${parts.join('; ')}. ` +
          'The body text already indexed was left as it was.';
        this.opts.logger?.warn(this.fulltextUnavailable);
      } else if (fulltextNotice && !token.cancelled) {
        // Nothing failed and nothing was withheld: this update simply has something to say
        // about full text, and the one moment it does is the one where it leaves a
        // metadata-only index exactly as it found it. Said only when no gap sentence stands,
        // because a gap is the more urgent half of the same subject.
        this.fulltextUnavailable = fulltextNotice;
        this.opts.logger?.info(fulltextNotice);
      }

      if (!token.cancelled && reconciled && crawlVersion && !ownWordsGap && !fulltextGap) {
        this.libraryVersion = crawlVersion;
        this.libraryBackend = opts.backend;
        // An index stamped before the library stamp existed gets one here: the update just
        // asserted (or trivially holds) that these rows are this library's.
        if (opts.library) this.library = opts.library;
      }
      // The full-text cursor advances under the same rule as the stamp, and for the same
      // reason: an update that did not finish must repeat this delta, not skip past it. A
      // gap on the item sequence does not hold it back, whether it is own words or the body
      // text of a changed item: the two sequences are independent (#26) and those items come
      // back with the delta. What DOES hold it back is a read the catch-up itself missed,
      // and `fulltextCatchUp` holds it by handing back the cursor it was given (#67).
      if (!token.cancelled && reconciled) {
        this.fulltextVersion = fulltextCursor;
        // And the coverage mark beside it, committed under the same condition and for the
        // same reason: it says whether this cursor can be trusted to name what is missing.
        // Only a catch-up that entered in recovery mode and finished it earns its removal
        // (`fulltextCatchUp` decides that, and nothing weaker counts); a delta that wrote
        // text off a map which stopped short puts it back (#78).
        if (fulltextRecovered) {
          this.fulltextPartial = false;
          // With the debt paid there is nothing left for the bound to bound, and an index
          // that kept the count would meet it having never re-read anything.
          this.fulltextRecoveryAttempts = 0;
        } else if (fulltextRecoveryFailed) {
          // A whole-census re-read was paid and still could not finish. Counted rather than
          // acted on here: a transient failure is answered by the next update paying it
          // again, and only a failure that repeats runs the count out (#78).
          this.fulltextRecoveryAttempts++;
        }
        if (fulltextPartialWrite) this.fulltextPartial = true;
      }
      // Inside the update's single transaction, like every other write it made: a delta
      // adds codes for the passages it added and nothing else, and a failure below rolls
      // them back with the rest.
      this.finalizeVectors();
      // Not forced: a delta of a few items cannot move a 30% threshold, and the scan that
      // derives the droplist is the one cost in this whole feature a user could feel. The
      // store rescans only when the corpus has drifted far enough to change the answer —
      // or when it holds no droplist at all, which is how an index built by an older
      // version adopts one without waiting for a rebuild.
      this.refreshDroplist(false);
      // Persisted once, at the end: the delta is small by construction, and one commit is
      // what makes "the stamp advanced" and "the rows are on disk" a single durable fact.
      try {
        await persist();
        this.persistError = undefined;
      } catch (e) {
        this.persistError = e instanceof Error ? e.message : String(e);
        this.opts.logger?.warn(`Could not persist index: ${this.persistError}`);
      }
      this.buildState = 'done';
      if (reconciled) {
        this.updateNotice =
          `Updated ${this.itemsFetched} changed and removed ${this.itemsRemoved} deleted items since ` +
          `${opts.backend} library version ${fromVersion}.` +
          // Reported apart from the changed count because it is a different question
          // answered by a different sequence: these items did not change at all, Zotero
          // merely finished extracting their text after the build (#26).
          (caughtUp
            ? ` ${caughtUp} unchanged item(s) gained newly extracted attachment full text.`
            : '') +
          // Also apart from the changed count, and for a similar reason: these items did
          // not change either, a note or a highlight hanging off them did (#33).
          (ownWordsRefreshed
            ? ` ${ownWordsRefreshed} item(s) had their notes and annotations re-indexed.`
            : '') +
          (skippedByCap
            ? ` ${skippedByCap} new items were left out because the index is at its item cap.`
            : '') +
          (this.itemsAvailable > this.itemsTotal
            ? ' An update maintains only the subset this index already holds: the items the cap left out stay' +
              ' unindexed until a full action:"build" covers them.'
            : '');
      } else if (token.cancelled) {
        this.updateNotice =
          `Update stopped after ${this.itemsFetched} changed items. Deletions were not reconciled and the version ` +
          'stamp was left where it was, so the next action:"update" repeats this delta.';
      }
      const final = this.buildStatus();
      this.opts.logger?.info(`index update ${token.cancelled ? 'stopped' : 'complete'}: ${progressLine(final)}`);
      opts.onProgress?.(final);
      return final;
    } catch (e) {
      this.buildState = 'error';
      this.lastBuildError = e instanceof Error ? e.message : String(e);
      this.opts.logger?.error(`index update failed: ${this.lastBuildError}`);
      // The opposite of a build's behaviour, and deliberately: a half-applied delta is not
      // a partial index but a wrong one (items refreshed, deletions not, stamp ambiguous),
      // so it is discarded and the last good state stands.
      const rolledBack = this.rollback();
      this.updateNotice = rolledBack
        ? `The update failed and was rolled back: the index is unchanged, at ${labelFor(this.libraryBackend)} ` +
          `library version ${this.libraryVersion}. Retry action:"update", or run action:"build" to rebuild.`
        : `The update failed partway through. The ${this.storage} store cannot roll back, so some items were ` +
          'refreshed in memory and others were not; nothing was written, so the last saved index is intact and ' +
          'the version stamp did not move. Retry action:"update", or run action:"build" to rebuild.';
      opts.onProgress?.(this.buildStatus());
      return this.buildStatus();
    } finally {
      this.cancelToken = null;
    }
  }

  /**
   * Index the body text Zotero extracted since this index's full-text cursor, for items
   * the delta itself never saw.
   *
   * The gap this closes: Zotero versions extracted text on a sequence of its own. Opening a
   * PDF for the first time makes Zotero extract it and touches no item version at all, so
   * that item appears in no `?since=` delta, ever, and until now an index's full-text
   * coverage was frozen at build time with a rebuild as the only remedy (#26).
   *
   * Costs one request on a library where nothing has been extracted since. Items the delta
   * already refreshed are skipped: they were re-read whole, body text included.
   *
   * Returns the cursor to store, how many items it re-indexed, whether it made a partial
   * index's coverage whole (which is what retires `fulltextPartial`; see the return below
   * for the whole of that predicate), whether a recovery it did pay for ended on unreadable
   * text (which is what bounds the next one), and, when a read in the loop failed or the map
   * behind it was incomplete, why. The cursor it returns is then the one it was
   * given: an item whose text this pass could not read is in no item delta (its attachment
   * did not change), so `/fulltext?since=` is the only thing that will ever offer it again,
   * and a cursor moved past it makes the miss permanent (#67).
   */
  private async fulltextCatchUp(
    opts: IncrementalUpdateOptions,
    known: Set<string>,
    refreshed: Set<string>,
    pending: ChunkRecord[],
    token: { cancelled: boolean },
    limit: Semaphore,
  ): Promise<{
    version: number;
    items: number;
    failed: number;
    recovered: boolean;
    recoveryFailed: boolean;
    gap?: string;
    notice?: string;
  }> {
    const since = this.fulltextVersion;
    // While the mark stands, this pass asks Zotero's full-text sequence from the START,
    // whatever cursor is stored (#78). The mark says this index's body text was gathered
    // over a map that never reached the end of the library, and a `?since=<cursor>` delta of
    // that sequence can never repair that: it names what Zotero extracted AFTER the cursor,
    // and the text the map missed was extracted before it. Keying the recovery on
    // `since === 0` instead left the mark unreachable whenever a cursor was already stamped,
    // which is precisely the case a delta raises it in (a delta runs on a stamped index, and
    // the cursor only ever moves forward), so it stood forever: no update ever acted on it,
    // and nothing on the status said so.
    //
    // What it costs while the mark stands: the census answer is the whole of Zotero's
    // full-text index rather than a delta of it, and resolving its keys to items opens the
    // attachment map, so an update that would otherwise have cost one probe pays a listing
    // crawl too. That is the price of the recovery being reachable at all; it is a listing
    // crawl and not a body crawl, the body reads below stay bounded by `gapOnly`, and it
    // ends the moment a pass earns the cursor back.
    const partial = this.fulltextPartial;
    const from = partial ? 0 : since;
    let answer;
    try {
      answer = await opts.fulltextCatchUp!(from);
    } catch (e) {
      // A probe of the other sequence must not fail the delta: the items that DID change
      // are correctly indexed either way, and the cursor stays put so the next update asks
      // again.
      this.opts.logger?.warn(
        `Zotero's full-text index could not be consulted (${e instanceof Error ? e.message : String(e)}), so ` +
          'newly extracted attachment text was not picked up by this update.',
      );
      return { version: since, items: 0, failed: 0, recovered: false, recoveryFailed: false };
    }
    // Never below the stored cursor: a from-the-start census over a library whose text was
    // all extracted before that cursor answers with a version behind it.
    const version = Math.max(since, answer.version);
    // Whether the attachment map behind THIS pass reached the end of the library, asked in
    // the POSITIVE. `fulltextMapComplete` answers false both for a map that stopped short
    // and for a map nobody opened, and those two are not the same thing (#78): an empty
    // census returns before any map is crawled, so read as "not incomplete" this question
    // answered "complete" for a pass that had crawled nothing, and such a pass then reported
    // the index's coverage made whole and retired the mark having read nothing at all. It is
    // the hinge of everything below: only over a map that reached the end of the library
    // does "this item holds passages" mean "this item holds all of its body text".
    const mapReachedEnd = !answer.incomplete && (opts.fulltextMapComplete?.() ?? false);
    // Recovery mode: this index is known to hold body text gathered over a map that stopped
    // short, and this pass asked Zotero's full-text sequence from the start (see `from`
    // above), so it is the one kind of pass that can make that coverage whole.
    const recovering = partial;
    // The bound on what recovery may cost (#78). Read failures are caught per item, so one
    // attachment that can never be read leaves the pass incomplete however often it runs,
    // and each run is a whole body crawl. Past the bound the crawl is not paid again: the
    // pass falls back to filling the coverage gap alone. The mark and the withheld cursor
    // stand either way, so nothing is traded away except the repetition.
    const exhausted = this.fulltextRecoveryAttempts >= FULLTEXT_RECOVERY_ATTEMPTS;
    /**
     * Why the whole-census re-read is not being paid although the mark stands, or undefined
     * when it is. Ordered by what explains what: an empty census is why no map was opened,
     * so it is asked before the map, and a bound already reached is asked before either
     * because it settles the pass whatever the rest says.
     */
    const notPaid: 'exhausted' | 'nothing-named' | 'map' | undefined = !recovering
      ? undefined
      : exhausted
        ? 'exhausted'
        : !answer.itemKeys.size
          ? 'nothing-named'
          : !mapReachedEnd
            ? 'map'
            : undefined;
    // The whole-census re-read itself: worth paying only when it can finish (a map that was
    // opened and reached the end of the library), has something to read, and has not already
    // failed its way through the bound.
    const fullPass = recovering && !notPaid;
    // The map that turned attachment keys into item keys could not be read in full, so some
    // of what the probe named resolved to nothing for want of the map. Nothing is indexed
    // over, but the cursor waits: over a readable map those items are named again (#67).
    // A recovery is the one exception, handled below: it has a coverage gap of its own to
    // fill, and its cursor is withheld by the flag whatever this pass manages to read.
    if (answer.incomplete && !recovering) {
      return { version: since, items: 0, failed: 0, recovered: false, recoveryFailed: false, gap: answer.incomplete };
    }
    // An index written before this cursor existed cannot say which text is new, so the
    // catch-up is narrowed to its coverage GAP: items holding no body passages at all. That
    // is also all an update will do for a metadata-only index: turning `action:"update"`
    // into the days-long full-text crawl it has never had is not an update.
    //
    // The exception is an index whose body text came off a map that stopped short of the
    // library, which is the whole of the recovery this cursor's absence promises (#78).
    // "Holds body passages" means "has all of its body text" only over a complete map: an
    // item with one attachment on a mapped page and another on a page the map never reached
    // holds passages and is still missing text, and nothing in the item's own version, or in
    // either sequence, will ever say so. So a recovery runs in FULL: every indexed item the
    // census names is re-read, at the cost of one body crawl. That is the work a rebuild
    // would do, without the metadata.
    //
    // Bounded twice, though, by the two things that make it worth paying. A full re-read can
    // only make coverage whole over a map that reached the end of the library, so when this
    // pass's own map stopped short again the expensive crawl cannot finish the job whatever
    // it reads. And it can only make it whole if the reads succeed, so an attachment that
    // can never be read would otherwise buy the crawl again on every update, forever
    // (FULLTEXT_RECOVERY_ATTEMPTS). Either way the pass falls back to the cheap gap fill,
    // the mark stands, and the cursor stays where it is: the debt is still recorded, it is
    // simply not re-paid at the price of a body crawl per update.
    const gapOnly = from === 0 && !fullPass;
    /** What the status says when a recovery ran against a map that stopped short again. */
    const mapGap = (): string =>
      `${answer.incomplete ?? 'the attachment map did not reach the end of the library'}; only the ` +
      'items holding no body text at all were filled in, and the ones already holding some were ' +
      'left for a pass over a map that reaches the end of the library';
    /** And when the re-read itself keeps failing on text that cannot be read (#78). */
    const stuckGap = (): string =>
      `the re-read that would make this index's partial full-text coverage whole has failed ` +
      `${this.fulltextRecoveryAttempts} time(s) on body text that could not be read, so it is no longer ` +
      'attempted: only the items holding no body text at all were filled in, the coverage mark stands, and ' +
      'zotero_index action:"refresh" with fulltext:true is what clears it';
    /** And when it named nothing to re-read, so the pass could not have recovered anything. */
    const emptyGap = (): string =>
      "Zotero's full-text index named no extracted attachment at all, so this pass re-read nothing and this " +
      "index's partial full-text coverage stands: the items whose attachments the truncated map never listed " +
      'are still owed a re-read';
    /** Which of those describes a recovery that could not run in full, if any. */
    const heldBack = (): string | undefined =>
      notPaid === 'exhausted'
        ? stuckGap()
        : notPaid === 'nothing-named'
          ? emptyGap()
          : notPaid === 'map'
            ? mapGap()
            : undefined;
    // Nothing indexed, so nothing to claim. Handing back the census's high-water mark here
    // let the caller stamp a cursor over body text this index had never seen, and the next
    // update then asked `?since=` past all of it: text extracted BEFORE that point was
    // named by no `?since=` on either sequence, ever (#78). Leaving it where it was is not
    // free: a cursor pinned at 0 makes every later update ask `?since=0`, take the whole
    // census back and re-open the attachment map to resolve it, so it pays that listing
    // crawl every time rather than once. No body text is read, and the alternative was a
    // cursor that claimed coverage this index had never seen.
    //
    // It also says so, which it did not: this is the one moment an update leaves a
    // metadata-only index exactly as it found it, and the status went on reporting nothing
    // at all about full text. A caller who asked for `fulltext:true` and got no body text
    // has one thing to do about it, and now reads it here (a `notice`, not a `gap`: nothing
    // was withheld and nothing failed, so the sentence stands on its own rather than being
    // folded into the "NOT fully updated" report).
    if (gapOnly && this.counts().fulltextPassages === 0) {
      const held = heldBack();
      return {
        version: since,
        items: 0,
        failed: 0,
        recovered: false,
        recoveryFailed: false,
        ...(held
          ? { gap: held }
          : {
              notice:
                'This index holds no attachment body text at all, and an action:"update" does not start the ' +
                'full-text crawl it has never had, so nothing was indexed for it and the full-text cursor stays ' +
                'at 0. Open the PDFs you want searchable in Zotero (opening one is what makes Zotero extract its ' +
                'text), then run zotero_index action:"build" with fulltext:true to index the whole library.',
            }),
      };
    }
    const targets = [...answer.itemKeys].filter(
      (key) => known.has(key) && !refreshed.has(key) && !(gapOnly && this.hasFulltext(key)),
    );
    const batchSize = opts.embedBatchSize ?? DEFAULT_EMBED_BATCH_SIZE;
    const delayMs = opts.embedBatchDelayMs ?? 0;
    let items = 0;
    /** Items named by the probe whose text could not be read, and the first reason why. */
    const failed = new Map<string, string>();
    for (let i = 0; i < targets.length && !token.cancelled; i += PAGE_GROUP) {
      const group = targets
        .slice(i, i + PAGE_GROUP)
        .map((key) => ({ key, title: this.itemTitle(key) ?? '(untitled)' }));
      const texts = await this.fulltextForKeys(group, opts, token, limit, failed);
      for (let j = 0; j < group.length; j++) {
        if (token.cancelled) break;
        const text = texts?.[j];
        // Nothing to write: either Zotero has since dropped this attachment's text, or the
        // read failed, in which case `failed` holds the key and the cursor waits for it.
        // Either way what the index holds for the item is left exactly as it is.
        if (!text) continue;
        // The item's own metadata passages are untouched: nothing about the item changed.
        // Its body passages are replaced wholesale, because their ids (`<key>#f<n>`) are
        // reused by the new text and a second attachment's arrival would otherwise collide
        // with the first's.
        this.clearFulltext(group[j]!.key);
        this.addFulltext(group[j]!.key, group[j]!.title, text, pending);
        items++;
      }
      await this.embedPending(pending, token, batchSize, delayMs, false);
    }
    if (!token.cancelled) await this.embedPending(pending, token, batchSize, delayMs, true);
    // A recovery that could not run in full: over a map that stopped short again, or past
    // the bound on a re-read that keeps failing. It filled what gap it could see and claims
    // nothing for it. The cursor stays where it was and the mark stands, so the full re-read
    // is still owed: by the first update whose map reaches the end in the first case, and by
    // a rebuild in the second.
    const held = heldBack();
    if (held) return { version: since, items, failed: failed.size, recovered: false, recoveryFailed: false, gap: held };
    if (failed.size) {
      return {
        version: since,
        items,
        failed: failed.size,
        recovered: false,
        // A whole-census re-read was paid for and still ended on text it could not read.
        // Counted, because that is what bounds the next one: a transient failure (the app
        // restarting, a volume not mounted yet) is answered by the next update paying the
        // crawl again, and a permanent one runs out of attempts instead of running forever.
        recoveryFailed: fullPass && !token.cancelled,
        gap: `newly extracted attachment text could not be read (${[...failed.values()][0]})`,
      };
    }
    // What makes the coverage whole again, and so retires the mark: this pass entered in
    // recovery mode, ran over the whole census rather than a delta of it, read every item
    // that census named without a single failure, ran against a map that was opened and
    // reached the end of the library, and was not cancelled. Anything less leaves the mark
    // standing, and only with the mark down does the cursor about to be stamped mean what it
    // says.
    return { version, items, failed: 0, recovered: fullPass && !token.cancelled, recoveryFailed: false };
  }

  /**
   * The own words of one page of changed items, in the order the page holds them.
   *
   * No concurrency limit and no per-item error handling, unlike the full-text sibling
   * below: every answer comes out of one census that is already resident by the time this
   * is first called, so there is no round trip to bound and nothing here can fail on its
   * own.
   */
  private async ownWordsForPage(
    batch: any[],
    opts: IncrementalBuildOptions,
    token: { cancelled: boolean },
  ): Promise<Array<OwnWordsEntry[]> | undefined> {
    if (!opts.ownWords || token.cancelled) return undefined;
    const out: Array<OwnWordsEntry[]> = [];
    for (const item of batch) {
      const key = item?.key ?? item?.data?.key;
      out.push(key ? await opts.ownWords.textsFor(key) : []);
    }
    return out;
  }

  /**
   * Re-index the notes and annotations of items the item delta never saw.
   *
   * The gap this closes is the one that makes #33 more than a coverage question. Writing a
   * note, or annotating a PDF, leaves the PARENT item's version exactly where it was: the
   * child is what Zotero versions. So an item whose reader has just written three pages of
   * objections appears in no `?since=` delta over `/items/top`, ever, and an index anyone
   * maintains by updating rather than rebuilding would stay blind to it indefinitely.
   *
   * One cheap question answers all three shapes of change. Every note and annotation key
   * in the library, with its version, is one keys-only request; compared against the child
   * keys this index holds it says what was edited (a version past the stamp), what was
   * added (a key the index has no passage for) and what was deleted (a key the library no
   * longer has) — that last one being the case no `?since=` can ever report, because
   * deleting a child moves no version anywhere. Notes and annotations are ordinary items
   * carrying ordinary versions, so unlike extracted full text (#26) none of this needs a
   * second cursor. The expensive census behind `textsFor` is opened only when there is
   * something to re-index, so an update over a library nobody has annotated since costs
   * exactly one request.
   *
   * Returns how many items it re-indexed and, when it could not do all of its work, why:
   * a census that could not be taken, that came back empty against an index holding
   * children, that opened degraded, or a body or attribution that could not be read. None
   * of those fails the delta (the items that DID change are correctly indexed either way),
   * but the caller withholds the stamp on the gap, because a child this update could not
   * compare is older than the stamp by the next update and would never be revisited (#63).
   * A degraded census replaces nothing: "no own words for this item" is not an answer it
   * can be trusted to give, so the text already indexed stays until a census can be read.
   */
  private async ownWordsCatchUp(
    opts: IncrementalUpdateOptions,
    since: number,
    known: Set<string>,
    refreshed: Set<string>,
    pending: ChunkRecord[],
    token: { cancelled: boolean },
  ): Promise<{ items: number; gap?: string }> {
    const access = opts.ownWords!;
    // Already opened degraded under the delta's own pages: nothing it answers from here on
    // can be trusted either, and asking it costs requests.
    if (this.ownWordsUnavailable) return { items: 0, gap: this.ownWordsUnavailable };
    let live: Map<string, number>;
    try {
      live = await access.childVersions();
    } catch (e) {
      return {
        items: 0,
        gap:
          "the library's notes and annotations could not be listed " +
          `(${e instanceof Error ? e.message : String(e)})`,
      };
    }
    const stored = this.ownWordsChildren();
    if (live.size === 0 && stored.size > 0) {
      // The same rule the item-level deletion pass learned: a library reporting no notes
      // and no annotations at all, against an index holding some, is a failed read far
      // more often than a reader who deleted every one of them, and acting on it would
      // erase exactly the text this feature exists to keep.
      return {
        items: 0,
        gap:
          'the library reported no notes or annotations at all, which is treated as a failed ' +
          'read rather than a reader who deleted every one',
      };
    }
    const targets = new Set<string>();
    const held = new Set<string>();
    for (const [itemKey, children] of stored) {
      for (const child of children) {
        held.add(child);
        if (refreshed.has(itemKey) || !known.has(itemKey)) continue;
        // Gone from the library: a deleted note or a deleted highlight. This is the case
        // no `?since=` can report — deleting a child moves no version anywhere — and it is
        // why the whole key set is compared rather than only the delta.
        if (!live.has(child)) targets.add(itemKey);
        // Still here, but written after the stamp this update is diffing from: edited, or
        // added to an item whose own version never moved.
        else if ((live.get(child) ?? 0) > since) targets.add(itemKey);
      }
    }
    // Children the library holds that this index has no passage for. Their items are
    // unknown until the census resolves them (an annotation names an attachment), so this
    // is the one branch that opens it.
    //
    // Narrowed to the ones written since the stamp, and the narrowing is what keeps an
    // idle update to one request: a real library always holds children that yield no
    // passage at all — an image annotation with no text, a note someone emptied — and
    // those are unheld forever. Unchanged since the stamp means they were already
    // considered, by the build or by an earlier update, and considered again would cost a
    // crawl of every note in the library to reach the same conclusion. The exception is an
    // index holding no own words whatsoever, which is one built before they existed: there
    // nothing has considered them yet, and filling that gap once is the point.
    const gapFill = stored.size === 0;
    const unheld = [...live.entries()]
      .filter(([key, version]) => !held.has(key) && (gapFill || version > since))
      .map(([key]) => key);
    let gap: string | undefined;
    if (unheld.length) {
      try {
        for (const itemKey of await access.itemsFor(unheld)) {
          if (known.has(itemKey) && !refreshed.has(itemKey)) targets.add(itemKey);
        }
      } catch (e) {
        gap =
          'new notes and annotations could not be attributed to their items ' +
          `(${e instanceof Error ? e.message : String(e)})`;
      }
      // Opening the census is what may have found it degraded (see noteOwnWordsUnavailable).
      if (this.ownWordsUnavailable) return { items: 0, gap: this.ownWordsUnavailable };
    }
    if (!targets.size) return gap ? { items: 0, gap } : { items: 0 };

    const batchSize = opts.embedBatchSize ?? DEFAULT_EMBED_BATCH_SIZE;
    const delayMs = opts.embedBatchDelayMs ?? 0;
    let items = 0;
    for (const key of targets) {
      if (token.cancelled) break;
      // Read before anything is cleared, so a body that cannot be read leaves the text the
      // index already holds in place rather than replacing it with nothing (#63).
      let entries: OwnWordsEntry[];
      try {
        entries = await access.textsFor(key);
      } catch (e) {
        gap ??=
          'the notes and annotations of an item could not be read ' +
          `(${e instanceof Error ? e.message : String(e)})`;
        break;
      }
      if (this.ownWordsUnavailable) {
        gap ??= this.ownWordsUnavailable;
        break;
      }
      // The item's own metadata and body passages are untouched: nothing about the item
      // changed. Its own words are replaced wholesale, which is also how a note that lost
      // a paragraph stops being findable by the paragraph it lost.
      this.clearOwnWords(key);
      this.addOwnWords(key, this.itemTitle(key) ?? '(untitled)', entries, pending);
      items++;
      await this.embedPending(pending, token, batchSize, delayMs, false);
    }
    if (!token.cancelled) await this.embedPending(pending, token, batchSize, delayMs, true);
    return gap ? { items, gap } : { items };
  }

  /**
   * Full text for one page of items, several attachments in flight, so the per-item round
   * trip does not serialize the whole crawl behind the network.
   *
   * A read that failed answers `undefined`, exactly as an item with no extracted text does,
   * so that one unreadable PDF cannot abort the job. `failed` is how the two are told apart
   * afterwards: the keys it collects are the items whose body text this page could NOT
   * read, and what a caller does about them is the whole of #67.
   */
  private async fulltextForPage(
    batch: any[],
    opts: IncrementalBuildOptions,
    token: { cancelled: boolean },
    limit: Semaphore,
    failed?: Map<string, string>,
  ): Promise<Array<string | undefined> | undefined> {
    if (!opts.fulltextFor || token.cancelled) return undefined;
    return Promise.all(
      batch.map((item) =>
        limit.run(async () => {
          if (token.cancelled) return undefined;
          const d = item.data ?? item;
          const key = item.key ?? d.key;
          if (!key) return undefined;
          try {
            return await opts.fulltextFor!(key, item);
          } catch (e) {
            const why = e instanceof Error ? e.message : String(e);
            failed?.set(key, why);
            this.opts.logger?.debug(`full text for ${key} skipped: ${why}`);
            return undefined;
          }
        }),
      ),
    );
  }

  /**
   * The same fetch as `fulltextForPage`, over the key/title pairs a build's metadata pass
   * recorded rather than over raw items. The full item is deliberately not kept: nothing
   * that supplies full text has ever used it (the supplier keys off the item key alone),
   * and holding a library's worth of item bodies to re-read one field would be the one
   * genuinely large allocation the two-pass split introduced.
   */
  private async fulltextForKeys(
    batch: Array<{ key: string; title: string }>,
    opts: IncrementalBuildOptions,
    token: { cancelled: boolean },
    limit: Semaphore,
    failed?: Map<string, string>,
  ): Promise<Array<string | undefined> | undefined> {
    if (!opts.fulltextFor || token.cancelled) return undefined;
    return Promise.all(
      batch.map((entry) =>
        limit.run(async () => {
          if (token.cancelled) return undefined;
          try {
            return await opts.fulltextFor!(entry.key);
          } catch (e) {
            const why = e instanceof Error ? e.message : String(e);
            failed?.set(entry.key, why);
            this.opts.logger?.debug(`full text for ${entry.key} skipped: ${why}`);
            return undefined;
          }
        }),
      ),
    );
  }

  /** Embed and store queued passages in batches; `force` drains a partial last batch. */
  private async embedPending(
    pending: ChunkRecord[],
    token: { cancelled: boolean },
    batchSize: number,
    delayMs: number,
    force: boolean,
  ): Promise<void> {
    if (!this.hasEmbedder) {
      pending.length = 0;
      return;
    }
    // Recorded per drain rather than per build, so `embedRate` describes the pacing in
    // force right now even on a job whose caller changed it between passes.
    this.embedBatchInUse = batchSize;
    this.embedDelayInUse = delayMs;
    while (pending.length >= (force ? 1 : batchSize)) {
      if (token.cancelled) return;
      const batch = pending.splice(0, Math.min(batchSize, pending.length));
      const startedAt = Date.now();
      try {
        const vecs = await this.opts.embedder!.embed(batch.map((r) => r.text), 'passage');
        batch.forEach((r, i) => {
          if (vecs[i]) this.putVector(r.id, vecs[i]!);
        });
        // Only a request that produced vectors counts towards the rate: one that spent two
        // minutes backing off and then failed measures the provider's refusal, not this
        // build's throughput.
        this.embedChars += batch.reduce((n, r) => n + r.text.length, 0);
        this.embedMs += Date.now() - startedAt + delayMs;
      } catch (e) {
        // hasEmbedder goes false from here, which both stops this loop and makes every
        // later status report say why the index has no vectors.
        this.noteEmbedFailure(e);
        pending.length = 0;
      }
      // Yield so long embedding runs stay interruptible and the event loop breathes; a
      // configured delay additionally paces requests against a provider's rate limit.
      await batchPause(delayMs);
    }
  }

  /** Chunk a single library item into the keyword index and queue passages for embedding. */
  private addOneItem(item: any, pending: ChunkRecord[], fulltext?: string, ownWords?: OwnWordsEntry[]): void {
    const entry = this.addMetadata(item, pending);
    if (!entry) return;
    if (fulltext) this.addFulltext(entry.key, entry.title, fulltext, pending);
    // An upsert replaces the item wholesale, so its own words have to come back with it:
    // without this, editing an item's title would silently drop every note hanging off it.
    if (ownWords?.length) this.addOwnWords(entry.key, entry.title, ownWords, pending);
  }

  /**
   * A build's write of one item, metadata and own words, as a unit (see `atomically`).
   *
   * The passages it queued for embedding are withdrawn with it when it fails, so a batch
   * never embeds rows the rollback removed; the failure itself still ends the build, as it
   * did, but with whole items committed and nothing for a resume to mistake for finished.
   */
  private indexItem(
    item: any,
    ownWords: OwnWordsEntry[] | undefined,
    pending: ChunkRecord[],
  ): { key: string; title: string } | undefined {
    const queued = pending.length;
    try {
      return this.atomically(() => {
        const entry = this.addMetadata(item, pending);
        if (entry && ownWords?.length) this.addOwnWords(entry.key, entry.title, ownWords, pending);
        return entry;
      });
    } catch (e) {
      pending.length = queued;
      throw e;
    }
  }

  /** The full-text pass's twin of `indexItem`: one item's body passages, whole or not at all. */
  private indexFulltext(itemKey: string, title: string, text: string, pending: ChunkRecord[]): void {
    const queued = pending.length;
    try {
      this.atomically(() => this.addFulltext(itemKey, title, text, pending));
    } catch (e) {
      pending.length = queued;
      throw e;
    }
  }

  /**
   * Store one passage, or step over it when the store already holds its id.
   *
   * A duplicate reaches this from a crawl that served the same item or child twice (see
   * `buildIncremental`), and until #59 the SQLite insert answered it by aborting the build.
   * The first copy stands; the second is counted, reported once by the job that met it, and
   * never queued for embedding, since the row it names is embedded already or in the queue.
   */
  private storePassage(rec: ChunkRecord): boolean {
    if (this.putPassage(rec)) return true;
    this.duplicatePassages++;
    this.opts.logger?.debug(`index: passage ${rec.id} is already stored, so its second copy was skipped.`);
    return false;
  }

  /**
   * Index one item's own text (title, abstract, creators, tags) and nothing else.
   *
   * Returns the key and title it used, which is what a build's full-text pass needs to
   * come back to this item later without holding on to the raw item: the pair is a couple
   * of hundred bytes where the item is a few kilobytes (#23).
   */
  private addMetadata(item: any, pending: ChunkRecord[]): { key: string; title: string } | undefined {
    const d = item.data ?? item;
    const key = item.key ?? d.key;
    if (!key) return undefined;
    const title = d.title ?? '(untitled)';
    this.putItem(key, title);
    for (const ch of chunkText(itemText(d))) {
      const rec: ChunkRecord = { id: `${key}#${ch.index}`, itemKey: key, title, text: ch.text };
      if (!this.storePassage(rec)) continue;
      if (this.hasEmbedder && !this.adoptVector(rec)) pending.push(rec);
    }
    return { key, title };
  }

  /**
   * Index an item's attachment body text as extra passages. They carry the parent item's
   * key, so a body hit is reported (and de-duplicated) as that item, exactly like a hit on
   * its abstract. Ids are namespaced `#f<n>` so they can never collide with metadata ones.
   */
  private addFulltext(itemKey: string, title: string, text: string, pending: ChunkRecord[]): void {
    for (const ch of chunkText(text, FULLTEXT_CHUNK_SIZE, FULLTEXT_CHUNK_OVERLAP)) {
      const rec: ChunkRecord = {
        id: `${itemKey}#f${ch.index}`,
        itemKey,
        title,
        text: ch.text,
        source: 'fulltext',
      };
      if (!this.storePassage(rec)) continue;
      if (this.hasEmbedder && !this.adoptVector(rec)) pending.push(rec);
    }
  }

  /**
   * Index one item's notes and annotations as extra passages.
   *
   * They carry the PARENT item's key, exactly as body text does, and that is the whole
   * design: `query()` de-duplicates by item, so an item with forty annotations takes one
   * result slot rather than forty, and the reader's own words extend what the item can be
   * found by instead of crowding out everything else. One passage per note or annotation
   * (chunked only when a note is long enough to need it), so each is retrievable on its
   * own terms and can leave on its own when it is deleted.
   */
  private addOwnWords(itemKey: string, title: string, entries: OwnWordsEntry[], pending: ChunkRecord[]): void {
    for (const entry of entries) {
      for (const ch of chunkText(entry.text, FULLTEXT_CHUNK_SIZE, FULLTEXT_CHUNK_OVERLAP)) {
        const rec: ChunkRecord = {
          id: ownWordsId(itemKey, entry.key, ch.index),
          itemKey,
          title,
          text: ch.text,
          source: entry.kind,
        };
        if (!this.storePassage(rec)) continue;
        // Through the same salvage every other passage goes through (#34): a note that has
        // not been edited embeds to the vector a sidelined index already holds for it.
        if (this.hasEmbedder && !this.adoptVector(rec)) pending.push(rec);
      }
    }
  }

  /**
   * The own-words passages this index holds for these items, read back whole, so an upsert
   * can carry them across when the census that would have replaced them cannot be read
   * (#63). One walk of the own-words ids for the page, not one per item.
   */
  private ownWordsRecords(keys: string[]): Map<string, ChunkRecord[]> {
    const wanted = new Set(keys.filter(Boolean));
    const out = new Map<string, ChunkRecord[]>();
    if (!wanted.size) return out;
    for (const id of this.ownWordsPassageIds()) {
      const itemKey = parseOwnWordsId(id)?.itemKey;
      if (!itemKey || !wanted.has(itemKey)) continue;
      const rec = this.passage(id);
      if (!rec) continue;
      const list = out.get(itemKey);
      if (list) list.push(rec);
      else out.set(itemKey, [rec]);
    }
    return out;
  }

  /**
   * The body passages this index holds for these items, read back whole, so an upsert can
   * carry them across when the attachments that would have replaced them cannot be read
   * (#67). The own-words twin above walks the ids of every note in the index because that
   * set is small; this one asks per item, because on a full-text index the same walk is
   * hundreds of thousands of passages and only a handful of items ever fail a read.
   */
  private fulltextRecords(keys: Iterable<string>): Map<string, ChunkRecord[]> {
    const out = new Map<string, ChunkRecord[]>();
    for (const key of keys) {
      if (!key) continue;
      const recs: ChunkRecord[] = [];
      for (const id of this.fulltextPassageIds(key)) {
        const rec = this.passage(id);
        if (rec) recs.push(rec);
      }
      if (recs.length) out.set(key, recs);
    }
    return out;
  }

  /**
   * Put passages an upsert took out back as they were, re-titled after the item they hang
   * off, and re-embedded only where the store cannot answer their vector from something it
   * already holds.
   */
  private restorePassages(recs: ChunkRecord[] | undefined, itemKey: string, pending: ChunkRecord[]): void {
    for (const rec of recs ?? []) {
      const back = { ...rec, title: this.itemTitle(itemKey) ?? rec.title };
      this.putPassage(back);
      if (this.hasEmbedder && !this.adoptVector(back)) pending.push(back);
    }
  }

  /** The notes and annotations this index currently holds, by the item they belong to. */
  protected ownWordsChildren(): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();
    for (const id of this.ownWordsPassageIds()) {
      const parsed = parseOwnWordsId(id);
      if (!parsed) continue;
      const set = map.get(parsed.itemKey);
      if (set) set.add(parsed.childKey);
      else map.set(parsed.itemKey, new Set([parsed.childKey]));
    }
    return map;
  }

  async query(q: string, opts: QueryOptions = {}): Promise<SearchHit[]> {
    // An unreadable store must refuse rather than answer nothing: a query that returns no
    // hits forever is indistinguishable from a library that holds nothing on the subject,
    // which is a silent wrong answer in place of a loud right one (#20, #21).
    this.refuseIfFaulted();
    const limit = opts.limit ?? 10;
    const mode = opts.mode ?? 'auto';

    // Embedded once, before the pool below is widened however many times: it is the one
    // step of a query that costs a model call or a network round trip, and widening only
    // changes how many stored vectors the same query vector is ranked against.
    let qv: number[] | undefined;
    if (mode !== 'keyword' && this.opts.embedder && this.counts().vectors) {
      try {
        const [embedded] = await this.opts.embedder.embed([q], 'query');
        const dim = this.vectorDimension();
        // Index files written before the embedder identity was persisted carry no
        // provenance, so a model switch under one shows up only here, as a query of a
        // different width. Cosine over mismatched widths still returns numbers.
        if (embedded && dim !== undefined && embedded.length !== dim) {
          this.dropStaleVectors(
            `The stored vectors have ${dim} dimensions, but ${this.embedderId ?? 'the current embedder'} produces ${embedded.length}.`,
          );
        } else {
          qv = embedded;
        }
      } catch (e) {
        this.noteEmbedFailure(e);
      }
    }

    // Both rankers rank PASSAGES; the page is made of ITEMS, de-duplicated by key in
    // distinctHits. The pool between the two starts at three passages per item asked for,
    // which is enough whenever the top of the ranking is spread across items, and doubles
    // for as long as it is not. An item whose forty annotations all rank first (#33) fills
    // a pool of fifteen by itself, and a fixed pool then cut the other relevant items off
    // before the de-duplication ever saw them (#65); a larger fixed pool would only move
    // the point at which that happens. The bound: a ranker that came back with fewer
    // candidates than it was asked for has been read to its end and is not asked again,
    // and the pool never exceeds the passages the index holds, so a page short of items
    // costs at most log2(passages / (3 * limit)) extra rounds before it is returned as it
    // stands. A page the first pool fills costs exactly what it always did.
    const total = this.counts().documents;
    let pool = limit * 3;
    let keyword: RankedId[] = [];
    let vector: RankedId[] = [];
    let keywordOpen = mode !== 'semantic';
    let vectorOpen = qv !== undefined;
    // Read once rather than per hit: on the SQLite backend it is a set lookup, on the JSON
    // one a closure over the live postings, and neither wants to be rebuilt ten times.
    const highDf = this.highDf();
    // Passages hydrated so far. A wider round re-walks the fused prefix the narrower one
    // already read, and on the SQLite backend each of those reads is a statement.
    const passages = new Map<string, ChunkRecord | undefined>();
    for (;;) {
      if (keywordOpen) {
        keyword = this.keywordSearch(q, pool);
        keywordOpen = keyword.length >= pool;
      }
      if (qv && vectorOpen) {
        vector = this.vectorSearch(qv, pool);
        vectorOpen = vector.length >= pool;
      }
      const hits = this.distinctHits(rrf([keyword, vector]), limit, q, highDf, passages);
      if (hits.length >= limit || !(keywordOpen || vectorOpen) || pool >= total) return hits;
      pool = Math.min(pool * 2, total);
    }
  }

  /**
   * The first `limit` distinct items among the fused candidates, best first, each cited
   * with the passage that ranked it. `passages` memoizes hydration across the rounds of one
   * query; it must not outlive the query, since a passage can be replaced by an update.
   */
  private distinctHits(
    fused: Array<{ id: string; score: number }>,
    limit: number,
    q: string,
    highDf: TermPredicate | undefined,
    passages: Map<string, ChunkRecord | undefined>,
  ): SearchHit[] {
    const seen = new Set<string>();
    const hits: SearchHit[] = [];
    for (const { id, score } of fused) {
      let rec = passages.get(id);
      if (rec === undefined && !passages.has(id)) {
        rec = this.passage(id);
        passages.set(id, rec);
      }
      if (!rec || seen.has(rec.itemKey)) continue;
      seen.add(rec.itemKey);
      const hit: SearchHit = {
        itemKey: rec.itemKey,
        title: rec.title,
        snippet: makeSnippet(rec.text, q, 240, highDf),
        score,
      };
      // Worth surfacing: a body-text snippet is a passage the caller can go and cite with
      // zotero_get_fulltext, whereas a metadata one is just the abstract, and a note or
      // annotation is the reader's own, which is a different thing again to be told.
      if (rec.source) hit.source = rec.source;
      hits.push(hit);
      if (hits.length >= limit) break;
    }
    return hits;
  }
}

export interface MemorySearchIndexOptions extends SearchIndexOptions {
  /**
   * JSON artifact save() writes. Without one the index is memory-only, which is what the
   * tests and the fallback-with-no-data-dir case want.
   */
  path?: string;
}

/**
 * The original backend: BM25 and the vectors in JS memory, persisted as one JSON file.
 * Correct and fastest for small libraries, and the only backend on Node < 22.13, but it
 * holds every passage and vector resident and serializes them through a single string:
 * past roughly 250k passages the file can neither be written nor re-read (#10).
 */
export class MemorySearchIndex extends SearchIndexBase {
  readonly storage = 'memory' as const;
  /**
   * BM25 postings, vectors and chunks are all keyed by passage id, so removing one item is
   * an exact in-place operation on each of the three (see BM25Index.removeDoc and
   * VectorStore.remove). That is what lets this backend serve incremental updates too.
   */
  readonly supportsDelete = true;
  private bm25 = new BM25Index();
  private vectors = new VectorStore();
  private chunks = new Map<string, ChunkRecord>();
  /**
   * Indexed items and their titles, in crawl order. A map rather than a set because a
   * resumed build and a full-text catch-up both need an item's title without holding the
   * item, and reading it off one of that item's passages would tie the title to whether
   * the item happened to produce any.
   */
  private items = new Map<string, string>();
  /** Passage ids per item, so a delete does not scan every chunk in the index. */
  private byItem = new Map<string, Set<string>>();
  /** Items with at least one full-text passage, and how many such passages exist. */
  private fulltextItems = new Set<string>();
  private fulltextPassages = 0;
  /** The same bookkeeping for the reader's own words; see the SQLite backend's twin. */
  private ownWordsItems = new Set<string>();
  private ownWordsPassages = 0;
  private readonly path: string | undefined;
  /**
   * JSON writes are atomic individually, but two overlapping writes can still rename out
   * of order. Keep their invocation order so an older snapshot can never overwrite a
   * newer durable state (notably a pause asserted while a build save is in flight).
   */
  private saveTail: Promise<void> = Promise.resolve();
  /**
   * The state this handle last read from, or last wrote to, the artifact. This backend
   * rewrites the file WHOLE, so it has nothing to merge: what it can do is notice that it
   * has nothing of its own to put there. An index handle held open across another
   * process's build otherwise replaced that process's finished artifact with the state it
   * loaded when it started, on the save every shutdown runs (#68).
   */
  private artifactState: string;
  /**
   * The artifact's mtime and size as this handle last read or wrote it, or undefined where
   * there was no file. Together with `artifactState` it separates the two cases a whole-file
   * rewrite has to tell apart: this handle is behind the file (leave it alone), or the file
   * is simply what this handle put there (rewrite it, exactly as before).
   */
  private artifactStamp: string | undefined;

  constructor(opts: MemorySearchIndexOptions) {
    super(opts);
    this.path = opts.path;
    this.artifactState = this.stateSignature();
    this.artifactStamp = this.stampOfArtifact();
  }

  /** Cheap identity of the file on disk: what changes when somebody else replaces it. */
  private stampOfArtifact(): string | undefined {
    if (!this.path) return undefined;
    try {
      const s = statSync(this.path);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return undefined; // no artifact yet, which is itself a state worth remembering
    }
  }

  /**
   * Everything a save would put in the file, as one comparable string: the row counts and
   * the index-level fields. Cheap by construction (sizes, not contents), because it is
   * taken on every save.
   */
  private stateSignature(paused = this.paused): string {
    return [
      this.chunks.size,
      this.vectors.size,
      this.items.size,
      this.builtFromVersion,
      this.itemsTotal,
      this.itemsAvailable,
      this.libraryVersion,
      this.libraryBackend ?? '',
      this.fulltextVersion,
      this.fulltextPartial,
      this.fulltextRecoveryAttempts,
      this.vectorEmbedderId ?? '',
      this.library ?? '',
      paused,
      this.checkpoint ? JSON.stringify(this.checkpoint) : '',
    ].join('|');
  }

  protected counts(): IndexCounts {
    return {
      documents: this.bm25.size,
      vectors: this.vectors.size,
      items: this.items.size,
      fulltextItems: this.fulltextItems.size,
      fulltextPassages: this.fulltextPassages,
      ownWordsItems: this.ownWordsItems.size,
      ownWordsPassages: this.ownWordsPassages,
    };
  }

  protected clearStore(): void {
    this.bm25 = new BM25Index();
    this.vectors = new VectorStore();
    this.chunks = new Map();
    this.items = new Map();
    this.byItem = new Map();
    this.fulltextItems = new Set();
    this.fulltextPassages = 0;
    this.ownWordsItems = new Set();
    this.ownWordsPassages = 0;
  }

  protected putItem(itemKey: string, title: string): void {
    this.items.set(itemKey, title);
  }

  protected putPassage(rec: ChunkRecord): boolean {
    // The Map would have overwritten the record silently, and the BM25 index and the
    // counters below would have taken the second copy for a new document.
    if (this.chunks.has(rec.id)) return false;
    this.chunks.set(rec.id, rec);
    // A passage restored from disk arrives without its item having been announced, so this
    // is also where a reloaded index learns its items and their titles.
    if (!this.items.has(rec.itemKey)) this.items.set(rec.itemKey, rec.title);
    const ids = this.byItem.get(rec.itemKey);
    if (ids) ids.add(rec.id);
    else this.byItem.set(rec.itemKey, new Set([rec.id]));
    this.bm25.addDoc(rec.id, rec.text);
    if (rec.source === 'fulltext') {
      this.fulltextItems.add(rec.itemKey);
      this.fulltextPassages++;
    } else if (rec.source === 'note' || rec.source === 'annotation') {
      this.ownWordsItems.add(rec.itemKey);
      this.ownWordsPassages++;
    }
    return true;
  }

  protected deleteItem(itemKey: string): void {
    for (const id of this.byItem.get(itemKey) ?? []) {
      const rec = this.chunks.get(id);
      if (rec?.source === 'fulltext') this.fulltextPassages--;
      else if (rec?.source === 'note' || rec?.source === 'annotation') this.ownWordsPassages--;
      this.chunks.delete(id);
      this.bm25.removeDoc(id);
      this.vectors.remove(id);
    }
    this.byItem.delete(itemKey);
    this.fulltextItems.delete(itemKey);
    this.ownWordsItems.delete(itemKey);
    this.items.delete(itemKey);
  }

  protected listItemKeys(): string[] {
    return [...this.items.keys()];
  }

  protected listItems(): Array<{ key: string; title: string }> {
    return [...this.items].map(([key, title]) => ({ key, title }));
  }

  protected itemTitle(itemKey: string): string | undefined {
    return this.items.get(itemKey);
  }

  protected hasFulltext(itemKey: string): boolean {
    return this.fulltextItems.has(itemKey);
  }

  protected fulltextPassageIds(itemKey: string): string[] {
    const ids: string[] = [];
    for (const id of this.byItem.get(itemKey) ?? []) {
      if (this.chunks.get(id)?.source === 'fulltext') ids.push(id);
    }
    return ids;
  }

  protected ownWordsPassageIds(): string[] {
    const ids: string[] = [];
    for (const [id, rec] of this.chunks) {
      if (rec.source === 'note' || rec.source === 'annotation') ids.push(id);
    }
    return ids;
  }

  /** The own-words half of `deleteItem`: same bookkeeping, everything else left in place. */
  protected clearOwnWords(itemKey: string): void {
    const ids = this.byItem.get(itemKey);
    if (!ids) return;
    for (const id of [...ids]) {
      const rec = this.chunks.get(id);
      if (rec?.source !== 'note' && rec?.source !== 'annotation') continue;
      this.ownWordsPassages--;
      this.chunks.delete(id);
      this.bm25.removeDoc(id);
      this.vectors.remove(id);
      ids.delete(id);
    }
    this.ownWordsItems.delete(itemKey);
  }

  /** The body half of `deleteItem`: same bookkeeping, metadata passages left in place. */
  protected clearFulltext(itemKey: string): void {
    const ids = this.byItem.get(itemKey);
    if (!ids) return;
    for (const id of [...ids]) {
      const rec = this.chunks.get(id);
      if (rec?.source !== 'fulltext') continue;
      this.fulltextPassages--;
      this.chunks.delete(id);
      this.bm25.removeDoc(id);
      this.vectors.remove(id);
      ids.delete(id);
    }
    this.fulltextItems.delete(itemKey);
  }

  protected putVector(id: string, vector: number[]): void {
    this.vectors.add(id, vector);
  }

  protected passagesMissingVectors(limit: number): ChunkRecord[] {
    const out: ChunkRecord[] = [];
    for (const [id, rec] of this.chunks) {
      if (this.vectors.has(id)) continue;
      out.push(rec);
      if (out.length >= limit) break;
    }
    return out;
  }

  protected clearVectors(): void {
    this.vectors = new VectorStore();
  }

  protected vectorDimension(): number | undefined {
    return this.vectors.dimension;
  }

  /**
   * Live off the resident postings, so this backend stores no droplist and needs no cadence
   * rule: `df` is exact, it is rebuilt from the raw passage text on every load exactly as
   * the postings are, and a JSON artifact written before this change therefore adopts the
   * pruning the moment it is read back. `refreshDroplist` stays a no-op here for the same
   * reason — there is nothing to derive and nothing to persist.
   */
  protected highDf(): TermPredicate {
    return (t) => this.bm25.isHighDf(t);
  }

  protected keywordSearch(q: string, topK: number): RankedId[] {
    return this.bm25.search(q, topK, this.opts.accentExpansion ?? true);
  }

  protected vectorSearch(query: number[], topK: number): RankedId[] {
    return this.vectors.search(query, topK);
  }

  protected passage(id: string): ChunkRecord | undefined {
    return this.chunks.get(id);
  }

  /** Atomically rewrite the JSON artifact. A no-op when this index has no file. */
  protected async writeSnapshot(snapshot: IndexSnapshot): Promise<void> {
    if (!this.path) return;
    await saveIndex({ toJSON: () => snapshot, loadFromJSON() {} }, this.path);
  }

  private async enqueueSnapshot(snapshot: IndexSnapshot): Promise<void> {
    const write = this.saveTail.then(() => this.writeSnapshot(snapshot));
    // A failed write rejects its own caller but must not poison every later save.
    this.saveTail = write.catch(() => {});
    await write;
  }

  protected override async persistPaused(paused: boolean): Promise<void> {
    const written = this.stateSignature(paused);
    await this.enqueueSnapshot({ ...this.toJSON(), paused });
    this.artifactState = written;
    this.artifactStamp = this.stampOfArtifact();
  }

  async save(): Promise<void> {
    // Refusing here is not tidiness, it is the difference between a bad read and lost
    // data. `loadFromJSON` resets before it parses, so an artifact that failed to load
    // leaves this object holding nothing — and the shutdown flush would then write that
    // nothing straight over the user's file, destroying the very index the fault was
    // reporting on. Faulted means: touch the artifact only to replace it deliberately.
    this.refuseIfFaulted();
    if (!this.path) return;
    // A build already winding down may save while resume is being persisted. Let that
    // transition settle before capturing its snapshot, or it could queue the old held
    // value after a successful clear (or the transient clear after a failed one).
    const pauseTransition = this.pauseTransition;
    if (pauseTransition) await pauseTransition.catch(() => {});
    // Nothing of this handle's own to write, and the file is no longer the one it read. On
    // a shared data dir that is another process's finished index, and this backend replaces
    // the file WHOLE: an idle handle's shutdown save would put back the state it loaded
    // (or, having loaded nothing, an empty index) over a build that finished meanwhile
    // (#68). Skipping is safe by construction, because an unchanged handle can only write
    // back what it already read. Both halves matter: a handle that indexed something still
    // writes, and so does one whose artifact nobody else has touched.
    if (this.stateSignature() === this.artifactState && this.stampOfArtifact() !== this.artifactStamp) {
      this.opts.logger?.info(
        `search index: ${this.path} was replaced by another process and this handle has indexed nothing since ` +
          'it read the file, so its own (older) state was NOT written over it. Another Zoteus process is sharing ' +
          'this ZOTEUS_DATA_DIR.',
      );
      return;
    }
    // Capture now, not when the queued write gets its turn. A later setter may roll its
    // in-memory value back after a failed write; no earlier save may publish that transient
    // value merely because it observed mutable `this` late.
    const snapshot = this.toJSON();
    const written = this.stateSignature();
    await this.enqueueSnapshot(snapshot);
    this.artifactState = written;
    this.artifactStamp = this.stampOfArtifact();
  }

  /** No handle to release, but do not report closed while a durable write is outstanding. */
  async close(): Promise<void> {
    const pauseTransition = this.pauseTransition;
    if (pauseTransition) await pauseTransition.catch(() => {});
    await this.saveTail.catch(() => {});
  }

  toJSON(): IndexSnapshot {
    const snapshot: IndexSnapshot = {
      chunks: [...this.chunks.values()],
      vectors: this.vectors.toJSON(),
      builtFromVersion: this.builtFromVersion,
      // Provenance of the vectors, not of the passages: it is what lets the next load
      // notice that ZOTEUS_EMBEDDING_MODEL (or ZOTEUS_EMBEDDINGS) changed under them.
      embedderId: this.vectorEmbedderId,
      // Persisted so a truncated build outlives the process that ran it: a restart that
      // dropped them reported total=0 available=0 and silently stopped warning.
      itemsTotal: this.itemsTotal,
      itemsAvailable: this.itemsAvailable,
      // The real library version, and the API whose sequence it belongs to: an update
      // reads them back to decide whether a `?since=` delta is even addressable.
      libraryVersion: this.libraryVersion,
      // The other sequence's cursor: what an update hands to `/fulltext?since=` to find
      // the text Zotero extracted after this index was built (#26).
      fulltextVersion: this.fulltextVersion,
      // Whether that cursor's absence is the recoverable kind: body text gathered over an
      // attachment map that never reached the end of the library, which the next catch-up
      // has to re-read in full rather than skip (#78).
      fulltextPartial: this.fulltextPartial,
      // And how often the recovery it demands has been paid for and still failed, which is
      // what bounds the next one: a count that reset on every restart would let a permanently
      // unreadable attachment buy a whole body crawl on every update again (#78).
      fulltextRecoveryAttempts: this.fulltextRecoveryAttempts,
      paused: this.paused,
    };
    if (this.libraryBackend) snapshot.libraryBackend = this.libraryBackend;
    // Present only while a build is unfinished, which is exactly when the next one has
    // somewhere to pick up from (#24).
    if (this.checkpoint) snapshot.checkpoint = this.checkpoint;
    if (this.library) snapshot.library = this.library;
    return snapshot;
  }

  loadFromJSON(data: IndexSnapshot): void {
    this.reset();
    for (const rec of data.chunks ?? []) this.putPassage(rec);
    // A reloaded index reports what it HOLDS: an index carrying full-text passages counts
    // as full-text-enabled even before this process runs a build of its own.
    this.fulltextEnabled = this.fulltextPassages > 0;
    this.vectors = VectorStore.fromJSON(data.vectors ?? []);
    this.vectorEmbedderId = data.embedderId;
    // Stored vectors are only comparable with queries embedded by the same model, so a
    // model switch invalidates them: drop them and say so rather than ranking a query
    // against a foreign vector space (cosine over mismatched dimensions still returns
    // numbers, which is exactly what makes it dangerous).
    this.reconcileVectorProvenance();
    this.builtFromVersion = data.builtFromVersion ?? 0;
    // Absent in files written before these were persisted: 0/0 leaves every truncation
    // check false, so an old index stays silent rather than inventing a shortfall.
    this.itemsTotal = data.itemsTotal ?? 0;
    this.itemsAvailable = data.itemsAvailable ?? 0;
    // Absent in files written before incremental updates existed: version 0 blocks an
    // update, which is the safe answer (the first action:"update" rebuilds once and stamps).
    this.libraryVersion = data.libraryVersion ?? 0;
    this.libraryBackend = data.libraryBackend;
    // Absent in files written before the full-text cursor existed. 0 then means "unknown",
    // and the first update that wants full text closes the coverage gap once and stores a
    // real cursor; see `fulltextCatchUp` (#26).
    this.fulltextVersion = data.fulltextVersion ?? 0;
    // Absent in files written before #78, where false is the right reading: those indexes
    // were built over a map nobody checked, and a spurious full re-read of every extracted
    // attachment is not something to hand every existing index on upgrade. A build over a
    // map that stops early sets it from here on.
    this.fulltextPartial = data.fulltextPartial ?? false;
    this.fulltextRecoveryAttempts = data.fulltextRecoveryAttempts ?? 0;
    // Absent in files written before resume existed, and in any file a finished build
    // wrote: both mean there is nothing to resume, which is what undefined says (#24).
    this.checkpoint = data.checkpoint;
    this.paused = data.paused ?? false;
    // Absent in files written before the library stamp existed: an unstamped index
    // refuses nothing (assertLibrary), which is the only workable answer for it.
    this.library = data.library;
    // What the file said, and which file it was, so a later save can tell whether this
    // handle has anything of its own to put back into it (#68).
    this.artifactState = this.stateSignature();
    this.artifactStamp = this.stampOfArtifact();
  }
}
