import { z } from 'zod';
import { provenance } from './common-output.js';
import type { ToolDefinition } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { okLibraryContent, resolveLibrary } from '../registry/registry.js';
import { collectActivity, MAX_ACTIVITY_SCAN, type ActivityRow } from '../features/review/activity.js';

const row = z
  .object({
    key: z.string().describe('Item key.'),
    itemType: z.string().describe('Zotero item type.'),
    change: z.string().describe('"added" (created in the window) or "modified" (created earlier, changed in the window).'),
    dateAdded: z.string().optional().describe('When it was created.'),
    dateModified: z.string().optional().describe('When it last changed.'),
    title: z.string().optional().describe('items: the title.'),
    parentItem: z.string().optional().describe('The direct parent: an item for a note or attachment, an attachment for an annotation.'),
    item: z.string().optional().describe('The top-level item a child belongs to.'),
    itemTitle: z.string().optional().describe("That item's title."),
    annotationType: z.string().optional().describe('annotations: highlight, underline, note, text, image or ink.'),
    text: z.string().optional().describe('annotations: the highlighted passage; notes: the note text, first 300 characters.'),
    comment: z.string().optional().describe('annotations: the comment.'),
    color: z.string().optional().describe('annotations: hex colour.'),
    pageLabel: z.string().optional().describe('annotations: page label.'),
    createdBy: z.string().optional().describe('Group libraries read from the cloud: who created it.'),
    modifiedBy: z.string().optional().describe('Group libraries read from the cloud: who changed it last.'),
  })
  .passthrough();

const activity: ToolDefinition = {
  name: 'zotero_activity',
  title: 'What was added, changed, read and marked recently',
  description:
    'Read-only: what was added or modified in the last `days` days in a library or one collection, newest first, split into items (papers and attachments), notes and annotations (highlights with their text and comments). In a group library read from the cloud, every row says who created and who last changed it, and `byUser` totals it per person, so a review team sees who added and screened what this week; the desktop local API does not report who made a change, so without a cloud key a group answer carries no names and says so. In your own library it is a "what did I read and mark this week" view. Zotero\'s "Recently Read" list is not available: it lives only in the desktop\'s own database and neither Zotero API exposes it. Reads go to the running Zotero desktop app when it holds the library, otherwise to the cloud Web API.',
  inputSchema: {
    days: z.number().int().min(1).max(365).optional().describe('How far back to look, in days (default 7).'),
    collection_key: z
      .string()
      .optional()
      .describe('Only changes to items in this collection and to their notes, attachments and annotations (subcollections not included). Omit for the whole library.'),
    limit: z.number().int().min(1).max(200).optional().describe('Most rows to return in each of items, notes and annotations (default 50, max 200).'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      since: z.string().describe('Start of the window, ISO 8601 UTC.'),
      items: z.array(row).describe('Items and attachments added or modified, newest first.'),
      notes: z.array(row).describe('Notes added or modified, newest first.'),
      annotations: z.array(row).describe('Annotations added or modified, newest first.'),
      totals: z
        .object({
          items: z.number().describe('Items and attachments in the window.'),
          notes: z.number().describe('Notes in the window.'),
          annotations: z.number().describe('Annotations in the window.'),
        })
        .passthrough()
        .describe('Counts before `limit` was applied.'),
      byUser: z.record(z.record(z.number())).optional().describe('Group libraries read from the cloud: per person, how many objects they added and modified.'),
      attribution: z.string().describe('"cloud" (names come from the Web API), "unavailable" (a group read without names) or "personal-library".'),
      attributionNote: z.string().optional().describe('Why names are or are not present.'),
      scanned: z.number().describe('Changed objects read in the window.'),
      complete: z.boolean().describe(`False when the window held more than ${MAX_ACTIVITY_SCAN} changes; shorten \`days\`.`),
      provenance,
    })
    .passthrough(),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const lib = resolveLibrary(ctx, args);
    const days = args.days ?? 7;
    const limit = args.limit ?? 50;
    const r = await collectActivity(ctx, lib, { days, collectionKey: args.collection_key });
    const cap = (rows: ActivityRow[]) => rows.slice(0, limit);
    const structured: Record<string, unknown> = {
      ...r,
      items: cap(r.items),
      notes: cap(r.notes),
      annotations: cap(r.annotations),
      totals: { items: r.items.length, notes: r.notes.length, annotations: r.annotations.length },
    };
    const scope = args.collection_key ? `collection ${args.collection_key}` : lib.type === 'group' ? `group ${lib.id}` : 'your library';
    const people = r.byUser ? ` by ${Object.keys(r.byUser).length} person(s)` : '';
    const more = r.complete ? '' : ` Only the newest ${MAX_ACTIVITY_SCAN} changes were read; shorten \`days\` to see the rest.`;
    return okLibraryContent(
      structured,
      `In the last ${days} day(s) in ${scope}: ${r.items.length} item(s), ${r.notes.length} note(s) and ${r.annotations.length} annotation(s) added or changed${people}.${more}`,
    );
  },
};

export default activity;
