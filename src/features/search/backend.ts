import type { EmbedKind, EmbeddingProvider } from './embeddings.js';
import type { Logger } from '../../lib/logger.js';
import type { LibraryRef } from '../../api/web-client.js';

/**
 * Canonical identity of a library for index stamping: `user` for the personal library,
 * `group:<id>` for a group. The personal library is deliberately one token with no id:
 * the desktop app serves it as users/0 while the cloud names the real user id, and the
 * doc-comment on startIndexBuild promises that seam never splits the index — so it must
 * never split the stamp either.
 */
export function canonicalLibraryToken(lib?: LibraryRef): string {
  return lib?.type === 'group' ? `group:${lib.id}` : 'user';
}

/** The token, for humans: "the personal library", or "group 4523". */
export function describeLibraryToken(library: string): string {
  return library === 'user' ? 'the personal library' : library.replace(/^group:/, 'group ');
}

/**
 * Store an index lives in. `memory` is the original in-memory + JSON implementation:
 * fastest for small libraries and the only one available before Node 22.13. `sqlite`
 * keeps passages, vectors and the keyword index in a SQLite file (FTS5) and is the only
 * one that survives a large library: a single JSON.stringify cannot exceed V8's maximum
 * string length (~512 MB), and re-parsing a file anywhere near it needs an order of
 * magnitude more heap than the file itself. See ZOTEUS_INDEX_BACKEND.
 */
export type StorageBackend = 'memory' | 'sqlite';

/**
 * Which Zotero API produced a library version stamp. The desktop app keeps its own version
 * sequence, unrelated to the cloud's, so a stored version only means anything beside the
 * backend that issued it: comparing a local version against the cloud (or the reverse)
 * would fetch a nonsense delta. Every version stamp therefore carries this alongside it.
 */
export type VersionBackend = 'local' | 'cloud';

/**
 * Where a passage's words came from. Absent means the item's own metadata (title,
 * abstract, creators, tags), which is what every passage was before there was anything
 * else, and which keeps already-persisted index files loadable.
 *
 * `note` and `annotation` are the reader's own words: a child note, or a highlight and
 * its comment on a PDF. They are labelled apart from `fulltext` because they are a
 * different kind of evidence — the only text in a library nobody else wrote — and a hit
 * on one is worth telling the caller about (#33).
 */
export type PassageSource = 'fulltext' | 'note' | 'annotation';

export interface SearchHit {
  itemKey: string;
  title: string;
  snippet: string;
  score: number;
  /** Present when the snippet came from something other than the item's own metadata. */
  source?: PassageSource;
}

/** One stored passage: the unit both the keyword index and the vector store rank. */
export interface ChunkRecord {
  id: string;
  itemKey: string;
  title: string;
  text: string;
  /** Absent for metadata passages, which keeps already-persisted index files loadable. */
  source?: PassageSource;
}

/**
 * One piece of a reader's own words, as the index takes it: a child note, or one
 * annotation's highlighted passage and comment together.
 *
 * Carries the CHILD's key, not the parent item's, and that is what makes the update path
 * work: the passage ids built from it name the note or annotation they came from, so the
 * set an index holds for an item can be compared against the set the library holds and
 * the difference re-indexed. Deleting one note of five moves no version anywhere in
 * Zotero, so nothing else would ever notice it had gone.
 */
export interface OwnWordsEntry {
  /** The note or annotation's own item key. */
  key: string;
  kind: 'note' | 'annotation';
  /** Plain text, HTML already stripped for notes. */
  text: string;
}

/**
 * Everything the index needs to ask about a library's notes and annotations, behind one
 * object rather than the four loose callbacks the full-text pass grew.
 *
 * The last two are answered from a single census — one paged crawl of the library's child
 * items plus a batched lookup that resolves each annotation's attachment to the item it
 * hangs off — so they are grouped here to make it obvious they share it, and that asking
 * the second costs nothing once the first has been asked. The census is opened lazily, and
 * `childVersions` is what lets an update decide whether to open it at all.
 */
