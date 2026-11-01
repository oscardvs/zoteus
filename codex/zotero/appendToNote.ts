import { callMCPTool } from '../runtime.js';

/**
 * Append Markdown to a Zotero note : Add Markdown to the end of an existing Zotero note, keeping everything already in it, including its own citations and formatting. Markdown: headings, paragraphs, bullet and numbered lists, **bold**, *italic*, ~~strikethrough~~, `code` and fenced code blocks, [links](https://...), > blockquotes, tables, horizontal rules, and $inline$ or $$display$$ math, all stored as the note editor's own HTML. Raw HTML is shown as text, not interpreted. Cite a library item with its key in brackets: [@ABCD2345], [@ABCD2345, p. 12], [see @ABCD2345; @WXYZ6789, pp. 3-5]. Each becomes a real Zotero citation (click
 * Params: note_key, markdown, cite, library_type, library_id.
 */
export function appendToNote(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_append_to_note', input);
}
