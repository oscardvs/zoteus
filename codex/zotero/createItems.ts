import { callMCPTool } from '../runtime.js';

/**
 * Create or update Zotero items : Create new items or update existing ones in a single batch (the server auto-chunks into groups of 50). `items` is an ARRAY of item-data objects; each object has `itemType` as a **plain string** (e.g. "journalArticle", "book", "preprint", "report") plus its valid fields, `creators` (each `{creatorType, firstName, lastName}` or `{creatorType, name}`), `tags` (`[{tag}]`), and `collections` (array of 8-char collection keys). To UPDATE an existing item, also include its `key` and current `version`; to CREATE, omit both. Every item is validated against the Zotero schema before anything is sent : if
 * Params: items, library_type, library_id.
 */
export function createItems(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_create_items', input);
}
