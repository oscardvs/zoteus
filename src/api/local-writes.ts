import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { RateLimitedFetcher, type FetchLike } from './http.js';
import { ZoteroApiError } from './errors.js';
import { LIVENESS_PATH, localLibraryPrefix } from './local-client.js';
import type { LibraryRef, WriteResult } from './web-client.js';
import type { Logger } from '../lib/logger.js';

export interface LocalWriteClientOptions {
  /** Zotero desktop local-API port (default 23119). */
  port?: number;
  fetcher?: RateLimitedFetcher;
  logger?: Logger;
  /** Where the granted local-API key is cached (default: <dataDir>/local-api-key.json). */
  keyStorePath?: string;
  /** Pre-provisioned local API key (ZOTEUS_LOCAL_API_KEY); skips the authorize prompt. */
  key?: string;
  /** App name shown in Zotero's grant dialog. */
  appName?: string;
  /**
   * The transport this client's requests go over, handed to the fetcher per call so its
   * semaphore and budgets still apply. src/server.ts passes the loopback transport
   * (loopback-fetch.ts, node:http rather than the undici behind fetch, #85); unset, every
   * request uses the fetcher's own fetch, which is what a test double wants.
   */
  fetchImpl?: FetchLike;
}

interface StoredGrant {
  key: string;
  appName: string;
  serverId?: string;
  remember?: boolean;
  grantedAt: string;
}

/** The local API caps a single write/delete batch at 50 objects. */
const MAX_WRITE_OBJECTS = 50;

function chunks(keys: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < keys.length; i += MAX_WRITE_OBJECTS) out.push(keys.slice(i, i + MAX_WRITE_OBJECTS));
  return out;
}

/**
 * Write client for the Zotero 10+ desktop local API.
 *
 * Local-API write support shipped in Zotero 10 (it is absent in 9.x, whose local API is
 * GET-only). Writes go to the same local API the reads use
 * (http://127.0.0.1:23119/api/users/0/... for the personal library,
 * .../api/groups/<groupID>/... for a group the app holds), gated by a *local* API key the
 * user grants through a one-time in-Zotero dialog. Every write method takes the library as
 * its last argument and defaults to the personal one. Verified against zotero/zotero @
 * 10.0.0, chrome/content/zotero/xpcom/server/server_localAPI.js, and against the 10.0.6
 * build's omni.ja for groups:
 *
 *   1. Every response carries a `Zotero-Server-ID` header; every request using a write
 *      method must echo it back — 428 when missing, 412 when it no longer matches the
 *      running instance (`LocalAPIEndpoint._validateServerID`). This applies to
 *      `/api/local/authorize` too, since it is itself a POST and does not opt out of
 *      `requireServerIDOnWrite`, so the server ID must be probed with a GET first.
 *   2. `POST /api/local/authorize` with `{"appName": "..."}` shows a dialog in Zotero
 *      ("Allow" / "Always Allow" / "Deny") and returns `{key, remember}`; a denial is
 *      403 `{"denied":true}` and more than 5 prompts a minute is 429.
 *   3. Writes then carry `Zotero-API-Key: <key>`. A single-use key is consumed by the
 *      first successful write, so a 401 means: re-authorize.
 *   4. Concurrency preconditions are enforced as in the Web API: multi-object DELETE
 *      *requires* `If-Unmodified-Since-Version`, and key-based writes require either it
 *      or a per-object `version` (428 otherwise). We send the library version we last
 *      observed and re-probe once on 412/428. Each library has its own version sequence
 *      (a group's `clientVersion` has nothing to do with the personal library's), so the
 *      version is tracked per library.
 *   5. A write to a library the app holds read-only is refused with 403 "Write access
 *      denied" (`library.editable`, checked after the key and before the write runs).
 *      Only a group can be read-only: one whose Library Editing setting leaves this user
 *      out. File uploads have their own 403 "File editing denied" (`filesEditable`).
 *
 * Keys are unrelated to zotero.org cloud keys. Grants are cached on disk so the user
 * is prompted once ("Always Allow"); single-use "Allow" grants degrade gracefully by
 * re-prompting on the next write.
 */
