import { z } from 'zod';
import type { ToolContext, ToolDefinition } from '../registry/registry.js';
import { ok, resolveLibrary } from '../registry/registry.js';
import type { LibraryRef } from '../api/web-client.js';
import { ZoteroApiError } from '../api/errors.js';
import { libraryArgs } from './common-args.js';
import { writeTarget } from './common-output.js';
import { mustFallBack, withLibraryWriter, type LibraryWriter } from './library-writer.js';
import { parentProblem, refusal } from '../features/notes/write-note.js';
import {
  EXTRACTION_TAG,
  extractionNoteHtml,
  hasExtractionTag,
  parseExtractionNote,
  type ExtractedField,
  type Extraction,
  type FieldValue,
} from '../features/extraction/record.js';
import { checkQuote, loadDocumentText, normalizeForMatch, type DocumentText } from '../features/extraction/quote-check.js';
import { mergeFields, type FieldChange } from '../features/extraction/merge.js';

/** Items one call saves. Each is a few requests, run sequentially. */
export const MAX_EXTRACTION_ITEMS = 50;

const fieldInput = z.object({
  name: z.string().min(1).max(100).describe('Field name, e.g. "sample_size", "method", "country". The same name across papers makes one column.'),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.null()])
    .describe('The value you read from the paper. null removes the field from the saved extraction.'),
  quote: z
    .string()
    .optional()
    .describe('Verbatim passage the value rests on. Checked against the item\'s full text when there is one, and the verdict is stored.'),
  page: z.string().optional().describe('Page of the quote, as you read it (e.g. "4" or "4-5").'),
});

const itemInput = z.object({
  item_key: z.string().describe('8-character key of the paper (a regular item, not its PDF).'),
  fields: z.array(fieldInput).min(1).describe('The fields extracted from this paper.'),
});

type ItemInput = z.infer<typeof itemInput>;

interface ItemOutcome {
  item_key: string;
  status: 'created' | 'updated' | 'unchanged' | 'failed';
  note_key?: string;
  added?: string[];
  replaced?: FieldChange[];
  removed?: FieldChange[];
  kept?: string[];
  quotes?: { verified: number; notFound: number; unchecked: number };
  notFound?: string[];
  duplicates?: string[];
  error?: string;
}

const PAGE = 100;

/** The item's child notes holding an extraction for `schema`, oldest key first. */
async function existingNotes(w: LibraryWriter, itemKey: string, schema: string): Promise<Array<{ key: string; version: number; ex: Extraction }>> {
  const out: Array<{ key: string; version: number; ex: Extraction }> = [];
  for (let start = 0; ; start += PAGE) {
    const page = await w.getChildren(itemKey, { start, limit: PAGE });
    for (const raw of page.data ?? []) {
      const data = raw?.data ?? raw;
      if (data?.itemType !== 'note' || !hasExtractionTag(data)) continue;
      const ex = parseExtractionNote(String(data.note ?? ''));
      if (ex && ex.schema === schema) out.push({ key: raw.key ?? data.key, version: Number(raw.version ?? data.version), ex });
    }
    if (!page.data?.length || start + PAGE >= (page.totalResults ?? 0)) return out;
  }
}

const sameFields = (a: ExtractedField[], b: ExtractedField[]): boolean => JSON.stringify(a) === JSON.stringify(b);

async function verifyFields(ctx: ToolContext, lib: LibraryRef, item: ItemInput, verify: boolean): Promise<ExtractedField[]> {
  const quoted = item.fields.some((f) => f.value !== null && f.quote?.trim());
  let doc: DocumentText | undefined;
  let normalized: { text: string; pages?: string[] } | undefined;
  if (quoted && verify) {
    try {
      doc = await loadDocumentText(ctx, item.item_key, lib);
    } catch (e) {
      doc = { unavailable: `the full text could not be read (${(e as Error).message})` };
    }
    if (!('unavailable' in doc)) normalized = { text: normalizeForMatch(doc.text), pages: doc.pages?.map(normalizeForMatch) };
  }
  return item.fields
    .filter((f) => f.value !== null)
    .map((f) => {
      const field: ExtractedField = { name: f.name.trim(), value: f.value as FieldValue };
      const quote = f.quote?.trim();
      if (quote) {
        field.quote = quote;
        if (!verify) {
          field.check = 'unchecked';
          field.checkNote = 'verification was turned off';
        } else {
          Object.assign(field, checkQuote(quote, doc!, normalized));
        }
      }
      if (f.page?.trim()) field.page = f.page.trim();
      return field;
    });
}

function quoteCounts(fields: ExtractedField[]): { verified: number; notFound: number; unchecked: number } {
  return {
    verified: fields.filter((f) => f.check === 'verified').length,
    notFound: fields.filter((f) => f.check === 'not-found').length,
    unchecked: fields.filter((f) => f.check === 'unchecked').length,
  };
}