export interface OwnWordsAccess {
  /**
   * Every note and annotation key in the library, mapped to its version. One request per
   * 5000 keys (`?format=versions`, which both APIs honour an `itemType` filter on), and
   * deliberately the FIRST thing an update asks: an update where nothing was written or
   * highlighted answers from this alone and never opens the census below.
   */
  childVersions(): Promise<Map<string, number>>;
  /**
   * The items these children belong to. Opens the census, because it is the only thing
   * that knows: an annotation names the attachment it sits on, never the item.
   */
  itemsFor(childKeys: Iterable<string>): Promise<Set<string>>;
  /** The reader's own words for one indexed item, in a stable order. Opens the census. */
  textsFor(itemKey: string): Promise<OwnWordsEntry[]>;
}

/** A candidate returned by one ranker, higher score = better. */
export interface RankedId {
  id: string;
  score: number;
}

/** Live sizes of a store, reported by status() without walking the passages. */
export interface IndexCounts {
  documents: number;
  vectors: number;
  items: number;
  fulltextItems: number;
  fulltextPassages: number;
  /** Items whose own notes or annotations are indexed. */
  ownWordsItems: number;
  /** Passages that came from them (a subset of `documents`). */
  ownWordsPassages: number;
}

export interface SearchIndexStatus {
  documents: number;
  /** Whether background index work is durably held until action:"resume" clears it. */
  paused: boolean;
  vectors: number;
  items: number;
  /** Where the index is kept: the legacy JSON file, or SQLite. */
  storage: StorageBackend;
  /**
   * What opening the store had to do, or refused to do: a JSON index imported into
   * SQLite, or one too large to parse at all. Surfaced so a migration is never silent.
   */
  storageNotice?: string;
  /**
   * The embedder that is actually producing vectors, NOT merely the one that was asked
   * for. Reads "none (local requested; ...)" when the configured provider cannot run, so
   * a 0-vector index explains itself instead of looking like an empty library (#7).
   */
  embedder: string;
  /** The requested ZOTEUS_EMBEDDINGS value, whether or not it works. */
  embedderConfigured: string;
  /** Model the active embedder uses, when it names one (ZOTEUS_EMBEDDING_MODEL). */
  embedderModel?: string;
  /** True only while the configured provider is genuinely producing vectors. */
  embedderActive: boolean;
  /** Why `embedderConfigured` is not active, and what to do about it. */
  embedderReason?: string;
  /** Set when stored vectors were discarded because another embedder had produced them. */
  vectorsStaleReason?: string;
  /**
   * How the last semantic query of this process ranked vectors, on a backend that has more
   * than one way to: `codes` is the two-stage path (binary codes scanned by Hamming
   * distance, then an exact cosine rescore of the candidates), `exact` is a full scan of
   * every stored vector. Absent until a semantic query has run.
   */
  vectorScan?: 'exact' | 'codes';
  /**
   * What that path had to do, or why the two-stage one could not serve the query. Reported
   * for the same reason as `embedderReason`: an index that quietly fell back to the scan
   * this exists to avoid is otherwise indistinguishable from one that is simply slow.
   */
  vectorScanNotice?: string;
  /**
   * True when this build indexed the library's child notes and PDF annotations. On by
   * default (ZOTEUS_INDEX_OWN_WORDS): unlike full text, the whole corpus is one paged
   * crawl of items the reader wrote by hand, orders of magnitude smaller than the
   * attachment bodies it sits beside.
   */
  ownWordsEnabled: boolean;
  /** Items whose notes or annotations are in the index. */
  ownWordsItems: number;
  /** Passages that came from them (a subset of `documents`). */
  ownWordsPassages: number;
  /** Why notes and annotations are not indexed although they were asked for. */
  ownWordsReason?: string;
  /** True when this build was asked to index attachment full text (opt-in). */
  fulltextEnabled: boolean;
  /** Items whose attachment full text is in the index. */
  fulltextItems: number;
  /** Passages that came from attachment full text (a subset of `documents`). */
  fulltextPassages: number;
  /** Why full text is not being indexed although it was requested. */
  fulltextReason?: string;
  /**
   * Items crawled by the build that produced this index. Named for the Zotero library
   * version it was once meant to hold, and kept as an item COUNT because callers (and
   * persisted indexes) read it that way. The real library version is `libraryVersion`.
   */
  builtFromVersion: number;
  /**
   * Zotero's Last-Modified-Version for the library this index was built or updated from
   * (0 = none recorded). This is what an incremental update diffs against.
   */
  libraryVersion: number;
  /** Which API issued `libraryVersion`; the two sequences are not comparable. */
  libraryBackend?: VersionBackend;
  /**
   * The highest version of Zotero's FULL-TEXT sequence this index has consumed (0 = none
   * recorded). Zotero numbers extracted text on a sequence of its own, unrelated to the
   * item versions `libraryVersion` holds: text extracted after a build leaves every item
   * version untouched, so it appears in no `?since=` delta and used to stay invisible to
   * `action:"update"` forever (#26). This is the cursor an update hands to `/fulltext?since=`.
   */
  fulltextVersion: number;
  /**
   * Canonical identity of the library whose rows this index holds (`user`, or
   * `group:<id>` — see canonicalLibraryToken). Absent in indexes written before the
   * stamp existed. One index file holds one library, and this is the stamp
   * `assertLibrary` guards on.
   */
  library?: string;
}

