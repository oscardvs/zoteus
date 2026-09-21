import { callMCPTool } from '../runtime.js';

/**
 * Search Zotero items : Search or list items in a Zotero library or collection. Quick search via `q` (`qmode`: titleCreatorYear=default, matches title/creator/year only; everything=also searches notes & attachment full text). For presence checks ("is X in my library?"): a default-mode `q` that matches nothing auto-retries once in `everything` mode, so terms appearing only inside PDF text don't false-negative : pin `qmode` explicitly to disable. An empty `everything` result is reported as strong-but-not-conclusive, since un-indexed/scanned/un-synced PDFs aren't full-text searchable. Also supports boolean `itemType` fi
 * Params: q, qmode, itemType, tag, collectionKey, top, since, includeTrashed, sort, direction, limit, start, response_format, library_type, library_id.
 */
export function searchItems(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_search_items', input);
}
