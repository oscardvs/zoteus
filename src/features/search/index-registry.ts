import { access, readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Logger } from '../../lib/logger.js';
import type { BuildState, SearchIndex } from './backend.js';
import { describeLibraryToken, isAddressableLibrary, libraryOfPathSegment, libraryPathSegment } from './backend.js';

// Re-exported where it has always been imported from: the spelling rule belongs to the
// token vocabulary (backend.ts), but this registry is what puts it on disk.
export { libraryPathSegment };
import { createSearchIndex, sqliteIndexPath, type CreateSearchIndexOptions } from './factory.js';

/**
 * ONE STORE PER LIBRARY, and the reason is not a preference.
 *
 * A passage id is `${itemKey}#${n}` with no library component (index-manager.ts), and
 * Zotero item keys repeat across libraries: the same key names a different item in a
 * group than it does in the personal library. Two libraries in one store therefore alias
 * each other's passages silently, which is exactly what the vector-salvage refusal
 * already says out loud. So a second library means a second file, and a search across
 * both means fanning out over the two and merging what comes back.
 *
 * This registry owns those files: which library maps to which path, which of them are
 * open, and which is closed first when there are too many.
 */

/** The message the reopen path has always used; kept word for word. */
const REOPEN_WHILE_BUILDING =
  'The search index cannot be reopened while a build is running. Stop it first with zotero_index action:"stop".';

/**
 * How long `closeAll` gives a cancelled build to reach its own final commit.
 *
 * Its caller is a shutdown that already has a deadline of its own (25 s in
 * installShutdownHandlers), and a cooperative build stops at the next page or embed batch,
 * so this is generous for the usual case and still well inside that budget when a job is
 * mid-request and cannot answer.
 */
const STOP_WAIT_MS = 5_000;

/** How often `closeAll` looks, while waiting for one. */
const STOP_POLL_MS = 10;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** `isAddressableLibrary`, as the refusal a path derivation owes its caller. */
function assertAddressable(library: string): void {
  if (isAddressableLibrary(library)) return;
  throw new Error(
    `${JSON.stringify(library)} is not a library this server can index: a group is addressed by its positive ` +
      'numeric id. Call zotero_groups to list the groups you can reach, then use the `id` it returns.',
  );
}

/** Literal text as a regular expression. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The index file for a library that is NOT the one this data directory's index was
 * already keyed to.
 *
 * `-lib-` rather than a bare suffix so the name cannot collide with the per-user primary
 * (`search-index-19552201.json`) however a Zotero user id is spelled, and so the reverse
 * match can be strict. Both halves of a pair stay together: the SQLite database is
 * derived from this json path by `sqliteIndexPath`, exactly as it is for the primary.
 */
export function siblingIndexPath(primaryPath: string, library: string): string {
  const stem = primaryPath.replace(/\.json$/i, '');
  return `${stem}-lib-${libraryPathSegment(library)}.json`;
}

/** One library that has an index in this data directory, as `zotero_index` reports it. */
export interface IndexedLibrary {
  /** Canonical token this index is keyed by: "user" or "group:<id>". */
  library: string;
  /** The same, for humans: "the personal library" or "group 4523". */
  label: string;
  /** Absolute path of the JSON artifact (the SQLite database sits beside it). */
  path: string;
  /** True for the index `ctx.search` points at, which is never closed to make room. */
  primary: boolean;
  /**
   * The store's OWN stamp, which is what the cross-library guard compares against. Absent
   * on an index written before the stamp existed; a value that differs from `library`
   * means the file was keyed one way and built another, which nothing here does but a
   * hand-moved file could.
   */
  stamp?: string;
  documents: number;
  items: number;
  vectors: number;
  /** Lifecycle of that index's own background job. */
  state: BuildState;
  /** Identity of the vectors it actually HOLDS, absent when it holds none. */
  vectorEmbedder?: string;
  /** Zotero library version it was last built or updated from (0 = none recorded). */
  libraryVersion: number;
  /** Why this index could not be opened or read at all. */
  fault?: string;
}

