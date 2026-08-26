import type { EmbeddingProvider } from './embeddings.js';
import type { Logger } from '../../lib/logger.js';

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

export interface SearchHit {
  itemKey: string;
  title: string;
  snippet: string;
  score: number;
  /** Present when the snippet came from an attachment's body text, not its metadata. */
  source?: 'fulltext';
}

/** One stored passage: the unit both the keyword index and the vector store rank. */
export interface ChunkRecord {
  id: string;
  itemKey: string;
  title: string;
  text: string;
  /** Absent for metadata passages, which keeps already-persisted index files loadable. */
  source?: 'fulltext';
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
}

export interface SearchIndexStatus {
  documents: number;
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
  fulltextFor?: (itemKey: string, item: any) => Promise<string | undefined>;
  /** Concurrent full-text fetches while indexing one page of items (default 4). */
  fulltextConcurrency?: number;
  /** Sentence to carry on the status, e.g. why this rebuild replaced an update. */
  note?: string;
  /** Which API is serving these pages, recorded alongside the version stamp. */
  versionBackend?: VersionBackend;
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
  status(): SearchIndexStatus;
  /** Full live status: index size + build progress. */
  buildStatus(): IndexBuildStatus;
  /** Cooperatively cancel the running build. Returns false if nothing is building. */
  requestStop(): boolean;
  /** Embed arbitrary texts with the configured provider (empty array if none). */
  embed(texts: string[]): Promise<number[][]>;
  build(libraryItems: any[], opts?: BuildOptions): Promise<SearchIndexStatus>;
  buildIncremental(fetchPage: PageFetcher, opts?: IncrementalBuildOptions): Promise<IndexBuildStatus>;
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
