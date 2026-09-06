import { randomBytes } from 'node:crypto';
import { RateLimitedFetcher } from './http.js';
import { ZoteroApiError, actionableMessage } from './errors.js';
import type { Logger } from '../lib/logger.js';

export interface LibraryRef {
  type: 'user' | 'group';
  id: number;
}

export interface KeyInfo {
  key?: string;
  userID: number;
  username: string;
  displayName?: string;
  access: Record<string, unknown>;
}

export interface ListResult<T = any> {
  data: T[];
  totalResults: number;
  lastModifiedVersion: number;
}

/** A `?format=versions` response: object keys mapped to their versions, plus the headers. */
export interface VersionsResult {
  versions: Record<string, number>;
  totalResults: number;
  lastModifiedVersion: number;
}

export interface WriteResult {
  successful: Array<{ index: number; key: string; version?: number }>;
  unchanged: string[];
  failed: Array<{ index: number; key?: string; code: number; message: string }>;
  newLibraryVersion: number;
}

export interface ItemQuery {
  q?: string;
  qmode?: 'titleCreatorYear' | 'everything';
  itemType?: string;
  /**
   * Comma-separated item keys, at most 50 (both APIs). The one way to look items up in
   * bulk without a request each: the search index resolves annotated attachments to their
   * parent items this way.
   */
  itemKey?: string;
  tag?: string | string[];
  sort?: string;
  direction?: 'asc' | 'desc';
  limit?: number;
  start?: number;
  since?: number;
  includeTrashed?: boolean;
  top?: boolean;
  collectionKey?: string;
  include?: string;
  format?: string;
}

export interface WebApiClientOptions {
  apiKey?: string;
  baseUrl?: string;
  fetcher?: RateLimitedFetcher;
  contactEmail?: string;
  logger?: Logger;
}

const DEFAULT_BASE = 'https://api.zotero.org';

