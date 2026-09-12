import type { ToolContext } from '../../registry/registry.js';
import type { LibraryRef } from '../../api/web-client.js';
import { looksLikeZip } from '../fulltext/epub.js';
import { DEFAULT_PRECISE_MAX_BYTES } from '../fulltext/pdf-pages.js';
import { loadAttachmentBytes, type AttachmentByteSource } from './bytes.js';

/**
 * From an item key to the file a reading tool should open.
 *
 * Every tool that reads a document (`zotero_get_fulltext` for its text, `zotero_pdf_images`
 * for its pages and figures) starts the same way: the caller names a parent item or an
 * attachment, the best readable attachment is picked, its bytes are fetched from whichever
 * source can produce them, and what those bytes actually are is decided from the bytes
 * themselves. This module holds that shared start so the tools cannot drift apart on which
 * attachment "the PDF" means.
 */

export interface ResolvedAttachment {
  attachmentKey: string;
  parentKey?: string;
  filename?: string;
  title?: string;
  /** Attachment file size in bytes, when known (used to skip oversized PDF re-extraction). */
  size?: number;
  /** The attachment's declared MIME type, when Zotero recorded one. */
  contentType?: string;
}

/** Best-effort attachment file size from Zotero item metadata (links.enclosure.length). */
function fileSize(raw: any): number | undefined {
  const len = raw?.links?.enclosure?.length ?? raw?.data?.links?.enclosure?.length;
  return typeof len === 'number' && len > 0 ? len : undefined;
}

/**
 * Rank an item's attachments for reading: a PDF first, then an EPUB, then whatever else is
 * there. Both formats can be read locally, so an item whose only attachment is an EPUB is
 * not a dead end for text (it is one for pages, and the tool that wants pages says so).
 */
function scoreForText(att: any): number {
  const type = att?.contentType ?? '';
  const name: string = att?.filename ?? '';
  if (type === 'application/pdf' || /\.pdf$/i.test(name)) return 3;
  if (type === 'application/epub+zip' || /\.epub$/i.test(name)) return 2;
  return 1;
}

/**
 * The attachment `itemKey` names, or the best child attachment of the parent it names.
 * Returns `{ error }` rather than throwing, since the tools all have a better sentence to
 * write than the router's.
 */
export async function resolveAttachment(
  ctx: ToolContext,
  itemKey: string,
  library: LibraryRef | undefined,
): Promise<ResolvedAttachment | { error: string }> {
  const item = await ctx.router.getItem(itemKey, { library });
  const d = item?.data ?? item ?? {};
  if (d.itemType === 'attachment') {
    return {
      attachmentKey: itemKey,
      parentKey: d.parentItem,
      filename: d.filename,
      title: d.title,
      size: fileSize(item),
      contentType: d.contentType,
    };
  }
  const children = await ctx.router.getItemChildren(itemKey, { library });
  const atts = (children.data ?? []).filter(
    (c: any) => (c.data?.itemType ?? c.itemType) === 'attachment',
  );
  const chosen = atts
    .slice()
    .sort((a: any, b: any) => scoreForText(b.data ?? b) - scoreForText(a.data ?? a))[0];
  if (!chosen)
    return { error: `Item ${itemKey} has no attachment with full text. Attach a PDF in Zotero.` };
  const cd = chosen.data ?? chosen;
  return {
    attachmentKey: chosen.key ?? cd.key,
    parentKey: itemKey,
    filename: cd.filename,
    title: d.title,
    size: fileSize(chosen),
    contentType: cd.contentType,
  };
}

/** What an attachment's bytes turned out to be, which decides how they are read. */
export type FileKind = 'pdf' | 'epub' | 'unknown';

/** Whether an ASCII marker appears in these bytes (a magic-number scan, no decoding). */
function findAscii(bytes: Uint8Array, marker: string): boolean {
  const needle = [...marker].map((c) => c.charCodeAt(0));
  outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * The attachment's format, from the bytes themselves first and its recorded metadata
 * second. Zotero's `contentType` is often right and sometimes absent (and an EPUB fetched
 * from the web arrives as `application/octet-stream` often enough to matter), so the magic
 * number decides and the metadata only breaks ties.
 */
export function detectKind(bytes: Uint8Array, contentType?: string, filename?: string): FileKind {
  // A PDF header is allowed a little junk in front of it, and real files do use that licence.
  if (findAscii(bytes.subarray(0, 1024), '%PDF-')) return 'pdf';
  if (looksLikeZip(bytes)) return 'epub';
  if (contentType === 'application/pdf' || /\.pdf$/i.test(filename ?? '')) return 'pdf';
  if (contentType === 'application/epub+zip' || /\.epub$/i.test(filename ?? '')) return 'epub';
  return 'unknown';
}

export interface FetchedAttachmentBytes {
  bytes?: Uint8Array;
  source?: AttachmentByteSource;
  tooLarge?: boolean;
  reasons: string[];
}

/**
 * Fetch the attachment's bytes for local reading, with the pre-read size guard applied.
 *
 * The guard is checked against the size Zotero recorded BEFORE any source is touched: a
 * transfer that only ends in a refusal is worth skipping, and on a small host parsing it
 * would be worse than skipping it (see DEFAULT_PRECISE_MAX_BYTES).
 */
export async function fetchAttachmentBytes(
  ctx: ToolContext,
  resolved: ResolvedAttachment,
  library: LibraryRef | undefined,
): Promise<FetchedAttachmentBytes> {
  if (resolved.size && resolved.size > DEFAULT_PRECISE_MAX_BYTES)
    return { tooLarge: true, reasons: [] };
  const loaded = await loadAttachmentBytes(ctx, {
    key: resolved.attachmentKey,
    library,
    filename: resolved.filename,
    maxBytes: DEFAULT_PRECISE_MAX_BYTES,
  });
  return {
    bytes: loaded.bytes,
    source: loaded.source,
    tooLarge: loaded.tooLarge,
    reasons: loaded.reasons,
  };
}

/** How the bytes were reached, in words, for the notice the caller reads. */
export const SOURCE_LABEL: Record<AttachmentByteSource, string> = {
  'local-api': 'the running Zotero desktop app',
  storage: "Zotero's local storage folder",
  cloud: 'Zotero cloud storage',
};
