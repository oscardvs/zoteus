import { callMCPTool } from '../runtime.js';

/**
 * Manage Zotero collections : List, create, rename, reparent, or delete collections, and move items into or out of a collection. Set `action` to one of: "list" (collections with key/name/parent, sorted by name; `q` filters by name over the whole library, `start`/`limit` page, `totalResults` counts them all), "create" (needs `name`, optional `parent_collection` key; omit it for top-level), "rename" (needs `collection_key` + `name`), "reparent" (needs `collection_key`; `parent_collection` key, or omit to move to top level), "delete" (needs `collection_key`), "add_items" / "remove_items" (need `collection_key` + `item_keys`;
 * Params: action, name, collection_key, parent_collection, item_keys, confirm, q, start, limit, library_type, library_id.
 */
export function manageCollections(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_manage_collections', input);
}
