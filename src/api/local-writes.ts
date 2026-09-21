import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { RateLimitedFetcher, type FetchLike } from './http.js';
import { ZoteroApiError } from './errors.js';
import type { WriteResult } from './web-client.js';
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
 * (http://127.0.0.1:23119/api/users/0/...), gated by a *local* API key the user grants
 * through a one-time in-Zotero dialog. Verified against zotero/zotero @ 10.0.0,
 * chrome/content/zotero/xpcom/server/server_localAPI.js:
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
 *      observed and re-probe once on 412/428.
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
  private libraryVersion?: number;

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
   * (`Last-Modified-Version`), used as the concurrency precondition on writes.
   */
  private async probe(force = false): Promise<{ serverId: string; libraryVersion: number }> {
    if (!force && this.serverId !== undefined && this.libraryVersion !== undefined) {
      return { serverId: this.serverId, libraryVersion: this.libraryVersion };
    }
    const res = await this.fetcher.fetch(
      `${this.base}/users/0/items?limit=1`,
      { method: 'GET', headers: this.readHeaders() },
      { maxRetries: 0, fetchImpl: this.fetchImpl },
    );
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
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
    this.libraryVersion = Number.isFinite(version) ? version : 0;
    return { serverId: id, libraryVersion: this.libraryVersion };
  }

  /** Stable ID of the running Zotero instance (required on every write). */
  async getServerId(): Promise<string> {
    return (await this.probe()).serverId;
  }

  /** Personal-library version last seen, used as the write precondition. */
  private async getLibraryVersion(): Promise<number> {
    return (await this.probe()).libraryVersion;
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
      return JSON.parse(readFileSync(this.keyStorePath, 'utf8')) as StoredGrant;
    } catch {
      return null;
    }
  }

  private storeGrant(grant: StoredGrant): void {
    if (!this.keyStorePath) return;
    try {
      mkdirSync(dirname(this.keyStorePath), { recursive: true });
      writeFileSync(this.keyStorePath, JSON.stringify(grant, null, 2));
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
   * `libraryPrecondition` adds `If-Unmodified-Since-Version`, which Zotero requires for
   * multi-object deletes and for key-based writes (it stands in for a per-object
   * `version`). It is recomputed on retry so a refreshed version is actually used.
   */
  private async request(
    method: 'POST' | 'PATCH' | 'DELETE',
    path: string,
    init: {
      json?: unknown;
      form?: URLSearchParams;
      headers?: Record<string, string>;
      libraryPrecondition?: boolean;
    } = {},
    retried = false,
  ): Promise<Response> {
    await this.ensureKey();
    if (!this.key) await this.authorize();
    const headers = await this.writeHeaders();
    if (init.libraryPrecondition) {
      headers['If-Unmodified-Since-Version'] = String(await this.getLibraryVersion());
    }
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
    } else if (init.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const res = await this.fetcher.fetch(
      `${this.base}${path}`,
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
      await this.authorize();
      return this.request(method, path, init, true);
    }
    if ((res.status === 412 || res.status === 428) && !retried) {
      await res.body?.cancel().catch(() => {});
      // Either the instance changed or the library moved on: refresh both preconditions.
      await this.probe(true);
      return this.request(method, path, init, true);
    }
    return res;
  }

  /** Multi-write (create/update) up to 50 items, mirroring the Web API semantics. */
  async writeItems(items: Record<string, unknown>[]): Promise<WriteResult> {
    // Only key-based writes (updates) need the precondition; sending it for pure
    // creates would just invent a 412 whenever the library moved on in the meantime.
    const hasKeyedWrite = items.some((it) => typeof it.key === 'string' && it.key);
    const res = await this.request('POST', '/users/0/items', { json: items, libraryPrecondition: hasKeyedWrite });
    const result = await this.parseWriteResult(res);
    if (result.newLibraryVersion) this.libraryVersion = result.newLibraryVersion;
    return result;
  }

  /**
   * Move items to the trash (`deleted: 1`) or restore them (`deleted: 0`). This is the
   * reversible operation — the local API's DELETE, like the Web API's, erases items
   * outright and is exposed separately as {@link deleteItems}.
   */
  async setDeleted(keys: string[], deleted: 0 | 1): Promise<WriteResult> {
    const merged: WriteResult = { successful: [], unchanged: [], failed: [], newLibraryVersion: 0 };
    let offset = 0;
    for (const chunk of chunks(keys)) {
      const res = await this.writeItems(chunk.map((key) => ({ key, deleted })));
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

  /** Partial single-item update. */
  async patchItem(key: string, patch: Record<string, unknown>): Promise<number> {
    const res = await this.request('PATCH', `/users/0/items/${key}`, { json: patch, libraryPrecondition: true });
    if (!res.ok) await this.throwApi(res, `PATCH /items/${key}`);
    const v = Number(res.headers.get('last-modified-version'));
    await res.body?.cancel().catch(() => {});
    if (Number.isFinite(v)) this.libraryVersion = v;
    return Number.isFinite(v) ? v : 0;
  }

  /**
   * PERMANENTLY erase items by key. The local API mirrors the Web API here: DELETE
   * removes the objects outright (no trash), and requires the library-version
   * precondition. Use {@link setDeleted} for the reversible trash.
   */
  async deleteItems(keys: string[]): Promise<void> {
    for (const chunk of chunks(keys)) {
      const path = `/users/0/items?itemKey=${chunk.join(',')}`;
      const res = await this.request('DELETE', path, { libraryPrecondition: true });
      if (!res.ok && res.status !== 204) await this.throwApi(res, `DELETE ${path}`);
      const v = Number(res.headers.get('last-modified-version'));
      await res.body?.cancel().catch(() => {});
      if (Number.isFinite(v)) this.libraryVersion = v;
    }
  }

  /**
   * Store a file on a (child) attachment item using the Web-API 3-phase upload flow,
   * which the local API re-implements: authorize -> POST bytes to the returned URL ->
   * register the uploadKey.
   */
  async uploadFile(
    attachmentKey: string,
    file: { bytes: Uint8Array; filename: string; contentType: string; mtimeMs?: number },
  ): Promise<void> {
    const md5 = createHash('md5').update(file.bytes).digest('hex');
    const mtime = file.mtimeMs ?? Date.now();
    const authorize = await this.request('POST', `/users/0/items/${attachmentKey}/file`, {
      form: new URLSearchParams({
        md5,
        filename: file.filename,
        filesize: String(file.bytes.length),
        mtime: String(mtime),
        contentType: file.contentType,
      }),
      headers: { 'If-None-Match': '*' },
    });
    if (!authorize.ok) await this.throwApi(authorize, `authorize upload for ${attachmentKey}`);
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

    const register = await this.request('POST', `/users/0/items/${attachmentKey}/file`, {
      form: new URLSearchParams({ upload: auth.uploadKey }),
      headers: { 'If-None-Match': '*' },
    });
    if (!register.ok && register.status !== 204) await this.throwApi(register, 'register upload');
    await register.body?.cancel().catch(() => {});
  }

  private async parseWriteResult(res: Response): Promise<WriteResult> {
    if (!res.ok) await this.throwApi(res, 'local write');
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

  private async throwApi(res: Response, what: string): Promise<never> {
    const body = await res.text().catch(() => '');
    throw new ZoteroApiError({ status: res.status, message: `Local API ${what} failed (${res.status}): ${body.slice(0, 400)}`, body });
  }
}
