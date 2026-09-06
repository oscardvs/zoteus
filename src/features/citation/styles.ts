/**
 * Human style name -> CSL style id (the filename, without .csl).
 *
 * The Chicago ids follow the style repository's own renames for the 18th edition:
 * `chicago-note-bibliography`, which "chicago" used to name here, is gone from the
 * repository and its rename record points at `chicago-shortened-notes-bibliography`, which
 * is also what zotero.org redirects the old id to and what the desktop app renders by
 * default. So "chicago" keeps meaning what it always rendered as, and the full-notes
 * variant gets names of its own (#58).
 */
const ALIASES: Record<string, string> = {
  apa: 'apa',
  'apa 7th': 'apa',
  apa7: 'apa',
  'apa 6th': 'apa-6th-edition',
  ieee: 'ieee',
  vancouver: 'vancouver',
  chicago: 'chicago-shortened-notes-bibliography',
  'chicago note': 'chicago-shortened-notes-bibliography',
  'chicago shortened notes': 'chicago-shortened-notes-bibliography',
  'chicago notes': 'chicago-notes-bibliography',
  'chicago full note': 'chicago-notes-bibliography',
  'chicago author-date': 'chicago-author-date',
  mla: 'modern-language-association',
  'mla 9th': 'modern-language-association',
  nature: 'nature',
  science: 'science',
  harvard: 'harvard-cite-them-right',
  acm: 'association-for-computing-machinery',
  acs: 'american-chemical-society',
  ama: 'american-medical-association',
  apsa: 'american-political-science-association',
  cell: 'cell',
};

export const COMMON_STYLES = Object.keys(ALIASES);

const STYLE_BASE = 'https://raw.githubusercontent.com/citation-style-language/styles/master';
const LOCALE_BASE = 'https://raw.githubusercontent.com/citation-style-language/locales/master';

export interface StyleResolverOptions {
  fetchImpl?: typeof fetch;
  styleBase?: string;
  localeBase?: string;
}

/** Resolves human style names to CSL ids and fetches (and caches) CSL style + locale XML. */
export class StyleResolver {
  private styleCache = new Map<string, string>();
  private localeCache = new Map<string, string>();
  /** The repository's record of ids it has renamed, read once, on the first id it lacks. */
  private renamed: Promise<Record<string, string>> | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly styleBase: string;
  private readonly localeBase: string;

  constructor(opts: StyleResolverOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
    this.styleBase = opts.styleBase ?? STYLE_BASE;
    this.localeBase = opts.localeBase ?? LOCALE_BASE;
  }

  resolveId(name: string): string {
    const key = name.trim().toLowerCase();
    return ALIASES[key] ?? name.trim();
  }

  async fetchStyle(id: string, depth = 0): Promise<string> {
    if (this.styleCache.has(id)) return this.styleCache.get(id)!;
    const res = await this.fetchImpl(`${this.styleBase}/${id}.csl`);
    let xml: string;
    if (res.ok) {
      xml = await res.text();
    } else {
      // The repository renames styles and keeps a record of it (`renamed-styles.json`),
      // which zotero.org applies as a redirect and a raw file fetch does not. An id a user
      // copied from Zotero's own preferences, or one this table carried for years, must
      // not 404 over a rename it could not know about (#58).
      const successor = res.status === 404 && depth < 3 ? (await this.renames())[id] : undefined;
      if (!successor) throw new Error(`CSL style "${id}" not found (HTTP ${res.status}).`);
      xml = await this.fetchStyle(successor, depth + 1);
      this.styleCache.set(id, xml);
      return xml;
    }
    const parent = this.parentId(xml);
    if (parent && parent !== id && depth < 3) {
      xml = await this.fetchStyle(parent, depth + 1);
    }
    this.styleCache.set(id, xml);
    return xml;
  }

  private renames(): Promise<Record<string, string>> {
    this.renamed ??= (async () => {
      try {
        const res = await this.fetchImpl(`${this.styleBase}/renamed-styles.json`);
        if (!res.ok) return {};
        const json: unknown = await res.json();
        return json && typeof json === 'object' ? (json as Record<string, string>) : {};
      } catch {
        // No record is the same as an empty one: the original 404 stands.
        return {};
      }
    })();
    return this.renamed;
  }

  async fetchLocale(lang = 'en-US'): Promise<string> {
    if (this.localeCache.has(lang)) return this.localeCache.get(lang)!;
    const res = await this.fetchImpl(`${this.localeBase}/locales-${lang}.xml`);
    if (!res.ok) {
      if (lang !== 'en-US') return this.fetchLocale('en-US');
      throw new Error(`CSL locale "${lang}" not found (HTTP ${res.status}).`);
    }
    const xml = await res.text();
    this.localeCache.set(lang, xml);
    return xml;
  }

  private parentId(xml: string): string | null {
    const link = xml.match(/<link[^>]*rel="independent-parent"[^>]*>/);
    if (!link) return null;
    const href = link[0].match(/href="([^"]+)"/);
    if (!href) return null;
    const id = href[1]!.match(/styles\/([^/"]+)$/);
    return id ? id[1]! : null;
  }
}