export interface SearchIndexRegistryOptions {
  /** Everything `createSearchIndex` needs except the path, which this registry supplies. */
  create: Omit<CreateSearchIndexOptions, 'jsonPath'>;
  /**
   * The index path this data directory already uses: `search-index.json`, or
   * `search-index-<zoteroUserId>.json` in multi-tenant mode. Unchanged, so an index built
   * by an earlier version keeps working with no migration.
   */
  primaryPath: string;
  /** The index already open at that path. */
  primary: SearchIndex;
  /**
   * The library the primary index answers for. Its OWN stamp when it carries one (an
   * install whose default library is a group has been writing that group's rows into this
   * file all along, and re-keying it would orphan them), otherwise the configured default
   * library, which is what a build with no library named is about to stamp it.
   */
  primaryLibrary: string;
  /** ZOTEUS_INDEX_MAX_OPEN. */
  maxOpen: number;
  logger: Logger;
}

interface Entry {
  library: string;
  path: string;
  index: SearchIndex;
  lastUsed: number;
  /** The primary. `ctx.search` holds this object, so closing it would break every tool. */
  pinned: boolean;
}

/**
 * The open set of per-library search indexes for one context.
 *
 * Bounded by ZOTEUS_INDEX_MAX_OPEN: each open index is a SQLite handle, a write-ahead log
 * and (on the JSON backend) a resident copy of every passage, so a user who addresses ten
 * groups must not end up holding ten of them. The least recently used is closed to make
 * room, through the same save-then-close pair the shutdown flush uses, because close() is
 * what checkpoints the WAL.
 *
 * Two entries are never closed to make room: the primary, because `ctx.search` points at
 * it and 31 tools read that field, and any index with a build running, because a running
 * build holds the instance rather than re-reading the field and would go on writing into
 * a closed store. When those are the only entries left the bound is exceeded rather than
 * enforced, and the logger says so.
 */
export class SearchIndexRegistry {
  private readonly entries = new Map<string, Entry>();
  /** Single-flight per library, shared by open() and reopen() so they cannot race. */
  private readonly inflight = new Map<string, Promise<SearchIndex>>();
  private order = 0;
  private readonly leases = new Map<string, number>();
  private readonly create: Omit<CreateSearchIndexOptions, 'jsonPath'>;
  private readonly maxOpen: number;
  private readonly logger: Logger;
  readonly primaryPath: string;
  readonly primaryLibrary: string;

  constructor(opts: SearchIndexRegistryOptions) {
    this.create = opts.create;
    this.primaryPath = opts.primaryPath;
    this.primaryLibrary = opts.primaryLibrary;
    this.maxOpen = Math.max(1, opts.maxOpen);
    this.logger = opts.logger;
    this.entries.set(opts.primaryLibrary, {
      library: opts.primaryLibrary,
      path: opts.primaryPath,
      index: opts.primary,
      lastUsed: ++this.order,
      pinned: true,
    });
  }

  /**
   * Where this library's index lives, whether or not it is open or even exists yet.
   *
   * The primary is exempt from the round-trip check: its path is this data directory's own
   * and was never derived from the token, so a store carrying an odd stamp still answers
   * for itself rather than becoming unaddressable.
   */
  pathFor(library: string): string {
    if (library === this.primaryLibrary) return this.primaryPath;
    assertAddressable(library);
    return siblingIndexPath(this.primaryPath, library);
  }

  /** The libraries whose indexes are open right now, most recently used last. */
  openLibraries(): string[] {
    return [...this.entries.values()].sort((a, b) => a.lastUsed - b.lastUsed).map((e) => e.library);
  }

  /** This library's index if it is already open, without opening one. */
  peek(library: string): SearchIndex | undefined {
    return this.entries.get(library)?.index;
  }

  /**
   * Whether ANY index this context has addressed has a build running, not just the primary.
   *
   * What a caller about to close them all has to ask. A build on a group runs inside that
   * group's own index and never touches `ctx.search`, so `ctx.search.isBuilding` answers
   * "no" while an hours-long build is writing into a store beside it.
   */
  /** Whether any search is holding an index open right now (`withIndex` in progress). */
  anyLeased(): boolean {
    return this.leases.size > 0;
  }

  anyBuilding(): boolean {
    for (const e of this.entries.values()) if (e.index.isBuilding) return true;
    return false;
  }

