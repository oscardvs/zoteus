import { randomBytes } from 'node:crypto';
import { RateLimitedFetcher, type FetchLike } from './http.js';
import type { Logger } from '../lib/logger.js';

export interface ConnectorWriteClientOptions {
  port?: number;
  fetcher?: RateLimitedFetcher;
  logger?: Logger;
  /**
   * The transport this client's requests go over, handed to the fetcher per call so its
   * semaphore and budgets still apply. src/server.ts passes the loopback transport
   * (loopback-fetch.ts, node:http rather than the undici behind fetch, #85); unset, every
   * request uses the fetcher's own fetch, which is what a test double wants.
   */
  fetchImpl?: FetchLike;
}

export interface SaveTarget {
  id: string; // treeViewID, e.g. "L1" (My Library) or "C20" (a collection)
  name: string;
  level?: number;
}

/**
 * Write client for the Zotero desktop connector API (available on Zotero 7+ while
 * the app is running, including versions whose local API is still read-only).
 *
 * This is the same protocol the browser connectors use:
 *  - `POST /connector/saveItems` saves items through Zotero's ItemSaver. Items may
 *    carry a client-chosen `id` ("connector key") that later calls use to reference
 *    them.
 *  - `POST /connector/saveAttachment` streams file bytes (X-Metadata header with
 *    sessionID/parentItemID/url/title) into a stored attachment under a session item.
 *  - `POST /connector/updateSession` re-targets a session: moves already-saved items
 *    to another collection (treeViewID), applies tags, and can attach a note.
 *
 * Limitations vs the cloud Web API: no updates/deletes, no response payload (created
 * keys must be recovered by querying the local API afterwards), and saves land in the
 * personal library only.
 */
export class ConnectorWriteClient {
  private readonly base: string;
  private readonly fetcher: RateLimitedFetcher;
  private readonly logger?: Logger;
  private readonly fetchImpl: FetchLike | undefined;

  constructor(opts: ConnectorWriteClientOptions = {}) {
    this.base = `http://127.0.0.1:${opts.port ?? 23119}`;
    this.fetcher = opts.fetcher ?? new RateLimitedFetcher();
    this.logger = opts.logger;
    this.fetchImpl = opts.fetchImpl;
  }

  private jsonHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-zotero-connector-api-version': '3',
      'x-zotero-connector-version': '5.0.125',
    };
  }

  private newSessionId(): string {
    return `zoteus-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.fetcher.fetch(`${this.base}/connector/ping`, { method: 'GET' }, { maxRetries: 0, fetchImpl: this.fetchImpl });
      const text = await res.text().catch(() => '');
      return res.ok && /zotero is running/i.test(text);
    } catch {
      return false;
    }
  }

  /**
   * Save items (metadata, notes, or annotations with `parentItem`) and open a session
   * for follow-up calls. Each item gets a connector `id` (returned alongside) that
   * `saveAttachment` uses as `parentItemID`.
   */
  async saveItems(
    items: Record<string, unknown>[],
    opts: { uri?: string; sessionID?: string } = {},
  ): Promise<{ sessionID: string; connectorIds: string[] }> {
    const sessionID = opts.sessionID ?? this.newSessionId();
    const connectorIds = items.map((_, i) => `${sessionID}-${i}`);
    const payload = {
      uri: opts.uri ?? 'zotero://zoteus/session/' + sessionID,
      sessionID,
      items: items.map((it, i) => ({ id: connectorIds[i], ...it })),
    };
    const res = await this.fetcher.fetch(
      `${this.base}/connector/saveItems`,
      { method: 'POST', headers: this.jsonHeaders(), body: JSON.stringify(payload) },
      { maxRetries: 0, fetchImpl: this.fetchImpl, deadlineMs: 120_000 },
    );
    const text = await res.text().catch(() => '');
    if (res.status === 409) {
      // Session id collision — retry once with a fresh id.
      if (!opts.sessionID) return this.saveItems(items, { ...opts, sessionID: this.newSessionId() });
      throw new Error(`Connector save session exists: ${text}`);
    }
    if (!res.ok && res.status !== 201) {
      throw new Error(`Connector saveItems failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
    this.logger?.info(`Connector session ${sessionID}: saved ${items.length} item(s).`);
    return { sessionID, connectorIds };
  }

  /**
   * Re-target a session: moves its saved items to `target` (a treeViewID like "L1" or
   * "C20"), applies `tags`, and optionally attaches `note` to each item.
   */
  async updateSession(
    sessionID: string,
    opts: { target?: string; tags?: string[]; note?: string } = {},
  ): Promise<void> {
    const body: Record<string, unknown> = { sessionID };
    if (opts.target) body.target = opts.target;
    if (opts.tags) body.tags = opts.tags;
    if (opts.note !== undefined) body.note = opts.note;
    const res = await this.fetcher.fetch(
      `${this.base}/connector/updateSession`,
      { method: 'POST', headers: this.jsonHeaders(), body: JSON.stringify(body) },
      { maxRetries: 0, fetchImpl: this.fetchImpl, deadlineMs: 60_000 },
    );
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`Connector updateSession failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
    if (/COLLECTION_NOT_FOUND|SESSION_NOT_FOUND/.test(text)) {
      throw new Error(`Connector updateSession rejected: ${text}`);
    }
  }

  /**
   * Stream file bytes into a stored attachment under an item saved in this session.
   * `url` is recorded as the attachment's source URL (it is NOT fetched by Zotero).
   */
  async saveAttachment(opts: {
    sessionID: string;
    parentConnectorId: string;
    url: string;
    title?: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<void> {
    const metadata = {
      sessionID: opts.sessionID,
      parentItemID: opts.parentConnectorId,
      url: opts.url,
      title: opts.title ?? 'Full Text PDF',
    };
    const bodyInit: RequestInit['body'] = opts.bytes;
    const res = await this.fetcher.fetch(
      `${this.base}/connector/saveAttachment`,
      {
        method: 'POST',
        headers: {
          ...this.jsonHeaders(),
          'Content-Type': opts.contentType,
          'X-Metadata': JSON.stringify(metadata),
        },
        body: bodyInit,
      },
      { maxRetries: 0, fetchImpl: this.fetchImpl, deadlineMs: 300_000 },
    );
    const text = await res.text().catch(() => '');
    if (!res.ok && res.status !== 201) {
      throw new Error(`Connector saveAttachment failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
    if (/not editable/i.test(text)) throw new Error(`Zotero refused the file: ${text}`);
    this.logger?.info(`Connector session ${opts.sessionID}: attached ${opts.bytes.length} bytes (${opts.contentType}).`);
  }

  /** Current save target + full list of selectable targets (library and collections). */
  async getSelectedCollection(): Promise<{ current: string; targets: SaveTarget[] }> {
    const res = await this.fetcher.fetch(
      `${this.base}/connector/getSelectedCollection`,
      { method: 'POST', headers: this.jsonHeaders(), body: '{}' },
      { maxRetries: 0, fetchImpl: this.fetchImpl },
    );
    const json = (await res.json().catch(() => ({}))) as any;
    return {
      current: typeof json.id === 'string' ? json.id : String(json.id ?? ''),
      targets: Array.isArray(json.targets) ? json.targets : [],
    };
  }
}
