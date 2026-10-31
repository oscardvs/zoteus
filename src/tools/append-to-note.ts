import { z } from 'zod';
import { writeTarget } from './common-output.js';
import type { ToolDefinition } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { resolveLibrary } from '../registry/registry.js';
import { refusal, renderNoteBody, rewriteNote } from '../features/notes/write-note.js';
import { appendToNote } from '../features/notes/note-html.js';
import { NOTE_MARKDOWN_HELP, citeArg } from './create-note.js';

const appendToNoteTool: ToolDefinition = {
  name: 'zotero_append_to_note',
  title: 'Append Markdown to a Zotero note',
  description:
    `Add Markdown to the end of an existing Zotero note, keeping everything already in it, including its own citations and formatting. ${NOTE_MARKDOWN_HELP} \`note_key\` is the note's own key (zotero_get_item with include_children lists an item's notes). To start a new note use zotero_create_note; to rewrite one, zotero_replace_note. If someone edits the note at the same moment, it is re-read and the text appended to the fresh copy. Writes go to the running Zotero desktop app (Zotero 10+) for every library it holds, otherwise to the cloud Web API.`,
  inputSchema: {
    note_key: z.string().describe('Key of the note to append to.'),
    markdown: z.string().describe('What to add at the end of the note, in Markdown.'),
    cite: citeArg,
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      note_key: z.string().describe('The note this call appended to.'),
      newVersion: z.number().describe('The note\'s version after the write.'),
      citations: z.number().describe('How many [@KEY] groups in the appended text became Zotero citations.'),
      retried: z.boolean().optional().describe('True when a version conflict made it re-read the note and append to the fresh copy.'),
      target: writeTarget,
    })
    .passthrough(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    const markdown: string = args.markdown ?? '';
    if (!markdown.trim()) return refusal('`markdown` is empty, so there is nothing to append.');
    const lib = resolveLibrary(ctx, args);
    const rendered = await renderNoteBody(ctx, lib, markdown, args.cite ?? true);
    if ('problems' in rendered) return refusal(`Nothing was written:\n- ${rendered.problems.join('\n- ')}`);
    return rewriteNote(ctx, lib, args.note_key, {
      transform: (existing) => appendToNote(existing, rendered.body, rendered.citationItems),
      describe: (key, version, via) =>
        `Appended to note ${key}${via} (now version ${version})` +
        (rendered.citations ? `, with ${rendered.citations} citation(s).` : '.'),
      extra: () => ({ citations: rendered.citations }),
    });
  },
};

export default appendToNoteTool;