  /**
   * Whether this library already has an index here, without opening (and therefore
   * creating) one.
   *
   * What a read-only action asks first. `open()` CREATES the store when none exists, so
   * asking `zotero_index action:"status"` about a group that was never indexed would
   * otherwise leave an empty index file behind for a question.
   */
  async exists(library: string): Promise<boolean> {
    if (this.entries.has(library)) return true;
    const json = this.pathFor(library);
    for (const file of [json, sqliteIndexPath(json)]) {
      try {
        await access(file);
        return true;
      } catch {
        // Not this one; try the other half of the pair.
      }
    }
    return false;
  }

  /** This library's index, or undefined when it has none. Never creates a store. */
  async openIfExists(library: string): Promise<SearchIndex | undefined> {
    return (await this.exists(library)) ? this.open(library) : undefined;
  }

  /**
   * This library's index, opening it if need be.
   *
   * Opening one CREATES its store when none exists, which is what a first build of a
   * second library needs. Anything that only wants to report on the indexes that already
   * exist goes through `list()` instead, which never creates a file.
   */
  async open(library: string): Promise<SearchIndex> {
    const inflight = this.inflight.get(library);
    if (inflight) return inflight;
    const hit = this.entries.get(library);
    if (hit) {
      hit.lastUsed = ++this.order;
      return hit.index;
    }
    return this.track(library, async () => {
      const path = this.pathFor(library);
      const index = await createSearchIndex({ ...this.create, jsonPath: path });
      this.remember(library, path, index);
      this.logger.debug(`Search index opened for ${describeLibraryToken(library)} (${index.storage}, ${path}).`);
      await this.evictIfNeeded(library);
      return index;
    });
  }

  /** Keep an index open for an asynchronous operation, including query embedding. */
  async withIndex<T>(
    library: string,
    work: (index: SearchIndex | undefined) => Promise<T>,
    existingOnly = false,
  ): Promise<T> {
    this.leases.set(library, (this.leases.get(library) ?? 0) + 1);
    try {
      const index = existingOnly ? await this.openIfExists(library) : await this.open(library);
      return await work(index);
    } finally {
      const remaining = (this.leases.get(library) ?? 1) - 1;
      if (remaining) this.leases.set(library, remaining);
      else this.leases.delete(library);
      // The next open enforces the bound. Closing here could race a caller that is
      // finishing synchronous result formatting immediately after its query.
    }
  }

  /**
   * Close this library's index and open a fresh one from the same options.
   *
   * The per-library form of the repair path, with the three properties it has always had:
   * single-flight, so two concurrent repairs cannot both open the same database; the old
   * handle released BEFORE the new one is opened, because a repair deletes files and on
   * Windows an open handle refuses the unlink; and the entry replaced only by an index
   * that opened successfully, so a failed reopen leaves the faulted one in place rather
   * than leaving a hole.
   *
   * Deliberately no save() first, unlike eviction: the caller is on its way to deleting
   * the very file this would write, and writing a store that could not be read is how a
   * repair becomes a second corruption.
   */
  async reopen(library: string): Promise<SearchIndex> {
    const inflight = this.inflight.get(library);
    if (inflight) return inflight;
    return this.track(library, async () => {
      const existing = this.entries.get(library);
      // A running build holds the instance rather than reading the field, so swapping
      // under it would leave the build writing into an index nothing can reach.
      if (existing?.index.isBuilding) throw new Error(REOPEN_WHILE_BUILDING);
      if (this.leases.has(library)) throw new Error('The search index cannot be reopened while a search is running. Retry after the search completes.');
      if (existing) {
        await existing.index
          .close()
          .catch((e) => this.logger.debug(`Releasing the old search index: ${message(e)}`));
      }
      const path = this.pathFor(library);
      const fresh = await createSearchIndex({ ...this.create, jsonPath: path });
      this.remember(library, path, fresh);
      this.logger.info(`Search index reopened (${fresh.storage}, ${path}).`);
      await this.evictIfNeeded(library);
      return fresh;
    });
  }

  /**
   * Ask every open index to stop whatever job it is running. True when at least one was.
   *
   * What a Ctrl-C needs: a `--library-id` job runs inside that library's own index, not
   * inside the default library's, so stopping `ctx.search` alone would leave it running.
   */
  requestStopAll(): boolean {
    let stopped = false;
    for (const e of this.entries.values()) stopped = e.index.requestStop() || stopped;
    return stopped;
  }

