import type {
  BuildOptions,
  IndexBuildStatus,
  SearchHit,
  SearchIndex,
  SearchIndexOptions,
  SearchIndexStatus,
  StorageBackend,
  VersionBackend,
} from './backend.js';

/**
 * The SQLite search index cannot be read.
 *
 * Raised in place of SQLite's own sentence, which reaches the caller as a bare "database
 * disk image is malformed" naming neither the file nor anything to do about it.
 */
export class SearchIndexCorruptError extends Error {
  constructor(
    readonly dbPath: string,
    readonly detail: string,
  ) {
    super(corruptionMessage(dbPath, detail));
    this.name = 'SearchIndexCorruptError';
  }
}

/**
 * SQLite's vocabulary for "this file is not a usable database".
 *
 * Matched on the message rather than on a code because `node:sqlite` does not surface
 * `SQLITE_CORRUPT` as a stable numeric field, and because these strings are part of
 * SQLite's public interface: they are in its documentation and have not changed across
 * the 3.x series.
 *
 * Deliberately narrow. A locked database, a read-only filesystem and a missing table are
 * all failures and none of them is corruption; widening this list would turn a transient
 * fault into a message telling someone to delete their index.
 */
const CORRUPTION_SIGNS = [
  'database disk image is malformed',
  'file is not a database',
  'file is encrypted or is not a database',
  'malformed database schema',
  'database corruption',
  'sqlite_corrupt',
  'sqlite_notadb',
];

/** True when `e` says the file itself is unusable, not that one operation failed. */
export function isCorruptionError(e: unknown): boolean {
  if (e instanceof SearchIndexCorruptError) return true;
  const text = (e instanceof Error ? `${e.message} ${(e as { code?: string }).code ?? ''}` : String(e)).toLowerCase();
  return CORRUPTION_SIGNS.some((sign) => text.includes(sign));
}

/**
 * Name the file, the sidecars and the command, because the caller can act on none of it
 * otherwise — least of all an agent, which is what is usually holding this connection.
 *
 * The index is derived data: deleting it costs only the time to rebuild. That is also the
 * reason not to rebuild it here without being asked. A rebuild re-crawls the whole library
 * and takes minutes to tens of minutes with full text on, and this error surfaces in the
 * middle of somebody's query — not a moment at which to start a job of that length on
 * their behalf. See the pull request for the alternatives.
 *
 * Deleting the file also clears the version stamp, which lives in the `meta` table inside
 * the same database. A recovery that dropped the passage tables and left `meta` standing
 * would leave an empty index claiming to be current, and `action:"update"` would then diff
 * against a stamp for passages that no longer exist — an empty library that reports itself
 * as up to date, which is worse than the error it replaced.
 */
export function corruptionMessage(dbPath: string, detail: string): string {
  return (
    `The search index at ${dbPath} cannot be read — SQLite reports: ${detail}. ` +
    'Every other tool still works: only search is affected, because the index is a derived ' +
    'cache and nothing else reads it. It is not rebuilt automatically, because rebuilding ' +
    're-reads the whole Zotero library and takes minutes to tens of minutes. To recover, ' +
    'delete the file and its write-ahead sidecars, then restart:\n' +
    `  rm ${JSON.stringify(dbPath)} ${JSON.stringify(`${dbPath}-wal`)} ${JSON.stringify(`${dbPath}-shm`)}\n` +
    'If a legacy search-index.json is still beside it, the next start imports that and the ' +
    'library is searchable again immediately. Otherwise call zotero_index with ' +
    'action:"build" (add fulltext:true if you index attachment text).'
  );
}

/**
 * The index the server holds when its database could not be opened.
 *
 * Not an empty index, and that is the whole design. An empty one answers every query with
 * no hits, which reads to a caller exactly like a library holding nothing — a silent wrong
 * answer in place of a loud right one. So every operation that would read or write the
 * index refuses with the message above, and the rest of the server is untouched: item
 * reads, bibliographies and attachment full text go to Zotero and never through here, so
 * one bad cache file no longer takes the whole MCP server down with it.
 */
export class CorruptSearchIndex implements SearchIndex {
  readonly storage: StorageBackend = 'sqlite';
  readonly embedderActive = false;
  readonly embedderId = undefined;
  readonly vectorEmbedderId = undefined;
  readonly supportsDelete = false;
  readonly embedderName = 'none (search index unreadable)';
  readonly hasEmbedder = false;
  readonly hasVectors = false;
  readonly isBuilding = false;

  constructor(
    readonly failure: SearchIndexCorruptError,
    private readonly opts: SearchIndexOptions,
  ) {}

  /** Read the same way every other index reads it, so a status still says what was asked for. */
  get embedderConfigured(): string {
    return this.opts.configured ?? this.opts.embedder?.name ?? 'off';
  }

  /**
   * Short on purpose. `statusSummary` prints this beside `storageNotice`, which already
   * carries the file, the sidecars and the command; repeating all of that here printed the
   * same paragraph three times in one response.
   */
  get embedderReason(): string {
    return 'the search index could not be opened';
  }

  /**
   * Reported non-empty so that nothing mistakes this for a library awaiting its first
   * build and helpfully starts one — `zotero_semantic_search`'s `auto_build` would.
   */
  get isEmpty(): boolean {
    return false;
  }

  noteFulltextUnavailable(): void {
    /* Nothing to report about full text: the index cannot be read at all. */
  }

  status(): SearchIndexStatus {
    return {
      documents: 0,
      vectors: 0,
      items: 0,
      storage: 'sqlite',
      storageNotice: this.failure.message,
      embedder: this.embedderName,
      embedderConfigured: this.embedderConfigured,
      embedderActive: false,
      fulltextEnabled: false,
      fulltextItems: 0,
      fulltextPassages: 0,
      builtFromVersion: 0,
      libraryVersion: 0,
    };
  }

  buildStatus(): IndexBuildStatus {
    return {
      ...this.status(),
      state: 'error',
      operation: 'build',
      itemsFetched: 0,
      itemsRemoved: 0,
      itemsTotal: 0,
      itemsAvailable: 0,
      passages: 0,
      lastError: this.embedderReason,
    };
  }

  requestStop(): boolean {
    return false;
  }

  async embed(): Promise<number[][]> {
    return [];
  }

  async build(_libraryItems: any[], _opts?: BuildOptions): Promise<SearchIndexStatus> {
    throw this.failure;
  }

  async buildIncremental(): Promise<IndexBuildStatus> {
    throw this.failure;
  }

  /** Never attempt a delta against an index that could not be read. */
  updateBlocker(_backend: VersionBackend): string {
    return 'the search index cannot be read';
  }

  async updateIncremental(): Promise<IndexBuildStatus> {
    throw this.failure;
  }

  async query(_q: string, _opts?: unknown): Promise<SearchHit[]> {
    throw this.failure;
  }

  /** Nothing is held, so nothing can be written; saving must not report false success. */
  async save(): Promise<void> {
    throw this.failure;
  }

  async close(): Promise<void> {
    /* No handle was ever opened. */
  }
}
