import type { LibraryRef } from '../../api/web-client.js';
import type { ToolContext } from '../../registry/registry.js';
import { doiKey } from '../resolve/library-census.js';

/**
 * The two library-side questions that come before any open-access lookup: what DOI is this
 * item, and does it already have the PDF? Both are asked before a single byte moves, because
 * the cheapest download is the one that never happens and the worst outcome is a second copy
 * of a file the user already has.
 */

/**
 * The DOI recorded on an item: the DOI field, or the `DOI: 10.…` line in Extra.
 *
 * Zotero has no DOI field for bookSection, report, thesis or manuscript, and the long-
 * standing convention for those is a line in Extra. Nothing else in Zoteus reads it, so
 * those items looked like items with no DOI at all while the DOI sat in the record.
 */
export function itemDoi(item: any): string | undefined {
  const d = item?.data ?? item ?? {};
  const field = doiKey(d.DOI ?? d.doi);
  if (field) return field;
  const extra = typeof d.extra === 'string' ? d.extra : typeof d.Extra === 'string' ? d.Extra : '';
  const line = extra.match(/^[ \t]*DOI[ \t]*:[ \t]*(\S+)[ \t]*$/im);
  return line ? doiKey(line[1]) : undefined;
}

/** Find an existing PDF across all child pages before creating another attachment. */
export async function existingPdfAttachment(
  ctx: ToolContext,
  parentKey: string,
  library: LibraryRef | undefined,
): Promise<string | undefined> {
  const seen = new Set<string>();
  const limit = 100;
  let start = 0;
  let version: number | undefined;
  for (;;) {
    const page = await ctx.router.getItemChildren(parentKey, { library, start, limit });
    if (version !== undefined && page.lastModifiedVersion !== version) {
      throw new Error('The library changed while checking existing PDFs; retry before attaching another copy.');
    }
    version = page.lastModifiedVersion;
    for (const item of page.data) {
      const data = item?.data ?? item;
      const key = item?.key ?? data?.key;
      if (!key || seen.has(key)) throw new Error('The attachment listing could not be verified complete; retry before attaching another copy.');
      seen.add(key);
      if (data.itemType === 'attachment' &&
          (data.contentType === 'application/pdf' || /\.pdf$/i.test(data.filename ?? ''))) return key;
    }
    start += page.data.length;
    const more = page.totalResults > start;
    if (!page.data.length) {
      if (more) throw new Error('The attachment listing ended before all reported children were read; retry before attaching another copy.');
      return undefined;
    }
    if (!more && page.data.length < limit) return undefined;
  }
}
