import { escapeHtml } from '../notes/markdown.js';
import { titleHtml, wrapNote } from '../notes/note-html.js';

/**
 * A structured extraction stored in Zotero: one child note per item and schema.
 *
 * Zotero has no custom fields, so the values live in a note, which syncs, shows up in the
 * item pane, and is readable by a person with no Zoteus at all. The note carries the same
 * extraction twice: a table for people, and a JSON block (inside `<pre>`, which the note
 * editor keeps as a code block) that zotero_extraction_table reads back. The JSON is the
 * copy Zoteus trusts; the note says so, so an edit made to the table alone is not mistaken
 * for one Zoteus will see.
 */

/** The tag every extraction note carries, so they can be listed without opening every note. */
export const EXTRACTION_TAG = 'zoteus-extraction';

/** Marks the JSON block as ours, so a code block a person pasted into a note is never misread. */
const MARKER = 'zoteus-extraction';
const FORMAT_VERSION = 1;

export type FieldValue = string | number | boolean;

/** How a field's source quote fared against the item's full text. */
export type QuoteCheck = 'verified' | 'not-found' | 'unchecked';

export interface ExtractedField {
  name: string;
  value: FieldValue;
  /** The passage the value was read from, as the caller supplied it. */
  quote?: string;
  /** The page the caller said the quote is on, as given. */
  page?: string;
  /** Present whenever `quote` is. */
  check?: QuoteCheck;
  /** Why a quote is unchecked, or what it was checked against. */
  checkNote?: string;
  /** The 1-based page the quote was found on, when the text came with real pages. */
  foundPage?: number;
}

export interface Extraction {
  schema: string;
  itemKey: string;
  /** ISO timestamp of the last save. */
  updated: string;
  fields: ExtractedField[];
}

const CHECK_LABEL: Record<QuoteCheck, string> = {
  verified: 'found in full text',
  'not-found': 'NOT found in full text',
  unchecked: 'not checked',
};

/** A field's quote check as one readable phrase, for the note table and the Markdown table. */
export function checkLabel(field: ExtractedField): string {
  if (!field.quote) return '';
  const base = CHECK_LABEL[field.check ?? 'unchecked'];
  if (field.check === 'verified' && field.foundPage) return `${base} (p. ${field.foundPage})`;
  if (field.check === 'unchecked' && field.checkNote) return `${base}: ${field.checkNote}`;
  return base;
}

export function formatValue(value: FieldValue): string {
  return typeof value === 'string' ? value : String(value);
}

/** The note's HTML: heading, a sentence on what this is, the table, then the JSON copy. */
export function extractionNoteHtml(ex: Extraction): string {
  const rows = ex.fields
    .map(
      (f) =>
        `<tr><td>${escapeHtml(f.name)}</td><td>${escapeHtml(formatValue(f.value))}</td>` +
        `<td>${escapeHtml(f.quote ?? '')}</td><td>${escapeHtml(f.page ?? '')}</td><td>${escapeHtml(checkLabel(f))}</td></tr>`,
    )
    .join('\n');
  const json = JSON.stringify({ [MARKER]: FORMAT_VERSION, ...ex }, null, 1);
  const body =
    titleHtml(`Extraction: ${ex.schema}`) +
    `<p>Structured extraction saved by Zoteus (schema "${escapeHtml(ex.schema)}", updated ${escapeHtml(ex.updated)}).</p>\n` +
    '<table>\n<tr><th>Field</th><th>Value</th><th>Source quote</th><th>Page</th><th>Quote check</th></tr>\n' +
    `${rows}\n</table>\n` +
    '<h2>Machine-readable copy</h2>\n' +
    '<p>zotero_extraction_table reads the block below, not the table above. Change values with zotero_save_extraction, ' +
    'or edit both together.</p>\n' +
    `<pre>${escapeHtml(json)}</pre>`;
  return wrapNote(body);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function isValue(v: unknown): v is FieldValue {
  return typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
}

/**
 * The extraction a note holds, or null when it holds none (any other note, or one whose JSON
 * block was damaged by hand). Tolerant of the note editor's rewriting: tags inside the block
 * (a `<code>` wrapper, `<br>` for line breaks) are dropped before the JSON is parsed.
 */
export function parseExtractionNote(html: string): Extraction | null {
  const blocks = html.match(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi) ?? [];
  for (const block of blocks) {
    const inner = block
      .replace(/^<pre\b[^>]*>/i, '')
      .replace(/<\/pre>$/i, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '');
    let parsed: any;
    try {
      parsed = JSON.parse(decodeEntities(inner));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || parsed[MARKER] !== FORMAT_VERSION) continue;
    if (typeof parsed.schema !== 'string' || !Array.isArray(parsed.fields)) continue;
    const fields: ExtractedField[] = [];
    for (const f of parsed.fields) {
      if (!f || typeof f.name !== 'string' || !isValue(f.value)) continue;
      const field: ExtractedField = { name: f.name, value: f.value };
      if (typeof f.quote === 'string') field.quote = f.quote;
      if (typeof f.page === 'string') field.page = f.page;
      if (f.check === 'verified' || f.check === 'not-found' || f.check === 'unchecked') field.check = f.check;
      if (typeof f.checkNote === 'string') field.checkNote = f.checkNote;
      if (typeof f.foundPage === 'number') field.foundPage = f.foundPage;
      fields.push(field);
    }
    return {
      schema: parsed.schema,
      itemKey: typeof parsed.itemKey === 'string' ? parsed.itemKey : '',
      updated: typeof parsed.updated === 'string' ? parsed.updated : '',
      fields,
    };
  }
  return null;
}

/** Whether a note record carries the extraction tag. */
export function hasExtractionTag(data: any): boolean {
  return Array.isArray(data?.tags) && data.tags.some((t: any) => t?.tag === EXTRACTION_TAG);
}
