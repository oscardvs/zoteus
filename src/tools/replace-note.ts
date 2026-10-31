import { z } from 'zod';
import { writeTarget } from './common-output.js';
import type { ToolDefinition } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { resolveLibrary } from '../registry/registry.js';
import { refusal, renderNoteBody, rewriteNote } from '../features/notes/write-note.js';
import { titleHtml, wrapNote } from '../features/notes/note-html.js';
import { NOTE_MARKDOWN_HELP, citeArg } from './create-note.js';

const replaceNote: ToolDefinition = {
  name: 'zotero_replace_note',
  title: 'Replace a Zotero note with Markdown',
  description:
    `Replace the whole content of an existing Zotero note with new Markdown. The note keeps its key, parent item, tags and collections; only its text changes, and the old text is gone from Zotero (Zotero keeps no history of a note). The result returns the previous HTML as \`previousNote\` so it can be put back. ${NOTE_MARKDOWN_HELP} Pass \`version\` (from zotero_get_item) to write only if nobody changed the note since you read it; without it the current text is replaced whatever it is. To add to a note instead, use zotero_append_to_note. Writes go to the running Zotero desktop app (Zotero 10+) for every library it holds, otherwise to the cloud Web API.`,
  inputSchema: {
    note_key: z.string().describe('Key of the note to replace.'),
    markdown: z.string().describe('The note\'s new content, in Markdown. Everything the note held before is replaced.'),
    title: z.string().optional().describe('A heading placed at the top of the note, which Zotero then shows as its title.'),
    version: z
      .number()
      .int()
      .optional()
      .describe('The note version you read. When given, a note that changed since is refused instead of overwritten.'),
    cite: citeArg,
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      note_key: z.string().describe('The note this call replaced.'),
      newVersion: z.number().describe('The note\'s version after the write.'),
      citations: z.number().describe('How many [@KEY] groups became Zotero citations.'),
      previousNote: z.string().describe('The note\'s HTML before this write, to restore it with zotero_update_item ({"note": ...}) if needed.'),
      retried: z.boolean().optional().describe('True when a version conflict made it re-read the note before replacing it.'),
      target: writeTarget,
    })
    .passthrough(),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const markdown: string = args.markdown ?? '';
    if (!markdown.trim() && !args.title?.trim()) {
      return refusal('`markdown` is empty. Replacing a note with nothing would erase it; trash it with zotero_trash_items instead.');
    }
    const lib = resolveLibrary(ctx, args);
    const rendered = await renderNoteBody(ctx, lib, markdown, args.cite ?? true);
    if ('problems' in rendered) return refusal(`Nothing was written:\n- ${rendered.problems.join('\n- ')}`);
    const html = wrapNote((args.title?.trim() ? titleHtml(args.title) : '') + rendered.body, rendered.citationItems);
    return rewriteNote(ctx, lib, args.note_key, {
      transform: () => html,
      version: args.version,
      describe: (key, version, via) =>
        `Replaced note ${key}${via} (now version ${version})` +
        (rendered.citations ? `, with ${rendered.citations} citation(s).` : '.'),
      extra: (previous) => ({ citations: rendered.citations, previousNote: previous }),
    });
  },
};

export default replaceNote;
