import { callMCPTool } from '../runtime.js';

/**
 * Zotero data model (types & fields) : Return the Zotero data model so you never hardcode item shapes. With no arguments, returns the schema version and the list of all item type names. With `item_type`, returns the valid fields and creator types for that type (the "primary" creator type is listed first). Use this to validate an item before creating or updating it: notes, attachments, and annotations are item types too but bypass the normal field/creator model.
 * Params: item_type.
 */
export function schema(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_schema', input);
}
