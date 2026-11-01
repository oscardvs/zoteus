import { callMCPTool } from '../runtime.js';

/**
 * Create a Zotero note from Markdown : Create a note in Zotero from Markdown: a child note under an item (`parent_item`), or a standalone note (optionally filed in `collections`). Markdown: headings, paragraphs, bullet and numbered lists, **bold**, *italic*, ~~strikethrough~~, `code` and fenced code blocks, [links](https://...), > blockquotes, tables, horizontal rules, and $inline$ or $$display$$ math, all stored as the note editor's own HTML. Raw HTML is shown as text, not interpreted. Cite a library item with its key in brackets: [@ABCD2345], [@ABCD2345, p. 12], [see @ABCD2345; @WXYZ6789, pp. 3-5]. Each becomes a real Zotero cita
 * Params: markdown, title, parent_item, collections, tags, cite, library_type, library_id.
 */
export function createNote(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_create_note', input);
}