export class LocalWriteClient {
  private readonly base: string;
  private readonly fetcher: RateLimitedFetcher;
  private readonly logger?: Logger;
  private readonly keyStorePath?: string;
  private readonly appName: string;
  private readonly fetchImpl: FetchLike | undefined;
  private key?: string;
  private serverId?: string;
  /** Each library's version as last seen, keyed by its local path prefix (`/users/0`, `/groups/<id>`). */
  private readonly libraryVersions = new Map<string, number>();

  constructor(opts: LocalWriteClientOptions = {}) {
    this.base = `http://127.0.0.1:${opts.port ?? 23119}/api`;
    this.fetcher = opts.fetcher ?? new RateLimitedFetcher();
    this.logger = opts.logger;
    this.keyStorePath = opts.keyStorePath;
    this.appName = opts.appName ?? 'Zoteus MCP';
    this.key = opts.key;
    this.fetchImpl = opts.fetchImpl;
  }

  /**
   * True when a local-API key is already available (env-provided or cached from a
   * previous "Always Allow" grant) — i.e. writes can proceed without prompting.
   */
  hasStoredKey(): boolean {
    if (this.key) return true;
    return Boolean(this.loadGrant()?.key);
  }

  /**
   * One GET against the local API yields both things every write needs: the stable
   * `Zotero-Server-ID` of the running instance and the library's current version
   * (`Last-Modified-Version`), used as the concurrency precondition on writes. Both come on
   * every local API response, so the read is the same cheap one the liveness probe makes,
   * not an items listing that costs the size of the library (#102). For a group it is the
   * group's own collections listing, which carries that group's version.
   */
  private async probe(force = false, lib?: LibraryRef): Promise<{ serverId: string; libraryVersion: number }> {
    const prefix = localLibraryPrefix(lib);
    const known = this.libraryVersions.get(prefix);
    if (!force && this.serverId !== undefined && known !== undefined) {
      return { serverId: this.serverId, libraryVersion: known };
    }
    const path = lib?.type === 'group' ? `${prefix}/collections?limit=1` : LIVENESS_PATH;
    const res = await this.fetcher.fetch(
      `${this.base}${path}`,
      { method: 'GET', headers: this.readHeaders() },
      { maxRetries: 0, fetchImpl: this.fetchImpl },
    );
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      // Zotero answers 404 for a group it does not hold. Worded so `isLocalWritesUnavailable`
      // still reads it as "the desktop cannot take this", which it is: nothing was written,
      // and the cloud may well hold that group.
      if (lib?.type === 'group' && res.status === 404) {
        throw new Error(`Local API 404 for group library ${lib.id}: the running Zotero desktop app does not hold that group.`);
      }
      throw new Error(`Local API unreachable (HTTP ${res.status}) — is Zotero running?`);
    }
    const id = res.headers.get('zotero-server-id');
    const version = Number(res.headers.get('last-modified-version'));
    await res.body?.cancel().catch(() => {});
    if (!id) {
      throw new Error(
        'Local API writes are not supported by this Zotero: no Zotero-Server-ID header. ' +
          'Desktop writes need Zotero 10 or newer (9.x has a read-only local API).',
      );
    }
    this.serverId = id;
    const libraryVersion = Number.isFinite(version) ? version : 0;
    this.libraryVersions.set(prefix, libraryVersion);
    return { serverId: id, libraryVersion };
  }

  /** Record the version a write answered with, for the library it was made in. */
  private noteVersion(lib: LibraryRef | undefined, version: number): void {
    if (Number.isFinite(version) && version > 0) this.libraryVersions.set(localLibraryPrefix(lib), version);
  }

  /**
   * Whether the running app takes local-API writes at all. The probe every write starts with
   * answers it (a Zotero 9 sends no `Zotero-Server-ID`), and it is cached once it succeeds,
   * so asking costs one GET per Zoteus process on a Zotero 10, and one per write on a 9.
   */
  async acceptsWrites(): Promise<boolean> {
    try {
      await this.getServerId();
      return true;
    } catch {
      return false;
    }
  }

  /** Stable ID of the running Zotero instance (required on every write). */
  async getServerId(): Promise<string> {
    return (await this.probe()).serverId;
  }

  /** The library's version last seen, used as the write precondition. */
  private async getLibraryVersion(lib?: LibraryRef): Promise<number> {
    return (await this.probe(false, lib)).libraryVersion;
  }

  /**
   * Ask Zotero to grant this app a local API key. Blocks until the user answers the
   * dialog in Zotero ("Always Allow" recommended). Returns the key, or throws with a
   * human-readable reason on denial/error.
   *
   * `/api/local/authorize` is a POST, so Zotero applies the same server-ID precondition
   * it applies to any write: the header is mandatory (428) and must match (412).
   */
  async authorize(retried = false): Promise<string> {
    const serverId = await this.getServerId();
    this.logger?.info(`Requesting local API write access from Zotero (appName="${this.appName}")…`);
    const res = await this.fetcher.fetch(
      `${this.base}/local/authorize`,
      {
        method: 'POST',
        headers: { ...this.readHeaders(), 'Content-Type': 'application/json', 'Zotero-Server-ID': serverId },
        body: JSON.stringify({ appName: this.appName }),
      },
      { maxRetries: 0, fetchImpl: this.fetchImpl, deadlineMs: 300_000 },
    );
    const text = await res.text().catch(() => '');
    if (res.status === 403) {
      throw new Error('Zotero local write access was denied. Re-run when you can accept the dialog in Zotero.');
    }
    if (res.status === 429) {
      throw new Error('Too many local-API authorization prompts; wait a minute and try again.');
    }
    if ((res.status === 412 || res.status === 428) && !retried) {
      // Zotero restarted (or was never probed) between the probe and the grant.
      await this.probe(true);
      return this.authorize(true);
    }
    if (!res.ok) {
      throw new Error(`Local API authorize failed (HTTP ${res.status}): ${text || res.statusText}. ` +
        'Writes need Zotero 10+ with the local API enabled.');
    }
    const { key, remember } = JSON.parse(text) as { key: string; remember?: boolean };
    this.key = key;
    this.storeGrant({ key, appName: this.appName, serverId: this.serverId, remember, grantedAt: new Date().toISOString() });
    this.logger?.info(`Local API write access granted (remember=${!!remember}).`);
    return key;
  }

  private readHeaders(): Record<string, string> {
    return { 'Zotero-API-Version': '3', 'x-zotero-connector-api-version': '3' };
  }

  private async writeHeaders(): Promise<Record<string, string>> {
    // Probe first: authorize() itself needs the server ID, so resolving it up front
    // keeps a single round trip regardless of whether a grant is still needed.
    const serverId = await this.getServerId();
    return {
      ...this.readHeaders(),
      'Zotero-API-Key': this.key ?? (await this.authorize()),
      'Zotero-Server-ID': serverId,
    };
  }

  private loadGrant(): StoredGrant | null {
    if (!this.keyStorePath) return null;
    try {
      const grant = JSON.parse(readFileSync(this.keyStorePath, 'utf8')) as StoredGrant;
      // Files written before the 0600 rule were created with the default mode (0644).
      this.restrictGrantFile();
      return grant;
    } catch {
      return null;
    }
  }

  /** The key file is a credential: readable and writable by its owner only. No-op on Windows. */
  private restrictGrantFile(): void {
    if (!this.keyStorePath) return;
    try {
      chmodSync(this.keyStorePath, 0o600);
    } catch {
      /* not ours to change, or a filesystem without modes */
    }
  }

  /** Remove a grant Zotero no longer accepts, so a revoked key does not stay on disk. */
  private dropGrant(): void {
    if (!this.keyStorePath) return;
    try {
      rmSync(this.keyStorePath, { force: true });
    } catch (e) {
      this.logger?.warn(`Could not remove the rejected local API grant: ${e}`);
    }
  }

  private storeGrant(grant: StoredGrant): void {
    if (!this.keyStorePath) return;
    try {
      mkdirSync(dirname(this.keyStorePath), { recursive: true });
      // `mode` only applies when the file is created, so an existing one is tightened after.
      writeFileSync(this.keyStorePath, JSON.stringify(grant, null, 2), { mode: 0o600 });
      this.restrictGrantFile();
    } catch (e) {
      this.logger?.warn(`Could not persist local API grant: ${e}`);
    }
  }

  private async ensureKey(): Promise<void> {
    if (this.key) return;
    const grant = this.loadGrant();
    if (grant?.key) {
      this.key = grant.key;
      this.serverId = this.serverId ?? grant.serverId;
    }
  }

  /**
   * Run a write request against the local API, transparently handling the two
   * re-auth/re-probe cases: 401 (key consumed/unknown -> authorize again) and
   * 412/428 (server-id or library version stale/missing -> refresh both).
   *
   * `path` is relative to the library (`/items`, `/collections?…`), and `init.lib` names
   * the library, so the prefix and the version precondition always belong to the same one.
   *
   * `libraryPrecondition` adds `If-Unmodified-Since-Version`, which Zotero requires for
   * multi-object deletes and for key-based writes (it stands in for a per-object
   * `version`). It is recomputed on retry so a refreshed version is actually used. An
   * explicit `If-Unmodified-Since-Version` in `init.headers` is a pin, not a guess: the retry
   * resends it unchanged, so a library that really moved answers 412 to the caller.
   */
  private async request(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    init: {
      json?: unknown;
      form?: URLSearchParams;
      headers?: Record<string, string>;
      libraryPrecondition?: boolean;
      lib?: LibraryRef;
    } = {},
    retried = false,
  ): Promise<Response> {
    // The group's own probe first: for a group the desktop does not hold, that is where the
    // refusal comes from, before a grant dialog is shown for a write that cannot land.
    if (init.lib?.type === 'group') await this.probe(false, init.lib);
    await this.ensureKey();
    if (!this.key) await this.authorize();
    const headers = await this.writeHeaders();
    if (init.libraryPrecondition) {
      headers['If-Unmodified-Since-Version'] = String(await this.getLibraryVersion(init.lib));
    }
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
    } else if (init.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const res = await this.fetcher.fetch(
      `${this.base}${localLibraryPrefix(init.lib)}${path}`,
      {
        method,
        headers: { ...headers, ...init.headers },
        body: init.json !== undefined ? JSON.stringify(init.json) : init.form?.toString(),
      },
      { maxRetries: 0, fetchImpl: this.fetchImpl, deadlineMs: 120_000 },
    );
    if (res.status === 401 && !retried) {
      this.logger?.info('Local API key rejected (401); requesting a fresh grant from Zotero…');
      this.key = undefined;
      // Consumed or revoked: either way the stored copy is dead. Drop it before asking
      // again, so a denied or unanswered prompt does not leave a rejected key behind.
      this.dropGrant();
      await this.authorize();
      return this.request(method, path, init, true);
    }
    if ((res.status === 412 || res.status === 428) && !retried) {
      await res.body?.cancel().catch(() => {});
      // Either the instance changed or the library moved on: refresh both preconditions.
      await this.probe(true, init.lib);
      return this.request(method, path, init, true);
    }
    return res;
  }

  /**
   * Multi-write (create/update) of items, mirroring the Web API semantics.
   *
   * `opts.libraryVersion` pins the whole request to that library version, exactly like the
   * Web API's `writeItems(lib, objects, { libraryVersion })`: Zotero refuses it with 412 if
   * anything in the library changed since, which is how a caller makes "nothing moved
   * between my read and this write" part of the write itself.
   */
  async writeItems(
    items: Record<string, unknown>[],
    lib?: LibraryRef,
    opts: { libraryVersion?: number } = {},
  ): Promise<WriteResult> {
    return this.writeObjects('items', items, lib, opts.libraryVersion);
  }

  /** Create or update collections (`{name, parentCollection}`, plus `key`+`version` to update). */
  async writeCollections(collections: Record<string, unknown>[], lib?: LibraryRef): Promise<WriteResult> {
    return this.writeObjects('collections', collections, lib);
  }

  /** Create or update saved searches (`{name, conditions}`). */
  async writeSearches(searches: Record<string, unknown>[], lib?: LibraryRef): Promise<WriteResult> {
    return this.writeObjects('searches', searches, lib);
  }

  /**
   * POST objects of one kind, in batches of 50 (the local API answers a larger batch with
   * 413), with the per-batch results merged back onto the caller's indexes.
   *
   * A key-based write needs a concurrency precondition, and Zotero takes either a
   * per-object `version` or the library-wide `If-Unmodified-Since-Version`. The library one
   * is sent only when some keyed object carries no version of its own: alongside versioned
   * objects it adds nothing but a 412 whenever anything else in the library moved since the
   * last probe, and for pure creates it would invent the same 412 for nothing.
   */
  private async writeObjects(
    kind: 'items' | 'collections' | 'searches',
    objects: Record<string, unknown>[],
    lib?: LibraryRef,
    pinnedVersion?: number,
  ): Promise<WriteResult> {
    const merged: WriteResult = { successful: [], unchanged: [], failed: [], newLibraryVersion: 0 };
    for (let offset = 0; offset < objects.length; offset += MAX_WRITE_OBJECTS) {
      const batch = objects.slice(offset, offset + MAX_WRITE_OBJECTS);
      const needsPrecondition = batch.some(
        (o) => typeof o.key === 'string' && o.key && (o.version === undefined || o.version === null),
      );
      const res = await this.request(
        'POST',
        `/${kind}`,
        pinnedVersion === undefined
          ? { json: batch, libraryPrecondition: needsPrecondition, lib }
          : { json: batch, headers: { 'If-Unmodified-Since-Version': String(pinnedVersion) }, lib },
      );
      const result = await this.parseWriteResult(res, lib);
      this.noteVersion(lib, result.newLibraryVersion);
      merged.successful.push(...result.successful.map((s) => ({ ...s, index: s.index + offset })));
      merged.failed.push(...result.failed.map((f) => ({ ...f, index: f.index + offset })));
      merged.unchanged.push(...result.unchanged.map((i) => String(Number(i) + offset)));
      merged.newLibraryVersion = result.newLibraryVersion || merged.newLibraryVersion;
    }
    return merged;
  }

  /**
   * Move items to the trash (`deleted: 1`) or restore them (`deleted: 0`). This is the
   * reversible operation — the local API's DELETE, like the Web API's, erases items
   * outright and is exposed separately as {@link deleteItems}.
   */
  async setDeleted(keys: string[], deleted: 0 | 1, lib?: LibraryRef): Promise<WriteResult> {
    const merged: WriteResult = { successful: [], unchanged: [], failed: [], newLibraryVersion: 0 };
    let offset = 0;
    for (const chunk of chunks(keys)) {
      const res = await this.writeItems(chunk.map((key) => ({ key, deleted })), lib);
      merged.successful.push(...res.successful.map((s) => ({ ...s, index: s.index + offset })));
      merged.failed.push(...res.failed.map((f) => ({ ...f, index: f.index + offset })));
      // `unchanged` is keyed by request index; resolve it back to item keys, since an
      // item already in the requested state is "done" as far as callers care.
      merged.unchanged.push(...res.unchanged.map((i) => chunk[Number(i)] ?? i));
      merged.newLibraryVersion = res.newLibraryVersion || merged.newLibraryVersion;
      offset += chunk.length;
    }
    return merged;
  }

  /**
   * Partial single-item update. With `version` (the item's own, as a read of it reported),
   * that is the precondition, exactly as on the Web API: Zotero answers 412 only when THIS
   * item changed since, which is the conflict a caller can resolve by re-reading it.
   * Without one, the library version last seen stands in.
   */
  async patchItem(key: string, patch: Record<string, unknown>, version?: number, lib?: LibraryRef): Promise<number> {
    const res = await this.request(
      'PATCH',
      `/items/${key}`,
      version === undefined
        ? { json: patch, libraryPrecondition: true, lib }
        : { json: patch, headers: { 'If-Unmodified-Since-Version': String(version) }, lib },
    );
    if (!res.ok) await this.throwApi(res, `PATCH /items/${key}`, lib);
    const v = Number(res.headers.get('last-modified-version'));
    await res.body?.cancel().catch(() => {});
    this.noteVersion(lib, v);
    return Number.isFinite(v) ? v : 0;
  }

  /**
   * PERMANENTLY erase items by key. The local API mirrors the Web API here: DELETE
   * removes the objects outright (no trash), and requires the library-version
   * precondition. Use {@link setDeleted} for the reversible trash.
   */
  async deleteItems(keys: string[], lib?: LibraryRef): Promise<void> {
    await this.deleteByKeys('items', 'itemKey', keys, lib);
  }

  /**
   * Erase collections by key. As on the Web API, the items in them are not touched: they
   * lose that membership and stay in the library. Subcollections go with their parent.
   */
  async deleteCollections(keys: string[], lib?: LibraryRef): Promise<void> {
    await this.deleteByKeys('collections', 'collectionKey', keys, lib);
  }

  /** Erase saved-search definitions by key (the items they matched are not touched). */
  async deleteSearches(keys: string[], lib?: LibraryRef): Promise<void> {
    await this.deleteByKeys('searches', 'searchKey', keys, lib);
  }

  private async deleteByKeys(
    kind: 'items' | 'collections' | 'searches',
    param: string,
    keys: string[],
    lib?: LibraryRef,
  ): Promise<void> {
    for (const chunk of chunks(keys)) {
      const path = `/${kind}?${param}=${chunk.join(',')}`;
      const res = await this.request('DELETE', path, { libraryPrecondition: true, lib });
      if (!res.ok && res.status !== 204) await this.throwApi(res, `DELETE ${path}`, lib);
      const v = Number(res.headers.get('last-modified-version'));
      await res.body?.cancel().catch(() => {});
      this.noteVersion(lib, v);
    }
  }

  /**
   * Store full text for one attachment, the local twin of the Web API's
   * `PUT /items/<key>/fulltext`. Zotero files it as the attachment's own index content, so
   * the desktop's full-text search and `GET …/fulltext` see it at once. A Zotero 10 build
   * without the endpoint answers 501, which callers read as "no local writes" and route to
   * the cloud instead.
   */
  async setFullText(
    key: string,
    body: { content: string; indexedChars?: number; totalChars?: number; indexedPages?: number; totalPages?: number },
    lib?: LibraryRef,
  ): Promise<void> {
    const res = await this.request('PUT', `/items/${key}/fulltext`, { json: body, lib });
    if (res.status === 404) {
      const text = await res.text().catch(() => '');
      // A build without the endpoint says "No endpoint found", which must stay a "Local API"
      // failure so callers fall back. Plain "Not found" is the item, and says so without the
      // words that would send a missing attachment off to the cloud to fail again there.
      if (!/no endpoint/i.test(text)) {
        throw new ZoteroApiError({
          status: 404,
          message: `No stored file attachment ${key} in the desktop library, so there is nothing to attach full text to. Full text belongs to an attachment (a PDF, EPUB or snapshot), not to its parent item.`,
          body: text,
        });
      }
      throw new ZoteroApiError({ status: 404, message: `Local API PUT /items/${key}/fulltext failed (404): ${text.slice(0, 400)}`, body: text });
    }
    if (!res.ok && res.status !== 204) await this.throwApi(res, `PUT /items/${key}/fulltext`, lib);
    const v = Number(res.headers.get('last-modified-version'));
    await res.body?.cancel().catch(() => {});
    this.noteVersion(lib, v);
  }

  /**
   * Store a file on a (child) attachment item using the Web-API 3-phase upload flow,
   * which the local API re-implements: authorize -> POST bytes to the returned URL ->
   * register the uploadKey.
   */
  async uploadFile(
    attachmentKey: string,
    file: { bytes: Uint8Array; filename: string; contentType: string; mtimeMs?: number },
    lib?: LibraryRef,
  ): Promise<void> {
    const md5 = createHash('md5').update(file.bytes).digest('hex');
    const mtime = file.mtimeMs ?? Date.now();
    const authorize = await this.request('POST', `/items/${attachmentKey}/file`, {
      lib,
      form: new URLSearchParams({
        md5,
        filename: file.filename,
        filesize: String(file.bytes.length),
        mtime: String(mtime),
        contentType: file.contentType,
      }),
      headers: { 'If-None-Match': '*' },
    });
    if (!authorize.ok) await this.throwApi(authorize, `authorize upload for ${attachmentKey}`, lib);
    const auth = (await authorize.json()) as { exists?: number; url?: string; uploadKey?: string };
    if (auth.exists) return; // identical file already stored
    if (!auth.url || !auth.uploadKey) throw new Error('Local API did not return an upload URL.');

    const bodyInit: RequestInit['body'] = file.bytes;
    const up = await this.fetcher.fetch(
      auth.url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bodyInit,
      },
      { maxRetries: 0, fetchImpl: this.fetchImpl, deadlineMs: 300_000 },
    );
    if (!up.ok) await this.throwApi(up, 'file-bytes upload');
    await up.body?.cancel().catch(() => {});

    const register = await this.request('POST', `/items/${attachmentKey}/file`, {
      lib,
      form: new URLSearchParams({ upload: auth.uploadKey }),
      headers: { 'If-None-Match': '*' },
    });
    if (!register.ok && register.status !== 204) await this.throwApi(register, 'register upload', lib);
    await register.body?.cancel().catch(() => {});
  }

  private async parseWriteResult(res: Response, lib?: LibraryRef): Promise<WriteResult> {
    if (!res.ok) await this.throwApi(res, 'local write', lib);
    const json = (await res.json().catch(() => ({}))) as any;
    const successful: WriteResult['successful'] = [];
    for (const [idx, obj] of Object.entries<any>(json.successful ?? {})) {
      successful.push({ index: Number(idx), key: obj.key, version: obj.version });
    }
    const failed: WriteResult['failed'] = [];
    for (const [idx, obj] of Object.entries<any>(json.failed ?? {})) {
      failed.push({ index: Number(idx), code: obj.code ?? 0, message: obj.message ?? 'write failed', key: obj.key });
    }
    return {
      successful,
      unchanged: Object.keys(json.unchanged ?? {}),
      failed,
      newLibraryVersion: Number(res.headers.get('last-modified-version')) || 0,
    };
  }

  private async throwApi(res: Response, what: string, lib?: LibraryRef): Promise<never> {
    const body = await res.text().catch(() => '');
    if (res.status === 403) {
      const refusal = readOnlyRefusal(body, lib);
      if (refusal) throw new ZoteroApiError({ status: 403, message: refusal, body });
    }
    throw new ZoteroApiError({ status: res.status, message: `Local API ${what} failed (${res.status}): ${body.slice(0, 400)}`, body });
  }
}

