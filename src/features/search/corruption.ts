import { SearchIndexBase } from './index-manager.js';
import type {
  IndexCounts,
  IndexBuildStatus,
  RankedId,
  SearchHit,
  SearchIndexOptions,
  SearchIndexStatus,
  StorageBackend,
} from './backend.js';

/**
 * The SQLite search index cannot be read.
 *
 * Raised in place of SQLite's own sentence, which reaches the caller as a bare "database
 * disk image is malformed" naming neither the file nor anything to do about it.
 */
export class SearchIndexCorruptError extends Error {
  readonly detail: string;

  constructor(
    readonly dbPath: string,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(corruptionMessage(dbPath, detail));
    this.detail = detail;
    this.name = 'SearchIndexCorruptError';
  }
}

/** One sentence for the status fields that have room only to say the index is unusable. */
const UNREADABLE = 'the search index cannot be read';

/**
 * SQLite's vocabulary for "this file is not a usable database". These strings are part of
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
];

/**
 * SQLite primary result codes for corruption: SQLITE_CORRUPT (11) and SQLITE_NOTADB (26).
 * `node:sqlite` sets `code` to the constant 'ERR_SQLITE_ERROR' on every error and carries
 * the real classification in numeric `errcode` and textual `errstr` — and the message can
 * be an unrelated wrapper: a corrupt FTS5 shadow table surfaces as "vtable constructor
 * failed: passages_fts" with errcode 11, which no message scan can recognize. Extended
 * codes put the primary code in the low byte, hence the mask.
 */
const CORRUPT_ERRCODES = new Set([11, 26]);

/** True when `e` says the file itself is unusable, not that one operation failed. */
export function isCorruptionError(e: unknown): boolean {
  if (e instanceof SearchIndexCorruptError) return true;
  const { errcode, errstr } = (e ?? {}) as { errcode?: number; errstr?: string };
  if (typeof errcode === 'number' && CORRUPT_ERRCODES.has(errcode & 0xff)) return true;
  const text = `${e instanceof Error ? e.message : String(e)} ${errstr ?? ''}`.toLowerCase();
  return CORRUPTION_SIGNS.some((sign) => text.includes(sign));
}

/**
 * The message the refusal carries, which is the whole of what a caller has to go on.
 *
 * It says why there is no automatic rebuild; what it does not say, and the reason deleting
 * the file is the recovery rather than emptying it, is the version stamp. That lives in the
 * `meta` table inside this same database. A repair that dropped the passage tables and left
 * `meta` standing would leave an empty index carrying a current stamp, and `action:"update"`
 * would then diff against passages that no longer exist — an empty library reporting itself
 * as up to date, which is worse than the error it replaced. Removing the file removes the
 * stamp with it, by construction.
 */
function corruptionMessage(dbPath: string, detail: string): string {
  const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((p) => JSON.stringify(p)).join(' ');
  return `The search index at ${dbPath} cannot be read — SQLite reports: ${detail}. Every other tool still works: only search is affected, because the index is a derived cache and nothing else reads it. It is not rebuilt automatically, because rebuilding re-reads the whole Zotero library and takes minutes to tens of minutes, which is not a job to start inside somebody's query. To recover, delete the file and its write-ahead sidecars, then restart:
  rm ${files}
If a legacy search-index.json is still beside it, the next start imports that and the library is searchable again immediately. Otherwise call zotero_index with action:"build" (add fulltext:true if you index attachment text).`;
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
 *
 * It extends `SearchIndexBase` rather than implementing `SearchIndex` directly, so that
 * everything a caller reads but this class has no opinion about — the embedder identity and
 * its degradation reasons, the counts, the build-status shape — keeps coming from the same
 * place it comes from on a healthy index. A hand-written copy drifts the first time a field
 * is added to the interface, and drifts silently, because the missing field is optional.
 */
export class CorruptSearchIndex extends SearchIndexBase {
  readonly storage: StorageBackend = 'sqlite';
  /** No store to delete from, and never a delta: see `updateBlocker`. */
  readonly supportsDelete = false;

  constructor(readonly failure: SearchIndexCorruptError, opts: SearchIndexOptions) {
    super(opts);
    // The channel the store already uses to explain what opening it did or refused to do,
    // so this reaches `status().storageNotice` and `statusSummary` the same way a refused
    // JSON migration does.
    this.storeNotice = failure.message;
  }

  /** The refusal every caller can defer to instead of explaining an empty index. */
  override get storeFault(): Error {
    return this.failure;
  }

  /**
   * Reported non-empty so that nothing mistakes this for a library awaiting its first
   * build and helpfully starts one — `zotero_semantic_search`'s `auto_build` would.
   */
  override get isEmpty(): boolean {
    return false;
  }

  override buildStatus(): IndexBuildStatus {
    return { ...super.buildStatus(), state: 'error', lastError: UNREADABLE };
  }

  /** Never attempt a delta against an index that could not be read. */
  override updateBlocker(): string {
    return UNREADABLE;
  }

  override async build(): Promise<SearchIndexStatus> {
    throw this.failure;
  }

  override async buildIncremental(): Promise<IndexBuildStatus> {
    throw this.failure;
  }

  override async updateIncremental(): Promise<IndexBuildStatus> {
    throw this.failure;
  }

  override async query(): Promise<SearchHit[]> {
    throw this.failure;
  }

  /** Nothing is held, so nothing can be written; saving must not report false success. */
  async save(): Promise<void> {
    throw this.failure;
  }

  async close(): Promise<void> {
    /* No handle was ever opened by this object: the store closed its own before throwing. */
  }

  // The storage primitives the base would call. Nothing reaches them — every public entry
  // point above refuses first — so they exist to satisfy the contract, not to be run.
  protected counts(): IndexCounts {
    return { documents: 0, vectors: 0, items: 0, fulltextItems: 0, fulltextPassages: 0 };
  }
  protected clearStore(): void {}
  protected clearVectors(): void {}
  protected putItem(): void {
    throw this.failure;
  }
  protected putPassage(): void {
    throw this.failure;
  }
  protected deleteItem(): void {
    throw this.failure;
  }
  protected putVector(): void {
    throw this.failure;
  }
  protected listItemKeys(): string[] {
    return [];
  }
  protected vectorDimension(): number | undefined {
    return undefined;
  }
  protected keywordSearch(): RankedId[] {
    throw this.failure;
  }
  protected vectorSearch(): RankedId[] {
    throw this.failure;
  }
  protected passage(): undefined {
    return undefined;
  }
}