/**
 * Where an interrupted build stopped, committed in the same write as the rows it describes.
 *
 * Kept apart from `libraryVersion` on purpose. That stamp answers "is this index current?"
 * and is deliberately withheld from a build that did not finish, so it can never double as
 * a resume cursor. That left a stopped build with nowhere to say how far it got, and the
 * next build restarting from 0 over rows it had already paid to embed (#24). This record
 * answers the other question, "where would a resume pick up?", and is cleared the moment a
 * build completes.
 */
export interface BuildCheckpoint {
  /** The pass that was running: informational, since a resume re-derives its own worklist. */
  phase: 'metadata' | 'fulltext';
  /** Crawl offset already covered, i.e. the `start` the metadata pass would fetch next. */
  crawlOffset: number;
  /** Items the library reported while that crawl ran (0 = never learned). */
  itemsAvailable: number;
  /** Items that crawl was going to index, after the build cap (0 = never learned). */
  itemsTotal: number;
  /** The cap in force on the interrupted build (0 = none). */
  maxItems: number;
  /** The library version the interrupted crawl began from (0 = the API issued none). */
  crawlVersion: number;
  /** Which API served it: offsets and versions from the other one are not comparable. */
  backend?: VersionBackend;
  /** Vectors the committed rows carry. A resume under another embedder is not a resume. */
  embedderId?: string;
  /** Whether that build was crawling attachment full text. */
  fulltext: boolean;
  /**
   * Passages committed but not yet embedded: the tail of the queue an interruption caught
   * between `putPassage` and the embedding call. Fewer than one batch by construction (the
   * queue is drained down to that before every save), and named individually so a resume
   * embeds exactly them instead of hunting the index for rows with no vector. Without it a
   * resumed build converges on an index a handful of vectors short of an uninterrupted one.
   */
  pendingPassages?: string[];
}

/** Lifecycle of the asynchronous background index build. */
export type BuildState = 'idle' | 'building' | 'done' | 'error';

/**
 * Live build/status snapshot. Backward compatible with SearchIndexStatus (it keeps
 * documents/vectors/items/embedder/builtFromVersion) and adds build progress.
 */
