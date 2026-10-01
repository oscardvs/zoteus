import { decodeLatex, splitTopLevel } from './latex.js';

/**
 * The one shape every bibliographic format is parsed into before anything Zotero-specific
 * happens.
 *
 * It is CSL-shaped on purpose. Zotero publishes a CSL mapping in its own global schema
 * (`csl.types`, `csl.fields`, `csl.names` at https://api.zotero.org/schema), so a record
 * expressed in CSL vocabulary can be turned into Zotero item-data by table lookup rather
 * than by a second hand-written mapping per format. The BibTeX-to-CSL and RIS-to-CSL legs
 * are hand-written because nothing publishes those, but they are the only hand-written
 * tables in the chain, and the Zotero-side names all come from the schema.
 */
export interface BibRecord {
  /** CSL item type, e.g. "article-journal". */
  cslType: string;
  /** CSL variable name to value, e.g. "container-title" -> "Nature". */
  fields: Record<string, string>;
  /** Creators, keyed by CSL name variable ("author", "editor", "translator", ...). */
  creators: BibCreator[];
  /** Keywords, which become Zotero tags. */
  tags: string[];
  /** Lines to append verbatim to Zotero's Extra field. */
  extra: string[];
  /** How to name this record in a message: a citation key, or "entry 3". */
  label: string;
}

export interface BibCreator {
  /** CSL name variable: "author", "editor", "container-author", ... */
  cslName: string;
  family?: string;
  given?: string;
  /** A single-field name (an organisation, or a name that could not be split). */
  literal?: string;
}

/** True when the whole value is one brace group, which BibTeX uses for an organisation. */
function isFullyBraced(s: string): boolean {
  if (!s.startsWith('{') || !s.endsWith('}')) return false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i === s.length - 1;
    }
  }
  return false;
}

/**
 * One BibTeX name into its parts.
 *
 * BibTeX writes a name in one of three ways and they mean different things:
 * `"Lovelace, Ada"` (family first), `"Ada Lovelace"` (given first), and `"{CERN}"` (one
 * field, an organisation). The third is why the braces have to survive the parser: dropping
 * them earlier would turn an institution into a person with the surname "CERN".
 *
 * The given-first form is split at the first lower-case word, which is the BibTeX rule for
 * a "von" particle ("Ludwig van Beethoven" is van Beethoven, Ludwig). Everything before it
 * is the given name. A single word is taken as a family name.
 */