  /**
   * Persist every open index, leaving them open.
   *
   * What a periodic flush wants. It is NOT what a shutdown wants: save() alone leaves the
   * SQLite write-ahead log uncheckpointed and the handle held, which is what `closeAll`
   * is for.
   */
  async saveAll(): Promise<void> {
    await Promise.allSettled(
      [...this.entries.values()].map((e) =>
        e.index.save().catch((err) => this.logger.debug(`Saving ${e.path}: ${message(err)}`)),
      ),
    );
  }

  /**
   * Persist and release every open index. Terminal: the registry is empty afterwards and
   * anything still holding one of these objects will find it closed.
   *
   * A build running in one of them is CANCELLED first, and waited for, because closing a
   * store under a running build is not a quieter way of stopping it. The build holds the
   * index object rather than re-reading `ctx.search`, so its next write, and the final
   * commit even a cancelled build makes, both fail with "The SQLite search index is not
   * open.": the job ends in `error` having lost the checkpoint that says where to pick it
   * up, which is the one thing that makes an interrupted build cheap to finish. Cancelling
   * first lets it stop at the next page or embed batch with its rows and its checkpoint on
   * disk, which is what `action:"stop"` promises and what a shutdown owes it too.
   *
   * Bounded rather than patient: the caller is a shutdown with a deadline of its own, so a
   * build that will not stop in time is closed under anyway, with a warning naming it,
   * which is what happened silently to every build before this. The registry's own
   * `evictIfNeeded` skips a building index outright instead, because it is making room
   * rather than shutting down and has somewhere else to go.
   */
  async closeAll(stopWaitMs = STOP_WAIT_MS): Promise<void> {
    const all = [...this.entries.values()];
    this.entries.clear();
    await this.stopBuilds(all, stopWaitMs);
    await Promise.allSettled(all.map((e) => this.release(e)));
  }

  /** Cancel every build running in `entries`, and wait up to `waitMs` for each to end. */
  private async stopBuilds(entries: Entry[], waitMs: number): Promise<void> {
    const building = entries.filter((e) => e.index.isBuilding);
    if (!building.length) return;
    for (const e of building) {
      e.index.requestStop();
      this.logger.debug(`Stopping the ${describeLibraryToken(e.library)} build before closing its index.`);
    }
    const deadline = Date.now() + Math.max(0, waitMs);
    while (Date.now() < deadline && building.some((e) => e.index.isBuilding)) {
      await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
    }
    for (const e of building) {
      if (!e.index.isBuilding) continue;
      this.logger.warn(
        `The ${describeLibraryToken(e.library)} index build did not stop within ${waitMs}ms, so its store is being ` +
          'closed under it: that job will end in an error. Whatever it had already committed is kept, and the next ' +
          'zotero_index action:"build" resumes from it.',
      );
    }
  }

  /**
   * Every library that has an index in this data directory, with its counts and its stamp.
   *
   * Reads the directory rather than guessing, so an index built by an earlier run of the
   * server is found even though nothing has opened it this time. It then OPENS each one it
   * found, because counts and stamp live inside the store and there is no cheaper way to
   * ask: that is bounded by the number of libraries the user has actually indexed, and it
   * respects the same open bound as everything else, so listing ten indexes does not hold
   * ten of them open. Nothing here creates a file that did not already exist.
   */
  async list(): Promise<IndexedLibrary[]> {
    const tokens = new Set<string>([this.primaryLibrary, ...this.entries.keys(), ...(await this.discover())]);
    const out: IndexedLibrary[] = [];
    for (const library of tokens) {
      const path = this.pathFor(library);
      const base = {
        library,
        label: describeLibraryToken(library),
        path,
        primary: library === this.primaryLibrary,
      };
      let index: SearchIndex;
      try {
        index = await this.open(library);
      } catch (e) {
        out.push({ ...base, documents: 0, items: 0, vectors: 0, state: 'error', libraryVersion: 0, fault: message(e) });
        continue;
      }
      // Read immediately, before the next open can evict this one: a closed store answers
      // nothing.
      const s = index.buildStatus();
      out.push({
        ...base,
        ...(s.library ? { stamp: s.library } : {}),
        documents: s.documents,
        items: s.items,
        vectors: s.vectors,
        state: s.state,
        ...(index.vectorEmbedderId ? { vectorEmbedder: index.vectorEmbedderId } : {}),
        libraryVersion: s.libraryVersion,
        ...(index.storeFault ? { fault: index.storeFault.message } : {}),
      });
    }
    // The primary first, then groups by id, so the list reads the same way twice running.
    return out.sort((a, b) => Number(b.primary) - Number(a.primary) || a.library.localeCompare(b.library));
  }

