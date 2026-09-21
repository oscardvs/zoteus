import { callMCPTool } from '../runtime.js';

/**
 * Format a bibliography (citeproc / any CSL style) : Render a formatted bibliography in any CSL style using citeproc-js : no Zotero library write required. Provide either `items` (an array of CSL-JSON objects, e.g. from zotero_import or external metadata) or `item_keys` (library items, which are exported to CSL-JSON first). Choose `style` (a name like "APA 7th" or a CSL id; default "apa"), `locale` (default "en-US"), and `format` (html/text/rtf; default html). The formatted bibliography text is returned. Use this for arbitrary items or styles; for items already in the library you can also use zotero_bibliography (server-rendered).
 * Params: items, item_keys, style, locale, format, library_type, library_id.
 */
export function formatBibliography(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_format_bibliography', input);
}
