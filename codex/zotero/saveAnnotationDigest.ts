import { callMCPTool } from '../runtime.js';

/**
 * Save a paper's or collection's annotations as a note : Gather the annotations zotero_annotation_digest lists and save them as a Zotero note, laid out the way Zotero's own "Add Note from Annotations" lays one out: a paragraph per annotation with the highlighted passage, a citation with its page, the comment and tags. Each highlight stays linked to its spot in the PDF and each citation to its paper, so both open from the note in Zotero. For `item_key` the note is attached to that paper; for `collection_key` it is a standalone note filed in that collection, with a heading per paper (up to 200 items; the note says so if the collection holds more). Tak
 * Params: item_key, collection_key, types, colors, tags, title, note_tags, library_type, library_id.
 */
export function saveAnnotationDigest(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_save_annotation_digest', input);
}
