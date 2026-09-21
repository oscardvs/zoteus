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

/** Split a keyword field the way every exporter writes one: on semicolons, else commas. */
export function splitKeywords(raw: string): string[] {
  const parts = raw.includes(';') ? raw.split(';') : raw.split(',');
  return parts.map((p) => p.trim()).filter(Boolean);
}