export class WebApiClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly fetcher: RateLimitedFetcher;
  private readonly contactEmail?: string;

  constructor(opts: WebApiClientOptions = {}) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE;
    this.fetcher = opts.fetcher ?? new RateLimitedFetcher({ logger: opts.logger });
    this.contactEmail = opts.contactEmail;
  }

  get hasKey(): boolean {
    return Boolean(this.apiKey);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Zotero-API-Version': '3' };
    if (this.apiKey) h['Zotero-API-Key'] = this.apiKey;
    h['User-Agent'] = this.contactEmail ? `zoteus (mailto:${this.contactEmail})` : 'zoteus';
    return h;
  }

  private prefix(lib: LibraryRef): string {
    return lib.type === 'user' ? `/users/${lib.id}` : `/groups/${lib.id}`;
  }

  private buildQuery(
    params: Record<string, string | number | boolean | string[] | undefined>,
  ): string {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) v.forEach((item) => sp.append(k, String(item)));
      else sp.append(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
    }
    const s = sp.toString();
    return s ? `?${s}` : '';
  }

  private async getJson(path: string, query = ''): Promise<{ json: any; headers: Headers }> {
    const url = `${this.baseUrl}${path}${query}`;
    const res = await this.fetcher.fetch(url, { method: 'GET', headers: this.headers() });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ZoteroApiError({
        status: res.status,
        message: actionableMessage(res.status, body, res.headers),
        retryAfter: numOrUndef(res.headers.get('retry-after')),
        currentVersion: numOrUndef(res.headers.get('last-modified-version')),
        body,
      });
    }
    return { json: await res.json(), headers: res.headers };
  }

  private toListResult<T>(json: T[], headers: Headers): ListResult<T> {
    return {
      data: json,
      totalResults: numOrUndef(headers.get('total-results')) ?? json.length,
      lastModifiedVersion: numOrUndef(headers.get('last-modified-version')) ?? 0,
    };
  }

  async keysCurrent(): Promise<KeyInfo> {
    const { json } = await this.getJson('/keys/current');
    return json as KeyInfo;
  }

  async getSchema(): Promise<any> {
    // The global schema endpoint takes no auth.
    const res = await this.fetcher.fetch(`${this.baseUrl}/schema`, { method: 'GET' });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ZoteroApiError({
        status: res.status,
        message: actionableMessage(res.status, body, res.headers),
      });
    }
    return res.json();
  }

  async listItems(lib: LibraryRef, query: ItemQuery = {}): Promise<ListResult> {
    const { top: _top, collectionKey, ...rest } = query;
    const base = collectionKey ? `/collections/${collectionKey}` : '';
    const segment = query.top ? `${base}/items/top` : `${base}/items`;
    const { json, headers } = await this.getJson(
      this.prefix(lib) + segment,
      this.buildQuery(rest as any),
    );
    return this.toListResult(json, headers);
  }

  async getItem(
    lib: LibraryRef,
    key: string,
    query: { include?: string; format?: string; style?: string; locale?: string } = {},
  ): Promise<any> {
    const { json } = await this.getJson(this.prefix(lib) + `/items/${key}`, this.buildQuery(query));
    return json;
  }

  async getItemChildren(lib: LibraryRef, key: string, query: ItemQuery = {}): Promise<ListResult> {
    const { json, headers } = await this.getJson(
      this.prefix(lib) + `/items/${key}/children`,
      this.buildQuery(query as any),
    );
    return this.toListResult(json, headers);
  }

  async listCollections(
    lib: LibraryRef,
    query: { top?: boolean; limit?: number; start?: number } = {},
  ): Promise<ListResult> {
    const segment = query.top ? '/collections/top' : '/collections';
    const { top: _t, ...rest } = query;
    const { json, headers } = await this.getJson(
      this.prefix(lib) + segment,
      this.buildQuery(rest as any),
    );
    return this.toListResult(json, headers);
  }

  async listTags(
    lib: LibraryRef,
    query: { q?: string; limit?: number; start?: number } = {},
  ): Promise<ListResult> {
    const { json, headers } = await this.getJson(
      this.prefix(lib) + '/tags',
      this.buildQuery(query as any),
    );
    return this.toListResult(json, headers);
  }

  async listSearches(lib: LibraryRef): Promise<ListResult> {
    const { json, headers } = await this.getJson(this.prefix(lib) + '/searches');
    return this.toListResult(json, headers);
  }

  async listGroups(userID: number): Promise<ListResult> {
    const { json, headers } = await this.getJson(`/users/${userID}/groups`);
    return this.toListResult(json, headers);
  }

  private async getRaw(path: string, query = ''): Promise<{ text: string; headers: Headers }> {
    const res = await this.fetcher.fetch(`${this.baseUrl}${path}${query}`, {
      method: 'GET',
      headers: this.headers(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ZoteroApiError({
        status: res.status,
        message: actionableMessage(res.status, body, res.headers),
        body,
      });
    }
    return { text: await res.text(), headers: res.headers };
  }

  /** Export items in a bibliographic format (bibtex/ris/csljson/csv/mods/tei/...). Returns raw text. */
  async exportItems(
    lib: LibraryRef,
    params: { format: string; itemKey?: string[]; collectionKey?: string; q?: string; itemType?: string; limit?: number },
  ): Promise<string> {
    const segment = params.collectionKey ? `/collections/${params.collectionKey}/items` : '/items';
    const query = this.buildQuery({
      format: params.format,
      itemKey: params.itemKey?.join(','),
      q: params.q,
      itemType: params.itemType,
      limit: params.limit ?? 50,
    });
    const { text } = await this.getRaw(this.prefix(lib) + segment, query);
    return text;
  }

  /** Cloud-rendered bibliography (format=bib XHTML) for item keys. Item-only, <=150. */
  async getBibliography(
    lib: LibraryRef,
    itemKeys: string[],
    opts: { style?: string; locale?: string; linkwrap?: boolean } = {},
  ): Promise<string> {
    const query = this.buildQuery({
      itemKey: itemKeys.join(','),
      format: 'bib',
      style: opts.style,
      locale: opts.locale,
      linkwrap: opts.linkwrap ? 1 : undefined,
    });
    const { text } = await this.getRaw(this.prefix(lib) + '/items', query);
    return text;
  }

  // ---- Full text ----

  async getFullText(lib: LibraryRef, key: string): Promise<any | null> {
    try {
      const { json } = await this.getJson(this.prefix(lib) + `/items/${key}/fulltext`);
      return json;
    } catch (e) {
      if (e instanceof ZoteroApiError && e.status === 404) return null;
      throw e;
    }
  }

  async setFullText(
    lib: LibraryRef,
    key: string,
    body: { content: string; indexedChars?: number; totalChars?: number; indexedPages?: number; totalPages?: number },
  ): Promise<void> {
    const res = await this.fetcher.fetch(`${this.baseUrl}${this.prefix(lib)}/items/${key}/fulltext`, {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = await res.text().catch(() => '');
      throw new ZoteroApiError({ status: res.status, message: actionableMessage(res.status, b, res.headers), body: b });
    }
  }

  async fullTextSince(lib: LibraryRef, since: number): Promise<Record<string, number>> {
    const { json } = await this.getJson(this.prefix(lib) + '/fulltext', this.buildQuery({ since }));
    return json;
  }

  // ---- Sync delta ----

  async versions(
    lib: LibraryRef,
    type: 'items' | 'collections' | 'searches' | 'tags',
    since?: number,
  ): Promise<Record<string, number>> {
    const { json } = await this.getJson(this.prefix(lib) + `/${type}`, this.buildQuery({ format: 'versions', since }));
    return json;
  }

  /**
   * Item keys mapped to their versions, with the response headers that give the library
   * version and the item count. Cheaper than any item read by a wide margin (keys only, no
   * item bodies), which is what makes it usable as a full census: the search index diffs
   * its own key set against this to find deletions, because `/deleted` is cloud-only and
   * indexing must work off the desktop app too.
   */
  async itemVersions(
    lib: LibraryRef,
    query: { since?: number; top?: boolean; limit?: number; start?: number; itemType?: string } = {},
  ): Promise<VersionsResult> {
    const { top, ...rest } = query;
    const { json, headers } = await this.getJson(
      this.prefix(lib) + (top ? '/items/top' : '/items'),
      this.buildQuery({ ...rest, format: 'versions' }),
    );
    const versions = (json ?? {}) as Record<string, number>;
    return {
      versions,
      totalResults: numOrUndef(headers.get('total-results')) ?? Object.keys(versions).length,
      lastModifiedVersion: numOrUndef(headers.get('last-modified-version')) ?? 0,
    };
  }

  async deleted(lib: LibraryRef, since: number): Promise<Record<string, string[]>> {
    const { json } = await this.getJson(this.prefix(lib) + '/deleted', this.buildQuery({ since }));
    return json;
  }

  // ---- File storage (low-level; orchestrated by api/attachments.ts) ----

  async requestUpload(
    lib: LibraryRef,
    key: string,
    info: { md5: string; filename: string; filesize: number; mtime: number; replaceMd5?: string },
  ): Promise<any> {
    const headers: Record<string, string> = {
      ...this.headers(),
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (info.replaceMd5) headers['If-Match'] = info.replaceMd5;
    else headers['If-None-Match'] = '*';
    const body = new URLSearchParams({
      md5: info.md5,
      filename: info.filename,
      filesize: String(info.filesize),
      mtime: String(info.mtime),
    }).toString();
    const res = await this.fetcher.fetch(`${this.baseUrl}${this.prefix(lib)}/items/${key}/file`, {
      method: 'POST',
      headers,
      body,
    });
    if (!res.ok) {
      const b = await res.text().catch(() => '');
      throw new ZoteroApiError({ status: res.status, message: actionableMessage(res.status, b, res.headers), body: b });
    }
    return res.json();
  }

  async uploadBytes(url: string, contentType: string, body: Uint8Array): Promise<void> {
    const res = await this.fetcher.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
    });
    if (res.status !== 201 && !res.ok) {
      const b = await res.text().catch(() => '');
      throw new ZoteroApiError({ status: res.status, message: `File storage upload failed (${res.status}). ${b.slice(0, 200)}` });
    }
  }

  async registerUpload(lib: LibraryRef, key: string, uploadKey: string, replaceMd5?: string): Promise<void> {
    const headers: Record<string, string> = {
      ...this.headers(),
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (replaceMd5) headers['If-Match'] = replaceMd5;
    else headers['If-None-Match'] = '*';
    const res = await this.fetcher.fetch(`${this.baseUrl}${this.prefix(lib)}/items/${key}/file`, {
      method: 'POST',
      headers,
      body: `upload=${encodeURIComponent(uploadKey)}`,
    });
    if (!res.ok) {
      const b = await res.text().catch(() => '');
      throw new ZoteroApiError({ status: res.status, message: actionableMessage(res.status, b, res.headers), body: b });
    }
  }

  async downloadFileBytes(
    lib: LibraryRef,
    key: string,
  ): Promise<{ bytes: Uint8Array; contentType?: string; etag?: string }> {
    const res = await this.fetcher.fetch(`${this.baseUrl}${this.prefix(lib)}/items/${key}/file`, {
      method: 'GET',
      headers: this.headers(),
    });
    if (!res.ok) {
      const b = await res.text().catch(() => '');
      throw new ZoteroApiError({ status: res.status, message: actionableMessage(res.status, b, res.headers), body: b });
    }
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? undefined,
      etag: res.headers.get('etag') ?? undefined,
    };
  }

  // ---- Writes ----

  /** Read the library's current version (used as a precondition for deletes/mixed writes). */
  async currentLibraryVersion(lib: LibraryRef): Promise<number> {
    const { headers } = await this.getJson(this.prefix(lib) + '/items', this.buildQuery({ limit: 1 }));
    return numOrUndef(headers.get('last-modified-version')) ?? 0;
  }

  /** Create/update items (batch POST /items). Objects with key+version update; without key create. */
  async writeItems(
    lib: LibraryRef,
    objects: any[],
    opts: { libraryVersion?: number } = {},
  ): Promise<WriteResult> {
    return this.postArray(this.prefix(lib) + '/items', objects, opts.libraryVersion);
  }

  async writeCollections(
    lib: LibraryRef,
    objects: any[],
    opts: { libraryVersion?: number } = {},
  ): Promise<WriteResult> {
    return this.postArray(this.prefix(lib) + '/collections', objects, opts.libraryVersion);
  }

  async writeSearches(
    lib: LibraryRef,
    objects: any[],
    opts: { libraryVersion?: number } = {},
  ): Promise<WriteResult> {
    return this.postArray(this.prefix(lib) + '/searches', objects, opts.libraryVersion);
  }

  /** Partial single-item update (PATCH). Returns the new library version. 412 on stale version. */
  async patchItem(lib: LibraryRef, key: string, patch: Record<string, unknown>, version: number): Promise<number> {
    const res = await this.fetcher.fetch(`${this.baseUrl}${this.prefix(lib)}/items/${key}`, {
      method: 'PATCH',
      headers: {
        ...this.headers(),
        'Content-Type': 'application/json',
        'If-Unmodified-Since-Version': String(version),
      },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ZoteroApiError({
        status: res.status,
        message: actionableMessage(res.status, body, res.headers),
        currentVersion: numOrUndef(res.headers.get('last-modified-version')),
        body,
      });
    }
    return numOrUndef(res.headers.get('last-modified-version')) ?? version;
  }

  async deleteItems(lib: LibraryRef, keys: string[], libraryVersion: number): Promise<void> {
    await this.deleteByKeys(this.prefix(lib) + '/items', 'itemKey', keys, libraryVersion);
  }

  async deleteCollections(lib: LibraryRef, keys: string[], libraryVersion: number): Promise<void> {
    await this.deleteByKeys(this.prefix(lib) + '/collections', 'collectionKey', keys, libraryVersion);
  }

  async deleteSearches(lib: LibraryRef, keys: string[], libraryVersion: number): Promise<void> {
    await this.deleteByKeys(this.prefix(lib) + '/searches', 'searchKey', keys, libraryVersion);
  }

  private writeToken(): string {
    return randomBytes(16).toString('hex');
  }

  private async postArray(path: string, objects: any[], libraryVersion?: number): Promise<WriteResult> {
    const merged: WriteResult = {
      successful: [],
      unchanged: [],
      failed: [],
      newLibraryVersion: libraryVersion ?? 0,
    };
    let currentVersion = libraryVersion ?? 0;
    let offset = 0;
    for (const c of chunk(objects, 50)) {
      const headers: Record<string, string> = { ...this.headers(), 'Content-Type': 'application/json' };
      const withVersion = c.filter((o) => o && typeof o.version === 'number').length;
      if (withVersion === c.length && c.length > 0) {
        // all updates: per-object version provides concurrency; no extra header needed
      } else if (withVersion === 0) {
        headers['Zotero-Write-Token'] = this.writeToken();
      } else {
        headers['If-Unmodified-Since-Version'] = String(currentVersion);
      }
      const res = await this.fetcher.fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(c),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ZoteroApiError({
          status: res.status,
          message: actionableMessage(res.status, body, res.headers),
          currentVersion: numOrUndef(res.headers.get('last-modified-version')),
          body,
        });
      }
      const json = await res.json();
      this.mergeWriteBody(merged, json, offset);
      const newV = numOrUndef(res.headers.get('last-modified-version'));
      if (newV !== undefined) currentVersion = newV;
      merged.newLibraryVersion = currentVersion;
      offset += c.length;
    }
    return merged;
  }

  private mergeWriteBody(merged: WriteResult, json: any, offset: number): void {
    for (const [idx, obj] of Object.entries<any>(json.successful ?? {})) {
      merged.successful.push({ index: offset + Number(idx), key: obj.key, version: obj.version });
    }
    for (const [idx, key] of Object.entries<any>(json.success ?? {})) {
      const index = offset + Number(idx);
      if (!merged.successful.some((s) => s.index === index)) {
        merged.successful.push({ index, key: String(key) });
      }
    }
    for (const key of Object.values<any>(json.unchanged ?? {})) merged.unchanged.push(String(key));
    for (const [idx, info] of Object.entries<any>(json.failed ?? {})) {
      merged.failed.push({
        index: offset + Number(idx),
        key: info.key,
        code: info.code,
        message: info.message,
      });
    }
  }

  private async deleteByKeys(
    path: string,
    keyParam: string,
    keys: string[],
    libraryVersion: number,
  ): Promise<void> {
    for (const c of chunk(keys, 50)) {
      const url = `${this.baseUrl}${path}?${keyParam}=${c.map(encodeURIComponent).join(',')}`;
      const res = await this.fetcher.fetch(url, {
        method: 'DELETE',
        headers: { ...this.headers(), 'If-Unmodified-Since-Version': String(libraryVersion) },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ZoteroApiError({
          status: res.status,
          message: actionableMessage(res.status, body, res.headers),
          currentVersion: numOrUndef(res.headers.get('last-modified-version')),
          body,
        });
      }
    }
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function numOrUndef(v: string | null): number | undefined {
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
