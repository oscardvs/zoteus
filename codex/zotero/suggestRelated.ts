import { callMCPTool } from '../runtime.js';

/**
 * Suggest Related links between library items that cite each other : Find pairs of items IN THE LIBRARY where one cites the other, as candidates for Zotero's "Related" links. Read-only: nothing is written; add the links you accept with zotero_relate_items. Citations come from OpenAlex reference lists, matched to library items by DOI, so an item with no DOI (in the DOI field or a "DOI:" line in Extra), or one OpenAlex does not know, cannot be paired, and the counts say how many that was. OpenAlex reference lists are incomplete for some publishers, so a missing pair is not proof that one paper does not cite the other. Scope: `item_keys`, a `collection_key` (pairs
 * Params: collection_key, item_keys, max_items, include_existing, library_type, library_id.
 */
export function suggestRelated(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_suggest_related', input);
}