/**
 * What to say when the desktop refuses a write because it holds the library read-only, or
 * null for any other 403.
 *
 * Zotero's own words are "Write access denied" and "File editing denied", which read like a
 * missing key or a lost grant and would send a caller off to re-authorize. They are neither:
 * the app checked the group's permissions, as synced from zotero.org, and this account may
 * not edit that library (or its files). The same account is refused by the cloud for the
 * same reason, so the message says what can change it and is deliberately worded so
 * `isLocalWritesUnavailable` never reads it as a reason to try the cloud instead.
 */
export function readOnlyRefusal(body: string, lib?: LibraryRef): string | null {
  const files = /file editing denied/i.test(body);
  if (!files && !/write access denied/i.test(body)) return null;
  const which = lib?.type === 'group' ? `group library ${lib.id}` : 'this library';
  const what = files ? 'store files in' : 'edit';
  return (
    `The Zotero desktop app refused this write: your account may not ${what} ${which}. ` +
    (lib?.type === 'group'
      ? `The group's ${files ? 'File Editing' : 'Library Editing'} setting on zotero.org leaves you out (for example, admins only). ` +
        'A group admin can change it; no API key or Zoteus setting overrides it.'
      : 'Zotero holds it as read-only.') +
    (files ? '' : ' Nothing was written.')
  );
}
