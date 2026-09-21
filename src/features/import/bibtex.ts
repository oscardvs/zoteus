import { decodeLatex } from './latex.js';
import { parseBibtexNames, splitKeywords, type BibCreator, type BibRecord } from './record.js';

/**
 * A BibTeX parser, written here rather than delegated.
 *
 * The alternative was to require a Zotero translation-server, which is optional, off by
 * default, published as an arm64-only Docker image, and unreachable from a hosted
 * deployment. That put the single most-asked-for import behind a container build. BibTeX is
 * a small, well-specified format, so it is parsed in-repo and the translation-server stays
 * what it should be: a better path when it happens to be running.
 *
 * What is implemented: entries with `{}` or `()` delimiters, values in braces, in quotes or
 * bare, nested braces, backslash escapes, string concatenation with `#`, `@string` macros
 * (including the twelve month abbreviations BibTeX predefines), `@comment` and `@preamble`
 * skipping, and the LaTeX accent forms real exports contain (see ./latex.ts).
 *
 * What is NOT implemented, said plainly so nobody discovers it in their library: `crossref`
 * inheritance between entries (a `@inproceedings` that takes its `booktitle` from a
 * `@proceedings` entry keeps only its own fields), user-defined `\newcommand` macros, and
 * math mode. Each of those is reported as a warning on the entry it affects where it can be
 * detected, rather than silently producing a half-filled item.
 */

/** One entry exactly as the file wrote it: no field mapping, no decoding. */
export interface BibtexEntry {
  /** Entry type without the `@`, lower-cased: "article", "inproceedings", ... */
  type: string;
  /** Citation key, e.g. "lovelace1843". Empty when the entry carried none. */
  key: string;
  /** Field name (lower-cased) to its raw, still-LaTeX value. */
  fields: Record<string, string>;
}

export interface BibtexParseResult {
  entries: BibtexEntry[];
  warnings: string[];
}

/**
 * A lookup table that cannot answer with something it does not hold.
 *
 * Every table in this file is indexed by a name taken straight out of the file: an entry
 * type, a field name, a macro name. A plain object literal inherits from `Object.prototype`,
 * so `BIBTEX_TYPES['constructor']` answers with a function and the `??` fallback beside it
 * never fires. That is not theoretical: `title = constructor` (a bare value, which is how
 * BibTeX writes a macro reference) imported as the string "function Object() [native code]",
 * a field named `constructor` turned its value into an author, and `@constructor{...}`
 * skipped the "no Zotero equivalent" warning. A null prototype has nothing to inherit, so an
 * unknown name is simply unknown.
 */
function table<T>(entries: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, entries);
}

/** The month macros BibTeX defines for every file, so `month = jan` resolves with no `@string`. */
const MONTH_MACROS: Record<string, string> = table({
  jan: 'January',
  feb: 'February',
  mar: 'March',
  apr: 'April',
  may: 'May',
  jun: 'June',
  jul: 'July',
  aug: 'August',
  sep: 'September',
  oct: 'October',
  nov: 'November',
  dec: 'December',
});

const MONTH_NUMBERS: Record<string, string> = table({
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
});

function skipSpace(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i]!)) i++;
  return i;
}

/** What a group reader found: its text, where to carry on, and whether it ever closed. */
interface GroupRead {
  body: string;
  next: number;
  /** False when the delimiter was never closed, so `body` is only what could be salvaged. */
  closed: boolean;
}

/**
 * Where the next entry begins after `from`, or -1 when there is none.
 *
 * A line that starts with `@type{` is where an entry begins, and nothing a value contains
 * may run past it. That boundary does two things. It is where the parser recovers its
 * footing when a value's brace is never closed: without it, a single stray `{` in one title
 * swallowed the whole rest of the file into that one field, so a 200-entry .bib came back as
 * 3 entries, one with a 15 KB title, and the only warning said the entry "is not closed
 * properly" rather than that 197 entries had gone. And it is what keeps the parse linear: a
 * reader that scans to the end of the file before giving up costs the length of the file
 * once per broken entry, which on a file where every entry is broken is quadratic.
 *
 * The cost of the boundary is that a braced value containing a line of its own that looks
 * exactly like an entry opener ends there and is reported as unclosed. Nothing an exporter
 * writes looks like that, and the alternative is silence about real losses.
 *
 * It is computed ONCE per entry and handed down to every value reader. Computing it per
 * value looked the same and was not: each call scans forward to the next entry, so an entry
 * with many small values cost fields times distance-to-next-entry, and one 240 KB entry of
 * 40,000 fields took 3.5 s, a 2 MB one minutes, with the event loop blocked throughout.
 */