  /** Library tokens whose index files are on disk, from the names alone. */
  private async discover(): Promise<string[]> {
    const dir = dirname(this.primaryPath);
    if (!dir || dir === '.') return [];
    const stem = basename(this.primaryPath).replace(/\.json$/i, '');
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      // No data directory yet (or not readable): nothing is on disk to report.
      return [];
    }
    // Strict on both ends. A loose match would read another TENANT's sibling as this
    // one's: the per-user primary stem carries the Zotero user id, so
    // `search-index-19552201-lib-group-4523.json` does not start with `search-index-lib-`
    // and cannot be seen from the operator context, nor from another user's.
    const re = new RegExp(`^${escapeRe(stem)}-lib-([A-Za-z0-9-]+)\\.(?:json|sqlite)$`);
    const found = new Set<string>();
    for (const file of files) {
      const m = re.exec(file);
      if (!m) continue;
      const library = libraryOfPathSegment(m[1] as string);
      if (library) found.add(library);
    }
    return [...found];
  }

  /** Register an opened index, replacing whatever was filed under that library. */
  private remember(library: string, path: string, index: SearchIndex): void {
    this.entries.set(library, {
      library,
      path,
      index,
      lastUsed: ++this.order,
      pinned: library === this.primaryLibrary,
    });
  }

  /**
   * Run `work` as the single in-flight operation for `library`.
   *
   * A rejection is not cached (the map entry is cleared either way), because the usual
   * causes are transient and a permanent one simply fails the same way on the next call.
   */
  private track(library: string, work: () => Promise<SearchIndex>): Promise<SearchIndex> {
    const p = work().finally(() => {
      this.inflight.delete(library);
    });
    this.inflight.set(library, p);
    return p;
  }

  /**
   * Close least-recently-used indexes until the open set is within the bound.
   *
   * `justOpened` is never the victim. It is the most recently used entry, so the LRU rule
   * would not pick it while anything else is eligible, but when everything else is pinned
   * or building it is the ONLY eligible entry, and closing the index the caller is about
   * to be handed would turn a bound into a bug.
   */
  private async evictIfNeeded(justOpened?: string): Promise<void> {
    while (this.entries.size > this.maxOpen) {
      let victim: Entry | undefined;
      for (const e of this.entries.values()) {
        if (e.pinned || e.index.isBuilding || this.leases.has(e.library) || this.inflight.has(e.library) || e.library === justOpened) continue;
        if (!victim || e.lastUsed < victim.lastUsed) victim = e;
      }
      if (!victim) {
        this.logger.debug(
          `${this.entries.size} search indexes are open, over ZOTEUS_INDEX_MAX_OPEN=${this.maxOpen}, and none can be ` +
            'closed: the rest are the default library\'s index, have a build running, or were just opened.',
        );
        return;
      }
      this.entries.delete(victim.library);
      this.logger.debug(`Closing the ${describeLibraryToken(victim.library)} index to stay within ZOTEUS_INDEX_MAX_OPEN.`);
      await this.release(victim);
    }
  }

  /**
   * Persist and release one index.
   *
   * Two independent attempts, for the reason the shutdown flush already documents:
   * `save()` refuses on a store that could not be read, and close() is what checkpoints
   * the write-ahead log and releases the handle, so chaining them would let one faulted
   * index leak a handle and an uncheckpointed WAL every time.
   */
  private async release(e: Entry): Promise<void> {
    await e.index.save().catch((err) => this.logger.debug(`Saving ${e.path} before closing it: ${message(err)}`));
    await e.index.close().catch((err) => this.logger.debug(`Closing ${e.path}: ${message(err)}`));
  }
}

/** The default index path for a data directory, per-user in multi-tenant mode. */
export function defaultIndexPath(dataDir: string, zoteroUserId?: number): string {
  return join(dataDir, zoteroUserId !== undefined ? `search-index-${zoteroUserId}.json` : 'search-index.json');
}