export interface IndexBuildStatus extends SearchIndexStatus {
  state: BuildState;
  /**
   * Which job the counters below describe. A build's `itemsFetched` is progress through
   * the library; an update's is the size of the delta, and reading one as the other makes
   * "7 of 5000" look like a build that stalled.
   */
  operation: 'build' | 'update';
  /** Items pulled from the Zotero API so far. On an update: the CHANGED items processed. */
  itemsFetched: number;
  /** Items an update removed because the library no longer holds them (0 for a build). */
  itemsRemoved: number;
  /** Total items expected (0 = not yet known). Capped by the build limit. */
  itemsTotal: number;
  /**
   * Items the library actually holds, before the build limit is applied (0 = not yet
   * known). Kept apart from `itemsTotal` so a truncated build stays legible: with only
   * the capped figure, a build that stopped at the limit reports `5000/5000` and is
   * indistinguishable from one that indexed the whole library.
   */
  itemsAvailable: number;
  /** Passages indexed so far (alias of documents). */
  passages: number;
  /** Set when state === 'error'. */
  lastError?: string;
  /**
   * Last failure to write the index to its store. Kept on the status because a build
   * whose artifact never reached disk still reports state:"done": without this the only
   * trace was a stderr warning, which desktop clients discard (#10).
   */
  persistError?: string;
  /**
   * What an incremental update did, or why one could not run and a full rebuild took its
   * place. Same reasoning as `persistError`: an update that silently became a ten-minute
   * rebuild, or one that skipped the deletion pass, is otherwise indistinguishable from a
   * cheap successful one.
   */
  updateNotice?: string;
  /**
   * Which pass of a build the counters describe. A build indexes every item's metadata
   * first and only then crawls attachment full text, so that a large library becomes
   * searchable on titles, abstracts, creators and tags within minutes rather than after a
   * body-text crawl that can run for days (#23). `'metadata'` throughout when full text
   * was not asked for.
   */
  phase: 'metadata' | 'fulltext';
  /** Items the full-text pass has looked at, whether or not they had extractable text. */
  fulltextItemsScanned: number;
  /** Size of the full-text pass's worklist; 0 until the metadata pass has finished. */
  fulltextItemsTotal: number;
  /**
   * Items an interrupted build had already committed when this one resumed it (absent when
   * this build started from nothing). Set in the build's synchronous prologue, so the
   * status the starter returns already says a resume is what began (#24).
   */
  resumedFrom?: number;
  /**
   * When Zotero's local API stopped answering while THIS job was reading from it (ISO
   * timestamp), and absent when it did not. Present means the job saturated the desktop
   * app: from that moment every read and write in the session falls back to the Zotero Web
   * API, which is slower and rate-limited, so the rest of the build takes far longer than
   * its start suggested. Until #39 the only trace was one INFO line on stderr, which
   * desktop hosts discard, so the slowdown had no visible cause at all.
   */
  localApiDegradedAt?: string;
  /**
   * Passages held for keyword search that carry no vector, when an embedder is configured
   * and something should have given them one. Present only when it is non-zero.
   *
   * The measure of a half-embedded index, and the number that used to have nowhere to be
   * reported: an embedder that failed partway through a build left tens of thousands of
   * these, and status said only "embedder=none", which reads as an index with no vectors
   * at all rather than one with most of them (#48). It is also what tells a caller the
   * remedy is `action:"build"` (which resumes and buys exactly these) rather than
   * `action:"refresh"` (which would pay for every vector again).
   */
  passagesWithoutVectors?: number;
  /**
   * The arithmetic that decides whether an API embedding provider will rate-limit this
   * build, reported because it is the one thing a user cannot work out from the outside.
   *
   * #48 is exactly this sum going wrong unseen: a 10k-item library at the default pacing
   * rode at 1,000,000 tokens/min, precisely OpenAI's Tier 2 ceiling, so every build 429'd
   * somewhere between 53k and 84k vectors and nothing in the tool output ever mentioned a
   * rate. Present only for an API provider, since a local pipeline has no such limit.
   */
  embedRate?: EmbedRate;
}

/** Rate arithmetic for a build embedding through an API provider (see IndexBuildStatus). */
export interface EmbedRate {
  /** Passages per request: ZOTEUS_EMBED_BATCH_SIZE. */
  batchSize: number;
  /** Pause between requests in ms: ZOTEUS_EMBED_BATCH_DELAY_MS. */
  delayMs: number;
  /**
   * Estimated tokens in one request, at four characters per token over the chunk size this
   * build is producing (1200 characters for body passages, 512 for metadata ones). An
   * estimate, not a count: the provider tokenizes, and this side would have to ship a
   * tokenizer per model to do better. It is the number the provider's per-request cap is
   * compared against (OpenAI rejects a request above 300,000 tokens outright).
   */
  tokensPerRequest: number;
  /**
   * Tokens per minute this build has actually sustained, measured over the time spent
   * inside the provider plus the configured pauses. Absent until enough has been embedded
   * to mean anything. Unlike the estimate above this is observed, which matters because
   * the rate at delay 0 is set by how fast the provider answers and nothing on this side
   * can predict it.
   */
  tokensPerMinute?: number;
}

