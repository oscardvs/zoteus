import { callMCPTool } from '../runtime.js';

/**
 * Write a Word document with live Zotero citations : Write a .docx whose citations are LIVE Zotero fields, not plain text: Zotero's Word plugin is meant to refresh, restyle and add to them (never run here, so check your first document). Give `body` as paragraphs containing `[[cite:ITEMKEY]]` or `[[cite:ITEMKEY,p. 12]]` placeholders; `[[cite:KEY1;KEY2]]` puts several works in one field, which is how "(Wu, 2026; Devos, 2026)" is written. Each placeholder becomes a Word field carrying the item's CSL data, with the formatted citation as its visible text. A bibliography field is appended by default. For plain formatted references with no live fields
 * Params: body, title, style, locale, bibliography, save_path, overwrite, library_type, library_id.
 */
export function wordDocument(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_word_document', input);
}
