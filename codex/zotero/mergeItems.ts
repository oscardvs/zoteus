import { callMCPTool } from '../runtime.js';

/**
 * Merge duplicate items : Merge one or more duplicate items into a master item: fields the master is MISSING are filled from the duplicates, their tags, collections and relations are unioned onto it, their child notes and attachments are reparented to it, and the emptied duplicates are moved to the trash (recoverable). A field the master already has is never overwritten, and nothing is ever deleted outright. PREVIEWS BY DEFAULT: with `dry_run` unset or true nothing is written and the answer is the exact plan, field by field, so the caller can see what would change before it changes. Pass `dry_run:false` to execute. The
 * Params: master_key, duplicate_keys, dry_run, confirm, expect_versions, library_type, library_id.
 */
export function mergeItems(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_merge_items', input);
}
