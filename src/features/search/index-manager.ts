import { BM25Index } from './bm25.js';
import { VectorStore } from './vector-store.js';
import { chunkText } from './chunker.js';
import { normalizeForSearch, tokenize } from './tokenize.js';
import { batchPause, embedderIdentity } from './embeddings.js';
import { DEFAULT_EMBED_BATCH_SIZE } from './limits.js';
import { Semaphore } from '../../lib/semaphore.js';
import { progressLine } from './build.js';
import { saveIndex } from './persistence.js';
import type {
  BuildOptions,
  BuildState,
  ChunkRecord,
  IncrementalBuildOptions,
  IncrementalUpdateOptions,
  IndexBuildStatus,
  IndexCounts,
  IndexSnapshot,
  PageFetcher,
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
  BuildOptions,
  BuildState,
  ChunkRecord,
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

function itemText(d: any): string {
  const creators = (d.creators ?? []).map((c: any) => c.lastName ?? c.name).filter(Boolean).join(' ');
  const tags = (d.tags ?? []).map((t: any) => t.tag).filter(Boolean).join(' ');
  return [d.title, d.abstractNote, creators, tags, d.date, d.publicationTitle, d.bookTitle, d.note]
    .filter(Boolean)
    .join('. ');
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

/** Build a readable, query-centred snippet trimmed to word boundaries. */
export function makeSnippet(text: string, query: string, max = 240): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  // Folded, not merely lowercased, because the terms being looked for are folded: an
  // accented query would otherwise never find its own passage and every snippet would
  // start at character 0. The fold is length-preserving on precomposed text, so the
  // offset carries over; on text stored decomposed it can drift by the number of marks
  // before the hit, which is immaterial to a window this function then snaps to word
  // boundaries and pads by a third of its width.
  const lower = normalizeForSearch(clean);
  let pos = -1;
  for (const t of tokenize(query)) {
    const i = lower.indexOf(t);
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
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
  protected builtFromVersion = 0;
  /**
   * Zotero's Last-Modified-Version this index was built or updated from, and the API that
   * issued it. Persisted together because neither is meaningful alone: a local version
   * number read as a cloud one asks for a delta that spans the wrong sequence entirely.
   */
  protected libraryVersion = 0;
  protected libraryBackend: VersionBackend | undefined = undefined;
  /** What the last update did, or why a rebuild replaced it (see IndexBuildStatus). */
  protected updateNotice: string | undefined = undefined;
  /**
   * Embedder identity that produced the vectors currently held (persisted with them).
   * Public because the update path compares it against the live embedder before deciding
   * whether a delta is even meaningful.
   */
  vectorEmbedderId: string | undefined = undefined;
  /** Set when a load discarded vectors another embedder had produced. */
  protected vectorsStale: string | undefined = undefined;
  /** What opening the store had to do or refused to do (JSON migration; see #10). */
  protected storeNotice: string | undefined = undefined;

  // Asynchronous build lifecycle (see buildIncremental / requestStop / buildStatus).
  private buildState: BuildState = 'idle';
  private operation: 'build' | 'update' = 'build';
  private itemsFetched = 0;
  private itemsRemoved = 0;
  protected itemsTotal = 0;
  protected itemsAvailable = 0;
  private lastBuildError: string | undefined = undefined;
  private cancelToken: { cancelled: boolean } | null = null;
  /**
   * Set the first time the provider throws. Kept on the instance (rather than in a build's
   * local scope) precisely so status can report it: a failure that only ever reached a
   * stderr log line is invisible to a desktop-extension user, whose client discards it.
   */
  private embedderError: string | undefined = undefined;
  /**
   * Last failure to write the index out. Same reasoning as `embedderError`: a build that
   * could not persist its artifact used to report state:"done" with only a stderr warning
   * to show for it, so the loss was discovered on the next startup (#10).
   */
  private persistError: string | undefined = undefined;

  constructor(protected readonly opts: SearchIndexOptions) {}

  /** Which store backs this index. */
  abstract readonly storage: StorageBackend;
  /** Live sizes of the store. Must not walk the passages: status() is called per progress tick. */
  protected abstract counts(): IndexCounts;
  /** Drop every passage and vector. */
  protected abstract clearStore(): void;
  /** Register an indexed item. Called for every item, including ones with no text at all. */
  protected abstract putItem(itemKey: string, title: string): void;
  /** Store one passage (also updating item and full-text bookkeeping). */
  protected abstract putPassage(rec: ChunkRecord): void;
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
  /** False when this store cannot delete rows, which makes an update impossible. */
  abstract readonly supportsDelete: boolean;
  /** Attach a vector to an already-stored passage. */
  protected abstract putVector(id: string, vector: number[]): void;
  /** Discard every stored vector, keeping the passages. */
  protected abstract clearVectors(): void;
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
  noteFulltextUnavailable(reason: string): void {
    this.fulltextUnavailable = reason;
  }

  /**
   * Drop vectors this embedder did not produce, and remember why. Ranking them would not
   * fail, it would return plausible nonsense, which is the whole reason to be strict here.
   */
  protected dropStaleVectors(cause: string): void {
    this.vectorsStale =
      `${cause} They were discarded (vectors from different models are not comparable). Keyword search is ` +
      'unaffected: run zotero_index action:"build" to re-embed the library with the current model.';
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
    };
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

  /** Embed arbitrary texts with the configured provider (empty array if none). */
  async embed(texts: string[]): Promise<number[][]> {
    if (!this.opts.embedder) return [];
    return this.opts.embedder.embed(texts);
  }

  status(): SearchIndexStatus {
    const c = this.counts();
    const s: SearchIndexStatus = {
      documents: c.documents,
      vectors: c.vectors,
      items: c.items,
      storage: this.storage,
      embedder: this.embedderName,
      embedderConfigured: this.embedderConfigured,
      embedderActive: this.embedderActive,
      fulltextEnabled: this.fulltextEnabled,
      fulltextItems: c.fulltextItems,
      fulltextPassages: c.fulltextPassages,
      builtFromVersion: this.builtFromVersion,
      libraryVersion: this.libraryVersion,
    };
    if (this.libraryBackend) s.libraryBackend = this.libraryBackend;
    const reason = this.embedderReason;
    if (reason) s.embedderReason = reason;
    if (this.opts.embedder?.model) s.embedderModel = this.opts.embedder.model;
    if (this.vectorsStale) s.vectorsStaleReason = this.vectorsStale;
    if (this.storeNotice) s.storageNotice = this.storeNotice;
    if (this.fulltextEnabled && this.fulltextUnavailable) s.fulltextReason = this.fulltextUnavailable;
    return s;
  }

  get isEmpty(): boolean {
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
  }

  async build(libraryItems: any[], opts: BuildOptions = {}): Promise<SearchIndexStatus> {
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
        records.push(rec);
        this.putPassage(rec);
      }
    }
    if (this.opts.embedder && records.length) {
      try {
        const vecs = await this.opts.embedder.embed(records.map((r) => r.text));
        records.forEach((r, i) => {
          if (vecs[i]) this.putVector(r.id, vecs[i]!);
        });
      } catch (e) {
        this.noteEmbedFailure(e);
      }
    }
    this.builtFromVersion = opts.version ?? 0;
    return this.status();
  }

  /**
   * Asynchronous, incremental, resumable index build.
   *
   * Pages items via `fetchPage`, chunks/keyword-indexes them as they arrive, embeds in
   * small batches, and atomically persists partial progress along the way — so a
   * timeout, crash, or `requestStop()` never leaves a corrupt index and whatever was
   * saved stays queryable. Returns the final build status; the caller should kick this
   * off without awaiting (fire-and-forget) and poll `buildStatus()`.
   */
  async buildIncremental(fetchPage: PageFetcher, opts: IncrementalBuildOptions = {}): Promise<IndexBuildStatus> {
    if (this.isBuilding) throw new Error('Index build already in progress; poll action:"status".');
    this.buildState = 'building';
    this.operation = 'build';
    this.lastBuildError = undefined;
    this.embedderError = undefined;
    this.persistError = undefined;
    // A rebuild is the retry for full text too: clear the previous run's verdict so a
    // library that has since been extracted in Zotero stops reporting the old reason.
    this.fulltextEnabled = Boolean(opts.fulltextFor);
    this.fulltextUnavailable = undefined;
    this.itemsFetched = 0;
    this.itemsRemoved = 0;
    this.itemsTotal = 0;
    this.itemsAvailable = 0;
    // Carried from the caller, e.g. the reason an update fell back to this rebuild, so it
    // must survive the reset below rather than being cleared with the rest of the state.
    this.updateNotice = opts.note;
    const token = { cancelled: false };
    this.cancelToken = token;
    this.reset();
    this.vectorEmbedderId = this.embedderId;

    const embedBatchSize = opts.embedBatchSize ?? DEFAULT_EMBED_BATCH_SIZE;
    const embedBatchDelayMs = opts.embedBatchDelayMs ?? 0;
    const persistEveryItems = opts.persistEveryItems ?? 200;
    const persistEveryMs = opts.persistEveryMs ?? 10_000;
    const progressEveryItems = opts.progressEveryItems ?? 500;
    const progressEveryMs = opts.progressEveryMs ?? 10_000;
    const maxItems = opts.maxItems;
    const fulltextLimit = new Semaphore(Math.max(1, opts.fulltextConcurrency ?? 4));
    // Without an explicit hook the index persists itself: the SQLite backend commits its
    // open transaction here, so "persist" and "make the last N items durable" are one act.
    const persist = opts.persist ?? (() => this.save());

    const pending: ChunkRecord[] = []; // passages awaiting embedding
    let start = 0;
    let crawlVersion = 0;
    let itemsSincePersist = 0;
    let lastPersistAt = Date.now();
    let itemsSinceLog = 0;
    let lastLogAt = Date.now();

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
      if (itemsSincePersist >= persistEveryItems || Date.now() - lastPersistAt >= persistEveryMs) await persistNow();
    };
    const maybeLog = (): void => {
      if (itemsSinceLog < progressEveryItems && Date.now() - lastLogAt < progressEveryMs) return;
      itemsSinceLog = 0;
      lastLogAt = Date.now();
      const s = this.buildStatus();
      this.opts.logger?.info(`index build: ${progressLine(s)}`);
      opts.onProgress?.(s);
    };
    const embedPending = (force: boolean): Promise<void> =>
      this.embedPending(pending, token, embedBatchSize, embedBatchDelayMs, force);

    try {
      for (;;) {
        if (token.cancelled) break;
        if (maxItems !== undefined && this.itemsFetched >= maxItems) break;
        const page = await fetchPage(start);
        // The library as it stood when the crawl began: recorded once, from the first page,
        // so a change made mid-crawl stays after the stamp and the next update still sees it.
        if (!crawlVersion && page.lastModifiedVersion) crawlVersion = page.lastModifiedVersion;
        const pageItems = page.items ?? [];
        if (pageItems.length === 0) break;
        if (!this.itemsTotal && page.totalResults) {
          this.itemsAvailable = page.totalResults;
          this.itemsTotal = maxItems !== undefined ? Math.min(page.totalResults, maxItems) : page.totalResults;
        }
        // Only the items that still fit under the cap are worth fetching full text for.
        const room = maxItems === undefined ? pageItems.length : Math.max(0, maxItems - this.itemsFetched);
        const batch = pageItems.slice(0, room);
        const texts = await this.fulltextForPage(batch, opts, token, fulltextLimit);
        for (let i = 0; i < batch.length; i++) {
          if (token.cancelled) break;
          this.addOneItem(batch[i], pending, texts?.[i]);
          this.itemsFetched++;
          itemsSincePersist++;
          itemsSinceLog++;
        }
        start += pageItems.length;
        await embedPending(false);
        maybeLog();
        await maybePersist();
        if (start >= page.totalResults) break;
      }
      if (!token.cancelled) await embedPending(true);
      this.builtFromVersion = this.itemsFetched;
      // A cancelled crawl covers an unknown prefix of the library, so it gets no stamp: an
      // update against one would treat every item it never reached as unchanged forever.
      if (!token.cancelled && crawlVersion) {
        this.libraryVersion = crawlVersion;
        this.libraryBackend = opts.versionBackend;
      }
      await persistNow();
      this.buildState = 'done';
      const final = this.buildStatus();
      this.opts.logger?.info(`index build ${token.cancelled ? 'stopped' : 'complete'}: ${progressLine(final)}`);
      opts.onProgress?.(final);
      return final;
    } catch (e) {
      this.buildState = 'error';
      this.lastBuildError = e instanceof Error ? e.message : String(e);
      this.opts.logger?.error(`index build failed: ${this.lastBuildError}`);
      // Keep whatever partial data we already indexed, and persist it best-effort.
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
    if (!this.supportsDelete) {
      return `the ${this.storage} index cannot remove rows, so deleted items could never leave it`;
    }
    if (this.isEmpty) return 'the index is empty';
    if (!this.libraryVersion) {
      return 'this index carries no library version stamp (it predates incremental updates, or its last build was cancelled)';
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
    if (this.isBuilding) throw new Error('Index build already in progress; poll action:"status".');
    const fromVersion = this.libraryVersion;
    this.buildState = 'building';
    this.operation = 'update';
    this.lastBuildError = undefined;
    this.embedderError = undefined;
    this.persistError = undefined;
    this.updateNotice = undefined;
    this.itemsFetched = 0;
    this.itemsRemoved = 0;
    if (opts.fulltextFor) {
      // An update is the retry for full text as well, but only upwards: an index that
      // already holds body passages does not stop being a full-text index when a metadata
      // update runs over it.
      this.fulltextEnabled = true;
      this.fulltextUnavailable = undefined;
    }
    const token = { cancelled: false };
    this.cancelToken = token;

    const embedBatchSize = opts.embedBatchSize ?? DEFAULT_EMBED_BATCH_SIZE;
    const embedBatchDelayMs = opts.embedBatchDelayMs ?? 0;
    const progressEveryItems = opts.progressEveryItems ?? 500;
    const progressEveryMs = opts.progressEveryMs ?? 10_000;
    const maxItems = opts.maxItems;
    const fulltextLimit = new Semaphore(Math.max(1, opts.fulltextConcurrency ?? 4));
    const persist = opts.persist ?? (() => this.save());

    const pending: ChunkRecord[] = [];
    // The keys the index holds, which the upsert loop keeps current: it is both the cap
    // check ("is this item already indexed?") and, at the end, the left side of the
    // deletion diff, so the store is walked once rather than per item.
    const known = new Set(this.listItemKeys());
    let start = 0;
    let crawlVersion = 0;
    let itemsSinceLog = 0;
    let lastLogAt = Date.now();
    let skippedByCap = 0;
    let reconciled = false;

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
        const texts = await this.fulltextForPage(pageItems, opts, token, fulltextLimit);
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
          this.addOneItem(item, pending, texts?.[i]);
          known.add(key);
          this.itemsFetched++;
          itemsSinceLog++;
        }
        start += pageItems.length;
        await this.embedPending(pending, token, embedBatchSize, embedBatchDelayMs, false);
        maybeLog();
        if (start >= page.totalResults) break;
      }
      if (!token.cancelled) await this.embedPending(pending, token, embedBatchSize, embedBatchDelayMs, true);

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

      if (!token.cancelled && reconciled && crawlVersion) {
        this.libraryVersion = crawlVersion;
        this.libraryBackend = opts.backend;
      }
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
   * Full text for one page of items, several attachments in flight, so the per-item round
   * trip does not serialize the whole crawl behind the network.
   */
  private async fulltextForPage(
    batch: any[],
    opts: IncrementalBuildOptions,
    token: { cancelled: boolean },
    limit: Semaphore,
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
            this.opts.logger?.debug(`full text for ${key} skipped: ${e instanceof Error ? e.message : String(e)}`);
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
    while (pending.length >= (force ? 1 : batchSize)) {
      if (token.cancelled) return;
      const batch = pending.splice(0, Math.min(batchSize, pending.length));
      try {
        const vecs = await this.opts.embedder!.embed(batch.map((r) => r.text));
        batch.forEach((r, i) => {
          if (vecs[i]) this.putVector(r.id, vecs[i]!);
        });
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
  private addOneItem(item: any, pending: ChunkRecord[], fulltext?: string): void {
    const d = item.data ?? item;
    const key = item.key ?? d.key;
    if (!key) return;
    const title = d.title ?? '(untitled)';
    this.putItem(key, title);
    for (const ch of chunkText(itemText(d))) {
      const rec: ChunkRecord = { id: `${key}#${ch.index}`, itemKey: key, title, text: ch.text };
      this.putPassage(rec);
      if (this.hasEmbedder) pending.push(rec);
    }
    if (fulltext) this.addFulltext(key, title, fulltext, pending);
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
      this.putPassage(rec);
      if (this.hasEmbedder) pending.push(rec);
    }
  }

  async query(q: string, opts: QueryOptions = {}): Promise<SearchHit[]> {
    const limit = opts.limit ?? 10;
    const mode = opts.mode ?? 'auto';
    const pool = limit * 3;

    const keyword: RankedId[] = mode === 'semantic' ? [] : this.keywordSearch(q, pool);
    let vector: RankedId[] = [];
    if (mode !== 'keyword' && this.opts.embedder && this.counts().vectors) {
      try {
        const [qv] = await this.opts.embedder.embed([q]);
        const dim = this.vectorDimension();
        // Index files written before the embedder identity was persisted carry no
        // provenance, so a model switch under one shows up only here, as a query of a
        // different width. Cosine over mismatched widths still returns numbers.
        if (qv && dim !== undefined && qv.length !== dim) {
          this.dropStaleVectors(
            `The stored vectors have ${dim} dimensions, but ${this.embedderId ?? 'the current embedder'} produces ${qv.length}.`,
          );
        } else if (qv) {
          vector = this.vectorSearch(qv, pool);
        }
      } catch (e) {
        this.noteEmbedFailure(e);
      }
    }

    const fused = rrf([keyword, vector]);
    const seen = new Set<string>();
    const hits: SearchHit[] = [];
    for (const { id, score } of fused) {
      const rec = this.passage(id);
      if (!rec || seen.has(rec.itemKey)) continue;
      seen.add(rec.itemKey);
      const hit: SearchHit = { itemKey: rec.itemKey, title: rec.title, snippet: makeSnippet(rec.text, q), score };
      // Worth surfacing: a body-text snippet is a passage the caller can go and cite with
      // zotero_get_fulltext, whereas a metadata one is just the abstract.
      if (rec.source === 'fulltext') hit.source = 'fulltext';
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
  private items = new Set<string>();
  /** Passage ids per item, so a delete does not scan every chunk in the index. */
  private byItem = new Map<string, Set<string>>();
  /** Items with at least one full-text passage, and how many such passages exist. */
  private fulltextItems = new Set<string>();
  private fulltextPassages = 0;
  private readonly path: string | undefined;

  constructor(opts: MemorySearchIndexOptions) {
    super(opts);
    this.path = opts.path;
  }

  protected counts(): IndexCounts {
    return {
      documents: this.bm25.size,
      vectors: this.vectors.size,
      items: this.items.size,
      fulltextItems: this.fulltextItems.size,
      fulltextPassages: this.fulltextPassages,
    };
  }

  protected clearStore(): void {
    this.bm25 = new BM25Index();
    this.vectors = new VectorStore();
    this.chunks = new Map();
    this.items = new Set();
    this.byItem = new Map();
    this.fulltextItems = new Set();
    this.fulltextPassages = 0;
  }

  protected putItem(itemKey: string): void {
    this.items.add(itemKey);
  }

  protected putPassage(rec: ChunkRecord): void {
    this.chunks.set(rec.id, rec);
    this.items.add(rec.itemKey);
    const ids = this.byItem.get(rec.itemKey);
    if (ids) ids.add(rec.id);
    else this.byItem.set(rec.itemKey, new Set([rec.id]));
    this.bm25.addDoc(rec.id, rec.text);
    if (rec.source === 'fulltext') {
      this.fulltextItems.add(rec.itemKey);
      this.fulltextPassages++;
    }
  }

  protected deleteItem(itemKey: string): void {
    for (const id of this.byItem.get(itemKey) ?? []) {
      const rec = this.chunks.get(id);
      if (rec?.source === 'fulltext') this.fulltextPassages--;
      this.chunks.delete(id);
      this.bm25.removeDoc(id);
      this.vectors.remove(id);
    }
    this.byItem.delete(itemKey);
    this.fulltextItems.delete(itemKey);
    this.items.delete(itemKey);
  }

  protected listItemKeys(): string[] {
    return [...this.items];
  }

  protected putVector(id: string, vector: number[]): void {
    this.vectors.add(id, vector);
  }

  protected clearVectors(): void {
    this.vectors = new VectorStore();
  }

  protected vectorDimension(): number | undefined {
    return this.vectors.dimension;
  }

  protected keywordSearch(q: string, topK: number): RankedId[] {
    return this.bm25.search(q, topK);
  }

  protected vectorSearch(query: number[], topK: number): RankedId[] {
    return this.vectors.search(query, topK);
  }

  protected passage(id: string): ChunkRecord | undefined {
    return this.chunks.get(id);
  }

  /** Atomically rewrite the JSON artifact. A no-op when this index has no file. */
  async save(): Promise<void> {
    if (!this.path) return;
    await saveIndex(this, this.path);
  }

  /** Nothing to release: the store is this object. */
  async close(): Promise<void> {}

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
    };
    if (this.libraryBackend) snapshot.libraryBackend = this.libraryBackend;
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
  }
}
