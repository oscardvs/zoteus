import { callMCPTool } from '../runtime.js';

/**
 * List Zotero groups : List the group libraries this server can reach, with each group's id and name. Use a returned group id with the `library_id`/`library_type:"group"` parameters of other tools to operate on that group library; `library_type` alone does not address a group. With a cloud API key each group the key can access is listed with its type, item count, description and edit permissions, plus `canWrite`: whether this key may write to that group, decided from the key's own access map without sending a write, and `writeBlockedReason` naming the remedy when it may not. Without a key the list falls back to the
 * Takes no parameters.
 */
export function groups(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_groups', input);
}
