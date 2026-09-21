import { splitKeywords, type BibCreator, type BibRecord } from './record.js';

/**
 * CSL-JSON into the shared record shape.
 *
 * This one is nearly a rename: the record shape IS CSL vocabulary, so the work here is
 * unwrapping the two shapes a CSL date takes, flattening the name objects, and refusing
 * anything that is not a list of objects. No format-specific type or field table is needed,
 * which is the whole reason the other two parsers translate into CSL first.
 */

/** A CSL date: `{"date-parts": [[2020, 7, 3]]}`, `{"raw": "..."}` or `{"literal": "..."}`. */
function cslDate(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const parts = v['date-parts'];
  if (Array.isArray(parts) && Array.isArray(parts[0])) {
    const first = (parts[0] as unknown[])
      .map((p) => (typeof p === 'number' ? String(p) : typeof p === 'string' ? p.trim() : ''))
      .filter(Boolean);
    if (first.length) {
      return first.map((p, i) => (i === 0 ? p : p.padStart(2, '0'))).join('-');
    }
  }
  const raw = v.raw ?? v.literal;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function cslCreators(variable: string, value: unknown): BibCreator[] {
  if (!Array.isArray(value)) return [];
  const out: BibCreator[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      out.push({ cslName: variable, literal: entry.trim() });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const literal = typeof e.literal === 'string' ? e.literal.trim() : '';
    if (literal) {
      out.push({ cslName: variable, literal });
      continue;
    }
    const family = typeof e.family === 'string' ? e.family.trim() : '';
    const given = typeof e.given === 'string' ? e.given.trim() : '';
    if (family || given) out.push({ cslName: variable, family: family || undefined, given: given || undefined });
  }
  return out;
}

/** CSL name variables, which is every key whose value is a list of name objects. */
const NAME_VARIABLES = new Set([
  'author',
  'chair',
  'collection-editor',
  'compiler',
  'composer',
  'container-author',
  'contributor',
  'curator',
  'director',
  'editor',
  'editorial-director',
  'executive-producer',
  'guest',
  'host',
  'illustrator',
  'interviewer',
  'narrator',
  'organizer',
  'original-author',
  'performer',
  'producer',
  'recipient',
  'reviewed-author',
  'script-writer',
  'series-creator',
  'translator',
]);

/** CSL date variables. */
const DATE_VARIABLES = new Set(['issued', 'accessed', 'submitted', 'original-date', 'event-date', 'available-date']);

/** Keys that are CSL bookkeeping rather than bibliographic content. */
const IGNORED = new Set(['id', 'type', 'schema', 'citation-key', 'custom', 'categories', 'journalAbbreviation-short']);

export interface CslJsonParseResult {
  records: BibRecord[];
  warnings: string[];
}

/**
 * Parse a CSL-JSON payload. Accepts a bare array (what Zotero's own csljson export produces
 * on the desktop) and a `{ "items": [...] }` wrapper (what the cloud export produces), which
 * are the two shapes already handled elsewhere in this server.
 */
export function cslJsonToRecords(text: string): CslJsonParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`The payload is not valid JSON (${e instanceof Error ? e.message : String(e)}).`);
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { items?: unknown }).items)
      ? ((parsed as { items: unknown[] }).items)
      : null;
  if (!list) {
    throw new Error('CSL-JSON must be an array of item objects, or an object with an `items` array.');
  }

  const warnings: string[] = [];
  const records: BibRecord[] = [];
  list.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      warnings.push(`entry ${index + 1} is not an object and was skipped.`);
      return;
    }
    const item = raw as Record<string, unknown>;
    const label =
      (typeof item.id === 'string' && item.id) ||
      (typeof item.title === 'string' && item.title) ||
      `entry ${index + 1}`;
    const cslType = typeof item.type === 'string' && item.type.trim() ? item.type.trim() : 'document';
    if (!(typeof item.type === 'string' && item.type.trim())) {
      warnings.push(`${label}: no CSL "type", so it was imported as a generic document.`);
    }

    const fields: Record<string, string> = {};
    const creators: BibCreator[] = [];
    const tags: string[] = [];
    const extra: string[] = [];

    for (const [key, value] of Object.entries(item)) {
      if (IGNORED.has(key)) continue;
      if (NAME_VARIABLES.has(key)) {
        creators.push(...cslCreators(key, value));
        continue;
      }
      if (DATE_VARIABLES.has(key)) {
        const date = cslDate(value);
        if (date) fields[key] = date;
        continue;
      }
      if (key === 'keyword') {
        if (typeof value === 'string') tags.push(...splitKeywords(value));
        else if (Array.isArray(value)) tags.push(...value.filter((v): v is string => typeof v === 'string'));
        continue;
      }
      if (typeof value === 'string' && value.trim()) fields[key] = value.trim();
      else if (typeof value === 'number') fields[key] = String(value);
      else if (value && typeof value === 'object') {
        // A nested object in a text position is not something CSL defines; keeping its JSON
        // in Extra loses nothing and invents nothing.
        extra.push(`${key}: ${JSON.stringify(value)}`);
      }
    }
    if (typeof item.id === 'string' && item.id.trim()) fields['citation-key'] ??= item.id.trim();

    records.push({ cslType, fields, creators, tags, extra, label });
  });

  return { records, warnings };
}
