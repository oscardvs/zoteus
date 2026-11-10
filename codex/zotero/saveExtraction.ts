import { callMCPTool } from '../runtime.js';

/**
 * Save structured fields extracted from papers : Save a structured extraction (named fields with values, such as sample_size, method, country, outcome) for one or many papers, as a child note on each paper: a readable table plus a machine-readable copy, tagged "zoteus-extraction". Zotero has no custom fields; a note syncs and anyone can read it in Zotero. YOU read the paper (zotero_get_fulltext) and supply the values: this server has no language model. Give each value the verbatim `quote` it rests on, and its `page`: when the paper's full text is available (Zotero's index, or the PDF or EPUB itself) the quote is checked against it and the ve
 * Params: schema, items, replace_all, verify_quotes, library_type, library_id.
 */
export function saveExtraction(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_save_extraction', input);
}
