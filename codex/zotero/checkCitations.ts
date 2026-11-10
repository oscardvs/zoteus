import { callMCPTool } from '../runtime.js';

/**
 * Check a draft's citations and quotations against the library : Check a draft (Markdown, LaTeX or plain text) for invented citations and misquotations, deterministically and without changing anything. Finds every citation: pandoc [@key, p. 12; @other], Zotero item keys [@ABCD2345], LaTeX \cite/\citep/\citet/\parencite/\textcite/\autocite{a,b}, author-year (Smith, 2020), (Smith & Jones, 2020, p. 4), Smith et al. (2020), numeric [3] (through the reference list) and bare DOIs. Each cited work is looked up in the library by item key, citation key (Zotero's Citation Key field, then Better BibTeX when it runs on this machine), DOI, or author + year (+ title word
 * Params: draft, references, check_quotes, start, max_citations, max_fulltexts, library_type, library_id.
 */
export function checkCitations(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_check_citations', input);
}
