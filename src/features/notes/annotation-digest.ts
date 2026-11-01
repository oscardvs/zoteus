import type { LibraryRef } from '../../api/web-client.js';
import type { ToolContext } from '../../registry/registry.js';
import { scorePdf } from '../../tools/annotate.js';
import { escapeHtml } from './markdown.js';
import { citationHtml, citationPreview, cslItemData, itemUri, userIdFor, type CitedItem, type StoredCitationItem, storedCitationItems } from './citations.js';
import { NOTE_SCHEMA_VERSION, UNDERLINE_SCHEMA_VERSION, wrapNote } from './note-html.js';

/**
 * The reader's annotations, gathered per paper: the read behind zotero_annotation_digest and
 * the note zotero_save_annotation_digest writes from it.
 *
 * An annotation hangs off the ATTACHMENT it was drawn on, never off the paper, so a paper's
 * annotations are its annotatable attachments' annotation children, read the way
 * zotero_annotate reads them back (`/children` with `itemType=annotation`; the local API
 * ignores a `parentItem` filter on `/items` and would answer with the whole library). Reads
 * are routed like every other read: the desktop app when it serves the library, the cloud
 * otherwise.
 */

/** Zotero's annotation palette (the reader's eight colours), by the name the reader shows. */
export const ANNOTATION_COLORS: Record<string, string> = {
  '#ffd400': 'yellow',
  '#ff6666': 'red',
  '#5fb236': 'green',
  '#2ea8e5': 'blue',
  '#a28ae5': 'purple',
  '#e56eee': 'magenta',
  '#f19837': 'orange',
  '#aaaaaa': 'gray',
};

const COLOR_BY_NAME = new Map(Object.entries(ANNOTATION_COLORS).map(([hex, name]) => [name, hex]));
COLOR_BY_NAME.set('grey', '#aaaaaa');

/** A colour as a caller may name it ("yellow", "#FFD400", "ffd400"), as Zotero stores it. */
export function normalizeColor(color: string): string {
  const c = color.trim().toLowerCase();
  if (COLOR_BY_NAME.has(c)) return COLOR_BY_NAME.get(c)!;
  return c.startsWith('#') ? c : `#${c}`;
}

/** Attachment types Zotero's reader annotates: PDFs, EPUBs and HTML snapshots. */
const ANNOTATABLE = new Set(['application/pdf', 'application/epub+zip', 'text/html']);

function isAnnotatable(att: any): boolean {
  return att?.itemType === 'attachment' && ANNOTATABLE.has(att.contentType) && att.linkMode !== 'linked_url';
}

export interface DigestFilters {
  types?: string[];
  colors?: string[];
  tags?: string[];
}

export interface DigestAnnotation {
  key: string;
  type: string;
  color?: string;
  colorName?: string;
  pageLabel?: string;
  text?: string;
  comment?: string;
  tags: string[];
  attachment: string;
  dateModified?: string;
}

/** One annotated paper (or standalone attachment), with what the note needs to cite it. */
export interface DigestItem {
  key: string;
  itemType: string;
  title: string;
  /** "Smith, 2019": Zotero's own citation preview for the item. */
  citation: string;
  attachments: Array<{ key: string; title?: string; annotations: number }>;
  annotations: DigestAnnotation[];
  /** For the note: the parent item URI and CSL-JSON, absent for a standalone attachment. */
  cited?: CitedItem;
  /** For the note: the account id personal-library URIs carry (see `itemUri`). */
  userId?: number;
  /** For the note: `annotationPosition` by annotation key, parsed. */
  positions: Map<string, unknown>;
  /** For the note: the collections a standalone attachment is filed in. */
  collections: string[];
}

/** Both APIs serve a hundred children per page. */
const PAGE = 100;
/** Ceiling on pages walked for one parent, so a pathological attachment cannot page forever. */
const MAX_PAGES = 50;