async function saveOne(
  w: LibraryWriter,
  schema: string,
  item: ItemInput,
  incoming: ExtractedField[],
  replaceAll: boolean,
): Promise<ItemOutcome> {
  const removals = item.fields.filter((f) => f.value === null).map((f) => f.name.trim());
  const problem = await parentProblem(w, item.item_key);
  if (problem) return { item_key: item.item_key, status: 'failed', error: problem.replace('no note was written', 'nothing was saved') };
  const quotes = quoteCounts(incoming);
  const notFound = incoming.filter((f) => f.check === 'not-found').map((f) => f.name);
  const extra = { quotes, ...(notFound.length ? { notFound } : {}) };
  for (let attempt = 0; ; attempt++) {
    const notes = await existingNotes(w, item.item_key, schema);
    const current = notes[0];
    const merged = mergeFields(current?.ex.fields ?? [], incoming, removals, replaceAll);
    const ex: Extraction = { schema, itemKey: item.item_key, updated: new Date().toISOString(), fields: merged.fields };
    const changes = {
      added: merged.added,
      replaced: merged.replaced,
      removed: merged.removed,
      kept: merged.kept,
      ...(notes.length > 1 ? { duplicates: notes.slice(1).map((n) => n.key) } : {}),
    };
    if (!current) {
      if (!merged.fields.length) return { item_key: item.item_key, status: 'unchanged', ...changes, ...extra };
      const result = await w.writeItems([
        { itemType: 'note', parentItem: item.item_key, note: extractionNoteHtml(ex), tags: [{ tag: EXTRACTION_TAG }] },
      ]);
      const written = result.successful[0];
      if (!written) {
        return { item_key: item.item_key, status: 'failed', error: result.failed[0]?.message ?? 'Zotero did not accept the note.' };
      }
      return { item_key: item.item_key, status: 'created', note_key: written.key, ...changes, ...extra };
    }
    if (sameFields(current.ex.fields, merged.fields)) {
      return { item_key: item.item_key, status: 'unchanged', note_key: current.key, ...changes, ...extra };
    }
    try {
      await w.patchItem(current.key, { note: extractionNoteHtml(ex) }, current.version);
      return { item_key: item.item_key, status: 'updated', note_key: current.key, ...changes, ...extra };
    } catch (e) {
      // Someone else saved the note in between: merge onto their copy once, never over it.
      if (attempt === 0 && e instanceof ZoteroApiError && e.status === 412) continue;
      throw e;
    }
  }
}

