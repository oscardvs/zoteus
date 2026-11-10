import { z } from 'zod';
import type { ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { okLibraryContent, resolveLibrary } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { provenance } from './common-output.js';
import {
  collectionPapers,
  columnsFor,
  labelsFor,
  listExtractionNotes,
  renderCsvTable,
  renderMarkdownTable,
  studyLabel,
  MAX_SCOPE_ITEMS,
  MAX_TABLE_NOTES,
  type FoundExtraction,
  type PaperLabel,
  type TableRow,
} from '../features/extraction/table.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const fieldOut = z
  .object({
    name: z.string().describe('Field name.'),
    value: z.any().describe('The saved value (string, number or boolean).'),
    quote: z.string().optional().describe('The source quote saved with it.'),
    page: z.string().optional().describe('The page given for the quote.'),
    check: z.string().optional().describe('"verified", "not-found" or "unchecked": how the quote fared against the full text when it was saved.'),
    checkNote: z.string().optional().describe('What it was checked against, or why it was not.'),
    foundPage: z.number().optional().describe('Page the quote was found on, when known.'),
  })
  .passthrough();

const extractionTable: ToolDefinition = {
  name: 'zotero_extraction_table',
  title: 'Gather saved extractions into one table',
  description:
    'Read every extraction saved with zotero_save_extraction for a collection, for given items, or for the whole library, and lay them out as ONE table: a row per paper, a column per field. Read-only. Returns the rows as structured data (each value with its saved quote, page and quote check), plus the same table as Markdown and as CSV text (each field gets value, quote, page and quote-check columns there, so a spreadsheet can filter on them). Gaps are listed, not hidden: `missingItems` names papers in the collection or in `item_keys` with no extraction saved under this schema, and `missingFields` names, per paper, the columns it has no value for. Values whose quote was NOT found in the paper\'s full text are marked "[quote not found]" in the Markdown. Omit `schema` when the library holds only one; otherwise the refusal lists the schemas found. Child notes are found by their "zoteus-extraction" tag, so a note whose tag was removed is not read.',
  inputSchema: {
    schema: z.string().optional().describe('The extraction schema to tabulate, as given to zotero_save_extraction. Optional when only one exists in scope.'),
    collection_key: z.string().optional().describe('Tabulate the papers filed directly in this collection.'),
    item_keys: z.array(z.string()).max(MAX_SCOPE_ITEMS).optional().describe('Tabulate these papers. Omit both this and collection_key for every extraction in the library.'),
    fields: z
      .array(z.string())
      .optional()
      .describe('Columns to show, in this order. Default: every field found, in first-seen order.'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      schema: z.string().describe('The schema tabulated.'),
      columns: z.array(z.string()).describe('The field columns, in order.'),
      rows: z
        .array(
          z
            .object({
              item_key: z.string().describe('The paper.'),
              study: z.string().describe('Short label: first author and year, or the title.'),
              title: z.string().optional().describe('The paper\'s title.'),
              note_key: z.string().describe('The extraction note it was read from.'),
              updated: z.string().describe('When the extraction was last saved.'),
              fields: z.array(fieldOut).describe('The saved fields, in column order, only those present.'),
            })
            .passthrough(),
        )
        .describe('One row per paper with an extraction.'),
      missingItems: z
        .array(z.object({ item_key: z.string().describe('The paper.'), study: z.string().describe('Its label.') }).passthrough())
        .describe('Papers in scope with no extraction saved under this schema (or keys that name no item).'),
      missingFields: z
        .array(z.object({ item_key: z.string().describe('The paper.'), fields: z.array(z.string()).describe('Columns it lacks.') }).passthrough())
        .describe('Per paper, the columns it has no value for.'),
      duplicates: z.array(z.string()).optional().describe('Extraction notes skipped because the same paper had another note for this schema (the most recently saved is used).'),
      markdown: z.string().describe('The table as Markdown, ready to paste.'),
      csv: z.string().describe('The table as RFC 4180 CSV; per field a value, quote, page and quote-check column.'),
      truncated: z.boolean().optional().describe(`True when the scan stopped at its cap (${MAX_TABLE_NOTES} notes or ${MAX_SCOPE_ITEMS} collection items).`),
      warnings: z.array(z.string()).optional().describe('CSV cells marked as text because a spreadsheet would have run them as a formula.'),
      provenance,
    })
    .passthrough(),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    if (args.collection_key && args.item_keys?.length) return err('Pass `collection_key` or `item_keys`, not both.');
    const lib = resolveLibrary(ctx, args);
    const listed = await listExtractionNotes(ctx, lib);
    let truncated = !listed.complete;

    let scope: PaperLabel[] | undefined;
    if (args.collection_key) {
      const c = await collectionPapers(ctx, lib, args.collection_key);
      scope = c.papers;
      truncated ||= !c.complete;
    } else if (args.item_keys?.length) {
      const keys = [...new Set(args.item_keys as string[])];
      const labels = await labelsFor(ctx, lib, keys);
      scope = keys.map((k) => labels.get(k) ?? { key: k });
    }
    const inScope = scope ? new Set(scope.map((p) => p.key)) : undefined;
    const candidates = listed.found.filter((f) => !inScope || inScope.has(f.parentKey));

    let schema = typeof args.schema === 'string' ? args.schema.trim() : '';
    if (!schema) {
      const names = [...new Set(candidates.map((f) => f.ex.schema))];
      if (names.length === 1) schema = names[0]!;
      else if (!names.length) return err('No saved extraction was found in this scope. Save some with zotero_save_extraction first.');
      else return err(`Several extraction schemas exist in this scope: ${names.map((n) => `"${n}"`).join(', ')}. Pass \`schema\` to pick one.`);
    }

    // One row per paper: when a paper has two notes for the schema, the latest save wins.
    const byPaper = new Map<string, FoundExtraction>();
    const duplicates: string[] = [];
    for (const f of candidates.filter((c) => c.ex.schema === schema)) {
      const prev = byPaper.get(f.parentKey);
      if (!prev) byPaper.set(f.parentKey, f);
      else if (f.ex.updated > prev.ex.updated) {
        duplicates.push(prev.noteKey);
        byPaper.set(f.parentKey, f);
      } else duplicates.push(f.noteKey);
    }

    const order = scope ? scope.map((p) => p.key).filter((k) => byPaper.has(k)) : [...byPaper.keys()];
    const labels = scope
      ? new Map(scope.map((p) => [p.key, p]))
      : await labelsFor(ctx, lib, order);
    const columns = columnsFor(order.map((k) => byPaper.get(k)!.ex), args.fields as string[] | undefined);
    const rows: TableRow[] = order.map((k) => {
      const f = byPaper.get(k)!;
      const fields = columns.flatMap((c) => f.ex.fields.filter((x) => x.name === c).slice(0, 1));
      return {
        paper: labels.get(k) ?? { key: k },
        noteKey: f.noteKey,
        updated: f.ex.updated,
        fields,
        missingFields: columns.filter((c) => !fields.some((x) => x.name === c)),
      };
    });
    const missing = scope ? scope.filter((p) => !byPaper.has(p.key)) : [];
    const markdown = renderMarkdownTable(schema, columns, rows, missing);
    const { csv, guarded } = renderCsvTable(columns, rows);
    const warnings = guarded.map((g) => `CSV cells marked as text with a leading apostrophe (a spreadsheet would run them as formulas): ${g}.`);

    const gaps = rows.filter((r) => r.missingFields.length).length;
    const summary =
      `Extraction "${schema}": ${rows.length} paper(s), ${columns.length} field(s).` +
      (missing.length ? ` ${missing.length} paper(s) in scope have no extraction saved.` : '') +
      (gaps ? ` ${gaps} row(s) lack at least one field.` : '') +
      (duplicates.length ? ` ${duplicates.length} older duplicate note(s) skipped.` : '') +
      (truncated ? ' The scan stopped at its cap, so the table may be incomplete.' : '');
    return okLibraryContent(
      {
        schema,
        columns,
        rows: rows.map((r) => ({
          item_key: r.paper.key,
          study: studyLabel(r.paper),
          ...(r.paper.title ? { title: r.paper.title } : {}),
          note_key: r.noteKey,
          updated: r.updated,
          fields: r.fields,
        })),
        missingItems: missing.map((p) => ({ item_key: p.key, study: studyLabel(p) })),
        missingFields: rows.filter((r) => r.missingFields.length).map((r) => ({ item_key: r.paper.key, fields: r.missingFields })),
        ...(duplicates.length ? { duplicates } : {}),
        markdown,
        csv,
        ...(truncated ? { truncated } : {}),
        ...(warnings.length ? { warnings } : {}),
      },
      summary,
    );
  },
};

export default extractionTable;
