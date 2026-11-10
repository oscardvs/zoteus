import { callMCPTool } from '../runtime.js';

/**
 * What was added, changed, read and marked recently : Read-only: what was added or modified in the last `days` days in a library or one collection, newest first, split into items (papers and attachments), notes and annotations (highlights with their text and comments). In a group library read from the cloud, every row says who created and who last changed it, and `byUser` totals it per person, so a review team sees who added and screened what this week; the desktop local API does not report who made a change, so without a cloud key a group answer carries no names and says so. In your own library it is a "what did I read and mark this week" view.
 * Params: days, collection_key, limit, library_type, library_id.
 */
export function activity(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_activity', input);
}
