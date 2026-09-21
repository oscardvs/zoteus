import { callMCPTool } from '../runtime.js';

/**
 * Annotate a PDF (highlights, notes) : Add or delete Zotero PDF annotations (highlights, underlines, notes), the same objects you create in the Zotero PDF reader. `action:"add"` needs `parent` (a regular item key OR a PDF attachment key) and `annotations`: each with `type` (highlight|note|underline, default highlight), `text` (the exact passage to highlight), optional `comment`, `color`, `page` (0-based page index). **You do not need page coordinates**: give the passage in `text` and it is located in the PDF and anchored to the exact lines it occupies, so quoting a passage is enough to highlight it. Pass `page` to disambiguate a pa
 * Params: action, parent, annotations, annotation_keys, library_type, library_id.
 */
export function annotate(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_annotate', input);
}