/** One page of library items plus the library-wide total (for progress). */
export interface PageResult {
  items: any[];
  totalResults: number;
  /**
   * Zotero's Last-Modified-Version for this response. Recorded from the FIRST page only:
   * it is the library as it stood when the crawl started, so anything modified while the
   * crawl runs still sorts after the stamp and is picked up by the next update.
   */
  lastModifiedVersion?: number;
}

/** Fetch a page of items starting at offset `start` (the Web API pages 100-at-a-time). */
export type PageFetcher = (start: number) => Promise<PageResult>;

export interface IncrementalBuildOptions {
  /** Hard cap on items to index (defaults to no cap beyond the fetcher). */
  maxItems?: number;
  /** Embedding batch size (texts handed to the provider per call). */
  embedBatchSize?: number;
  /** Pause between embedding batches in ms; 0 only yields (see batchPause). */
  embedBatchDelayMs?: number;
  /** Persist partial progress every N items. */
  persistEveryItems?: number;
  /** Persist partial progress at least every N ms. */
  persistEveryMs?: number;
  /** Log/report progress every N items. */
  progressEveryItems?: number;
  /** Log/report progress at least every N ms. */
  progressEveryMs?: number;
  /** Persist the current (partial) index; defaults to the backend's own save(). */
  persist?: () => Promise<void>;
  /** Optional progress hook (e.g. MCP notifications) fired alongside the logger. */
  onProgress?: (status: IndexBuildStatus) => void;
  /**
   * Optional supplier of an item's attachment full text. When present, that text is
   * chunked into extra passages beside the metadata ones, so a search can match the body
   * of a paper and not only its title and abstract. Opt-in: see ZOTEUS_INDEX_FULLTEXT.
   */
  fulltextFor?: (itemKey: string, item?: any) => Promise<string | undefined>;
  /**
   * The item keys the full-text source can actually serve. Lets the full-text pass skip
   * the items with no extractable attachment instead of awaiting a no-op for each, which
   * on a library where a minority of items have PDFs is most of the worklist.
   */
  fulltextKeys?: () => Promise<Set<string>>;
  /**
   * Attachments whose text could not be read so far. Consulted after the full-text pass,
   * because those failures are caught per item so the pass always "succeeds" — and a
   * desktop app that quits partway through would otherwise leave a build reporting `done`
   * with a valid version stamp and most of its body text silently missing.
   */
  fulltextFailures?: () => number;
  /**
   * Persist cadence for the full-text pass only. Body passages are far bulkier than
   * metadata ones (and on the JSON backend a persist re-serializes everything), so that
   * pass saves less often — while the metadata pass keeps the fast default, which is what
   * makes its results durable early.
   */
  persistEveryItemsFulltext?: number;
  persistEveryMsFulltext?: number;
  /**
   * Concurrent full-text fetches while indexing one page of items. `startIndexBuild` picks
   * it from the API serving the crawl (see DEFAULT_FULLTEXT_CONCURRENCY_LOCAL / _CLOUD):
   * the desktop app is one process that can be saturated, the Web API is a fleet that
   * rate-limits instead. Unset falls back to the cloud number.
   */
  fulltextConcurrency?: number;
  /**
   * The library's notes and annotations, if they are being indexed. Passages built from
   * them carry the PARENT item's key, so an item with forty annotations is still one
   * search result and its own words extend the corpus rather than diluting it (#33).
   */
  ownWords?: OwnWordsAccess;
  /**
   * The highest full-text version the source behind `fulltextFor` has seen, read once the
   * pass is over. Stored beside the library version so a later update can ask Zotero's
   * own full-text sequence what has been extracted since this build (#26).
   */
  fulltextVersion?: () => number;
  /** Sentence to carry on the status, e.g. why this rebuild replaced an update. */
  note?: string;
  /** Which API is serving these pages, recorded alongside the version stamp. */
  versionBackend?: VersionBackend;
  /**
   * Start over rather than resume: discard any checkpoint an interrupted build left and
   * crawl the library from the top. `action:"refresh"` is what asks for it; a plain
   * `action:"build"` resumes, because redoing work already committed is the thing #24 is
   * about.
   */
  fresh?: boolean;
  /**
   * Canonical identity of the library being indexed (see canonicalLibraryToken).
   * Asserted against the stored stamp before anything is cleared — a build for a
   * different library refuses instead of erasing this one — and stamped on the index
   * with the first rows written. Callers should also assert synchronously
   * (`assertLibrary`) so the refusal reaches them, not a fire-and-forget job's log.
   */
  library?: string;
}

