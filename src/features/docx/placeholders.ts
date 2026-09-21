/**
 * The `[[cite:KEY]]` placeholder language.
 *
 * The tool takes paragraphs the model already wrote and turns marked spots into live
 * fields. Keeping the language this small is deliberate: a placeholder names an item and
 * optionally a locator, and everything else about the citation (style, ordering,
 * disambiguation, the bibliography) is citeproc's job, not the caller's.
 *
 *   [[cite:ABCD1234]]              one item
 *   [[cite:ABCD1234,p. 12]]        with a locator, label parsed from the prefix
 *   [[cite:ABCD1234,12]]           a bare number means a page, which is Zotero's default
 *   [[cite:ABCD1234;EFGH5678]]     two items in ONE field, rendered as one cluster
 */

export const PLACEHOLDER_PATTERN = /\[\[cite:([^\]]*)\]\]/g;

/** The CSL locator terms, keyed by the abbreviations people actually type. */
const LOCATOR_LABELS: Record<string, string> = {
  bk: 'book',
  book: 'book',
  ch: 'chapter',
  chap: 'chapter',
  chapter: 'chapter',
  col: 'column',
  column: 'column',
  fig: 'figure',
  figure: 'figure',
  fol: 'folio',
  folio: 'folio',
  no: 'issue',
  issue: 'issue',
  l: 'line',
  line: 'line',
  n: 'note',
  note: 'note',
  op: 'opus',
  opus: 'opus',
  p: 'page',
  pp: 'page',
  page: 'page',
  pages: 'page',
  para: 'paragraph',
  paragraph: 'paragraph',
  pt: 'part',
  part: 'part',
  sec: 'section',
  section: 'section',
  sv: 'sub verbo',
  v: 'verse',
  verse: 'verse',
  vol: 'volume',
  volume: 'volume',
};

/** Symbols that stand in for a label, so "§5" and "¶3" do not become page numbers. */
const SYMBOL_LABELS: Record<string, string> = { '§': 'section', '¶': 'paragraph' };

export interface ParsedLocator {
  locator: string;
  label: string;
}

/**
 * Split "p. 12" into a CSL label and a locator.
 *
 * An unrecognised prefix is NOT silently dropped: it stays part of the locator string and
 * the label falls back to "page", because inventing a label for text we did not understand
 * would quietly change what the citation says.
 */
export function parseLocator(raw: string): ParsedLocator | undefined {
  const text = raw.trim();
  if (!text) return undefined;

  const symbol = SYMBOL_LABELS[text[0] as string];
  if (symbol) {
    const rest = text.slice(1).trim();
    return rest ? { locator: rest, label: symbol } : { locator: text, label: 'page' };
  }

  const match = /^([A-Za-z]+)\.?\s+(.+)$/.exec(text) ?? /^([A-Za-z]+)\.\s*(.+)$/.exec(text);
  if (match) {
    const label = LOCATOR_LABELS[match[1]!.toLowerCase()];
    if (label) return { locator: match[2]!.trim(), label };
  }
  return { locator: text, label: 'page' };
}

export interface PlaceholderItem {
  itemKey: string;
  locator?: string;
  label?: string;
}

export interface PlaceholderMatch {
  /** The whole `[[cite:...]]` text, so an unresolvable one can be left in place verbatim. */
  raw: string;
  items: PlaceholderItem[];
}

export type Segment = { type: 'text'; text: string } | { type: 'cite'; cite: PlaceholderMatch };

/** Zotero item keys are eight characters of uppercase letters and digits. */
const ITEM_KEY = /^[A-Za-z0-9]{8}$/;

function parseOne(body: string): PlaceholderItem | null {
  const comma = body.indexOf(',');
  const rawKey = (comma === -1 ? body : body.slice(0, comma)).trim();
  if (!rawKey) return null;
  // Models routinely lowercase a key they copied out of prose; both APIs are
  // case-sensitive, so normalise the shape Zotero actually uses and leave anything else
  // alone so it fails visibly as an unresolvable key rather than as a silent mismatch.
  const itemKey = ITEM_KEY.test(rawKey) ? rawKey.toUpperCase() : rawKey;
  if (comma === -1) return { itemKey };
  const locator = parseLocator(body.slice(comma + 1));
  return locator ? { itemKey, ...locator } : { itemKey };
}

/**
 * Split a paragraph into literal text and citation placeholders, in order.
 *
 * A placeholder with no usable item key is returned as literal text: a malformed
 * `[[cite:]]` should show up in the document where the author can see it, not disappear.
 */
export function parseParagraph(paragraph: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  PLACEHOLDER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_PATTERN.exec(paragraph)) !== null) {
    const items = match[1]!
      .split(';')
      .map((part) => parseOne(part))
      .filter((item): item is PlaceholderItem => item !== null);
    if (match.index > last) segments.push({ type: 'text', text: paragraph.slice(last, match.index) });
    if (items.length) segments.push({ type: 'cite', cite: { raw: match[0], items } });
    else segments.push({ type: 'text', text: match[0] });
    last = match.index + match[0].length;
  }
  if (last < paragraph.length) segments.push({ type: 'text', text: paragraph.slice(last) });
  return segments;
}

/** Every distinct item key referenced by these paragraphs, in first-appearance order. */
export function collectItemKeys(paragraphs: string[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const paragraph of paragraphs) {
    for (const segment of parseParagraph(paragraph)) {
      if (segment.type !== 'cite') continue;
      for (const item of segment.cite.items) {
        if (seen.has(item.itemKey)) continue;
        seen.add(item.itemKey);
        keys.push(item.itemKey);
      }
    }
  }
  return keys;
}
