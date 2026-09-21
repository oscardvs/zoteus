import { callMCPTool } from '../runtime.js';

/**
 * Export Zotero items : Export items in a bibliographic format and return the raw text. Choose `format` (bibtex, biblatex, better-biblatex, ris, csljson, csv, mods, tei, coins, rdf_*, refer, wikipedia, bookmarks). Stock formats are rendered by Zotero itself: by the desktop app when it serves the selected library (no cloud key needed), by the Web API otherwise. `biblatex` is Zotero's STOCK translator; BBT-specific options (citation-key generation, sentence-case, biblatexExtendedNameFormat, unicode→LaTeX) are NOT available there. `better-biblatex` uses the local desktop Better BibTeX plugin (your configured BBT export
 * Params: format, item_keys, collection_key, q, item_type, limit, library_type, library_id.
 */
export function exportTool(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_export', input);
}
