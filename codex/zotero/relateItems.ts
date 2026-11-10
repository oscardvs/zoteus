import { callMCPTool } from '../runtime.js';

/**
 * Link items as Related : Link pairs of library items as "Related", the link Zotero shows in an item's Related pane, on BOTH items of each pair, as Zotero itself does. Additive only: every relation an item already has (other Related links, merge records, any other predicate) is kept, and a pair already linked is reported as such and not written again. Both items must be in the same library. Every item is read before anything is written, so an unknown key refuses the whole call. Get candidates from zotero_suggest_related (pairs that cite each other), or pass any pairs you choose. To remove a link, edit `relations` with
 * Params: pairs, library_type, library_id.
 */
export function relateItems(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_relate_items', input);
}
