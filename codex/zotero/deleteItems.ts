import { callMCPTool } from '../runtime.js';

/**
 * Permanently delete Zotero items : PERMANENTLY and IRREVERSIBLY delete items by key (this purges them : it is NOT the trash). Prefer zotero_trash_items, which is reversible. This tool is disabled unless the server is started with ZOTEUS_ALLOW_DELETE=true, and additionally requires `confirm: true` on every call. For the personal library it goes through the running Zotero desktop app when that app supports local-API writes, otherwise the cloud Web API. The current library version is used as a precondition; the operation auto-chunks to 50 keys per request.
 * Params: item_keys, confirm, library_type, library_id.
 */
export function deleteItems(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_delete_items', input);
}
