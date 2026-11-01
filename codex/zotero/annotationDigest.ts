import { callMCPTool } from '../runtime.js';

/**
 * List the annotations on a paper or collection : List the reader's PDF/EPUB annotations, grouped per paper: type, colour, page label, the highlighted text verbatim, the comment, and tags, in reading order. Give `item_key` for one paper, or `collection_key` for every top-level item in a collection (paged with `start`/`limit`, sorted by title). Filter with `types`, `colors` and `tags`. Each paper comes with `citation` ("Smith, 2019"), so a synthesis can cite it as [@ITEMKEY, p. 12] in zotero_create_note. Read-only: to keep the digest in Zotero as a note, call zotero_save_annotation_digest with the same arguments, which writes it without retypi
 * Params: item_key, collection_key, types, colors, tags, start, limit, library_type, library_id.
 */
export function annotationDigest(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_annotation_digest', input);
}
