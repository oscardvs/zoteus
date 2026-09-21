import { z } from 'zod';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { okLibraryContent } from '../registry/registry.js';
import { provenance } from './common-output.js';
import { callerRoot } from './caller-root.js';
import { resolveCallerPath, CallerPathError } from '../lib/caller-path.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const rowSchema = z.object({
  item_key: z.string().describe('8-character Zotero item key of the study.'),
  study: z.string().describe('How to label the study in the table, e.g. "Smith et al. (2019)".'),
  finding: z.string().describe('What this study found in relation to the question, in your words.'),
  quotation: z.string().optional().describe('Verbatim passage supporting the finding. Omit only when coverage is not "passage".'),
  page: z.string().optional().describe('Page locator for the quotation, as zotero_get_fulltext reported it.'),
  page_exact: z.boolean().optional().describe('True when the locator came from `page`, false when it came from `pageApprox`.'),
  coverage: z
    .enum(['passage', 'abstract-only', 'unavailable'])
    .describe('How well the source was actually read: "passage" (text retrieved), "abstract-only", or "unavailable".'),
  support: z
    .enum(['supported', 'contradicted', 'uncertain', 'unverified'])
    .describe('Your judgement of how the passage bears on the question. A row with no retrieved passage is "unverified".'),
  note: z.string().optional().describe('Caveat, uncertainty or scope limit worth carrying into the table.'),
});

type EvidenceRow = z.infer<typeof rowSchema>;

/** The published vocabulary, from docs/first-research-task.md and the zotero-citation-audit prompt. */
const COVERAGE_LABEL: Record<EvidenceRow['coverage'], string> = {
  passage: 'passage retrieved',
  'abstract-only': 'abstract only',
  unavailable: 'unavailable',
};

/**
 * A gap is rendered, never left blank. An empty cell reads as an oversight; these read as
 * what they are, which is the whole point of the Coverage column.
 */
const NO_QUOTATION = '(none retrieved)';
const NO_LOCATOR = '(none reported)';

/** Whether a cell carries actual text. An all-whitespace quotation is not a quotation. */
function filled(value: string | undefined): boolean {
  return Boolean(value && value.trim());
}

/**
 * A Markdown table cell.
 *
 * Two things break a GFM table row: an unescaped pipe, which starts a new column, and a
 * line break, which ends the row. A backslash is escaped first so that a literal `\|` in
 * the retrieved text survives as a literal `\|` rather than turning into a column break.
 *
 * This escapes what would break the TABLE, not everything Markdown reads: a quotation
 * containing asterisks still renders as emphasis. The text itself is never altered.
 */
function mdCell(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s*[\r\n]+\s*/g, ' ');
}

/** One line of prose outside a table still cannot carry a line break where a line is expected. */
function mdLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/**
 * The leading characters that make a spreadsheet read a cell as a formula rather than as
 * text. A tab or a carriage return is stripped before the cell is parsed, so a payload can
 * hide behind one.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** A value a spreadsheet reads as a number, and therefore never as a formula. */
function isNumeric(value: string): boolean {
  return value.trim() !== '' && Number.isFinite(Number(value));
}

/**
 * Whether this cell would execute when the file is opened.
 *
 * The quotations in this table come out of PDFs, which is to say out of documents written by
 * someone other than the reader: a downloaded preprint, an attachment in a shared group
 * library. `=HYPERLINK(...)`, `=IMPORTXML(...)` and the DDE `=cmd|...` forms are a passage of
 * text to Zoteus and a program to Excel, LibreOffice and Sheets, and RFC 4180 quoting is no
 * defence at all, because the spreadsheet unquotes the field before it decides what it is.
 *
 * A plain number is exempt: a page locator of `-5` or `+12` starts with a trigger character
 * but evaluates to itself, and marking it as text would cost the one column a researcher
 * sorts numerically, for no safety.
 */
function needsFormulaGuard(value: string): boolean {
  if (!FORMULA_LEAD.test(value)) return false;
  return !(/^[+-]/.test(value) && isNumeric(value));
}

/**
 * One RFC 4180 field: quoted when it contains a delimiter, a quote, a line break or
 * edge whitespace, with an embedded quote doubled.
 *
 * A cell that would otherwise be read as a formula gets the spreadsheet's own text marker, a
 * leading apostrophe, and is quoted unconditionally so the marker cannot be mistaken for part
 * of an unquoted value. Excel, LibreOffice and Sheets consume that apostrophe and display the
 * rest as the literal string, so the passage still reads as it was written: the only cell this
 * changes is one that was going to run rather than be read. Every such cell is named in
 * `warnings`, because a caller who promised a verbatim quotation should be able to see it.
 */
