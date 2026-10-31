import { z } from 'zod';
import { provenance } from './common-output.js';
import type { ToolDefinition } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { okLibraryContent, resolveLibrary } from '../registry/registry.js';
import { refusal } from '../features/notes/write-note.js';
import { collectDigest, digestItemJson } from '../features/notes/annotation-digest.js';

/** The scope and filter arguments the digest and the tool that saves it share. */
export const digestArgs = {
  item_key: z
    .string()
    .optional()
    .describe('A paper (or a standalone PDF/EPUB attachment) whose annotations to gather. Give this or `collection_key`, not both.'),
  collection_key: z
    .string()
    .optional()
    .describe('A collection whose top-level items\' annotations to gather (from zotero_list_collections; subcollections are not included).'),
  types: z
    .array(z.enum(['highlight', 'underline', 'note', 'text', 'image', 'ink']))
    .optional()
    .describe('Only these annotation types, e.g. ["highlight", "note"]. Default: all.'),
  colors: z
    .array(z.string())
    .optional()
    .describe('Only these colours: Zotero\'s names (yellow, red, green, blue, purple, magenta, orange, gray) or hex values like "#ffd400". Default: all.'),
  tags: z
    .array(z.string())
    .optional()
    .describe('Only annotations carrying at least one of these tags (case-insensitive). Default: all.'),
};

/** Why a digest scope cannot be read, or null when it names exactly one thing. */
export function scopeProblem(args: { item_key?: string; collection_key?: string }): string | null {
  if (args.item_key && args.collection_key) return 'Pass `item_key` or `collection_key`, not both.';
  if (!args.item_key && !args.collection_key) return 'Pass `item_key` (one paper) or `collection_key` (a collection).';
  return null;
}

const annotationRow = z
  .object({
    key: z.string().describe('Annotation key.'),
    type: z.string().describe('highlight, underline, note, text, image or ink.'),
    color: z.string().optional().describe('Hex colour as Zotero stores it, e.g. "#ffd400".'),
    colorName: z.string().optional().describe('The colour\'s name in Zotero\'s palette, e.g. "yellow".'),
    pageLabel: z.string().optional().describe('Page label as the reader shows it, e.g. "12" or "xii".'),
    text: z.string().optional().describe('The highlighted or underlined passage, verbatim.'),
    comment: z.string().optional().describe('The reader\'s own comment on it.'),
    tags: z.array(z.string()).describe('Tags on the annotation.'),
    attachment: z.string().describe('Key of the PDF/EPUB/snapshot attachment it was drawn on.'),
    dateModified: z.string().optional().describe('When it was last changed.'),
  })
  .passthrough();

const annotationDigest: ToolDefinition = {
  name: 'zotero_annotation_digest',
  title: 'List the annotations on a paper or collection',
  description:
    'List the reader\'s PDF/EPUB annotations, grouped per paper: type, colour, page label, the highlighted text verbatim, the comment, and tags, in reading order. Give `item_key` for one paper, or `collection_key` for every top-level item in a collection (paged with `start`/`limit`, sorted by title). Filter with `types`, `colors` and `tags`. Each paper comes with `citation` ("Smith, 2019"), so a synthesis can cite it as [@ITEMKEY, p. 12] in zotero_create_note. Read-only: to keep the digest in Zotero as a note, call zotero_save_annotation_digest with the same arguments, which writes it without retyping a word. Reads go to the running Zotero desktop app when it serves the library, otherwise to the cloud Web API.',
  inputSchema: {
    ...digestArgs,
    start: z.number().int().min(0).optional().describe('collection_key only: index of the first item to read (default 0). Use `nextStart` from the previous call.'),
    limit: z.number().int().min(1).max(100).optional().describe('collection_key only: how many items to read per call (default 25, max 100).'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      scope: z.string().describe('What was read: "item ABCD2345" or "collection WXYZ6789".'),
      collection: z
        .object({ key: z.string().describe('Collection key.'), name: z.string().describe('Collection name.') })
        .passthrough()
        .optional()
        .describe('The collection read, for collection_key.'),
      items: z
        .array(
          z
            .object({
              key: z.string().describe('Item key of the paper (or standalone attachment).'),
              itemType: z.string().describe('Its Zotero item type.'),
              title: z.string().describe('Its title.'),
              citation: z.string().describe('Zotero\'s short citation for it, e.g. "Smith, 2019".'),
              attachments: z
                .array(
                  z
                    .object({
                      key: z.string().describe('Attachment key.'),
                      title: z.string().optional().describe('Attachment title.'),
                      annotations: z.number().describe('Matching annotations on it.'),
                    })
                    .passthrough(),
                )
                .describe('The annotated attachments, with how many matching annotations each holds.'),
              annotations: z.array(annotationRow).describe('Its matching annotations, in reading order per attachment.'),
            })
            .passthrough(),
        )
        .describe('Papers with at least one matching annotation. Items with none are counted in itemsScanned and left out.'),
      annotations: z.number().describe('Matching annotations across all items returned.'),
      itemsScanned: z.number().describe('Items looked at on this call.'),
      totalItems: z.number().optional().describe('collection_key: top-level items in the collection.'),
      nextStart: z.number().optional().describe('collection_key: pass as `start` to read the next page; absent on the last one.'),
      provenance,
    })
    .passthrough(),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const problem = scopeProblem(args);
    if (problem) return refusal(problem);
    const lib = resolveLibrary(ctx, args);
    const collected = await collectDigest(
      ctx,
      lib,
      { itemKey: args.item_key, collectionKey: args.collection_key },
      { types: args.types, colors: args.colors, tags: args.tags },
      { start: args.start ?? 0, limit: args.limit ?? 25 },
    );
    if ('problem' in collected) return refusal(collected.problem);
    const total = collected.items.reduce((n, item) => n + item.annotations.length, 0);
    const scope = args.item_key ? `item ${args.item_key}` : `collection ${args.collection_key}`;
    const structured: Record<string, unknown> = {
      scope,
      ...(args.collection_key ? { collection: { key: args.collection_key, name: collected.collectionName } } : {}),
      items: collected.items.map(digestItemJson),
      annotations: total,
      itemsScanned: collected.scanned,
    };
    if (collected.totalItems != null) structured.totalItems = collected.totalItems;
    if (collected.nextStart != null) structured.nextStart = collected.nextStart;
    const filtered = args.types?.length || args.colors?.length || args.tags?.length ? ' matching' : '';
    const where = args.collection_key
      ? `${collected.items.length} of ${collected.scanned} item(s) read from collection "${collected.collectionName}"`
      : `item ${args.item_key}`;
    const more = collected.nextStart != null ? ` More items remain: call again with start:${collected.nextStart}.` : '';
    return okLibraryContent(
      structured,
      total ? `${total}${filtered} annotation(s) on ${where}.${more}` : `No${filtered} annotations on ${where}.${more}`,
    );
  },
};

export default annotationDigest;