const saveExtraction: ToolDefinition = {
  name: 'zotero_save_extraction',
  title: 'Save structured fields extracted from papers',
  description:
    'Save a structured extraction (named fields with values, such as sample_size, method, country, outcome) for one or many papers, as a child note on each paper: a readable table plus a machine-readable copy, tagged "zoteus-extraction". Zotero has no custom fields; a note syncs and anyone can read it in Zotero. YOU read the paper (zotero_get_fulltext) and supply the values: this server has no language model. Give each value the verbatim `quote` it rests on, and its `page`: when the paper\'s full text is available (Zotero\'s index, or the PDF or EPUB itself) the quote is checked against it and the verdict ("verified", "not-found" or "unchecked", with the page it was found on when known) is stored beside the value. A quote that was not found is still saved, and named in the result, so you can correct it. `schema` names the extraction (e.g. "rct-review"): one note per paper and schema. Saving again for the same paper and schema UPDATES that note in place: fields you send replace fields of the same name, a null value removes a field, fields you do not mention are kept (pass `replace_all:true` to drop them), and the result lists every replaced and removed value with what it was. Nothing else in the library is touched. Read the extractions back as one table with zotero_extraction_table. Writes go to the running Zotero desktop app (Zotero 10+) for every library it holds, otherwise to the cloud Web API.',
  inputSchema: {
    schema: z
      .string()
      .min(1)
      .max(80)
      .describe('Name of the extraction schema, e.g. "rct-review". Papers saved under the same name form one table.'),
    items: z
      .array(itemInput)
      .min(1)
      .max(MAX_EXTRACTION_ITEMS)
      .describe(`One entry per paper, at most ${MAX_EXTRACTION_ITEMS}.`),
    replace_all: z
      .boolean()
      .optional()
      .describe('Drop fields already saved for a paper that this call does not mention (default false: they are kept).'),
    verify_quotes: z
      .boolean()
      .optional()
      .describe('Check each quote against the paper\'s full text (default true). Off skips reading the text and stores quotes as "unchecked".'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      schema: z.string().describe('The schema saved under.'),
      items: z
        .array(
          z
            .object({
              item_key: z.string().describe('The paper.'),
              status: z.string().describe('"created" (new note), "updated" (its note rewritten), "unchanged" (nothing differed), or "failed".'),
              note_key: z.string().optional().describe('Key of the extraction note.'),
              added: z.array(z.string()).optional().describe('Fields that were not in the note before.'),
              replaced: z
                .array(z.object({ name: z.string().describe('Field.'), previous: z.any().describe('Value before.'), value: z.any().describe('Value now.') }).passthrough())
                .optional()
                .describe('Fields whose saved entry this call replaced, with the value it held.'),
              removed: z
                .array(z.object({ name: z.string().describe('Field.'), previous: z.any().describe('Value removed.') }).passthrough())
                .optional()
                .describe('Fields removed from the note, by a null value or by replace_all.'),
              kept: z.array(z.string()).optional().describe('Fields already in the note that this call left as they were.'),
              quotes: z
                .object({
                  verified: z.number().describe('Quotes found in the full text.'),
                  notFound: z.number().describe('Quotes NOT found in the full text that was checked.'),
                  unchecked: z.number().describe('Quotes that could not be checked (no full text, too short, or verification off).'),
                })
                .passthrough()
                .optional()
                .describe('How the quotes sent in this call fared.'),
              notFound: z.array(z.string()).optional().describe('Fields whose quote was not found in the full text.'),
              duplicates: z.array(z.string()).optional().describe('Other extraction notes for the same paper and schema, left as they are.'),
              error: z.string().optional().describe('Why this paper failed.'),
            })
            .passthrough(),
        )
        .describe('One entry per paper, in the order given.'),
      saved: z.number().describe('Papers whose note was created or updated.'),
      failed: z.number().describe('Papers that failed.'),
      target: writeTarget,
    })
    .passthrough(),
  // Destructive in the sense client directories mean it: a saved value can be replaced, a field
  // removed with null, and replace_all drops what is not sent. The result returns every value
  // it replaced or removed, but being able to put something back does not make a write safe.
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const schema = String(args.schema).trim();
    if (!schema) return refusal('`schema` is empty. Name the extraction, e.g. "rct-review".');
    const items = args.items as ItemInput[];
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.item_key)) return refusal(`${item.item_key} appears twice in \`items\`. Send each paper once.`);
      seen.add(item.item_key);
      const names = item.fields.map((f) => f.name.trim());
      if (names.some((n) => !n)) return refusal(`A field name for ${item.item_key} is empty.`);
      const dupe = names.find((n, i) => names.indexOf(n) !== i);
      if (dupe) return refusal(`Field "${dupe}" appears twice for ${item.item_key}. Nothing was saved.`);
    }
    const lib = resolveLibrary(ctx, args);
    const verify = args.verify_quotes !== false;
    const prepared: ExtractedField[][] = [];
    for (const item of items) prepared.push(await verifyFields(ctx, lib, item, verify));

    return withLibraryWriter(ctx, lib, async (w) => {
      const outcomes: ItemOutcome[] = [];
      for (let i = 0; i < items.length; i++) {
        try {
          outcomes.push(await saveOne(w, schema, items[i]!, prepared[i]!, args.replace_all === true));
        } catch (e) {
          if (mustFallBack(e)) throw e;
          outcomes.push({ item_key: items[i]!.item_key, status: 'failed', error: (e as Error).message });
        }
      }
      const saved = outcomes.filter((o) => o.status === 'created' || o.status === 'updated').length;
      const failed = outcomes.filter((o) => o.status === 'failed').length;
      const unchanged = outcomes.filter((o) => o.status === 'unchanged').length;
      const replaced = outcomes.reduce((n, o) => n + (o.replaced?.length ?? 0) + (o.removed?.length ?? 0), 0);
      const notFound = outcomes.filter((o) => o.notFound?.length);
      const via = w.target === 'local' ? ' via the Zotero desktop app' : '';
      const summary =
        `Saved extraction "${schema}" for ${saved} of ${items.length} paper(s)${via}` +
        (unchanged ? `, ${unchanged} unchanged` : '') +
        (failed ? `, ${failed} failed (${outcomes.filter((o) => o.error).map((o) => `${o.item_key}: ${o.error}`).join('; ')})` : '') +
        '.' +
        (replaced ? ` ${replaced} previously saved value(s) were replaced or removed; see items[].replaced and items[].removed.` : '') +
        (notFound.length
          ? ` Quotes NOT found in the full text: ${notFound.map((o) => `${o.item_key} (${o.notFound!.join(', ')})`).join('; ')}.`
          : '');
      const result = ok({ schema, items: outcomes, saved, failed, target: w.target }, summary);
      return failed && !saved && !unchanged ? { ...result, isError: true } : result;
    });
  },
};

export default saveExtraction;