function csvField(value: string): string {
  const body = value.replace(/"/g, '""');
  if (needsFormulaGuard(value)) return `"'${body}"`;
  if (!/[",\r\n]/.test(value) && value === value.trim()) return value;
  return `"${body}"`;
}

/** The locator, plus whether it is a real page or a proportional estimate. Never one without the other. */
function locatorQuality(row: EvidenceRow): string {
  if (!filled(row.page)) return 'none';
  if (row.page_exact === true) return 'exact';
  if (row.page_exact === false) return 'approximate';
  return 'unspecified';
}

function locatorCell(row: EvidenceRow): string {
  if (!filled(row.page)) return NO_LOCATOR;
  const quality = locatorQuality(row);
  if (quality === 'unspecified') return `${row.page} (exact or approximate not stated)`;
  return `${row.page} (${quality})`;
}

/** The study label, with its item key, so a row can be traced back to the library. */
function studyCell(row: EvidenceRow): string {
  return row.study.includes(row.item_key) ? row.study : `${row.study} (${row.item_key})`;
}

/**
 * Rows that contradict their own evidence fields.
 *
 * Each one is a claim the row makes that the row's other fields do not support. They are
 * warnings rather than refusals: the table still renders, because the researcher fixing it
 * needs to see it, and because a half-covered table is a legitimate result.
 */
function rowWarnings(row: EvidenceRow, index: number): string[] {
  const out: string[] = [];
  const where = `Row ${index + 1} (${row.item_key})`;
  if (filled(row.page) && !filled(row.quotation)) {
    out.push(`${where}: a page locator is given with no quotation, so the locator points at text this table does not show.`);
  }
  if (row.coverage === 'passage' && !filled(row.quotation)) {
    out.push(`${where}: coverage says a passage was retrieved, but the row carries no quotation.`);
  }
  if (row.support === 'supported' && row.coverage === 'unavailable') {
    out.push(`${where}: support says "supported" while coverage says the source could not be read at all.`);
  }
  return out;
}

function warningsFor(rows: EvidenceRow[]): string[] {
  return rows.flatMap((row, i) => rowWarnings(row, i));
}

/** Rows carrying at least one warning. One row can trip more than one check, so this is not the warning count. */
function flaggedRowCount(rows: EvidenceRow[]): number {
  return rows.filter((row, i) => rowWarnings(row, i).length > 0).length;
}

function countCoverage(rows: EvidenceRow[]): { passage: number; abstractOnly: number; unavailable: number } {
  return {
    passage: rows.filter((r) => r.coverage === 'passage').length,
    abstractOnly: rows.filter((r) => r.coverage === 'abstract-only').length,
    unavailable: rows.filter((r) => r.coverage === 'unavailable').length,
  };
}

function coverageSentence(rows: EvidenceRow[]): string {
  const c = countCoverage(rows);
  const noun = rows.length === 1 ? 'row' : 'rows';
  return `${rows.length} ${noun}: ${c.passage} backed by a retrieved passage, ${c.abstractOnly} abstract only, ${c.unavailable} unavailable.`;
}

/**
 * The column set published in docs/first-research-task.md, unchanged. Notes is added only
 * when a row has one, so a table with no caveats does not carry an empty column.
 */
function renderMarkdown(question: string, rows: EvidenceRow[], warnings: string[]): string {
  const withNotes = rows.some((r) => filled(r.note));
  const headers = ['Study', 'Finding', 'Quotation', 'Locator', 'Coverage', 'Support'];
  if (withNotes) headers.push('Notes');
  const lines: string[] = [];
  lines.push(`**Evidence table: ${mdLine(question)}**`, '');
  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`|${headers.map(() => '---').join('|')}|`);
  for (const row of rows) {
    const cells = [
      mdCell(studyCell(row)),
      mdCell(row.finding),
      filled(row.quotation) ? mdCell(row.quotation!) : NO_QUOTATION,
      mdCell(locatorCell(row)),
      COVERAGE_LABEL[row.coverage],
      row.support,
    ];
    if (withNotes) cells.push(filled(row.note) ? mdCell(row.note!) : '');
    lines.push(`| ${cells.join(' | ')} |`);
  }
  lines.push('', `Coverage: ${coverageSentence(rows)}`);
  if (warnings.length) {
    lines.push('', 'Warnings:');
    for (const w of warnings) lines.push(`- ${w}`);
  }
  return lines.join('\n');
}

/**
 * The published column set. The locator is split into the page and its quality so a
 * spreadsheet can sort and filter on both, which is the reason to ask for CSV at all.
 */
const CSV_HEADER = ['Item key', 'Study', 'Finding', 'Quotation', 'Locator', 'Locator quality', 'Coverage', 'Support', 'Notes'];

/** One row's cells, in header order. The one place that mapping lives. */
function csvValues(row: EvidenceRow): string[] {
  return [
    row.item_key,
    row.study,
    row.finding,
    filled(row.quotation) ? row.quotation! : '',
    filled(row.page) ? row.page! : '',
    locatorQuality(row),
    COVERAGE_LABEL[row.coverage],
    row.support,
    filled(row.note) ? row.note! : '',
  ];
}

/**
 * RFC 4180, CRLF-terminated, with a fixed header. Nothing but the rows: a warning or a
 * caption in here would land in someone's spreadsheet as data.
 */
function renderCsv(rows: EvidenceRow[]): string {
  const lines = [CSV_HEADER.map(csvField).join(',')];
  for (const row of rows) lines.push(csvValues(row).map(csvField).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * The cells the CSV marked as text, named by row and column.
 *
 * The guard is silent in the file itself, which is the whole point of it, so it is said out
 * loud here instead: a researcher reading the table should know which cell arrived carrying
 * something a spreadsheet would have run.
 */
function guardWarnings(rows: EvidenceRow[]): string[] {
  const out: string[] = [];
  rows.forEach((row, i) => {
    const columns = csvValues(row)
      .map((value, c) => (needsFormulaGuard(value) ? CSV_HEADER[c]! : undefined))
      .filter((name): name is string => name !== undefined);
    if (!columns.length) return;
    const noun = columns.length === 1 ? 'cell' : 'cells';
    out.push(
      `Row ${i + 1} (${row.item_key}): the ${columns.join(' and ')} ${noun} would be read as a formula by a spreadsheet ` +
        '(the text begins with =, +, -, @ or a tab), so the CSV marks it as text with a leading apostrophe. The text is ' +
        'unchanged and displays as written; nothing runs when the file is opened.',
    );
  });
  return out;
}

/**
 * Render an evidence table the model has already gathered.
 *
 * Deliberately not a retrieval engine. The rows come from zotero_semantic_search and
 * zotero_get_fulltext, which already return passages with locators; what is missing is a
 * deterministic rendering of them, so a quotation cannot drift between the passage that was
 * retrieved and the cell that is shown, and a file the researcher can keep.
 */
const evidenceTable: ToolDefinition = {
  name: 'zotero_evidence_table',
  title: 'Render an evidence table',
  description:
    'Render rows of retrieved evidence as a Markdown or CSV table, deterministically, from passages you already retrieved with zotero_get_fulltext and zotero_semantic_search. This tool does NOT search and does NOT read the library: it formats what you pass it and echoes each row\'s quotation, locator and coverage back unchanged. It counts the coverage summary from the rows rather than taking your word for it, and it warns, naming the row, when a row contradicts its own evidence (a page locator with no quotation, coverage claiming a retrieved passage with no quotation, or a "supported" verdict on a source that could not be read); it warns and still renders, and never rewords a cell. One byte is added and only in CSV: a cell whose text begins with =, +, -, @ or a tab is a formula to Excel, LibreOffice and Sheets, so the CSV writes it with a leading apostrophe, the spreadsheet\'s own marker for literal text, which the spreadsheet consumes so the passage still displays exactly as it was retrieved; every such cell is named in `warnings`, and a plain number like a page locator of -5 is left alone. Markdown output carries no such marker. Use the `zotero-evidence-table` prompt to gather the rows first. Each row records one study against one question: the finding, the verbatim quotation that supports it, the page locator, whether that locator is exact or approximate, how well the source was covered (a passage was retrieved, only the abstract was available, or nothing was), and the support status. Returns the rendered table as text; pass `save_path` to also write it to a file.',
  inputSchema: {
    question: z.string().describe('The research question this table answers; it becomes the table caption.'),
    rows: z.array(rowSchema).min(1).describe('One row per study. Order is preserved.'),
    format: z.enum(['markdown', 'csv']).optional().describe('Rendering to produce (default "markdown").'),
    save_path: z
      .string()
      .optional()
      .describe('Write the rendered table to this file as well as returning it. Confined to this caller\'s own directory under the server data directory on a shared deployment.'),
    overwrite: z
      .boolean()
      .optional()
      .describe('Allow `save_path` to replace a file that already exists (default false).'),
  },
  outputSchema: z
    .object({
      question: z.string().describe('The question echoed back.'),
      format: z.string().describe('The rendering that was produced.'),
      table: z.string().describe('The rendered table, ready to paste or save.'),
      rowCount: z.number().describe('Rows rendered.'),
      coverage: z
        .object({
          passage: z.number().describe('Rows backed by a retrieved passage.'),
          abstractOnly: z.number().describe('Rows where only an abstract was available.'),
          unavailable: z.number().describe('Rows where the source could not be read at all.'),
        })
        .passthrough()
        .describe('How much of this table rests on text actually retrieved; the honesty summary for the whole answer.'),
      warnings: z
        .array(z.string())
        .optional()
        .describe(
          'Rows whose claims did not match their own evidence fields, named individually, plus (CSV only) any cell the file had to mark as text because a spreadsheet would have run it as a formula.',
        ),
      savedTo: z.string().optional().describe('Absolute path written, when `save_path` was given.'),
      provenance,
    })
    .passthrough(),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  handler: async (args, ctx) => {
    const rows = args.rows as EvidenceRow[];
    const question = args.question as string;
    const format: 'markdown' | 'csv' = args.format ?? 'markdown';

    // The path is resolved before anything is rendered: on a shared deployment it addresses
    // the operator's disk, not the caller's, and a refusal should cost nothing. The root it is
    // confined to is the caller's own subtree, not the whole data directory (see callerRoot):
    // one tenant writing a table into another tenant's directory, or learning from the
    // "already exists" refusal below what another tenant has saved, is not a file operation
    // anyone asked for.
    let savedTo: string | undefined;
    if (args.save_path) {
      const root = await callerRoot(ctx);
      try {
        savedTo = await resolveCallerPath(args.save_path as string, {
          dataDir: root,
          confined: ctx.remoteCaller,
          mode: 'write',
          argName: 'save_path',
          alternative: `Omit \`save_path\` and copy the rendered table out of the result instead, or choose a path inside \`${root}\`.`,
        });
      } catch (e) {
        if (e instanceof CallerPathError) return err(e.message);
        throw e;
      }
      if (!args.overwrite && existsSync(savedTo)) {
        return err(
          `\`${savedTo}\` already exists. Pass \`overwrite: true\` to replace it, or choose another \`save_path\`. Nothing was written.`,
        );
      }
    }

    const contradictions = warningsFor(rows);
    const flagged = flaggedRowCount(rows);
    const table = format === 'csv' ? renderCsv(rows) : renderMarkdown(question, rows, contradictions);
    // Only the CSV needs the formula guard, and only the CSV reports it: a Markdown table is
    // read, never evaluated, so the same cell is left exactly as it arrived there.
    const guarded = format === 'csv' ? guardWarnings(rows) : [];
    const warnings = [...contradictions, ...guarded];
    const coverage = countCoverage(rows);

    if (savedTo) {
      await mkdir(dirname(savedTo), { recursive: true });
      try {
        // Exclusive creation keeps overwrite:false safe if another call wins after the preview.
        await writeFile(savedTo, table, { flag: args.overwrite === true ? 'w' : 'wx' });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
          return err(`\`${savedTo}\` already exists. Pass \`overwrite: true\` to replace it, or choose another \`save_path\`. Nothing was written.`);
        }
        throw e;
      }
    }

    const summary =
      `Rendered ${rows.length} ${rows.length === 1 ? 'row' : 'rows'} as ${format}. Coverage: ${coverageSentence(rows)}` +
      (contradictions.length ? ` ${flagged === 1 ? '1 row contradicts its own evidence' : `${flagged} rows contradict their own evidence`} (${contradictions.length} ${contradictions.length === 1 ? 'warning' : 'warnings'}); see warnings.` : '') +
      (guarded.length ? ` ${guarded.length === 1 ? '1 row carries a cell' : `${guarded.length} rows carry a cell`} a spreadsheet would have run as a formula; marked as text in the CSV, see warnings.` : '') +
      (savedTo ? ` Written to ${savedTo}.` : '');

    return okLibraryContent(
      {
        question,
        format,
        table,
        rowCount: rows.length,
        coverage,
        ...(warnings.length ? { warnings } : {}),
        ...(savedTo ? { savedTo } : {}),
      },
      summary,
    );
  },
};

export default evidenceTable;
