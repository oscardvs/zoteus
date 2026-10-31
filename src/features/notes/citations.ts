import type { LibraryRef } from '../../api/web-client.js';
import type { ToolContext } from '../../registry/registry.js';
import { SNAPSHOT_TYPES } from '../import/csl-tables.js';
import { escapeHtml, type CitationRef } from './markdown.js';

/**
 * Zotero note citations, in the exact shape the note editor writes them (Zotero 10.0.6,
 * `EditorInstanceUtilities.serializeAnnotations` and `formatCitation`):
 *
 *   <span class="citation" data-citation="<URI-encoded JSON>">(<span class="citation-item">Smith, 2019, p. 4</span>)</span>
 *
 * where the JSON is `{"citationItems":[{"uris":[...],"locator":"4"}],"properties":{}}`, and
 * the note's wrapper div carries `data-citation-items`: each cited item's URI and CSL-JSON,
 * which is what a note still renders and exports from when the item is not in the library
 * it is opened in. A citation written this way is one Zotero treats as its own: clicking it
 * opens the item (or the PDF at the locator), and "Add Note to Word" turns it into a live
 * field.
 */

/** One library item a note cites, resolved. */
export interface CitedItem {
  key: string;
  uri: string;
  itemData: Record<string, unknown>;
}

/** An entry of the wrapper's `data-citation-items`. */
export interface StoredCitationItem {
  uris: string[];
  itemData: Record<string, unknown>;
}

/**
 * The URI Zotero names an item by in notes: `http://zotero.org/users/<id>/items/<key>` or
 * `http://zotero.org/groups/<id>/items/<key>`.
 *
 * For the personal library Zotero resolves any `users/...` URI to the personal library,
 * whatever the id in it (`Zotero.URI._getURIObjectLibrary`, "Handles local and synced
 * libraries"), so the account id matters only for reading the note somewhere else, such as
 * zotero.org. It is taken from the item record when Zotero reports one, and from the cloud
 * key otherwise; an unsynced desktop library reports 0, which the desktop still resolves.
 */
export function itemUri(lib: LibraryRef, key: string, userId?: number): string {
  if (lib.type === 'group') return `http://zotero.org/groups/${lib.id}/items/${key}`;
  return `http://zotero.org/users/${userId || lib.id || 0}/items/${key}`;
}

/** The account id for personal-library URIs, from an item record or the cloud key. */
export function userIdFor(ctx: Pick<ToolContext, 'capabilities'>, item?: any): number | undefined {
  const fromItem = item?.library?.type === 'user' ? Number(item.library.id) : NaN;
  if (Number.isFinite(fromItem) && fromItem > 0) return fromItem;
  return ctx.capabilities.cloud?.userID || undefined;
}

/** Zotero item type to CSL type, from the frozen copy of Zotero's own CSL mapping. */
const CSL_TYPE_OF = new Map<string, string>(
  Object.entries(SNAPSHOT_TYPES).flatMap(([csl, zoteroTypes]) => zoteroTypes.map((z) => [z, csl] as [string, string])),
);

/** `item.csljson` in whichever shape the API that answered sends it. */
function includedCsl(item: any): Record<string, unknown> | null {
  let csl = item?.csljson;
  if (typeof csl === 'string') {
    try {
      csl = JSON.parse(csl);
    } catch {
      return null;
    }
  }
  // The desktop exports a bare array, the cloud a `{ items: [...] }` wrapper or the object itself.
  if (Array.isArray(csl)) csl = csl[0];
  else if (csl && Array.isArray(csl.items)) csl = csl.items[0];
  return csl && typeof csl === 'object' ? (csl as Record<string, unknown>) : null;
}

/**
 * The item's CSL-JSON: Zotero's own (`include=csljson`) when the read carried it, otherwise
 * the handful of variables a citation preview and a bibliography entry are made of.
 */
export function cslItemData(item: any, uri: string): Record<string, unknown> {
  const own = includedCsl(item);
  if (own) return own;
  const d = item?.data ?? item ?? {};
  const out: Record<string, unknown> = { id: uri, type: CSL_TYPE_OF.get(d.itemType) ?? 'document' };
  if (d.title) out.title = d.title;
  const names = (role: string) =>
    (d.creators ?? [])
      .filter((c: any) => (c?.creatorType ?? 'author') === role)
      .map((c: any) => (c.name ? { literal: c.name } : { family: c.lastName ?? '', given: c.firstName ?? '' }));
  const authors = names('author');
  if (authors.length) out.author = authors;
  const editors = names('editor');
  if (editors.length) out.editor = editors;
  const year = /\b(\d{4})\b/.exec(String(d.date ?? ''))?.[1];
  if (year) out.issued = { 'date-parts': [[Number(year)]] };
  const container = d.publicationTitle ?? d.bookTitle ?? d.proceedingsTitle;
  if (container) out['container-title'] = container;
  if (d.DOI) out.DOI = d.DOI;
  if (d.URL) out.URL = d.URL;
  return out;
}

/**
 * Zotero's "romanesque" script test, which decides whether a prefix or suffix is joined to
 * the citation with a space. The zero-width (non-)joiners and the left-to-right mark are
 * alternatives outside the class: the same characters, without a joiner inside a class.
 */
