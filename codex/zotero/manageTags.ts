import { callMCPTool } from '../runtime.js';

/**
 * Manage Zotero tags : List tags, or add/remove tags on items. Set `action` to "list" (returns library tags; supports `q` substring filter), "add" (add `tags` to each of `item_keys`), or "remove" (remove `tags` from each of `item_keys`). Tags are stored on the parent item's tag array, so add/remove edits the items (cloud Web API). Tag names are case-sensitive. When the server sets a bulk-write threshold (ZOTEUS_CONFIRM_BULK_WRITES, off by default), editing more items than that in one call also needs `confirm: true`.
 * Params: action, tags, item_keys, q, confirm, limit, library_type, library_id.
 */
export function manageTags(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_manage_tags', input);
}
