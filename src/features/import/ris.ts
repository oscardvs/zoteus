import { parseRisName, splitKeywords, type BibCreator, type BibRecord } from './record.js';

/**
 * An RIS parser.
 *
 * RIS is the format every database export button produces (Web of Science, Scopus, EBSCO,
 * PubMed, Endnote), so it is the one a migrating user actually has on disk. The grammar is
 * two lines deep: `TAG  - value`, a value that may continue on the following lines, and
 * `ER  -` to end a record. Tags repeat, and the repeats carry meaning (every `AU` is another
 * author, every `KW` another keyword).
 *
 * Tolerances that real files require: one space before the dash instead of two, a missing
 * trailing `ER`, a byte-order mark, CRLF line endings, and blank lines between records.
 */

/** One record: its `TY` and every tag it carried, each tag holding its values in order. */
export interface RisRecord {
  ty: string;
  tags: Record<string, string[]>;
}

export interface RisParseResult {
  records: RisRecord[];
  warnings: string[];
}

/** `TAG  - value`. Two spaces is the spec; one turns up often enough to accept. */
const TAG_LINE = /^([A-Z][A-Z0-9])\s{1,3}-\s?(.*)$/;

export function parseRis(text: string): RisParseResult {
  const records: RisRecord[] = [];
  const warnings: string[] = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);

  let current: RisRecord | null = null;
  let lastTag: string | null = null;

  const finish = (terminated: boolean): void => {
    if (!current) return;
    if (!terminated) {
      warnings.push(
        `RIS record ${records.length + 1} ("${current.tags.TI?.[0] ?? current.tags.T1?.[0] ?? 'untitled'}") has no ER line; ` +
          'it was read to the end of the file anyway.',
      );
    }
    records.push(current);
    current = null;
    lastTag = null;
  };

  for (const line of lines) {
    const match = TAG_LINE.exec(line);
    if (!match) {
      // A continuation of the previous value. A blank line is just spacing, not content.
      if (current && lastTag && line.trim()) {
        const values = current.tags[lastTag]!;
        values[values.length - 1] = `${values[values.length - 1]} ${line.trim()}`.trim();
      }
      continue;
    }
    const tag = match[1]!;
    const value = (match[2] ?? '').trim();
    if (tag === 'TY') {
      // A new record starting while one is still open means the previous had no ER.
      finish(false);
      current = { ty: value.toUpperCase(), tags: {} };
      lastTag = null;
      continue;
    }
    if (tag === 'ER') {
      finish(true);
      continue;
    }
    if (!current) {
      // A file whose first record has no TY line. Read it as a generic record rather than
      // dropping everything before the first tag we recognised.
      current = { ty: '', tags: {} };
    }
    (current.tags[tag] ??= []).push(value);
    lastTag = tag;
  }
  finish(false);

  if (!records.length && /^[A-Z][A-Z0-9]\s{1,3}-/m.test(text)) {
    warnings.push('The payload looks like RIS but no record could be read from it.');
  }
  return { records, warnings };
}

/**
 * A lookup table that cannot answer with something it does not hold.
 *
 * Every table below is indexed by a name out of the file. A plain object literal inherits
 * from `Object.prototype`, so a lookup can come back with an inherited member (a `Record`
 * whose key is `constructor` answers with a function) and the `??` fallback beside it never
 * fires. RIS tags are two characters and a `TY` is upper-cased, so this file is harder to
 * reach that way than the BibTeX one, but the tables are written the same way rather than
 * relying on that.
 */
function table<T>(entries: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, entries);
}

/**
 * RIS `TY` to CSL type. Hand-written for the same reason the BibTeX table is: nothing
 * publishes it. A `TY` absent from here becomes `document` and the caller is told.
 */
