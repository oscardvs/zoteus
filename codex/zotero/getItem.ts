import { callMCPTool } from '../runtime.js';

/**
 * Get a Zotero item — Fetch one item by its key, returning the full item record (itemType, all bibliographic fields, creators, tags, collections, relations, version). Optionally set `include_children` to also return the item's child notes and attachments. Use `include` to additionally request rendered output: "bib" (formatted bibliography entry), "citation" (inline citation), or "csljson" (CSL-JSON for downstream formatting); combine with `style` (a style name such as "apa" or "chicago author-date", a CSL style id such as chicago-notes-bibliography, or the URL of a CSL file; unset renders Zotero's default, Chicago 
 * Params: item_key, include_children, include, style, locale, library_type, library_id.
 */
export function getItem(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_get_item', input);
}
