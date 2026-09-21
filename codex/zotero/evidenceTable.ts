import { callMCPTool } from '../runtime.js';

/**
 * Render an evidence table : Render rows of retrieved evidence as a Markdown or CSV table, deterministically, from passages you already retrieved with zotero_get_fulltext and zotero_semantic_search. This tool does NOT search and does NOT read the library: it formats what you pass it and echoes each row's quotation, locator and coverage back unchanged. It counts the coverage summary from the rows rather than taking your word for it, and it warns, naming the row, when a row contradicts its own evidence (a page locator with no quotation, coverage claiming a retrieved passage with no quotation, a quotation on a source marked
 * Params: question, rows, format, save_path, overwrite.
 */
export function evidenceTable(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_evidence_table', input);
}
