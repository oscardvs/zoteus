import { callMCPTool } from '../runtime.js';

/**
 * Replace a Zotero note with Markdown : Replace the whole content of an existing Zotero note with new Markdown. The note keeps its key, parent item, tags and collections; only its text changes, and the old text is gone from Zotero (Zotero keeps no history of a note). The result returns the previous HTML as `previousNote` so it can be put back. Markdown: headings, paragraphs, bullet and numbered lists, **bold**, *italic*, ~~strikethrough~~, `code` and fenced code blocks, [links](https://...), > blockquotes, tables, horizontal rules, and $inline$ or $$display$$ math, all stored as the note editor's own HTML. Raw HTML is shown as text,
 * Params: note_key, markdown, title, version, cite, library_type, library_id.
 */
export function replaceNote(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_replace_note', input);
}
