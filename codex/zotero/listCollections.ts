import { callMCPTool } from '../runtime.js';

/**
 * List Zotero collections (read-only) : List collections in a Zotero library (key, name, parent collection key, item count), sorted by name. Read-only: available even in read-only mode (unlike zotero_manage_collections, which also writes). Every collection in the library is read, then `q` filters by name and `start`/`limit` page the result; `totalResults` says how many there are, so a large library is never mistaken for its first page. Use the keys to scope zotero_search_items (collectionKey) or zotero_tag_audit (scope.collection_keys).
 * Params: top, q, start, limit, library_type, library_id.
 */
export function listCollections(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_list_collections', input);
}