async function allChildren(
  ctx: ToolContext,
  lib: LibraryRef,
  parentKey: string,
  itemType?: string,
): Promise<any[]> {
  const out: any[] = [];
  let start = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await ctx.router.getItemChildren(parentKey, {
      library: lib,
      limit: PAGE,
      start,
      ...(itemType ? { itemType } : {}),
    });
    const batch = res.data ?? [];
    out.push(...batch);
    start += batch.length;
    if (batch.length < PAGE || (res.totalResults && start >= res.totalResults)) break;
  }
  return out;
}

function matches(a: any, filters: DigestFilters): boolean {
  if (filters.types?.length && !filters.types.map((t) => t.toLowerCase()).includes(String(a.annotationType).toLowerCase())) return false;
  if (filters.colors?.length) {
    const wanted = filters.colors.map(normalizeColor);
    if (!wanted.includes(String(a.annotationColor ?? '').toLowerCase())) return false;
  }
  if (filters.tags?.length) {
    const own = (a.tags ?? []).map((t: any) => String(t?.tag ?? t).toLowerCase());
    if (!filters.tags.some((t) => own.includes(t.toLowerCase()))) return false;
  }
  return true;
}

function parsePosition(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * The annotations of one item record (as read, `{ key, data, library, ... }`), filtered.
 * A regular item is read through its annotatable attachments; a standalone attachment is
 * its own. Notes and annotations have none, and come back as null.
 */
export async function digestOf(
  ctx: ToolContext,
  lib: LibraryRef,
  record: any,
  filters: DigestFilters = {},
): Promise<DigestItem | null> {
  const data = record?.data ?? record;
  const key: string = record?.key ?? data?.key;
  if (!data?.itemType || data.itemType === 'note' || data.itemType === 'annotation') return null;

  const standalone = data.itemType === 'attachment';
  const attachments = standalone
    ? isAnnotatable(data)
      ? [data]
      : []
    : (await allChildren(ctx, lib, key))
        .map((c) => c?.data ?? c)
        .filter(isAnnotatable)
        .sort((a, b) => scorePdf(b) - scorePdf(a) || String(a.title ?? '').localeCompare(String(b.title ?? '')));

  const userId = userIdFor(ctx, record);
  const uri = itemUri(lib, key, userId);
  const cited: CitedItem | undefined = standalone ? undefined : { key, uri, itemData: cslItemData(record, uri) };

  const item: DigestItem = {
    key,
    itemType: data.itemType,
    title: String(data.title || data.filename || key),
    citation: cited ? citationPreview(cited.itemData) : String(data.title || data.filename || key),
    attachments: [],
    annotations: [],
    ...(cited ? { cited } : {}),
    ...(userId ? { userId } : {}),
    positions: new Map(),
    collections: standalone ? (data.collections ?? []) : [],
  };

  for (const att of attachments) {
    const found = (await allChildren(ctx, lib, att.key, 'annotation'))
      .map((c) => c?.data ?? c)
      .filter((a) => a?.itemType === 'annotation' && matches(a, filters))
      .sort((a, b) => String(a.annotationSortIndex ?? '').localeCompare(String(b.annotationSortIndex ?? '')));
    if (!found.length) continue;
    item.attachments.push({ key: att.key, ...(att.title ? { title: att.title } : {}), annotations: found.length });
    for (const a of found) {
      const color = a.annotationColor ? String(a.annotationColor).toLowerCase() : undefined;
      const out: DigestAnnotation = {
        key: a.key,
        type: a.annotationType,
        tags: (a.tags ?? []).map((t: any) => String(t?.tag ?? t)),
        attachment: att.key,
      };
      if (color) out.color = color;
      if (color && ANNOTATION_COLORS[color]) out.colorName = ANNOTATION_COLORS[color];
      if (a.annotationPageLabel) out.pageLabel = String(a.annotationPageLabel);
      if (a.annotationText) out.text = String(a.annotationText);
      if (a.annotationComment) out.comment = String(a.annotationComment);
      if (a.dateModified) out.dateModified = String(a.dateModified);
      item.annotations.push(out);
      item.positions.set(a.key, parsePosition(a.annotationPosition));
    }
  }
  return item;
}

/** What a digest covers: one item, or the top-level items of one collection. */
export interface DigestScope {
  itemKey?: string;
  collectionKey?: string;
}

export interface CollectedDigest {
  /** Items with at least one matching annotation, in the order they were read. */
  items: DigestItem[];
  /** Items looked at on this page (a collection's notes count, and have no annotations). */
  scanned: number;
  /** Top-level items in the collection, when the API reported it. */
  totalItems?: number;
  /** Where the next page starts, when the collection has more. */
  nextStart?: number;
  collectionName?: string;
}

const isNotFound = (e: unknown): boolean => (e as { status?: number } | null)?.status === 404;

/**
 * Read a digest's scope: the one item, or `limit` top-level items of the collection from
 * `start` on, sorted by title. `csl` asks for each item's CSL-JSON too, which only the note
 * needs. Returns why it cannot instead, for a key that names nothing or a note.
 */
export async function collectDigest(
  ctx: ToolContext,
  lib: LibraryRef,
  scope: DigestScope,
  filters: DigestFilters,
  page: { start: number; limit: number },
  opts: { csl?: boolean } = {},
): Promise<CollectedDigest | { problem: string }> {
  const include = opts.csl ? 'data,csljson' : undefined;
  const where = lib.type === 'group' ? `group library ${lib.id}` : 'this library';
  if (scope.itemKey) {
    let record: any;
    try {
      record = await ctx.router.getItem(scope.itemKey, { library: lib, ...(include ? { include } : {}) });
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    const type = (record?.data ?? record)?.itemType;
    if (!type) return { problem: `No item ${scope.itemKey} in ${where}. Check the key with zotero_search_items.` };
    if (type === 'note' || type === 'annotation') {
      return {
        problem: `${scope.itemKey} is ${type === 'note' ? 'a note' : 'an annotation'}; annotations hang off a paper's PDF, EPUB or snapshot. Pass the paper's key (or the attachment's).`,
      };
    }
    const item = await digestOf(ctx, lib, record, filters);
    return { items: item?.annotations.length ? [item] : [], scanned: 1 };
  }

  const collectionKey = scope.collectionKey!;
  const collection = await ctx.router.getCollection(collectionKey, { library: lib });
  if (!collection) {
    return { problem: `No collection ${collectionKey} in ${where}. Call zotero_list_collections and use the \`key\` it returns.` };
  }
  const res = await ctx.router.searchItems({
    library: lib,
    collectionKey,
    top: true,
    sort: 'title',
    direction: 'asc',
    start: page.start,
    limit: page.limit,
    ...(include ? { include } : {}),
  });
  const records = res.data ?? [];
  const items: DigestItem[] = [];
  for (const record of records) {
    const item = await digestOf(ctx, lib, record, filters);
    if (item?.annotations.length) items.push(item);
  }
  const next = page.start + records.length;
  const out: CollectedDigest = {
    items,
    scanned: records.length,
    collectionName: String(collection?.data?.name ?? collection?.name ?? collectionKey),
  };
  if (res.totalResults) out.totalItems = res.totalResults;
  if (records.length === page.limit && (!res.totalResults || next < res.totalResults)) out.nextStart = next;
  return out;
}

/** The JSON a caller sees for one item: everything but what only the note needs. */
export function digestItemJson(item: DigestItem): Record<string, unknown> {
  return {
    key: item.key,
    itemType: item.itemType,
    title: item.title,
    citation: item.citation,
    attachments: item.attachments,
    annotations: item.annotations,
  };
}

// ---------------------------------------------------------------------------------------
// The note

/**
 * Annotation text or a comment as note HTML: escaped, with the four formats the reader's
 * own editor writes into them (bold, italic, sub- and superscript) let back through, as
 * Zotero's `_transformTextToHTML` does, and line breaks kept.
 */
function annotationTextHtml(text: string): string {
  return escapeHtml(text.trim())
    .replace(/&lt;(\/?)(b|i|sub|sup)&gt;/gi, '<$1$2>')
    .replace(/\n/g, '<br>');
}

/** `data-annotation` for one annotation: what lets Zotero open the PDF at it from the note. */
function storedAnnotation(lib: LibraryRef, item: DigestItem, a: DigestAnnotation): string {
  const stored: Record<string, unknown> = {
    attachmentURI: itemUri(lib, a.attachment, item.userId),
    annotationKey: a.key,
    color: a.color,
    pageLabel: a.pageLabel,
    position: item.positions.get(a.key),
  };
  if (item.cited) {
    stored.citationItem = { uris: [item.cited.uri], ...(a.pageLabel ? { locator: a.pageLabel } : {}) };
  }
  return encodeURIComponent(JSON.stringify(stored));
}

/**
 * One annotation as Zotero's default note templates render it (Zotero 10.0.6 prefs
 * `annotations.noteTemplates.highlight` and `.note`):
 *
 *   highlight, underline   <p>{{highlight}} {{citation}} {{comment}}</p>
 *   note, text             <p>{{citation}} {{comment}}</p>
 *   image, ink             <p>{{image}}<br/>{{citation}} {{comment}}</p>
 *
 * The image itself is not embedded: that needs the rendered region, which only the reader
 * has, so the paragraph says which kind of annotation it was. Tags, which the default
 * templates leave out, close the paragraph, because the digest promises them.
 */
function annotationHtml(lib: LibraryRef, item: DigestItem, a: DigestAnnotation): string {
  const citation = item.cited
    ? citationHtml([{ key: item.cited.key, ...(a.pageLabel ? { locator: a.pageLabel } : {}) }], new Map([[item.cited.key, item.cited]]))
    : '';
  const comment = a.comment ? annotationTextHtml(a.comment) : '';
  const tags = a.tags.length ? `<br>Tags: ${escapeHtml(a.tags.join(', '))}` : '';
  let html: string;
  if ((a.type === 'highlight' || a.type === 'underline') && a.text) {
    const highlight = `<span class="${a.type}" data-annotation="${storedAnnotation(lib, item, a)}">\u201c${annotationTextHtml(a.text)}\u201d</span>`;
    html = `<p>${highlight} ${citation} ${comment}${tags}</p>`;
  } else if (a.type === 'image' || a.type === 'ink') {
    html = `<p>[${a.type} annotation${a.pageLabel ? `, page ${escapeHtml(a.pageLabel)}` : ''}]<br/>${citation} ${comment}${tags}</p>`;
  } else {
    html = `<p>${citation} ${comment}${tags}</p>`;
  }
  // The template engine's own clean-up: no space before the paragraph closes, none doubled.
  return html.replace(/\s*(<\/p)/g, '$1').replace(/\s\s+/g, ' ');
}

/**
 * The digest as a Zotero note, laid out the way "Add Note from Annotations" lays one out:
 * a title, an `<h2>` per paper when there is more than one, an `<h3>` per attachment when a
 * paper has several (or the attachment is standalone), and one paragraph per annotation
 * whose highlight opens the PDF at that spot and whose citation opens the paper.
 */
export function digestNoteHtml(lib: LibraryRef, items: DigestItem[], title: string, footnote?: string): string {
  const parts: string[] = [`<h1>${escapeHtml(title)}</h1>`];
  const several = items.length > 1;
  const cited: CitedItem[] = [];
  let underline = false;
  for (const item of items) {
    if (item.cited) cited.push(item.cited);
    if (several) parts.push(`<h2>${escapeHtml(item.title)}</h2>`);
    const byAttachment = item.attachments.length > 1 || !item.cited;
    for (const att of item.attachments) {
      if (byAttachment) parts.push(`<h3>${escapeHtml(att.title ?? att.key)}</h3>`);
      for (const a of item.annotations.filter((x) => x.attachment === att.key)) {
        if (a.type === 'underline') underline = true;
        parts.push(annotationHtml(lib, item, a));
      }
    }
  }
  if (footnote) parts.push(`<p><em>${escapeHtml(footnote)}</em></p>`);
  const stored: StoredCitationItem[] = storedCitationItems(cited);
  return wrapNote(parts.join('\n'), stored, underline ? UNDERLINE_SCHEMA_VERSION : NOTE_SCHEMA_VERSION);
}
