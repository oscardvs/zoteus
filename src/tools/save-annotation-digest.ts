import { z } from 'zod';
import { newLibraryVersion, writeFailures, writeTarget } from './common-output.js';
import type { ToolDefinition } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { resolveLibrary } from '../registry/registry.js';
import { refusal, writeNewNote } from '../features/notes/write-note.js';
import { collectDigest, digestNoteHtml, type DigestItem } from '../features/notes/annotation-digest.js';
import { digestArgs, scopeProblem } from './annotation-digest.js';

/**
 * Items one saved digest walks before it stops. A note is one document; past this a
 * collection is better digested per subcollection, and the note says it stopped.
 */
export const MAX_SAVED_ITEMS = 200;

const PAGE = 100;

const saveAnnotationDigest: ToolDefinition = {
  name: 'zotero_save_annotation_digest',
  title: 'Save a paper\'s or collection\'s annotations as a note',
  description:
    'Gather the annotations zotero_annotation_digest lists and save them as a Zotero note, laid out the way Zotero\'s own "Add Note from Annotations" lays one out: a paragraph per annotation with the highlighted passage, a citation with its page, the comment and tags. Each highlight stays linked to its spot in the PDF and each citation to its paper, so both open from the note in Zotero. For `item_key` the note is attached to that paper; for `collection_key` it is a standalone note filed in that collection, with a heading per paper (up to 200 items; the note says so if the collection holds more). Takes the same `types`, `colors` and `tags` filters. Nothing is written when no annotation matches. Writes go to the running Zotero desktop app (Zotero 10+) for every library it holds, otherwise to the cloud Web API.',
  inputSchema: {
    ...digestArgs,
    title: z
      .string()
      .optional()
      .describe('The note\'s heading and title. Default "Annotations (<date>)", or "Annotations: <collection> (<date>)".'),
    note_tags: z.array(z.string()).optional().describe('Tags to put on the note itself, e.g. ["annotation-digest"].'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      key: z.string().optional().describe('Key of the note created.'),
      version: z.number().optional().describe('Its version after the write.'),
      parentItem: z.string().optional().describe('The paper the note was attached to, for item_key.'),
      collections: z.array(z.string()).optional().describe('Collections the standalone note was filed in.'),
      items: z.number().describe('Papers the note covers.'),
      annotations: z.number().describe('Annotations the note holds.'),
      truncated: z.boolean().optional().describe(`True when the collection held more than ${MAX_SAVED_ITEMS} items and the note covers the first ${MAX_SAVED_ITEMS} by title.`),
      target: writeTarget,
      libraryVersion: newLibraryVersion,
      failed: writeFailures,
    })
    .passthrough(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    const problem = scopeProblem(args);
    if (problem) return refusal(problem);
    const lib = resolveLibrary(ctx, args);
    const filters = { types: args.types, colors: args.colors, tags: args.tags };
    const scope = { itemKey: args.item_key, collectionKey: args.collection_key };

    const items: DigestItem[] = [];
    let collectionName: string | undefined;
    let totalItems: number | undefined;
    let truncated = false;
    for (let start = 0; ; ) {
      const limit = Math.min(PAGE, MAX_SAVED_ITEMS - start);
      const page = await collectDigest(ctx, lib, scope, filters, { start, limit }, { csl: true });
      if ('problem' in page) return refusal(page.problem);
      items.push(...page.items);
      collectionName = page.collectionName;
      totalItems = page.totalItems ?? totalItems;
      if (page.nextStart == null) break;
      start = page.nextStart;
      if (start >= MAX_SAVED_ITEMS) {
        truncated = true;
        break;
      }
    }

    const annotations = items.reduce((n, item) => n + item.annotations.length, 0);
    const what = args.item_key ? `item ${args.item_key}` : `collection "${collectionName}"`;
    if (!annotations) {
      const filtered = args.types?.length || args.colors?.length || args.tags?.length ? ' matching' : '';
      return refusal(`No${filtered} annotations on ${what}, so no note was written.`);
    }

    const date = new Date().toISOString().slice(0, 10);
    const title = args.title?.trim() || (args.collection_key ? `Annotations: ${collectionName} (${date})` : `Annotations (${date})`);
    const footnote = truncated
      ? `This digest covers the first ${MAX_SAVED_ITEMS} of ${totalItems ?? 'more'} items in the collection, by title.`
      : undefined;
    const html = digestNoteHtml(lib, items, title, footnote);

    // Where it goes: under the paper, or for a standalone attachment (which Zotero will not
    // give a child note) beside it in its collections; a collection digest is filed there.
    const only = items[0]!;
    const parentItem = args.item_key && only.cited ? only.key : undefined;
    const collections = args.collection_key ? [args.collection_key] : parentItem ? undefined : only.collections;
    return writeNewNote(
      ctx,
      lib,
      { html, parentItem, collections, tags: args.note_tags },
      (key, via) =>
        `Saved ${annotations} annotation(s) from ${items.length} item(s) as note ${key}${parentItem ? ` under ${parentItem}` : ''}${via}.` +
        (truncated ? ` The collection holds more than ${MAX_SAVED_ITEMS} items; the note covers the first ${MAX_SAVED_ITEMS} by title.` : ''),
      {
        items: items.length,
        annotations,
        ...(collections?.length ? { collections } : {}),
        ...(truncated ? { truncated } : {}),
      },
    );
  },
};

export default saveAnnotationDigest;