const RIS_TYPES: Record<string, string> = table({
  JOUR: 'article-journal',
  JFULL: 'article-journal',
  ABST: 'article-journal',
  INPR: 'article-journal',
  SER: 'article-journal',
  EJOUR: 'article-journal',
  MGZN: 'article-magazine',
  NEWS: 'article-newspaper',
  BOOK: 'book',
  EBOOK: 'book',
  EDBOOK: 'book',
  CHAP: 'chapter',
  ECHAP: 'chapter',
  CONF: 'paper-conference',
  CPAPER: 'paper-conference',
  THES: 'thesis',
  RPRT: 'report',
  GOVDOC: 'report',
  UNPB: 'manuscript',
  MANSCPT: 'manuscript',
  ELEC: 'webpage',
  WEB: 'webpage',
  BLOG: 'post-weblog',
  COMP: 'software',
  DATA: 'dataset',
  DBASE: 'dataset',
  PAT: 'patent',
  CASE: 'legal_case',
  STAT: 'legislation',
  BILL: 'bill',
  HEAR: 'hearing',
  MAP: 'map',
  ART: 'graphic',
  FIGURE: 'graphic',
  CHART: 'graphic',
  VIDEO: 'motion_picture',
  MPCT: 'motion_picture',
  SOUND: 'song',
  MUSIC: 'song',
  SLIDE: 'speech',
  ICOMM: 'personal_communication',
  PCOMM: 'personal_communication',
  STAND: 'standard',
  GEN: 'document',
});

/** Single-valued RIS tags whose CSL variable is fixed. */
const RIS_FIELDS: Record<string, string> = table({
  TI: 'title',
  T1: 'title',
  CT: 'title',
  T2: 'container-title',
  JO: 'container-title',
  JF: 'container-title',
  JA: 'journalAbbreviation',
  J1: 'journalAbbreviation',
  J2: 'journalAbbreviation',
  T3: 'collection-title',
  VL: 'volume',
  IS: 'issue',
  CP: 'issue',
  PB: 'publisher',
  CY: 'publisher-place',
  PP: 'publisher-place',
  AB: 'abstract',
  N2: 'abstract',
  DO: 'DOI',
  UR: 'URL',
  ET: 'edition',
  LA: 'language',
  M3: 'genre',
  SE: 'section',
  VO: 'volume',
  NV: 'number-of-volumes',
});

const RIS_CREATORS: Record<string, string> = table({
  AU: 'author',
  A1: 'author',
  A2: 'editor',
  A3: 'editor',
  A4: 'contributor',
  ED: 'editor',
  TA: 'translator',
});

/** Tags kept in Extra because Zotero has no field for them. */
const RIS_EXTRA_LABELS: Record<string, string> = table({
  AN: 'Accession Number',
  C1: 'Custom 1',
  DB: 'Database',
  DP: 'Database Provider',
  M1: 'Number',
  M2: 'Start Page',
  N1: 'Notes',
  RN: 'Research Notes',
  RI: 'Reviewed Item',
  ID: 'Citation Key',
  CN: 'Call Number',
});

/** The tags already consumed by a dedicated branch, so the catch-all leaves them alone. */
const HANDLED = new Set(['TY', 'ER', 'SP', 'EP', 'PY', 'Y1', 'DA', 'Y2', 'KW', 'SN', 'BT', 'L1', 'L2', 'L3', 'L4']);

/** RIS writes a date as `2020/07/03/` or `2020///`; Zotero wants the ISO prefix of that. */
function risDate(raw: string): string {
  const parts = raw.split('/').map((p) => p.trim());
  const kept: string[] = [];
  for (const part of parts.slice(0, 3)) {
    if (!part || !/^\d+$/.test(part)) break;
    kept.push(kept.length === 0 ? part : part.padStart(2, '0'));
  }
  if (kept.length) return kept.join('-');
  return raw.trim();
}

/** An ISSN looks like `1234-5678`; anything else in `SN` is an ISBN. */
function isIssn(value: string): boolean {
  return /^\d{4}-?\d{3}[\dxX]$/.test(value.replace(/\s/g, ''));
}