/** What Zotero's full-text sequence has extracted since a cursor, and the new cursor. */
export interface FulltextCatchUp {
  /** Indexed items whose attachments carry text newer than the cursor handed in. */
  itemKeys: Set<string>;
  /** The highest full-text version seen, to store once those items are indexed. */
  version: number;
}

/**
 * A delta update: re-index only what changed since the stored version stamp, and drop what
 * the library no longer holds. Everything the build loop already knows how to do (chunking,
 * batched embedding, full text, progress) is inherited; the two extra members are the only
 * reads an update needs that a build does not.
 */
export interface IncrementalUpdateOptions extends IncrementalBuildOptions {
  /** Which API is serving this update. Must match the stored stamp's backend. */
  backend: VersionBackend;
  /** Page the items changed since the stored version (the caller supplies `?since=`). */
  fetchChanged: PageFetcher;
  /**
   * Every item key the library holds right now, from `?format=versions` (keys only, so it
   * costs a fraction of an item crawl). Deletions are the set difference against it,
   * because the `/deleted` endpoint is cloud-only and an update must work off the desktop
   * app too.
   */
  liveKeys: () => Promise<Set<string>>;
  /**
   * Ask Zotero's full-text sequence what it has extracted since `since`, the cursor this
   * index stored when it was built. Without it an update sees text extracted after the
   * build only for items that also changed in some other way, which is almost none of
   * them: opening a PDF makes Zotero extract it and touches no item version at all (#26).
   *
   * Costs one request on a library where nothing was extracted, and only then the
   * attachment map behind `fulltextFor`. Omitted when the update was not asked for full
   * text.
   */
  fulltextCatchUp?: (since: number) => Promise<FulltextCatchUp>;
}

export interface BuildOptions {
  version?: number;
  extraText?: Map<string, string>;
}

export interface SearchIndexOptions {
  embedder: EmbeddingProvider | null;
  logger?: Logger;
  /** What ZOTEUS_EMBEDDINGS asked for (defaults to the provider's own name, or 'off'). */
  configured?: string;
  /** Why the request produced no provider at all, known at construction time. */
  unavailable?: string;
  /**
   * Query-side accent expansion (ZOTEUS_ACCENT_EXPANSION, default true): an unaccented
   * query term also matches the accented spellings that dominate the library's
   * vocabulary. Expansion compensates the recall that keeping diacritics in the index
   * removed for unaccented queries; false opts into strict as-typed exactness. Gates the
   * query step only — what is indexed, the migration and the variants-map derivation are
   * unchanged either way, so flipping it never needs a rebuild.
   */
  accentExpansion?: boolean;
}

/** The JSON artifact the legacy backend writes, and the SQLite backend imports. */
export interface IndexSnapshot {
  chunks: ChunkRecord[];
  vectors: Array<{ id: string; vector: number[] }>;
  builtFromVersion: number;
  itemsTotal?: number;
  itemsAvailable?: number;
  embedderId?: string;
  /** Real Zotero library version stamp, and which API issued it (absent in older files). */
  libraryVersion?: number;
  libraryBackend?: VersionBackend;
  /** Cursor into Zotero's full-text sequence (absent in files written before #26). */
  fulltextVersion?: number;
  /** Where an interrupted build stopped (absent in files written before #24, and once
   * a build has finished: a completed build has nothing to resume). */
  checkpoint?: BuildCheckpoint;
  /** Canonical identity of the library these rows belong to (absent in older files). */
  library?: string;
  /** Durable hold on all build/update entry points (absent in older files means false). */
  paused?: boolean;
}

export interface QueryOptions {
  limit?: number;
  mode?: 'auto' | 'keyword' | 'semantic';
}

/**
 * The hybrid (keyword + vector) library index, as its callers use it: the build pipeline
 * (features/search/build.ts), zotero_index, zotero_semantic_search and zotero_get_fulltext's
 * reranker. Two implementations satisfy it, chosen by ZOTEUS_INDEX_BACKEND: MemorySearchIndex
 * (in-memory + JSON) and SqliteSearchIndex (SQLite FTS5). Nothing above this interface knows
 * which one it holds.
 */
