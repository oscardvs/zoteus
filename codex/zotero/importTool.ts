import { callMCPTool } from '../runtime.js';

/**
 * Import items by identifier, URL, bibliography file or PDF : Resolve bibliographic metadata to Zotero item-data and optionally save it to your library. `action: "by_identifier"` resolves a DOI, ISBN, PMID, arXiv id, or ADS bibcode (set `identifier`). `action: "by_url"` scrapes a web page (set `url`) and may return multiple choices to pick from. `action: "by_file"` imports a BibTeX, RIS or CSL-JSON bibliography: set `text` with the contents or `path` with a local file. Those three formats are parsed by Zoteus itself, so they need no translation-server, no Docker and no network; a reachable translation-server is used first when there is one, because it co
 * Params: action, identifier, url, text, path, format, attachment_key, scan_pages, confirm, save_to_library, collection_key, attach_url, attach_title, check_duplicates, allow_duplicate, library_type, library_id.
 */
export function importTool(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_import', input);
}
