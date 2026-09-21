import { callMCPTool } from '../runtime.js';

/**
 * Attach a file (PDF, snapshot) to an item : Add a stored file attachment (e.g. a PDF full text) under an existing item. Give `parent` (the item key) and one of `url` (Zoteus downloads it, then stores it), `path` (a file on the machine running Zoteus), or `find_oa: true` (Zoteus looks the parent item's DOI up in OpenAlex and attaches the open-access PDF, if there is one). `find_oa` finds only copies OpenAlex already knows about, which is arXiv, PubMed Central, DOAJ journals and institutional repositories: it is not a way past a paywall, and it says so plainly when there is no free copy. The copy it finds is often the author's accepted or
 * Params: parent, path, url, find_oa, filename, content_type, title, library_type, library_id.
 */
export function attachFile(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_attach_file', input);
}