export interface SearchIndex {
  /** Which store backs this index. */
  readonly storage: StorageBackend;
  /**
   * Set when the store itself could not be opened, and every operation on this index will
   * therefore refuse. Callers that would otherwise explain an empty index — the 0-vector
   * refusal in zotero_semantic_search, say — must defer to it, or they explain the wrong
   * thing: "this index holds no vectors, rebuild it" is not what is wrong when the file
   * cannot be read at all.
   */
  readonly storeFault: Error | undefined;
  /** What ZOTEUS_EMBEDDINGS asked for. */
  readonly embedderConfigured: string;
  /** True only while vectors are genuinely being produced. */
  readonly embedderActive: boolean;
  /** Identity of the vectors this index would produce now (undefined with no provider). */
  readonly embedderId: string | undefined;
  /** Identity of the vectors this index actually HOLDS (undefined when it holds none). */
  readonly vectorEmbedderId: string | undefined;
  /** True when the store can remove an item's rows, which is what an update needs. */
  readonly supportsDelete: boolean;
  /** Why the configured embedder is not active (undefined when nothing is wrong). */
  readonly embedderReason: string | undefined;
  /** The effective embedder, for humans. */
  readonly embedderName: string;
  readonly hasEmbedder: boolean;
  /** True when the index actually holds vectors, i.e. semantic-only ranking can work. */
  readonly hasVectors: boolean;
  /** True while a background build is running. */
  readonly isBuilding: boolean;
  readonly isEmpty: boolean;
  /** Explain why an opt-in full-text build is not producing passages. */
  noteFulltextUnavailable(reason: string): void;
  /** Why this index holds no notes or annotations although they were asked for. */
  noteOwnWordsUnavailable(reason: string): void;
  /**
   * Zotero's local API stopped answering while the running job was reading from it. Backs
   * the full-text crawl off to one fetch at a time and records the moment on the status;
   * a no-op when nothing is running (#39).
   */
  noteLocalApiDegraded(at: number): void;
  status(): SearchIndexStatus;
  /** Full live status: index size + build progress. */
  buildStatus(): IndexBuildStatus;
  /** Whether build/update work is durably held. */
  readonly isPaused: boolean;
  /** Persist or clear the hold, including while no job is running. */
  setPaused(paused: boolean): Promise<void>;
  /** Cooperatively cancel the running build. Returns false if nothing is building. */
  requestStop(): boolean;
  /** Embed arbitrary texts with the configured provider (empty array if none). */
  embed(texts: string[], kind?: EmbedKind): Promise<number[][]>;
  build(libraryItems: any[], opts?: BuildOptions): Promise<SearchIndexStatus>;
  buildIncremental(fetchPage: PageFetcher, opts?: IncrementalBuildOptions): Promise<IndexBuildStatus>;
  /**
   * Refuse to index `library` over the rows of a different one. Throws, naming both,
   * when the store is non-empty and stamped with another library; silent otherwise
   * (same library, empty store, or a pre-stamp index). Build/update callers check this
   * BEFORE kicking off their fire-and-forget job, so the refusal reaches the tool
   * caller instead of the job's error log.
   */
  assertLibrary(library: string): void;
  /**
   * Why a delta update cannot run against this index right now, or undefined when it can.
   * Checked by the caller BEFORE any request is made, so a refusal costs nothing and can
   * fall back to a full rebuild with the reason attached.
   */
  updateBlocker(backend: VersionBackend): string | undefined;
  /** Apply a delta update. Fire-and-forget like buildIncremental; poll `buildStatus()`. */
  updateIncremental(opts: IncrementalUpdateOptions): Promise<IndexBuildStatus>;
  query(q: string, opts?: QueryOptions): Promise<SearchHit[]>;
  /**
   * Persist the index to its store. Rejects on failure: callers record the error on the
   * build status rather than swallowing it, because a build that could not be written is
   * not a build that is done.
   */
  save(): Promise<void>;
  /** Release the store (the SQLite handle). A no-op for the in-memory backend. */
  close(): Promise<void>;
}
