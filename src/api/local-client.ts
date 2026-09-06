import { fileURLToPath } from 'node:url';
import { RateLimitedFetcher } from './http.js';
import type { ItemQuery, LibraryRef, ListResult, VersionsResult } from './web-client.js';

export interface LocalApiClientOptions {
  port?: number;
  fetcher?: RateLimitedFetcher;
  /**
   * Fetcher used only by `probe`. Separate from the one every real read goes through
   * because they want opposite things: reads share a four-slot semaphore so a crawl
   * cannot flood Zotero, while a liveness probe must answer now or not at all. Behind
   * the shared fetcher a probe issued during an index build queues behind the build's
   * own pages and times out on a Zotero that is answering perfectly well.
   */
  probeFetcher?: RateLimitedFetcher;
}

/**
 * A non-OK response from the desktop local API, carrying the HTTP status so callers can
 * tell "this item has no full text" (404) apart from "the app is unreachable".
 */
export class LocalApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LocalApiError';
  }
}

/**
 * Path prefix for a library on the local API. The personal library is always `users/0`
 * whatever its cloud id; a group keeps its real id, exactly as on the Web API.
 *
 * Group libraries are served locally from Zotero 10 — items, children, collections,
 * searches and both /fulltext endpoints all answer under /groups/<id>. Before that they
 * did not, which is why every path here used to be hardcoded to users/0.
 */
export function localLibraryPrefix(lib?: LibraryRef): string {
  return lib && lib.type === 'group' ? `/groups/${lib.id}` : '/users/0';
}

/**
 * Read-only client for the Zotero desktop local API (Zotero 7+).
 * Base: http://127.0.0.1:<port>/api ; the personal library is always users/0.
 * Every endpoint here is GET. Native local-API writes exist from Zotero 10 and live in
 * local-writes.ts, which needs the grant flow this client deliberately stays out of.
 */
export class LocalApiClient {
  static readonly LOCAL_USER_ID = 0;
  private readonly base: string;
  private readonly fetcher: RateLimitedFetcher;
  private readonly probeFetcher: RateLimitedFetcher;

  constructor(opts: LocalApiClientOptions = {}) {
    this.base = `http://127.0.0.1:${opts.port ?? 23119}/api`;
    this.fetcher = opts.fetcher ?? new RateLimitedFetcher();
    this.probeFetcher = opts.probeFetcher ?? new RateLimitedFetcher({ maxConcurrency: 2 });
  }

  private headers(): Record<string, string> {
    return { 'Zotero-API-Version': '3', 'x-zotero-connector-api-version': '3' };
  }

