import { callMCPTool } from '../runtime.js';

/**
 * Update a Zotero item : Partially update one item (HTTP PATCH : only the fields you supply change; omitted fields are preserved). Provide `item_key` and a `patch` object of the fields to change (e.g. {"title":"New","extra":"note"} or {"tags":[{"tag":"reviewed"}]}). All field values are plain JSON strings/numbers/booleans/arrays : never wrapped in nested objects (e.g. `"title": "New"`, NOT `"title": {"title": "New"}`). Optimistic concurrency is handled for you: if you pass the item's `version` it is used; otherwise the current version is fetched first. If the item changed on the server in the meantime (412), the updat
 * Params: item_key, patch, version, dry_run, library_type, library_id.
 */
export function updateItem(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_update_item', input);
}
