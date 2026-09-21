import { callMCPTool } from '../runtime.js';

/**
 * Get attachment full text / passages / outline (read-only) : Retrieve an item's PDF or EPUB text for grounding. Pass a parent `item_key` (its best PDF/EPUB attachment is resolved automatically) or an attachment key. With `query`, returns the top relevant passages with locators (char offsets, nearest section, and a page); with `page_range` (e.g. "3-7"), returns just those pages, re-extracted from the PDF so the span is exact; with `outline:true`, returns the PDF's table of contents with page numbers (the cheapest way to decide which pages to read next); with none of them, returns a truncated head. Text comes from Zotero's full-text index when available;
 * Params: item_key, query, page_range, outline, max_passages, max_chars, precise_pages, fallback, ocr, library_type, library_id.
 */
export function getFulltext(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_get_fulltext', input);
}