export function parseBibtexName(raw: string, cslName: string): BibCreator {
  const t = raw.trim();
  if (!t) return { cslName, literal: '' };
  if (isFullyBraced(t)) return { cslName, literal: decodeLatex(t) };

  const commaParts = splitTopLevel(t, ',');
  if (commaParts.length >= 2) {
    const family = decodeLatex(commaParts[0]!);
    // "Family, Jr, Given" puts the suffix in the middle; Zotero has no suffix field, so it
    // rides with the given name rather than being dropped.
    const given = commaParts
      .slice(1)
      .map((p) => decodeLatex(p))
      .filter(Boolean)
      .reverse()
      .join(' ');
    return { cslName, family, given: given || undefined };
  }

  const words = t.split(/\s+/).filter(Boolean);
  if (words.length === 1) return { cslName, family: decodeLatex(words[0]!) };
  let familyStart = words.length - 1;
  for (let k = 0; k < words.length - 1; k++) {
    if (/^[a-z]/.test(words[k]!.replace(/[{\\]/g, ''))) {
      familyStart = k;
      break;
    }
  }
  return {
    cslName,
    family: decodeLatex(words.slice(familyStart).join(' ')),
    given: decodeLatex(words.slice(0, familyStart).join(' ')) || undefined,
  };
}

/** Every name in a BibTeX creator field, split on the ` and ` that is not inside braces. */
export function parseBibtexNames(raw: string, cslName: string): BibCreator[] {
  return splitTopLevel(raw, /\s+and\s+/i)
    .map((n) => n.trim())
    .filter(Boolean)
    .map((n) => parseBibtexName(n, cslName));
}

/**
 * One RIS name. RIS specifies "Family, Given, Suffix" and exporters mostly obey, but a
 * plain "Ada Lovelace" turns up often enough that the comma-less form has to work too.
 * No LaTeX decoding: RIS is already plain text, so a backslash in it is a backslash.
 */
export function parseRisName(raw: string, cslName: string): BibCreator {
  const t = raw.trim();
  if (!t) return { cslName, literal: '' };
  const parts = t.split(',').map((p) => p.trim());
  if (parts.length >= 2 && parts[0]) {
    const given = parts.slice(1).filter(Boolean).join(' ');
    return { cslName, family: parts[0], given: given || undefined };
  }
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return { cslName, literal: t };
  return { cslName, family: words[words.length - 1]!, given: words.slice(0, -1).join(' ') };
}

/**
 * The Extra label a citation key travels under when it has no field of its own, which is how
 * Zotero itself and Better BibTeX have long written one ("Citation Key: lovelace1843"), and
 * how the RIS leg keeps an `ID` tag. A line under it is bookkeeping, not bibliographic content.
 */
export const CITATION_KEY_EXTRA_LABEL = 'Citation Key';

const CITATION_KEY_LINE = new RegExp(`^${CITATION_KEY_EXTRA_LABEL}:`, 'i');

/**
 * An entry reduced to the four facts the empty-entry rule reads. The two checks below each
 * know their own shape (a record from Zoteus's own parsers, or Zotero item JSON from a
 * translation-server) and hand this to {@link emptyEntryReason}, which holds the rule and its
 * wording once, so "a citation key and keywords are not a work" cannot come to mean one thing
 * on one import path and something else on the other.
 */
interface EntryContent {
  /** A title, a named creator, or any field other than the citation key. */
  substantive: boolean;
  /** Its Extra lines: one that is not the citation key is content, the key line is not. */
  extra: readonly string[];
  /** A citation key held in a field of its own rather than in Extra. */
  keyField: boolean;
  /** Any keyword (tag). */
  keywords: boolean;
}

/**
 * The empty-entry rule itself, and the reason reported in `skipped` when it applies. `remedy`
 * is the closing sentence, which depends on who read the entry and what they can say about it.
 */
function emptyEntryReason(content: EntryContent, remedy: string): string | undefined {
  const lines = content.extra.map((line) => line.trim()).filter(Boolean);
  if (content.substantive || lines.some((line) => !CITATION_KEY_LINE.test(line))) return undefined;
  // Every Extra line left is a citation key line, so any line at all means a key.
  const had = [
    content.keyField || lines.length ? 'a citation key' : '',
    content.keywords ? 'keywords' : '',
  ].filter(Boolean);
  return (
    'nothing usable could be read from this entry: no title, no creators and no other field' +
    (had.length ? ` (only ${had.join(' and ')})` : '') +
    `, so it was not turned into an item, which would have been empty. ${remedy}`
  );
}

/**
 * Why a record would become an empty item, or undefined when it holds something worth saving.
 *
 * "Something" is deliberately little: a title, one named creator, any field other than the
 * citation key, or any Extra line other than the citation key. Keywords alone do not count,
 * since tags name what a work is about, not which work it is. What is left when all of that is
 * missing is a record that was opened and never filled, which in practice means the parser
 * could not read the entry: a brace that never closed swallowed every field, a missing comma
 * after the key folded the fields into it, or an RIS record held nothing between its TY and
 * its ER. Until the 2026-10-01 stress test such a record still became an item, a `document`
 * (or whatever its type said) carrying at most a citation key, and the warning that explained
 * the broken entry sat beside an `items` list that contained it, ready to be saved as a blank
 * row in the library. The reason returned here is what the import reports in `skipped`.
 */
export function emptyRecordReason(record: BibRecord): string | undefined {
  return emptyEntryReason(
    {
      substantive:
        Object.entries(record.fields).some(([name, value]) => name !== 'citation-key' && value.trim()) ||
        record.creators.some((c) => c.family || c.given || c.literal),
      extra: record.extra,
      keyField: Boolean(record.fields['citation-key']?.trim()),
      keywords: record.tags.some((t) => t.trim()),
    },
    'The warnings say what went wrong in the entry when the parser could tell; fix it and import the file again.',
  );
}

/**
 * Item JSON keys that say nothing about which work an item is. `itemType` is always there;
 * `tags` are keywords, which {@link emptyEntryReason} weighs on its own; `collections` and
 * `relations` are where an item is filed and what it links to; `key`, `version`,
 * `dateAdded` and `dateModified` are the bookkeeping a translation-server stamps on every
 * item it returns; `citationKey` is the key in a field of its own. `creators` and `extra`
 * are read separately, since a named creator is content and an Extra line may be.
 */
const NOT_CONTENT = new Set([
  'itemType',
  'tags',
  'collections',
  'relations',
  'key',
  'version',
  'dateAdded',
  'dateModified',
  'citationKey',
  'creators',
  'extra',
]);

/** True when a JSON value holds anything: a non-blank string, a non-empty list or object, a number. */
function filled(value: unknown): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return typeof value === 'number' && Number.isFinite(value);
}

