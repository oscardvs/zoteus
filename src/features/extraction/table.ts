import type { ToolContext } from '../../registry/registry.js';
import type { LibraryRef } from '../../api/web-client.js';
import { yearKey } from '../resolve/library-census.js';
import { csvField, mdCell, needsFormulaGuard } from '../../tools/evidence-table.js';
import { EXTRACTION_TAG, checkLabel, formatValue, hasExtractionTag, parseExtractionNote, type ExtractedField, type Extraction } from './record.js';

/** Notes and items one table reads before it stops; the result says when it stopped. */
export const MAX_TABLE_NOTES = 5000;
export const MAX_SCOPE_ITEMS = 2000;
const PAGE = 100;

export interface FoundExtraction {
  noteKey: string;
  parentKey: string;
  ex: Extraction;
}

/** Every extraction note in `lib`, found by its tag: one listing, never one read per item. */
export async function listExtractionNotes(ctx: ToolContext, lib: LibraryRef): Promise<{ found: FoundExtraction[]; complete: boolean }> {
  const found: FoundExtraction[] = [];
  for (let start = 0; start < MAX_TABLE_NOTES; start += PAGE) {
    const page = await ctx.router.searchItems({ itemType: 'note', tag: EXTRACTION_TAG, limit: PAGE, start, library: lib });
    for (const raw of page.data ?? []) {
      const data = raw?.data ?? raw;
      if (!data?.parentItem || data.deleted || !hasExtractionTag(data)) continue;
      const ex = parseExtractionNote(String(data.note ?? ''));
      if (ex) found.push({ noteKey: raw.key ?? data.key, parentKey: data.parentItem, ex });
    }
    if (!page.data?.length || start + PAGE >= (page.totalResults ?? 0)) return { found, complete: true };
  }
  return { found, complete: false };
}

export interface PaperLabel {
  key: string;
  title?: string;
  creator?: string;
  year?: string;
  itemType?: string;
}

function labelOf(raw: any): PaperLabel {
  const d = raw?.data ?? raw ?? {};
  const first = Array.isArray(d.creators) ? d.creators[0] : undefined;
  const creator = first ? (first.lastName ?? first.name) : undefined;
  return {
    key: raw?.key ?? d.key,
    ...(d.title ? { title: String(d.title) } : {}),
    ...(creator ? { creator: String(creator) } : {}),
    ...(yearKey(d.date) ? { year: yearKey(d.date) } : {}),
    ...(d.itemType ? { itemType: String(d.itemType) } : {}),
  };
}

/** The papers a collection holds directly (top-level, not notes or attachments). */
export async function collectionPapers(ctx: ToolContext, lib: LibraryRef, collectionKey: string): Promise<{ papers: PaperLabel[]; complete: boolean }> {
  const papers: PaperLabel[] = [];
  for (let start = 0; start < MAX_SCOPE_ITEMS; start += PAGE) {
    const page = await ctx.router.searchItems({ collectionKey, top: true, limit: PAGE, start, library: lib });
    for (const raw of page.data ?? []) {
      const label = labelOf(raw);
      if (label.itemType === 'note' || label.itemType === 'attachment' || label.itemType === 'annotation') continue;
      papers.push(label);
    }
    if (!page.data?.length || start + PAGE >= (page.totalResults ?? 0)) return { papers, complete: true };
  }
  return { papers, complete: false };
}

/** Labels for item keys, 50 per request (the API's limit for `itemKey`). Unknown keys are absent. */
export async function labelsFor(ctx: ToolContext, lib: LibraryRef, keys: string[]): Promise<Map<string, PaperLabel>> {
  const out = new Map<string, PaperLabel>();
  for (let i = 0; i < keys.length; i += 50) {
    const group = keys.slice(i, i + 50);
    const page = await ctx.router.searchItems({ itemKey: group.join(','), limit: 50, library: lib });
    for (const raw of page.data ?? []) {
      const label = labelOf(raw);
      if (label.key) out.set(label.key, label);
    }
  }
  return out;
}

export function studyLabel(p: PaperLabel): string {
  const who = [p.creator, p.year ? `(${p.year})` : undefined].filter(Boolean).join(' ');
  return who || p.title || p.key;
}

export interface TableRow {
  paper: PaperLabel;
  noteKey: string;
  updated: string;
  fields: ExtractedField[];
  missingFields: string[];
}

/** Columns: `wanted` when given, else every field name in first-seen order. */
export function columnsFor(rows: Array<{ fields: ExtractedField[] }>, wanted?: string[]): string[] {
  if (wanted?.length) return [...new Set(wanted)];
  const cols: string[] = [];
  for (const r of rows) for (const f of r.fields) if (!cols.includes(f.name)) cols.push(f.name);
  return cols;
}

function cell(row: TableRow, col: string): ExtractedField | undefined {
  return row.fields.find((f) => f.name === col);
}

export function renderMarkdownTable(schema: string, columns: string[], rows: TableRow[], missing: PaperLabel[]): string {
  const headers = ['Study', ...columns];
  const lines = [`**Extraction: ${mdCell(schema)}**`, '', `| ${headers.map(mdCell).join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`];
  for (const row of rows) {
    const cells = [mdCell(`${studyLabel(row.paper)} (${row.paper.key})`)];
    for (const col of columns) {
      const f = cell(row, col);
      if (!f) cells.push('(missing)');
      else cells.push(mdCell(formatValue(f.value) + (f.check === 'not-found' ? ' [quote not found]' : '')));
    }
    lines.push(`| ${cells.join(' | ')} |`);
  }
  if (missing.length) {
    lines.push('', `No extraction saved for: ${missing.map((p) => `${mdCell(studyLabel(p))} (${p.key})`).join('; ')}.`);
  }
  return lines.join('\n');
}

/** Per field: value, quote, page and quote check, so a spreadsheet can filter on each. */
export function renderCsvTable(columns: string[], rows: TableRow[]): { csv: string; guarded: string[] } {
  const header = ['Item key', 'Study', 'Title'];
  for (const col of columns) header.push(col, `${col} quote`, `${col} page`, `${col} quote check`);
  const lines = [header.map(csvField).join(',')];
  const guarded: string[] = [];
  for (const row of rows) {
    const values = [row.paper.key, studyLabel(row.paper), row.paper.title ?? ''];
    for (const col of columns) {
      const f = cell(row, col);
      values.push(f ? formatValue(f.value) : '', f?.quote ?? '', f?.page ?? '', f ? checkLabel(f) : '');
    }
    const cols = values.flatMap((v, i) => (needsFormulaGuard(v) ? [header[i]!] : []));
    if (cols.length) guarded.push(`${row.paper.key}: ${cols.join(', ')}`);
    lines.push(values.map(csvField).join(','));
  }
  return { csv: `${lines.join('\r\n')}\r\n`, guarded };
}
