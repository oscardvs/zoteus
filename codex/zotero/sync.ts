import { callMCPTool } from '../runtime.js';

/**
 * Incremental sync delta : Return what changed in a library since a given version, for efficient incremental sync. Provide `since` (a library version; 0 = everything). Returns, per object type (items/collections/searches/tags), the map of keys→version that changed after `since`, plus the deletion log (keys removed since `since`). This is the version-based delta the Zotero sync algorithm uses: fetch the changed keys, then pull only those with zotero_get_item/zotero_search_items. Follows the library route: a running Zotero desktop app serves the delta for any library it holds, with no cloud API key, and otherwise the clou
 * Params: since, types, include_deleted, library_type, library_id.
 */
export function sync(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_sync', input);
}
