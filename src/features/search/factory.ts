import { createRequire } from 'node:module';
import { CorruptSearchIndex, SearchIndexCorruptError, isCorruptionError } from './corruption.js';
import { MemorySearchIndex } from './index-manager.js';
import { loadIndex } from './persistence.js';
import type { SearchIndex, SearchIndexOptions } from './backend.js';

/** ZOTEUS_INDEX_BACKEND. `auto` takes SQLite whenever the runtime provides it. */
export type IndexBackendSetting = 'auto' | 'sqlite' | 'memory';

export interface CreateSearchIndexOptions extends SearchIndexOptions {
  backend: IndexBackendSetting;
  /**
   * Path of the legacy JSON artifact. The SQLite database sits beside it under the same
   * name, so both stay keyed by the data dir and, in multi-tenant mode, by the user.
   * Empty means "no artifact": an index that lives only for this process.
   */
  jsonPath: string;
}

/** The SQLite database that pairs with a given search-index.json path. */
export function sqliteIndexPath(jsonPath: string): string {
  return `${jsonPath.replace(/\.json$/i, '')}.sqlite`;
}

/**
 * Whether this runtime has Node's built-in SQLite. It landed unflagged in Node 22.13;
 * earlier versions either lack the module or need --experimental-sqlite, and both refuse
 * to load it. Probed with require rather than import(): `sqlite` is absent from
 * `module.builtinModules` while experimental, so bundlers and test runners fail to resolve
 * the specifier even where Node itself provides it.
 */
export function nodeSqliteAvailable(): boolean {
  try {
    createRequire(import.meta.url)('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the search index this context will use, and open its store.
 *
 * `auto` prefers SQLite because it is the only backend a large library survives (a JSON
 * index cannot be written past ~512 MB, nor re-read anywhere near it), and falls back to
 * the JSON one when the runtime has no `node:sqlite`. `sqlite` demands it: an operator who
 * asked for the durable backend must not be quietly given the one with the ceiling.
 */
export async function createSearchIndex(opts: CreateSearchIndexOptions): Promise<SearchIndex> {
  const { backend, jsonPath, ...indexOpts } = opts;
  if (backend !== 'memory') {
    if (nodeSqliteAvailable()) {
      const { SqliteSearchIndex } = await import('./sqlite-index.js');
      const path = jsonPath ? sqliteIndexPath(jsonPath) : ':memory:';
      const index = new SqliteSearchIndex({
        ...indexOpts,
        path,
        ...(jsonPath ? { migrateFrom: jsonPath } : {}),
      });
      try {
        await index.open();
      } catch (e) {
        // An unreadable index must not take the server with it. Everything that does not
        // read the index — item lookups, bibliographies, attachments, citations — is
        // unaffected by a bad cache file and keeps working; search alone refuses, and says
        // why. Anything that is not corruption still throws: a permission error or a full
        // disk is not a reason to tell someone their index is beyond saving.
        if (!isCorruptionError(e)) throw e;
        const failure = new SearchIndexCorruptError(path, e instanceof Error ? e.message : String(e));
        opts.logger?.error(failure.message);
        return new CorruptSearchIndex(failure, indexOpts.configured ?? indexOpts.embedder?.name ?? 'off');
      }
      return index;
    }
    if (backend === 'sqlite') {
      throw new Error(
        `ZOTEUS_INDEX_BACKEND=sqlite requires Node's built-in node:sqlite module, which ${process.version} does ` +
          'not provide (it is available unflagged from Node 22.13). Upgrade Node, or set ' +
          'ZOTEUS_INDEX_BACKEND=auto to fall back to the JSON index backend.',
      );
    }
    opts.logger?.info(
      `node:sqlite is unavailable on ${process.version}, so the search index uses the JSON backend. ` +
        'A library past roughly 250k passages needs Node 22.13+: a JSON index cannot be saved beyond ~512 MB.',
    );
  }
  const index = new MemorySearchIndex({ ...indexOpts, ...(jsonPath ? { path: jsonPath } : {}) });
  if (jsonPath) await loadIndex(index, jsonPath).catch(() => false);
  return index;
}