export function risRecordToRecord(record: RisRecord, index: number): { record: BibRecord; warnings: string[] } {
  const warnings: string[] = [];
  const first = (tag: string): string | undefined => record.tags[tag]?.[0]?.trim() || undefined;
  const label = first('ID') ?? first('TI') ?? first('T1') ?? `record ${index + 1}`;

  const cslType = RIS_TYPES[record.ty];
  if (!cslType) {
    warnings.push(
      record.ty
        ? `${label}: RIS type "TY  - ${record.ty}" has no Zotero equivalent, so it was imported as a generic document.`
        : `${label}: this record has no TY line, so it was imported as a generic document.`,
    );
  }

  const fields: Record<string, string> = {};
  const creators: BibCreator[] = [];
  const tags: string[] = [];
  const extra: string[] = [];
  /** Tags whose surplus values went to Extra, named once at the end rather than per value. */
  const parked = new Set<string>();

  for (const [tag, values] of Object.entries(record.tags)) {
    const creatorVariable = RIS_CREATORS[tag];
    if (creatorVariable) {
      for (const v of values) if (v.trim()) creators.push(parseRisName(v, creatorVariable));
      continue;
    }
    if (tag === 'KW') {
      for (const v of values) tags.push(...splitKeywords(v));
      continue;
    }
    if (HANDLED.has(tag)) continue;
    const variable = RIS_FIELDS[tag];
    if (variable) {
      // A single-valued tag that arrives twice, or two tags that mean the same CSL variable
      // (`AB` and `N2` are both the abstract, `JO` and `JF` both the journal), can only put
      // one value in the field. The rest used to be dropped on the floor, which lost a whole
      // structured abstract or an EBSCO permalink with nothing said. They go to Extra
      // instead, which is what the BibTeX leg and the CSL mapper already do with a value
      // that has no home. An exact repeat is not a loss: PubMed emits AB and N2 identically,
      // and every export mirrors TI into T1, so those are skipped rather than parked.
      for (const raw of values) {
        const value = raw.trim();
        if (!value) continue;
        if (fields[variable] === undefined) {
          fields[variable] = value;
          continue;
        }
        if (fields[variable] === value) continue;
        extra.push(`${tag}: ${value}`);
        parked.add(tag);
      }
      continue;
    }
    const extraLabel = RIS_EXTRA_LABELS[tag];
    for (const v of values) if (v.trim()) extra.push(`${extraLabel ?? tag}: ${v.trim()}`);
  }
  if (parked.size) {
    warnings.push(
      `${label}: ${[...parked].join(', ')} gave a second value for a field that was already filled, either by ` +
        'a repeat of the tag or by another tag meaning the same thing, so it was kept in Extra rather than dropped.',
    );
  }

  // `BT` is the book title: the record's own title for a whole book, the container for a
  // chapter or a conference paper.
  const bt = first('BT');
  if (bt) {
    if (fields.title) fields['container-title'] ??= bt;
    else fields.title = bt;
  }

  const sp = first('SP');
  const ep = first('EP');
  if (sp) fields.page = ep ? `${sp}-${ep}` : sp;

  const date = first('DA') ?? first('PY') ?? first('Y1');
  if (date) fields.issued = risDate(date);

  for (const sn of record.tags.SN ?? []) {
    const value = sn.trim();
    if (!value) continue;
    const variable = isIssn(value) ? 'ISSN' : 'ISBN';
    fields[variable] ??= value;
  }

  for (const link of [...(record.tags.L1 ?? []), ...(record.tags.L2 ?? []), ...(record.tags.L4 ?? [])]) {
    if (link.trim()) {
      warnings.push(
        `${label}: the record points at a local file (${link.trim()}), which is not fetched. ` +
          'Attach the file yourself with zotero_attach_file after the item exists.',
      );
    }
  }

  return {
    record: { cslType: cslType ?? 'document', fields, creators, tags, extra, label },
    warnings,
  };
}

/** Parse an .ris payload straight into records. */
export function risToRecords(text: string): { records: BibRecord[]; warnings: string[] } {
  const parsed = parseRis(text);
  const warnings = [...parsed.warnings];
  const records: BibRecord[] = [];
  parsed.records.forEach((record, index) => {
    // One record that cannot be read loses that record, not the file, which is what the
    // caller's docstring promises.
    try {
      const mapped = risRecordToRecord(record, index);
      warnings.push(...mapped.warnings);
      records.push(mapped.record);
    } catch (e) {
      warnings.push(
        `record ${index + 1}: this record could not be read and was skipped (${e instanceof Error ? e.message : String(e)}).`,
      );
    }
  });
  return { records, warnings };
}
