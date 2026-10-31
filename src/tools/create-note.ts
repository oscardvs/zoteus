import { z } from 'zod';
import { newLibraryVersion, writeFailures, writeTarget } from './common-output.js';
import type { ToolDefinition } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { resolveLibrary } from '../registry/registry.js';
import { refusal, renderNoteBody, writeNewNote } from '../features/notes/write-note.js';
import { titleHtml, wrapNote } from '../features/notes/note-html.js';

/** What every note tool says about the Markdown it takes, so the three never drift apart. */
export const NOTE_MARKDOWN_HELP =
  'Markdown: headings, paragraphs, bullet and numbered lists, **bold**, *italic*, ~~strikethrough~~, `code` and fenced code blocks, [links](https://...), > blockquotes, tables, horizontal rules, and $inline$ or $$display$$ math, all stored as the note editor\'s own HTML. Raw HTML is shown as text, not interpreted. Cite a library item with its key in brackets: [@ABCD2345], [@ABCD2345, p. 12], [see @ABCD2345; @WXYZ6789, pp. 3-5]. Each becomes a real Zotero citation (clickable in Zotero, live when the note is added to a Word document), and a key that names nothing refuses the write.';

export const citeArg = z
  .boolean()
  .optional()
  .describe('Turn [@ITEMKEY] references into Zotero citations (default true). false leaves them as plain text.');

const createNote: ToolDefinition = {
  name: 'zotero_create_note',
  title: 'Create a Zotero note from Markdown',
  description:
    `Create a note in Zotero from Markdown: a child note under an item (\`parent_item\`), or a standalone note (optionally filed in \`collections\`). ${NOTE_MARKDOWN_HELP} Zotero titles a note by its first line; pass \`title\` to put a heading there. To add to a note that exists, use zotero_append_to_note; to rewrite one, zotero_replace_note. Writes go to the running Zotero desktop app (Zotero 10+) for every library it holds, otherwise to the cloud Web API (requires ZOTERO_API_KEY with write access).`,
  inputSchema: {
    markdown: z.string().describe('The note body, in Markdown.'),
    title: z
      .string()
      .optional()
      .describe('A heading placed at the top of the note, which Zotero then shows as its title. Omit to let the first line of `markdown` be the title.'),
    parent_item: z
      .string()
      .optional()
      .describe('Key of the regular item (paper, book, ...) the note belongs to. Omit for a standalone note.'),
    collections: z
      .array(z.string())
      .optional()
      .describe('Collection keys to file a standalone note in (from zotero_list_collections). A child note lives with its parent, so this is refused together with `parent_item`.'),
    tags: z.array(z.string()).optional().describe('Tags to put on the note, e.g. ["literature-note"].'),
    cite: citeArg,
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      key: z.string().optional().describe('Key of the note created.'),
      version: z.number().optional().describe('Its version after the write.'),
      parentItem: z.string().optional().describe('The item the note was attached to, for a child note.'),
      citations: z.number().describe('How many [@KEY] groups became Zotero citations.'),
      target: writeTarget,
      libraryVersion: newLibraryVersion,
      failed: writeFailures,
    })
    .passthrough(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    const markdown: string = args.markdown ?? '';
    if (!markdown.trim() && !args.title?.trim()) return refusal('`markdown` is empty, so there is no note to write.');
    if (args.parent_item && args.collections?.length) {
      return refusal(
        'A child note cannot be filed in collections: Zotero keeps it with its parent item, and only top-level items belong to collections. ' +
          'Drop `collections` to attach the note to the item, or drop `parent_item` for a standalone note in those collections.',
      );
    }
    const lib = resolveLibrary(ctx, args);
    const rendered = await renderNoteBody(ctx, lib, markdown, args.cite ?? true);
    if ('problems' in rendered) return refusal(`Nothing was written:\n- ${rendered.problems.join('\n- ')}`);
    const html = wrapNote((args.title?.trim() ? titleHtml(args.title) : '') + rendered.body, rendered.citationItems);
    return writeNewNote(
      ctx,
      lib,
      { html, parentItem: args.parent_item, collections: args.collections, tags: args.tags },
      (key, via) =>
        `Created note ${key}${args.parent_item ? ` under ${args.parent_item}` : ''}${via}` +
        (rendered.citations ? ` with ${rendered.citations} citation(s).` : '.'),
      { citations: rendered.citations },
    );
  },
};

export default createNote;
