import { callMCPTool } from '../runtime.js';

/**
 * List Zotero collections (read-only) : List collections in a Zotero library (key, name, parent collection key, item count). Read-only : available even in read-only mode (unlike zotero_manage_collections, which also writes). Use the keys to scope zotero_search_items (collectionKey) or zotero_tag_audit (scope.collection_keys).
 * Params: top, library_type, library_id.
 */
export function listCollections(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_list_collections', input);
}