const blankString = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';

/**
 * The same rule as {@link emptyRecordReason}, for Zotero item JSON: the shape a
 * translation-server's import translators answer with, which never passes through a
 * BibRecord and so used to skip the check entirely. With a translation-server running,
 * by_file sends the payload to it first, and a malformed entry could come back as an item
 * with no title, no creators and nothing but its itemType (and perhaps a citation key in
 * Extra), be shown in the preview and saved as a blank row, which is the 2026-10-01 stress
 * test's defect on the other path. Undefined when the item holds something, and for anything
 * that is not an item object at all, which this does not judge.
 */
export function emptyZoteroItemReason(item: unknown): string | undefined {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
  const data = item as Record<string, unknown>;
  const creators = Array.isArray(data.creators) ? (data.creators as unknown[]) : [];
  const tags = Array.isArray(data.tags) ? (data.tags as unknown[]) : [];
  return emptyEntryReason(
    {
      substantive:
        Object.entries(data).some(([name, value]) => !NOT_CONTENT.has(name) && filled(value)) ||
        creators.some((c) => {
          const creator = (c ?? {}) as Record<string, unknown>;
          return !blankString(creator.lastName) || !blankString(creator.firstName) || !blankString(creator.name);
        }),
      extra: typeof data.extra === 'string' ? data.extra.split(/\r?\n/) : [],
      keyField: !blankString(data.citationKey),
      keywords: tags.some((t) => !blankString(typeof t === 'string' ? t : (t as { tag?: unknown } | null)?.tag)),
    },
    'The translation-server read the entry this way and does not say why; check the entry in the file, fix it and ' +
      'import the file again.',
  );
}

/**
 * How to name a translation-server item in a message: its citation key, from its own field or
 * from the Extra line a translator files it under, else its position in what was returned.
 */
export function zoteroItemLabel(item: unknown, index: number): string {
  const data = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
  if (!blankString(data.citationKey)) return String(data.citationKey).trim();
  const lines = typeof data.extra === 'string' ? data.extra.split(/\r?\n/) : [];
  const line = lines.find((l) => CITATION_KEY_LINE.test(l.trim()));
  const key = line?.trim().slice(CITATION_KEY_EXTRA_LABEL.length + 1).trim();
  return key || `entry ${index + 1}`;
}

/** Split a keyword field the way every exporter writes one: on semicolons, else commas. */
export function splitKeywords(raw: string): string[] {
  const parts = raw.includes(';') ? raw.split(';') : raw.split(',');
  return parts.map((p) => p.trim()).filter(Boolean);
}