function nextEntryStart(s: string, from: number): number {
  const re = /\n[ \t]*@[A-Za-z]+[ \t]*[{(]/g;
  re.lastIndex = Math.max(0, from);
  const m = re.exec(s);
  return m ? m.index + m[0].lastIndexOf('@') : -1;
}

/** Where a value starting inside the entry that opens at `from` may run to, at most. */
function entryEnd(s: string, from: number): number {
  const boundary = nextEntryStart(s, from + 1);
  return boundary < 0 ? s.length : boundary;
}

/**
 * The body of a `{...}` or `(...)` group starting at `i`, and the index past its closer.
 * `end` is the entry boundary the group may not run past; see {@link nextEntryStart}.
 */
function readDelimited(s: string, i: number, open: string, close: string, end: number): GroupRead {
  let depth = 0;
  const start = i;
  for (; i < end; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return { body: s.slice(start + 1, i), next: i + 1, closed: true };
    }
  }
  // Unbalanced. The caller is told, so it can report what was lost instead of handing back a
  // field full of the rest of the file.
  return { body: s.slice(start + 1, end), next: end, closed: false };
}

/** A `"..."` value. Braces still nest inside it, so a quote inside `{}` does not end it. */
function readQuoted(s: string, i: number, end: number): GroupRead {
  let depth = 0;
  const start = ++i;
  for (; i < end; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '"' && depth === 0) return { body: s.slice(start, i), next: i + 1, closed: true };
  }
  // A stray `"` runs away exactly as a stray `{` does, and stops at the same boundary.
  return { body: s.slice(start, end), next: end, closed: false };
}

interface FieldRead {
  name: string;
  value: string;
  next: number;
  /** The delimiter that was never closed, when the value ran past the end of the entry. */
  unclosed?: '{' | '"';
}

/**
 * `name = value`, with `#` concatenation and `@string` macro substitution. `end` is the
 * boundary of the entry the field belongs to, past which no value may run.
 */
function readField(s: string, i: number, macros: Record<string, string>, end: number): FieldRead | null {
  i = skipSpace(s, i);
  const nameStart = i;
  while (i < s.length && !/[=,\s{}()]/.test(s[i]!)) i++;
  const name = s.slice(nameStart, i);
  if (!name) return null;
  i = skipSpace(s, i);
  if (s[i] !== '=') return null;
  i++;
  const parts: string[] = [];
  for (;;) {
    i = skipSpace(s, i);
    const c = s[i];
    if (c === '{' || c === '"') {
      const g = c === '{' ? readDelimited(s, i, '{', '}', end) : readQuoted(s, i, end);
      parts.push(g.body);
      i = g.next;
      // Nothing after an unclosed delimiter can be read as part of this field, so stop here
      // and let the caller decide what to keep and what to report.
      if (!g.closed) return { name, value: parts.join(''), next: i, unclosed: c };
    } else {
      const start = i;
      while (i < s.length && !/[,})#\s]/.test(s[i]!)) i++;
      const word = s.slice(start, i);
      if (!word) break;
      parts.push(macros[word.toLowerCase()] ?? word);
    }
    i = skipSpace(s, i);
    if (s[i] === '#') {
      i++;
      continue;
    }
    break;
  }
  return { name, value: parts.join(''), next: i };
}

/**
 * What to do with a field name that appears twice in one entry.
 *
 * BibTeX has no repeated fields: several authors go in ONE `author` field joined by " and ",
 * several keywords in one field. A file that repeats the field is malformed either way, and
 * the old behaviour, a plain overwrite, silently kept whichever value came last: `author={A
 * B}, author={C D}` imported one author and dropped the other without a word. Classic bibtex
 * keeps the first and warns about the extra; Zotero's own BibTeX translator keeps both
 * creators. Keeping both is what the user wanted, so a repeated creator or keyword field is
 * joined with the separator the format already uses for exactly that, and any other repeated
 * field keeps its first value, which is what bibtex itself does. Either way it is reported:
 * the one thing not to do is drop a name in silence.
 */
