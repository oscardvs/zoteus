import type { FetchLike } from './http.js';

export interface BbtClientOptions {
  port?: number;
  baseUrl?: string;
  /**
   * The transport requests go over. zotero_export passes the loopback transport
   * (loopback-fetch.ts, node:http rather than the undici behind fetch, #85); the default
   * is the global fetch, which is what a test double replaces.
   */
  fetchImpl?: FetchLike;
}

/**
 * Minimal client for the Better BibTeX endpoints exposed by the desktop Zotero
 * process at 127.0.0.1:<port>/better-bibtex. Local-only; used by zotero_export
 * format:"better-biblatex". Verify the JSON-RPC shape against current BBT docs.
 *
 * JSON-RPC shape verified against https://retorque.re/zotero-better-bibtex/exporting/json-rpc/
 * (2026-05-30): endpoint POST /better-bibtex/json-rpc; item.export(citekeys: string[],
 * translator: string) -> string; item.citationkey(item_keys: string[]) -> { [itemKey]: citekey };
 * item.search(terms) used for the liveness ping.
 */
export class BbtClient {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: BbtClientOptions = {}) {
    this.base = opts.baseUrl ?? `http://127.0.0.1:${opts.port ?? 23119}/better-bibtex`;
    this.fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.base}/json-rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'item.search', params: [''], id: 0 }),
      });
      // The answer to an empty search can be every item BBT knows, and nobody here reads
      // it; a body nobody reads keeps its socket until it is collected.
      await res.body?.cancel().catch(() => {});
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Map Zotero item keys to BBT citation keys. */
  async citationKeys(itemKeys: string[]): Promise<string[]> {
    const json = await this.rpc('item.citationkey', [itemKeys]);
    // BBT returns { <itemKey>: <citekey> }; preserve input order, drop misses.
    return itemKeys.map((k) => (json && json[k]) || '').filter(Boolean);
  }

  /** Export the given citation keys with a translator (default better-biblatex). */
  async exportItems(opts: { citekeys: string[]; translator?: string }): Promise<string> {
    const result = await this.rpc('item.export', [opts.citekeys, opts.translator ?? 'better-biblatex']);
    if (typeof result === 'string') return result;
    if (Array.isArray(result)) return String(result[0] ?? '');
    return String(result ?? '');
  }

  private async rpc(method: string, params: unknown[]): Promise<any> {
    const res = await this.fetchImpl(`${this.base}/json-rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
    });
    if (!res.ok) throw new Error(`Better BibTeX JSON-RPC ${method} failed (${res.status}).`);
    const json = (await res.json()) as any;
    if (json.error) throw new Error(`Better BibTeX error: ${json.error.message ?? JSON.stringify(json.error)}`);
    return json.result;
  }
}
