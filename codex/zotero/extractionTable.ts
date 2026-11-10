import { callMCPTool } from '../runtime.js';

/**
 * Gather saved extractions into one table : Read every extraction saved with zotero_save_extraction for a collection, for given items, or for the whole library, and lay them out as ONE table: a row per paper, a column per field. Read-only. Returns the rows as structured data (each value with its saved quote, page and quote check), plus the same table as Markdown and as CSV text (each field gets value, quote, page and quote-check columns there, so a spreadsheet can filter on them). Gaps are listed, not hidden: `missingItems` names papers in the collection or in `item_keys` with no extraction saved under this schema, and `missingFields` n
 * Params: schema, collection_key, item_keys, fields, library_type, library_id.
 */
export function extractionTable(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_extraction_table', input);
}
