import { callMCPTool } from '../runtime.js';

/**
 * Trash or restore Zotero items : Move items to the trash (the safe, REVERSIBLE default) or restore them. This sets the `deleted` flag (1=trash, 0=restore) : it is NOT a permanent delete, so trashed items can be recovered here or in the Zotero app. Use this instead of zotero_delete_items unless you truly need irreversible removal. Provide `item_keys` and optional `action` (default "trash"). Writes go to the running Zotero desktop app for your personal library (via its local-API writes where available), otherwise to the cloud Web API. When the server sets a bulk-write threshold (ZOTEUS_CONFIRM_BULK_WRITES, off by default), tras
 * Params: item_keys, action, confirm, library_type, library_id.
 */
export function trashItems(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_trash_items', input);
}