  private buildQuery(
    params: Record<string, string | number | boolean | string[] | undefined>,
  ): string {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) v.forEach((i) => sp.append(k, String(i)));
      else sp.append(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
    }
    const s = sp.toString();
    return s ? `?${s}` : '';
  }

  private async getJson(path: string, query = ''): Promise<{ json: any; headers: Headers }> {
    const res = await this.fetcher.fetch(
      `${this.base}${path}${query}`,
      { method: 'GET', headers: this.headers() },
      { maxRetries: 0 },
    );
    if (!res.ok) throw new LocalApiError(res.status, `Local API ${res.status} for ${path}`);
    return { json: await res.json(), headers: res.headers };
  }

  private toListResult<T>(json: T[], headers: Headers): ListResult<T> {
    // Mirror the Web API client: a MISSING header must fall back, not parse as 0
    // (`Number(null)` is 0, which is finite). A bogus totalResults of 0 would stop a
    // paging caller — e.g. the search-index build — after its very first page.
    return {
      data: json,
      totalResults: numOrUndef(headers.get('total-results')) ?? json.length,
      lastModifiedVersion: numOrUndef(headers.get('last-modified-version')) ?? 0,
    };
  }

  async ping(): Promise<boolean> {
    try {
      await this.getJson('/users/0/items', this.buildQuery({ limit: 1 }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Liveness check with its own time budget and its own fetcher, for the repeated probing
   * `LocalApiStatus` does. Distinguishes the two ways a desktop app can be absent, because
   * they deserve different retry rates: a refused connection is instant and cheap to repeat,
   * whereas a firewall that DROPs the packet costs the whole budget every time.
   *
   * `up` is the only thing callers act on; `timedOut` only tunes how soon to ask again.
   */
  async probe(timeoutMs: number): Promise<{ up: boolean; timedOut: boolean }> {
    const started = Date.now();
    try {
      const res = await this.probeFetcher.fetch(
        `${this.base}/users/0/items?limit=1`,
        { method: 'GET', headers: this.headers() },
        { maxRetries: 0, deadlineMs: timeoutMs },
      );
      // Any answer at all proves something is listening and speaking HTTP on the port,
      // which is what the capability means. A non-2xx from Zotero itself (an unsupported
      // query, say) is not the app being absent.
      return { up: res.ok, timedOut: false };
    } catch {
      // The fetcher turns its own abort into a timeout error, but a DROPped packet can
      // also surface as a socket error at the same moment the budget runs out, so the
      // elapsed time is the reliable signal rather than the error's identity.
      return { up: false, timedOut: Date.now() - started >= timeoutMs - 50 };
    }
  }

  async listItems(query: ItemQuery = {}, lib?: LibraryRef): Promise<ListResult> {
    const { top: _t, collectionKey, ...rest } = query;
    const base = collectionKey ? `/collections/${collectionKey}` : '';
    const segment = query.top ? `${base}/items/top` : `${base}/items`;
    const { json, headers } = await this.getJson(
      `${localLibraryPrefix(lib)}${segment}`,
      this.buildQuery(rest as any),
    );
    return this.toListResult(json, headers);
  }

  async getItem(
    key: string,
    query: { include?: string; format?: string; style?: string; locale?: string } = {},
    lib?: LibraryRef,
  ): Promise<any> {
    const { json } = await this.getJson(
      `${localLibraryPrefix(lib)}/items/${key}`,
      this.buildQuery(query),
    );
    return json;
  }

  /**
   * Children (attachments, notes, annotations) of an item. The desktop local API
   * silently ignores a `parentItem` query param on /items and answers with the whole
   * library, so the dedicated /children endpoint is the only correct way to ask.
   */
  async getItemChildren(key: string, query: ItemQuery = {}, lib?: LibraryRef): Promise<ListResult> {
    const { top: _t, collectionKey: _c, ...rest } = query;
    const { json, headers } = await this.getJson(
      `${localLibraryPrefix(lib)}/items/${key}/children`,
      this.buildQuery(rest as any),
    );
    return this.toListResult(json, headers);
  }

  /**
   * Indexed full text for an attachment, or null when the app has none for it.
   *
   * The desktop app serves the same `/fulltext` endpoints as the cloud, which is what lets
   * full-text reads (and full-text indexing for semantic search) work with no cloud API key.
   */
  async getFullText(key: string, lib?: LibraryRef): Promise<any | null> {
    try {
      const { json } = await this.getJson(`${localLibraryPrefix(lib)}/items/${key}/fulltext`);
      return json;
    } catch (e) {
      if (e instanceof LocalApiError && e.status === 404) return null;
      throw e;
    }
  }

  /**
   * The attachment's file bytes, read from the desktop app's own storage.
   *
   * `/items/<key>/file` does not serve the file: it answers 302 with a `file://` Location
   * pointing into the Zotero data directory, so the bytes are read off disk rather than
   * over HTTP (fetch refuses a `file://` redirect, hence `redirect: 'manual'`). Only a
   * Zoteus running on the user's own machine can take this path, but where it can it
   * reaches PDFs the cloud has no copy of: a local-only library, or one whose storage
   * quota was never bought. A hosted Zoteus has no route to that loopback and falls back
   * to Web API file downloads.
   */
  async downloadFileBytes(key: string, lib?: LibraryRef): Promise<Uint8Array> {
    const url = `${this.base}${localLibraryPrefix(lib)}/items/${key}/file`;
    const res = await this.fetcher.fetch(
      url,
      { method: 'GET', headers: this.headers(), redirect: 'manual' },
      { maxRetries: 0 },
    );
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new LocalApiError(res.status, `Local API redirect without a location for ${key}`);
      if (location.startsWith('file://')) {
        const { readFile } = await import('node:fs/promises');
        return new Uint8Array(await readFile(fileURLToPath(location)));
      }
      const followed = await this.fetcher.fetch(location, { method: 'GET' }, { maxRetries: 0 });
      if (!followed.ok) throw new LocalApiError(followed.status, `Local API file fetch ${followed.status} for ${key}`);
      return new Uint8Array(await followed.arrayBuffer());
    }
    if (!res.ok) throw new LocalApiError(res.status, `Local API file ${res.status} for ${key}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Item keys mapped to their versions (`?format=versions`), served by the desktop app
   * from Zotero 10. The desktop keeps its OWN version sequence, so these numbers are only
   * comparable with other local reads, never with the cloud's.
   */
  async itemVersions(
    query: { since?: number; top?: boolean; limit?: number; start?: number; itemType?: string } = {},
    lib?: LibraryRef,
  ): Promise<VersionsResult> {
    const { top, ...rest } = query;
    const { json, headers } = await this.getJson(
      `${localLibraryPrefix(lib)}${top ? '/items/top' : '/items'}`,
      this.buildQuery({ ...rest, format: 'versions' }),
    );
    const versions = (json ?? {}) as Record<string, number>;
    return {
      versions,
      totalResults: numOrUndef(headers.get('total-results')) ?? Object.keys(versions).length,
      lastModifiedVersion: numOrUndef(headers.get('last-modified-version')) ?? 0,
    };
  }

  /** Map of attachment key -> library version for full text changed after `since`. */
  async fullTextSince(since: number, lib?: LibraryRef): Promise<Record<string, number>> {
    const { json } = await this.getJson(
      `${localLibraryPrefix(lib)}/fulltext`,
      this.buildQuery({ since }),
    );
    return json;
  }

  /**
   * Group libraries the desktop app holds. Used to decide whether a group read can be
   * served locally: a group the cloud key can see but the desktop does not have must
   * still go to the Web API. Returns [] when the endpoint is absent (pre-Zotero-10).
   */
  async listLocalGroupIds(): Promise<number[]> {
    const ids: number[] = [];
    // Both Zotero APIs page groups 100 at a time, so a user in more than 100 groups needs
    // the same start/limit loop every other list read uses; without it the tail of the
    // list is invisible here and those groups route to the cloud for no reason.
    const limit = 100;
    let start = 0;
    try {
      for (;;) {
        const { json, headers } = await this.getJson(
          '/users/0/groups',
          this.buildQuery({ limit, start }),
        );
        if (!Array.isArray(json)) return ids;
        for (const g of json as any[]) {
          // Group JSON is often data-wrapped ({ data: { id } }); read both shapes, exactly
          // as the zotero_groups parser does. Reading only `g.id` against the wrapped
          // shape makes every id NaN, so no group is ever recognised as local.
          const n = Number(g?.id ?? g?.data?.id);
          if (Number.isFinite(n)) ids.push(n);
        }
        start += json.length;
        // A MISSING total-results must fall back to the page length, not parse as 0
        // (same trap as toListResult), which here simply stops after one page.
        const total = numOrUndef(headers.get('total-results')) ?? json.length;
        if (!json.length || start >= total) return ids;
      }
    } catch {
      // Whatever pages already came back are still true; only a first-page failure
      // (endpoint absent, app down) yields [].
      return ids;
    }
  }

  async listCollections(
    query: { top?: boolean; limit?: number; start?: number } = {},
    lib?: LibraryRef,
  ): Promise<ListResult> {
    const segment = query.top ? '/collections/top' : '/collections';
    const { top: _t, ...rest } = query;
    const { json, headers } = await this.getJson(
      `${localLibraryPrefix(lib)}${segment}`,
      this.buildQuery(rest as any),
    );
    return this.toListResult(json, headers);
  }
}

function numOrUndef(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