function mergeRepeatedField(name: string, previous: string, repeat: string, where: string, warnings: string[]): string {
  const isCreator = CREATOR_FIELDS[name] !== undefined;
  if (isCreator || name === 'keywords' || name === 'keyword') {
    const separator = isCreator ? ' and ' : previous.includes(';') || repeat.includes(';') ? '; ' : ', ';
    warnings.push(
      `${where}: the field "${name}" appears more than once, which BibTeX does not allow; the values were combined so that none was lost.`,
    );
    return `${previous}${separator}${repeat}`;
  }
  warnings.push(
    `${where}: the field "${name}" appears more than once, which BibTeX does not allow; the first value was kept and the later one ignored.`,
  );
  return previous;
}

/** Parse a whole .bib file into its entries, leaving every value in its original LaTeX. */
export function parseBibtex(text: string): BibtexParseResult {
  const entries: BibtexEntry[] = [];
  const warnings: string[] = [];
  const macros: Record<string, string> = table(MONTH_MACROS);
  const n = text.length;
  let i = 0;

  for (;;) {
    i = text.indexOf('@', i);
    if (i < 0) break;
    i++;
    const typeStart = i;
    while (i < n && /[A-Za-z]/.test(text[i]!)) i++;
    const type = text.slice(typeStart, i).toLowerCase();
    i = skipSpace(text, i);
    const open = text[i];
    if (open !== '{' && open !== '(') continue; // a stray "@" in a value or a comment
    const close = open === '{' ? '}' : ')';
    // One scan to the next entry, shared by every value in this one.
    const end = entryEnd(text, i);

    if (type === 'comment' || type === 'preamble') {
      const block = readDelimited(text, i, open, close, end);
      if (!block.closed) {
        warnings.push(`An @${type} block opens a "${open}" that is never closed; reading resumed at the next entry.`);
      }
      i = block.next;
      continue;
    }
    if (type === 'string') {
      const body = readDelimited(text, i, open, close, end);
      const field = readField(body.body, 0, macros, body.body.length);
      if (field && !field.unclosed) macros[field.name.toLowerCase()] = field.value;
      else warnings.push('An @string definition could not be read and was skipped.');
      i = body.next;
      continue;
    }

    i++; // past the opening delimiter
    let keyEnd = i;
    while (keyEnd < n && text[keyEnd] !== ',' && text[keyEnd] !== close) keyEnd++;
    const key = text.slice(i, keyEnd).trim();
    i = keyEnd;
    const where = `entry "${key || '(no key)'}" (@${type})`;
    // Null-prototype, so that `'constructor' in fields` answers about this file and not
    // about Object.prototype.
    const fields: Record<string, string> = Object.create(null);
    let unreadable: { field: string; opener: string; buried: number; resumed: boolean } | undefined;
    while (i < n && text[i] === ',') {
      i++;
      i = skipSpace(text, i);
      if (text[i] === close) break; // a trailing comma before the closing brace
      const fieldAt = i;
      const field = readField(text, i, macros, end);
      if (!field) break;
      if (field.unclosed) {
        // The value is not a value, it is the rest of the entry and possibly of the file.
        // Drop it rather than importing a title made of everything that followed, and count
        // the entries buried in it so the report can say what was actually lost.
        unreadable = {
          field: field.name,
          opener: field.unclosed,
          buried: (text.slice(fieldAt, field.next).match(/@[A-Za-z]+[ \t]*[{(]/g) ?? []).length,
          resumed: field.next < n,
        };
        i = field.next;
        break;
      }
      const name = field.name.toLowerCase();
      const previous = fields[name];
      if (previous === undefined) fields[name] = field.value;
      else fields[name] = mergeRepeatedField(name, previous, field.value, where, warnings);
      i = skipSpace(text, field.next);
    }
    if (unreadable) {
      warnings.push(
        `${where}: the value of "${unreadable.field}" opens a ${unreadable.opener === '"' ? 'quotation mark' : 'brace'} ` +
          'that is never closed, so that field and the rest of the entry could not be read. ' +
          (unreadable.resumed ? 'Reading resumed at the next entry. ' : 'Nothing after it in the file could be read. ') +
          (unreadable.buried
            ? `${unreadable.buried} further ${unreadable.buried === 1 ? 'entry was' : 'entries were'} inside what could not be read and ${unreadable.buried === 1 ? 'was' : 'were'} skipped. `
            : '') +
          'Balance the delimiter and import the file again.',
      );
    } else if (text[i] === close) i++;
    else warnings.push(`${where} is not closed properly; what was read of it was kept.`);
    entries.push({ type, key, fields });
  }

  if (!entries.length && /@\s*[A-Za-z]/.test(text)) {
    warnings.push('The payload looks like BibTeX but no complete entry could be read from it.');
  }
  return { entries, warnings };
}

/**
 * BibTeX entry type to CSL type.
 *
 * Hand-written because nothing publishes this table: Zotero's schema maps CSL to Zotero,
 * not BibTeX to anything. It is the only format-specific type table in the chain, and it is
 * deliberately short. An entry type absent from it becomes `document`, Zotero's own name for
 * "some other kind of thing", and the caller is told which entry that happened to rather
 * than being handed an item whose type was guessed.
 */
const BIBTEX_TYPES: Record<string, string> = table({
  article: 'article-journal',
  book: 'book',
  booklet: 'book',
  inbook: 'chapter',
  incollection: 'chapter',
  inproceedings: 'paper-conference',
  conference: 'paper-conference',
  proceedings: 'book',
  manual: 'report',
  mastersthesis: 'thesis',
  phdthesis: 'thesis',
  thesis: 'thesis',
  techreport: 'report',
  report: 'report',
  unpublished: 'manuscript',
  misc: 'document',
  online: 'webpage',
  electronic: 'webpage',
  www: 'webpage',
  patent: 'patent',
  dataset: 'dataset',
  software: 'software',
  video: 'motion_picture',
  audio: 'song',
  periodical: 'article-magazine',
  standard: 'standard',
  legislation: 'legislation',
  jurisdiction: 'legal_case',
  artwork: 'graphic',
  letter: 'personal_communication',
  collection: 'book',
  suppbook: 'chapter',
  mvbook: 'book',
});

/** BibTeX field to CSL variable. Fields absent from this table are kept in Extra. */
const BIBTEX_FIELDS: Record<string, string> = table({
  title: 'title',
  subtitle: 'title-subtitle',
  shorttitle: 'title-short',
  journal: 'container-title',
  journaltitle: 'container-title',
  shortjournal: 'journalAbbreviation',
  volume: 'volume',
  number: 'issue',
  issue: 'issue',
  pages: 'page',
  publisher: 'publisher',
  address: 'publisher-place',
  location: 'publisher-place',
  edition: 'edition',
  series: 'collection-title',
  abstract: 'abstract',
  doi: 'DOI',
  url: 'URL',
  isbn: 'ISBN',
  issn: 'ISSN',
  language: 'language',
  type: 'genre',
  institution: 'publisher',
  school: 'publisher',
  organization: 'publisher',
  howpublished: 'medium',
  chapter: 'chapter-number',
  pagetotal: 'number-of-pages',
  volumes: 'number-of-volumes',
  version: 'version',
  pmid: 'PMID',
  pmcid: 'PMCID',
});

/** Fields that describe the containing work rather than the entry itself. */
const CONTAINER_FIELDS = new Set(['booktitle', 'maintitle']);

const CREATOR_FIELDS: Record<string, string> = table({
  author: 'author',
  editor: 'editor',
  translator: 'translator',
  bookauthor: 'container-author',
  editora: 'editor',
  director: 'director',
  commentator: 'contributor',
});

/** `10--20` and `10-20` both mean the same span; Zotero stores the plain hyphen form. */
function normalisePages(value: string): string {
  return value.replace(/\s*(?:--+|[\u2013\u2014])\s*/g, '-').replace(/\s+/g, ' ').trim();
}

/** `year` plus `month` into the one date string Zotero keeps. */
function bibtexDate(fields: Record<string, string>): string | undefined {
  const explicit = (fields.date ?? '').trim();
  if (explicit) return decodeLatex(explicit);
  const year = decodeLatex(fields.year ?? '').trim();
  const rawMonth = (fields.month ?? '').trim();
  if (!year) return rawMonth ? decodeLatex(rawMonth) : undefined;
  if (!rawMonth) return year;
  const month = decodeLatex(rawMonth).trim();
  const numeric = /^\d{1,2}$/.test(month)
    ? month.padStart(2, '0')
    : MONTH_NUMBERS[month.slice(0, 3).toLowerCase()];
  return numeric ? `${year}-${numeric}` : `${month} ${year}`;
}

/** One parsed entry into the CSL-shaped record the Zotero mapper reads. */
export function bibtexEntryToRecord(entry: BibtexEntry, index: number): { record: BibRecord; warnings: string[] } {
  const warnings: string[] = [];
  const label = entry.key || `entry ${index + 1}`;
  const cslType = BIBTEX_TYPES[entry.type];
  if (!cslType) {
    warnings.push(
      `${label}: BibTeX type "@${entry.type}" has no Zotero equivalent, so it was imported as a generic document. ` +
        'Change its item type in Zotero if that is wrong.',
    );
  }
  const type = cslType ?? 'document';

  const fields: Record<string, string> = {};
  const creators: BibCreator[] = [];
  const tags: string[] = [];
  const extra: string[] = [];

  for (const [rawName, rawValue] of Object.entries(entry.fields)) {
    const name = rawName.toLowerCase();
    if (!rawValue.trim()) continue;
    if (name === 'year' || name === 'month' || name === 'date') continue; // folded into `issued`
    if (name === 'crossref') {
      warnings.push(
        `${label}: this entry inherits fields from "${decodeLatex(rawValue)}" via crossref, which is not resolved here, ` +
          'so any field it only had through the parent is missing.',
      );
      continue;
    }
    const creatorVariable = CREATOR_FIELDS[name];
    if (creatorVariable) {
      creators.push(...parseBibtexNames(rawValue, creatorVariable));
      continue;
    }
    if (name === 'keywords' || name === 'keyword') {
      tags.push(...splitKeywords(decodeLatex(rawValue)));
      continue;
    }
    if (CONTAINER_FIELDS.has(name)) {
      // `booktitle` is the container for a chapter or a conference paper, and the title
      // itself for a whole proceedings volume that carries no `title`.
      const target = entry.fields.title ? 'container-title' : 'title';
      fields[target] = decodeLatex(rawValue);
      continue;
    }
    const variable = BIBTEX_FIELDS[name];
    if (variable === 'page') {
      fields.page = normalisePages(decodeLatex(rawValue));
      continue;
    }
    if (variable === 'title-subtitle') {
      fields['title-subtitle'] = decodeLatex(rawValue);
      continue;
    }
    if (variable) {
      fields[variable] = decodeLatex(rawValue);
      continue;
    }
    // No CSL home. Zotero parks what it cannot model in Extra as `Name: value`, and so do
    // we: an `eprint` or an `annote` is worth more in Extra than dropped on the floor.
    extra.push(`${rawName}: ${decodeLatex(rawValue)}`);
  }

  // A subtitle is a BibLaTeX field with no Zotero counterpart; joining it onto the title is
  // what every exporter does, and losing it would lose half the name of the work.
  const subtitle = fields['title-subtitle'];
  if (subtitle) {
    delete fields['title-subtitle'];
    fields.title = fields.title ? `${fields.title}: ${subtitle}` : subtitle;
  }

  const date = bibtexDate(entry.fields);
  if (date) fields.issued = date;
  if (entry.key) fields['citation-key'] = entry.key;

  return { record: { cslType: type, fields, creators, tags, extra, label }, warnings };
}

/** Parse a .bib payload straight into records. */
export function bibtexToRecords(text: string): { records: BibRecord[]; warnings: string[] } {
  const parsed = parseBibtex(text);
  const warnings = [...parsed.warnings];
  const records: BibRecord[] = [];
  parsed.entries.forEach((entry, index) => {
    // One entry that cannot be turned into a record loses that entry, not the file. This is
    // what makes the promise in parse.ts true: whatever could be read comes back, with a
    // warning for what could not. Without it a single pathological value (a title nesting
    // accent groups thousands deep used to exhaust the stack) failed the whole import with
    // an internal message that named neither the entry nor anything to do about it.
    try {
      const mapped = bibtexEntryToRecord(entry, index);
      warnings.push(...mapped.warnings);
      records.push(mapped.record);
    } catch (e) {
      warnings.push(
        `${entry.key || `entry ${index + 1}`}: this entry could not be read and was skipped (${e instanceof Error ? e.message : String(e)}).`,
      );
    }
  });
  return { records, warnings };
}
