import type { RateLimitedFetcher } from '../../api/http.js';

export interface MultipleChoices {
  url: string;
  session: string;
  items: Record<string, string>;
}

/**
 * Client for a Zotero translation-server (https://github.com/zotero/translation-server).
 * Used for add-by-identifier (DOI/ISBN/PMID/arXiv) and add-by-URL. Optional: if the
 * server is not reachable, callers should degrade gracefully via isUp().
 */
export class TranslationServerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: RateLimitedFetcher,
  ) {}

  async isUp(): Promise<boolean> {
    try {
      const res = await this.fetcher.fetch(`${this.baseUrl}/`, { method: 'GET' }, { maxRetries: 0 });
      return res.status > 0;
    } catch {
      return false;
    }
  }

  /** Resolve an identifier (DOI/ISBN/PMID/arXiv/Bibcode) to Zotero-JSON items. */
  async search(identifier: string): Promise<any[]> {
    const res = await this.fetcher.fetch(
      `${this.baseUrl}/search`,
      { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: identifier },
      { maxRetries: 0 },
    );
    if (res.status === 400 || res.status === 501) {
      throw new Error(`No translator could resolve "${identifier}".`);
    }
    if (!res.ok) throw new Error(`translation-server /search returned ${res.status}.`);
    return (await res.json()) as any[];
  }

  /**
   * Convert a bibliographic file (BibTeX, RIS, CSL-JSON, EndNote XML, MODS, RDF) to
   * Zotero-JSON items, using the translator set the server has bundled.
   *
   * This is the better path when a translation-server happens to be running: it covers
   * formats Zoteus does not parse itself and it is Zotero's own translator code. It is not
   * the required path. Zoteus parses BibTeX, RIS and CSL-JSON in-repo
   * (src/features/import/) precisely because this server is optional, off by default,
   * published as an arm64-only Docker image, and unreachable from a hosted deployment.
   *
   * Throws when no translator matched (400/501), so a caller can fall back to the built-in
   * parsers rather than reporting a failure the user can do nothing about.
   */
  async import(payload: string): Promise<any[]> {
    const res = await this.fetcher.fetch(
      `${this.baseUrl}/import`,
      { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: payload },
      { maxRetries: 0 },
    );
    if (res.status === 400 || res.status === 501) {
      throw new Error('No translator on the translation-server recognised this payload.');
    }
    if (!res.ok) throw new Error(`translation-server /import returned ${res.status}.`);
    const items = (await res.json()) as any[];
    return Array.isArray(items) ? items : [];
  }

  /** Scrape a URL. Returns items, or a 300 Multiple-Choices selection set. */
  async web(url: string): Promise<{ items?: any[]; multiple?: MultipleChoices }> {
    const res = await this.fetcher.fetch(
      `${this.baseUrl}/web`,
      { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: url },
      { maxRetries: 0 },
    );
    if (res.status === 300) return { multiple: (await res.json()) as MultipleChoices };
    if (!res.ok) throw new Error(`translation-server /web returned ${res.status}.`);
    return { items: (await res.json()) as any[] };
  }

  async exportFormat(items: any[], format: string): Promise<string> {
    const res = await this.fetcher.fetch(
      `${this.baseUrl}/export?format=${encodeURIComponent(format)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(items) },
      { maxRetries: 0 },
    );
    if (!res.ok) throw new Error(`translation-server /export returned ${res.status}.`);
    return res.text();
  }
}
