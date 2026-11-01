import { escapeHtml } from './markdown.js';
import type { StoredCitationItem } from './citations.js';

/**
 * The note editor's schema version, as Zotero 10.0.6 stamps a note it builds from
 * annotations. It raises it to 10 only when the note holds underline annotations ("Update
 * schema version only if using new features"), and a newer number than a client knows is
 * what makes that client open the note read-only, so nothing here claims more than it uses.
 */
export const NOTE_SCHEMA_VERSION = 9;

/** The schema version a note holding underline annotations needs (Zotero 10.0.6). */
export const UNDERLINE_SCHEMA_VERSION = 10;

/** `<div ... data-schema-version="N" ...>` at the start of a note: the editor's metadata container. */
const CONTAINER_OPEN = /^\s*<div\b([^>]*\bdata-schema-version="(\d+)"[^>]*)>/i;
const CITATION_ITEMS_ATTR = /\s*\bdata-citation-items="([^"]*)"/i;

/** A complete note: the body inside the metadata container, with the items it cites. */
export function wrapNote(
  body: string,
  citationItems: StoredCitationItem[] = [],
  schemaVersion: number = NOTE_SCHEMA_VERSION,
): string {
  const items = citationItems.length
    ? ` data-citation-items="${encodeURIComponent(JSON.stringify(citationItems))}"`
    : '';
  return `<div${items} data-schema-version="${schemaVersion}">${body}\n</div>`;
}

/** An `<h1>` for a note's title line; Zotero names a note after its first line. */
export function titleHtml(title: string): string {
  return `<h1>${escapeHtml(title.trim())}</h1>\n`;
}

function parseStored(encoded: string | undefined): StoredCitationItem[] {
  if (!encoded) return [];
  try {
    const parsed = JSON.parse(decodeURIComponent(encoded));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * `existing` with `body` added at the end, and the items `body` cites merged into the
 * container's `data-citation-items`.
 *
 * Everything already in the note stays byte for byte: its content, its other container
 * attributes, its schema version (raised, never lowered). A note written before the current
 * editor, with no container at all, is left as it was when nothing new is cited, and
 * wrapped in one only when there is citation metadata to carry, which is what the editor
 * itself does to such a note the first time it saves it.
 */
export function appendToNote(
  existing: string,
  body: string,
  citationItems: StoredCitationItem[] = [],
  schemaVersion: number = NOTE_SCHEMA_VERSION,
): string {
  const open = CONTAINER_OPEN.exec(existing);
  const closeAt = existing.lastIndexOf('</div>');
  if (open && closeAt > open.index + open[0].length && !existing.slice(closeAt + 6).trim()) {
    const attrs = open[1]!;
    const stored = parseStored(CITATION_ITEMS_ATTR.exec(attrs)?.[1]);
    for (const item of citationItems) {
      if (!stored.some((s) => s.uris?.some((u) => item.uris.includes(u)))) stored.push(item);
    }
    const version = Math.max(Number(open[2]) || 0, schemaVersion);
    let rest = attrs.replace(CITATION_ITEMS_ATTR, '').replace(/\bdata-schema-version="\d+"/i, `data-schema-version="${version}"`);
    if (!/^\s/.test(rest)) rest = ` ${rest}`;
    const items = stored.length ? ` data-citation-items="${encodeURIComponent(JSON.stringify(stored))}"` : '';
    const inner = existing.slice(open.index + open[0].length, closeAt).replace(/\s+$/, '');
    return `<div${items}${rest}>${inner}\n${body}\n</div>`;
  }
  const before = existing.replace(/\s+$/, '');
  if (!before) return wrapNote(body, citationItems, schemaVersion);
  if (!citationItems.length) return `${before}\n${body}`;
  return wrapNote(`${before}\n${body}`, citationItems, schemaVersion);
}
