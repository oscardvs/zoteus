import { SearchIndexBase } from './index-manager.js';
import { SearchIndexCorruptError, SearchIndexUnreadableError, UNREADABLE } from './store-faults.js';
import type {
  IndexCounts,
  IndexBuildStatus,
  RankedId,
  SearchHit,
  SearchIndexOptions,
  SearchIndexStatus,
  StorageBackend,
} from './backend.js';

// Re-exported so the many importers of this module keep resolving; the definitions live in
// store-faults.ts, which nothing in the index can cycle through.
export {
  SearchIndexCorruptError,
  SearchIndexUnreadableError,
  isCorruptionError,
  isQuerySyntaxError,
  sidecarsOf,
} from './store-faults.js';

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

  constructor(readonly failure: SearchIndexCorruptError | SearchIndexUnreadableError, opts: SearchIndexOptions) {
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
   * build and sends the caller off to start one, as `zotero_semantic_search` does for an
   * empty index.
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
    return { documents: 0, vectors: 0, items: 0, fulltextItems: 0, fulltextPassages: 0, ownWordsItems: 0, ownWordsPassages: 0 };
  }
  protected clearStore(): void {}
  protected clearVectors(): void {}
  protected passagesMissingVectors(): [] {
    return [];
  }
  protected putItem(): void {
    throw this.failure;
  }
  protected putPassage(): boolean {
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
  protected listItems(): Array<{ key: string; title: string }> {
    return [];
  }
  protected itemTitle(): undefined {
    return undefined;
  }
  protected hasFulltext(): boolean {
    return false;
  }
  protected fulltextPassageIds(): string[] {
    return [];
  }
  protected clearFulltext(): void {
    throw this.failure;
  }
  protected ownWordsPassageIds(): string[] {
    return [];
  }
  protected clearOwnWords(): void {
    throw this.failure;
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
