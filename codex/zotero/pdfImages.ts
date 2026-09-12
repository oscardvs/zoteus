import { callMCPTool } from '../runtime.js';

/**
 * Look at PDF pages and figures as images (read-only) — See a PDF the way a reader does. Text extraction (zotero_get_fulltext) loses figures, turns tables into run-together numbers, drops most equations, and returns nothing for a scanned page with no text layer; this tool returns pictures instead. Pass a parent `item_key` (its PDF attachment is resolved automatically, exactly as zotero_get_fulltext does) or an attachment key, a `mode`, and `pages` ("3" or "3-7", 1-based; default "1"). `mode:"pages"` renders whole pages and returns them as image content blocks you can look at, followed by a JSON block with each page's pixel size and byte count: the 
 * Params: item_key, mode, pages, dpi, format, max_pages, max_images, min_size, inline, save, library_type, library_id.
 */
export function pdfImages(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_pdf_images', input);
}
