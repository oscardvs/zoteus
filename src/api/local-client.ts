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
  /**
   * Per-request budget for this client's ordinary reads (ZOTEUS_ZOTERO_DEADLINE_MS).
   * Unset leaves the fetcher's own default. Passed per call rather than set on the
   * fetcher because that fetcher is shared with the cloud Web API: a desktop app given
   * two minutes to answer a listing must not make every cloud tool call able to hang for
   * two minutes inside an MCP host's own timeout (#78).
   */
  deadlineMs?: number;
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
 * A read the desktop app cannot answer for a library it otherwise serves: an endpoint it
 * does not implement, or one that answers 200 without the data it was asked for.
 *
 * Separate from LocalApiError because it is not a transport failure and must never be
 * retried, and above all because the alternative is worse than an error. The reads this
 * covers all answer in maps, and an absent map is indistinguishable from an empty one, so
 * swallowing the gap would report "nothing changed" for a library where everything did.
 * Whoever catches this has to say what is missing and where else it can be had.
 */
export class LocalApiUnsupportedError extends Error {
  constructor(
    /** What could not be served, in words a caller can put in a sentence: "tags". */
    readonly what: string,
    message: string,
  ) {
    super(message);
    this.name = 'LocalApiUnsupportedError';
  }
}

/** The object types a sync delta asks about, as both Zotero APIs name them in a path. */
export type SyncObjectType = 'items' | 'collections' | 'searches' | 'tags';

/**
 * A group library the desktop app holds, carrying only what the local API really serves
 * for it.
 *
 * Zotero 10 answers /users/0/groups out of its own database, and a group's response JSON
 * there is `{ id, version, links, meta: { numItems }, data: { id, version, name,
 * description } }`. The cloud's `type` (PublicOpen/PublicClosed/Private) and
 * `libraryEditing` are membership facts the desktop never stores, so they are absent
 * here rather than guessable, and anything reporting a local group has to leave them out.
 */
export interface LocalGroup {
  id: number;
  name?: string;
  description?: string;
  /**
   * Items in the group library as the DESKTOP counts them: `SELECT COUNT(*) FROM items
   * WHERE libraryID = ?`, so every row, child attachments, notes, annotations and
   * trashed items included. The cloud computes its own numItems separately, so the two
   * need not agree; callers that show this number must say where it came from.
   */
  numItems?: number;
  /** The group's synced METADATA version, not the version of its contents. */
  version?: number;
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
  private readonly deadlineMs: number | undefined;

  constructor(opts: LocalApiClientOptions = {}) {
    this.base = `http://127.0.0.1:${opts.port ?? 23119}/api`;
    this.fetcher = opts.fetcher ?? new RateLimitedFetcher();
    this.probeFetcher = opts.probeFetcher ?? new RateLimitedFetcher({ maxConcurrency: 2 });
    this.deadlineMs = opts.deadlineMs;
  }