const ROMANESQUE =
  '[a-zA-Z\\u0e01-\\u0e5b\\u00c0-\\u017f\\u0370-\\u03ff\\u0400-\\u052f\\u0590-\\u05d4\\u05d6-\\u05ff\\u1f00-\\u1fff\\u0600-\\u06ff\\u0218-\\u021b\\u202a-\\u202e]|\\u200c|\\u200d|\\u200e';
const STARTS_ROMANESQUE = new RegExp(`^(?:&|${ROMANESQUE})`);
const ENDS_ROMANESQUE = new RegExp(`(?:[.;:&]|${ROMANESQUE})$`);

/**
 * The text Zotero shows for one cited item, "Smith, 2019, p. 4": a port of the note
 * editor's `_formatCitationItemPreview`, so a note written here reads the same as one the
 * editor wrote, before and after Zotero refreshes it.
 */
export function citationPreview(itemData: Record<string, unknown>, ref: Omit<CitationRef, 'key'> = {}): string {
  const family = (a: any): string => a?.family || a?.literal || '';
  const authors = Array.isArray(itemData.author) ? (itemData.author as unknown[]) : [];
  let str = '';
  if (authors.length === 1) str = family(authors[0]);
  else if (authors.length === 2) str = `${family(authors[0])} and ${family(authors[1])}`;
  else if (authors.length >= 3) str = `${family(authors[0])} et al.`;
  if (!str && itemData.title) str = `\u201c${itemData.title}\u201d`;
  const year = (itemData.issued as any)?.['date-parts']?.[0]?.[0];
  if (year && year != '0000') str += `, ${year}`;
  if (ref.locator) {
    const label = ref.label ?? (/[-\u2013,]/.test(ref.locator) ? 'pp.' : 'p.');
    str += `, ${label} ${ref.locator}`;
  }
  if (ref.prefix) str = ref.prefix + (ENDS_ROMANESQUE.test(ref.prefix) ? ' ' : '') + str;
  if (ref.suffix) str += (STARTS_ROMANESQUE.test(ref.suffix) ? ' ' : '') + ref.suffix;
  return str;
}

/** One `<span class="citation">` for a bracketed group, every key of which is in `cited`. */
export function citationHtml(refs: CitationRef[], cited: Map<string, CitedItem>): string {
  const citationItems = refs.map((ref) => {
    const { key: _key, ...rest } = ref;
    return { uris: [cited.get(ref.key)!.uri], ...rest };
  });
  const formatted = refs
    .map((ref) => {
      const { key, ...rest } = ref;
      return `<span class="citation-item">${escapeHtml(citationPreview(cited.get(key)!.itemData, rest))}</span>`;
    })
    .join('; ');
  const data = encodeURIComponent(JSON.stringify({ citationItems, properties: {} }));
  return `<span class="citation" data-citation="${data}">(${formatted})</span>`;
}

/** The wrapper's `data-citation-items` for these items, one entry per URI. */
export function storedCitationItems(items: Iterable<CitedItem>): StoredCitationItem[] {
  const out: StoredCitationItem[] = [];
  for (const item of items) {
    if (!out.some((o) => o.uris.includes(item.uri))) out.push({ uris: [item.uri], itemData: item.itemData });
  }
  return out;
}

/** Item types a note cannot cite: they are not works, and have no CSL record of their own. */
const NOT_CITABLE = new Set(['note', 'attachment', 'annotation']);

const isNotFound = (e: unknown): boolean => (e as { status?: number } | null)?.status === 404;

/**
 * Resolve the item keys a note cites, reading each from `lib` with its CSL-JSON.
 *
 * A key that names nothing, or names a note, attachment or annotation, is a problem the
 * caller must fix before anything is written: a citation that points nowhere renders as
 * "(MISSING CITATION)" the moment the note is exported, which is the kind of failure nobody
 * notices until it is in a manuscript.
 */
export async function resolveCitations(
  ctx: ToolContext,
  lib: LibraryRef,
  keys: string[],
): Promise<{ cited: Map<string, CitedItem>; problems: string[] }> {
  const cited = new Map<string, CitedItem>();
  const problems: string[] = [];
  const where = lib.type === 'group' ? `group library ${lib.id}` : 'this library';
  for (const key of keys) {
    let item: any;
    try {
      item = await ctx.router.getItem(key, { library: lib, include: 'data,csljson' });
    } catch (e) {
      if (!isNotFound(e)) throw e;
      item = null;
    }
    const data = item?.data ?? item;
    if (!data?.itemType) {
      problems.push(`[@${key}] does not name an item in ${where}. Find the key with zotero_search_items.`);
      continue;
    }
    if (NOT_CITABLE.has(data.itemType)) {
      const parent = data.parentItem ? ` Cite its parent item, ${data.parentItem}, instead.` : '';
      problems.push(`[@${key}] is ${data.itemType === 'attachment' ? 'an' : 'a'} ${data.itemType}, not a citable work.${parent}`);
      continue;
    }
    const uri = itemUri(lib, key, userIdFor(ctx, item));
    cited.set(key, { key, uri, itemData: cslItemData(item, uri) });
  }
  return { cited, problems };
}
