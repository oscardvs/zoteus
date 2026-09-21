import { callMCPTool } from '../runtime.js';

/**
 * Scholarly context (references, citations, related) : Explore the EXTERNAL scholarly graph around a paper (OpenAlex, Crossref fallback). This does NOT search, list, or read your Zotero library: it queries the open web, and results are works from the scholarly web, not your items. To search or inspect YOUR library use zotero_search_items, zotero_semantic_search, zotero_get_item, or zotero_list_tags instead. Provide a `doi` and an `action`: "lookup" (metadata + citation count, plus an `oa` block naming the open-access PDF OpenAlex knows of, when there is one), "references" (works this paper cites), "citations" (works that cite this paper, most-cite
 * Params: action, doi, limit, include_in_library, library_scan.
 */
export function scholar(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_scholar', input);
}