  /**
   * The per-call options every ordinary read passes. `maxRetries: 0` because the desktop
   * app has no rate limiter to retry against, and the budget only when one was configured,
   * so an unset variable leaves the fetcher's default exactly where it was.
   *
   * Deliberately not applied to the two reads that must not inherit it. `probe` passes its
   * own 1.5 s, which is the whole point of a liveness check. `downloadFileBytes` passes
   * none and so keeps the fetcher's 25 s default: it is usually a redirect the desktop app
   * answers at once and then bytes read straight off disk, not a query Zotero has to
   * compute, so the budget this variable raises is not the budget it is spending.
   */
  private readOpts(): { maxRetries: number; deadlineMs?: number } {
    return { maxRetries: 0, ...(this.deadlineMs !== undefined ? { deadlineMs: this.deadlineMs } : {}) };
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
      this.readOpts(),
    );
    if (!res.ok) throw new LocalApiError(res.status, `Local API ${res.status} for ${path}`);
    return { json: await res.json(), headers: res.headers };
  }

  /**
   * A read whose body is text rather than JSON: a rendered bibliography, an export. On
   * failure the body is kept in the error, because that is where Zotero explains itself:
   * an unknown style comes back as a 400 whose text names the style and the repository
   * lookup that failed for it, and a bare status code would throw that away.
   */
  private async getRaw(path: string, query = ''): Promise<string> {
    return (await this.getRawResponse(path, query)).text;
  }

  /** As `getRaw`, but keeping the headers: `format=keys` carries its count in them. */
  private async getRawResponse(
    path: string,
    query = '',
  ): Promise<{ text: string; headers: Headers }> {
    const res = await this.fetcher.fetch(
      `${this.base}${path}${query}`,
      { method: 'GET', headers: this.headers() },
      this.readOpts(),
    );
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).trim();
      throw new LocalApiError(
        res.status,
        `Local API ${res.status} for ${path}${body ? `: ${body}` : ''}`,
      );
    }
    return { text: await res.text(), headers: res.headers };
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

  /**
   * The keys of a listing and nothing else (`format=keys`), in the query's own sort order.
   *
   * A whole key set costs a fraction of the same set of items: measured against Zotero 10
   * on a 1302-item library, every attachment key came back in 7 ms where the same 363
   * attachments as JSON took 4.4 s, because the desktop resolves storage paths per
   * attachment. That gap is what makes it affordable for `top` to be resolved key-side
   * (see LibraryRouter.topLevelItemsOfType) instead of by reading every candidate item.
   *
   * Neither API caps a `format=keys` response the way it caps a page of items, so a
   * request with no `limit` answers with the whole set.
   */
  async listItemKeys(
    query: ItemQuery = {},
    lib?: LibraryRef,
  ): Promise<{ keys: string[]; totalResults: number; lastModifiedVersion: number }> {
    const { top: _t, collectionKey, ...rest } = query;
    const base = collectionKey ? `/collections/${collectionKey}` : '';
    const segment = query.top ? `${base}/items/top` : `${base}/items`;
    const { text, headers } = await this.getRawResponse(
      `${localLibraryPrefix(lib)}${segment}`,
      this.buildQuery({ ...(rest as any), format: 'keys' }),
    );
    const keys = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return {
      keys,
      totalResults: numOrUndef(headers.get('total-results')) ?? keys.length,
      lastModifiedVersion: numOrUndef(headers.get('last-modified-version')) ?? 0,
    };
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
   * Items exported in a bibliographic format (bibtex/ris/csljson/...), as the raw text
   * Zotero sends. The desktop app serves the same `format=` exports as the cloud, with two
   * differences a caller never sees: its csljson is a bare array where the cloud's is
   * wrapped in `{ items }` (the tools accept both), and its `?itemKey=` answers with the
   * named items AND their children, so the attachment of a cited paper would come back as
   * a `document` entry of its own. A keyed export therefore reads `/items/top`, which is
   * exactly the items named, as on the cloud; a child key named on its own then yields
   * nothing, which is also all a bibliography could make of it.
   */
  async exportItems(
    params: {
      format: string;
      itemKey?: string[];
      collectionKey?: string;
      q?: string;
      itemType?: string;
      limit?: number;
    },
    lib?: LibraryRef,
  ): Promise<string> {
    const base = params.collectionKey ? `/collections/${params.collectionKey}` : '';
    const segment = params.itemKey?.length ? `${base}/items/top` : `${base}/items`;
    return this.getRaw(
      `${localLibraryPrefix(lib)}${segment}`,
      this.buildQuery({
        format: params.format,
        itemKey: params.itemKey?.join(','),
        q: params.q,
        itemType: params.itemType,
        limit: params.limit ?? 50,
      }),
    );
  }

  /**
   * A bibliography rendered by the desktop app (`format=bib`) for item keys. Zotero 10
   * honours `style` (a CSL id or URL; a style it lacks is fetched from the repository, an
   * unknown one answers 400), `locale` and `linkwrap` exactly as the cloud does, so a
   * library the desktop serves renders with no cloud key at all (#64).
   */
  async getBibliography(
    itemKeys: string[],
    opts: { style?: string; locale?: string; linkwrap?: boolean } = {},
    lib?: LibraryRef,
  ): Promise<string> {
    return this.getRaw(
      `${localLibraryPrefix(lib)}/items`,
      this.buildQuery({
        itemKey: itemKeys.join(','),
        format: 'bib',
        style: opts.style,
        locale: opts.locale,
        linkwrap: opts.linkwrap ? 1 : undefined,
      }),
    );
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

  /**
   * The desktop's own version for one object, or null when it does not have it.
   *
   * Addressed by key rather than through a filtered listing on purpose: the local API
   * leaves trashed objects out of `?itemKey=` listings even with `includeTrashed`
   * (measured against Zotero 10: a trashed item answers `[]` there while `GET
   * /items/<key>` answers 200 with `deleted: true`), and "in the trash" has to read as
   * present, not missing, for anyone asking whether the app has caught up with a write.
   *
   * The number belongs to the DESKTOP's sequence, so it is comparable only with other
   * answers from this method, never with a cloud version.
   */
  async objectVersion(
    type: 'items' | 'collections' | 'searches',
    key: string,
    lib?: LibraryRef,
  ): Promise<number | null> {
    try {
      const { json } = await this.getJson(`${localLibraryPrefix(lib)}/${type}/${key}`);
      const version = json?.version ?? json?.data?.version;
      // Present but versionless should still count as present, so fall back to 0 rather
      // than to null, which is this method's word for "the app does not have it".
      return typeof version === 'number' ? version : 0;
    } catch (err) {
      if (err instanceof LocalApiError && err.status === 404) return null;
      throw err;
    }
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
   * Group libraries the desktop app holds, with the metadata it serves for them. Used
   * both to decide whether a group read can be served locally (a group the cloud key can
   * see but the desktop does not have must still go to the Web API) and to answer
   * zotero_groups for a user who has no cloud key at all. Returns [] when the endpoint is
   * absent (pre-Zotero-10).
   */
  async listLocalGroups(): Promise<LocalGroup[]> {
    const groups: LocalGroup[] = [];
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
        if (!Array.isArray(json)) return groups;
        for (const g of json as any[]) {
          const parsed = parseLocalGroup(g);
          if (parsed) groups.push(parsed);
        }
        start += json.length;
        // A MISSING total-results must fall back to the page length, not parse as 0
        // (same trap as toListResult), which here simply stops after one page.
        const total = numOrUndef(headers.get('total-results')) ?? json.length;
        if (!json.length || start >= total) return groups;
      }
    } catch {
      // Whatever pages already came back are still true; only a first-page failure
      // (endpoint absent, app down) yields [].
      return groups;
    }
  }

  /** Just the ids, for the router's "does this desktop hold that group" question. */
  async listLocalGroupIds(): Promise<number[]> {
    return (await this.listLocalGroups()).map((g) => g.id);
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

  /**
   * Saved-search definitions the desktop app holds.
   *
   * Zotero 7+ serves `/searches` locally, exactly as the cloud does. Added because
   * zotero_saved_searches read `ctx.web` unconditionally, so a desktop-only install asked
   * api.zotero.org for users/0 and got "Invalid user ID" back while the app beside it had
   * the answer all along. Same defect, and same fix, as the tag and sync reads before it.
   */
  async listSearches(lib?: LibraryRef): Promise<ListResult> {
    const { json, headers } = await this.getJson(`${localLibraryPrefix(lib)}/searches`);
    return this.toListResult(json, headers);
  }

  /**
   * Whether this library really has that collection key.
   *
   * Asked because the desktop app does NOT refuse an unknown collection on the route that
   * matters: `/collections/<unknown>/items` answers 200 with the WHOLE library (measured:
   * 723 items for a key that does not exist, against 14 for one that does), so a scoped
   * read comes back looking exactly like an unscoped one. The collection itself does 404,
   * which is the only place the desktop admits the key is unknown. The cloud Web API 404s
   * the `/items` sub-route directly and needs no such question.
   */
  async collectionExists(key: string, lib?: LibraryRef): Promise<boolean> {
    try {
      await this.getJson(`${localLibraryPrefix(lib)}/collections/${encodeURIComponent(key)}`);
      return true;
    } catch (e) {
      if (e instanceof LocalApiError && e.status === 404) return false;
      throw e;
    }
  }

  /**
   * Tags in the library, in the same `{ tag, meta: { type, numItems } }` shape the cloud
   * serves, paged with the same limit/start.
   *
   * `q` is the one parameter that does not survive the trip. Zotero 10.0.1 accepts it on
   * /tags and then ignores it: `?q=zzzznotag` answers with the whole tag list and a
   * Total-Results counting every tag, so passing it through would look like a filter that
   * matched everything. It is applied here instead, as the case-insensitive substring
   * match the tool documents, and over the WHOLE list rather than one page, because a tag
   * matching at position 150 of 211 has to be findable from a first page of 100.
   */
  async listTags(
    query: { q?: string; limit?: number; start?: number } = {},
    lib?: LibraryRef,
  ): Promise<ListResult> {
    const path = `${localLibraryPrefix(lib)}/tags`;
    if (!query.q) {
      const { json, headers } = await this.getJson(path, this.buildQuery({ ...query, q: undefined }));
      return this.toListResult(json, headers);
    }
    const all: any[] = [];
    let lastModifiedVersion = 0;
    const pageSize = 100;
    for (let start = 0; ; ) {
      const { json, headers } = await this.getJson(path, this.buildQuery({ limit: pageSize, start }));
      if (!Array.isArray(json)) break;
      all.push(...json);
      lastModifiedVersion = numOrUndef(headers.get('last-modified-version')) ?? lastModifiedVersion;
      start += json.length;
      // Same fallback as toListResult: a MISSING total must be the page length, not 0.
      const total = numOrUndef(headers.get('total-results')) ?? json.length;
      if (!json.length || start >= total) break;
    }
    const needle = query.q.toLowerCase();
    const matched = all.filter((t) =>
      String(typeof t === 'string' ? t : (t?.tag ?? ''))
        .toLowerCase()
        .includes(needle),
    );
    const from = query.start ?? 0;
    return {
      data: matched.slice(from, query.limit === undefined ? undefined : from + query.limit),
      totalResults: matched.length,
      lastModifiedVersion,
    };
  }

  /**
   * Keys mapped to versions for one object type (`?format=versions`), the delta a sync
   * runs on. Like every version this client returns, these belong to the desktop app's own
   * sequence and are not comparable with the cloud's.
   *
   * Not every type is really served. Zotero 10.0.1 answers /users/0/tags?format=versions
   * with `{}` for a library holding 211 tags, while the very same response's Total-Results
   * header counts all 211: a 200 that reads as "no tag changed" for a library where every
   * tag did. That header is therefore the check. A map holding fewer keys than the response
   * says exist means the app declined the question, and the caller is told so rather than
   * handed a silence it would report as an answer.
   */
  async objectVersions(
    type: SyncObjectType,
    since: number,
    lib?: LibraryRef,
  ): Promise<Record<string, number>> {
    const { json, headers } = await this.getJson(
      `${localLibraryPrefix(lib)}/${type}`,
      this.buildQuery({ format: 'versions', since }),
    );
    const versions = (json ?? {}) as Record<string, number>;
    const got = Object.keys(versions).length;
    const total = numOrUndef(headers.get('total-results'));
    if (total !== undefined && got < total) {
      throw new LocalApiUnsupportedError(
        type,
        `The Zotero desktop app does not serve versions for ${type}: it answered with ${got} of ` +
          `the ${total} ${type} its own response counted.`,
      );
    }
    return versions;
  }

  /**
   * The deletion log: object keys removed since a version, by type.
   *
   * Zotero 10.0.1 has no /deleted endpoint at all, for users/0 or for a group it holds; it
   * answers 404 "No endpoint found". This asks anyway and translates the refusal, rather
   * than hardcoding the absence: it costs one loopback request on a tool that already makes
   * several, and it starts working by itself if a later Zotero serves it.
   */
  async deleted(since: number, lib?: LibraryRef): Promise<Record<string, string[]>> {
    try {
      const { json } = await this.getJson(
        `${localLibraryPrefix(lib)}/deleted`,
        this.buildQuery({ since }),
      );
      return json;
    } catch (e) {
      if (e instanceof LocalApiError && e.status === 404) {
        throw new LocalApiUnsupportedError(
          'the deletion log',
          'The Zotero desktop app keeps no deletion log: it serves no /deleted endpoint (404). ' +
            'Deletions can still be found by diffing a full key census against your own copy.',
        );
      }
      throw e;
    }
  }
}

/**
 * One entry of a group list, from either API. Group JSON is often data-wrapped
 * ({ data: { id, name } }) and sometimes flat; read both shapes. Reading only `g.id`
 * against the wrapped shape makes every id NaN, so no group is ever recognised as local,
 * and the same tolerance keeps this usable against the cloud's list, whose entries carry
 * the desktop's fields plus more. An entry with no usable id is dropped: it could not be
 * addressed anyway.
 */
function parseLocalGroup(g: any): LocalGroup | undefined {
  const id = Number(g?.id ?? g?.data?.id);
  if (!Number.isFinite(id)) return undefined;
  const group: LocalGroup = { id };
  const name = g?.data?.name ?? g?.name;
  if (typeof name === 'string') group.name = name;
  const description = g?.data?.description ?? g?.description;
  if (typeof description === 'string') group.description = description;
  const numItems = Number(g?.meta?.numItems);
  if (Number.isFinite(numItems)) group.numItems = numItems;
  const version = Number(g?.version ?? g?.data?.version);
  if (Number.isFinite(version)) group.version = version;
  return group;
}

function numOrUndef(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
