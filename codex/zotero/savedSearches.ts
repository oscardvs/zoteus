import { callMCPTool } from '../runtime.js';

/**
 * Manage Zotero saved searches : List, create, or delete saved-search DEFINITIONS. NOTE: the Zotero cloud Web API stores saved searches but does NOT execute them : to get the items a saved search matches, run an equivalent zotero_search_items query (or use the desktop local API when available). Set `action` to "list" (all saved searches with their conditions), "create" (needs `name` and `conditions`, each `{condition, operator, value}`), or "delete" (needs `search_key`). Writes go to the cloud Web API.
 * Params: action, name, conditions, search_key, library_type, library_id.
 */
export function savedSearches(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_saved_searches', input);
}
