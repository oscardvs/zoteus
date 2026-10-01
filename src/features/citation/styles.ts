/**
 * Human style name -> CSL style id (the filename, without .csl).
 *
 * The Chicago ids follow the style repository's own renames for the 18th edition:
 * `chicago-note-bibliography`, which "chicago" used to name here, is gone from the
 * repository and its rename record points at `chicago-shortened-notes-bibliography`, which
 * is also what zotero.org redirects the old id to and what the desktop app renders by
 * default. So "chicago" keeps meaning what it always rendered as, and the full-notes
 * variant gets names of its own (#58).
 *
 * "vancouver" names the repository's current id rather than the old one: `vancouver.csl` is
 * gone too, renamed to `nlm-citation-sequence`, and naming the successor here saves every
 * Vancouver render a 404 and a read of the rename record.
 *
 * This table is the exact-match fast path and what action:"list" shows. Anything longer,
 * from "APA 7th edition" to the titles Zotero's own style list uses, goes through
 * {@link resolveLongStyleName} below.
 */
const ALIASES: Record<string, string> = {
  apa: 'apa',
  'apa 7th': 'apa',
  apa7: 'apa',
  'apa 6th': 'apa-6th-edition',
  ieee: 'ieee',
  vancouver: 'nlm-citation-sequence',
  chicago: 'chicago-shortened-notes-bibliography',
  'chicago note': 'chicago-shortened-notes-bibliography',
  'chicago shortened notes': 'chicago-shortened-notes-bibliography',
  'chicago notes': 'chicago-notes-bibliography',
  'chicago full note': 'chicago-notes-bibliography',
  'chicago author-date': 'chicago-author-date',
  mla: 'modern-language-association',
  'mla 9th': 'modern-language-association',
  nature: 'nature',
  science: 'science',
  harvard: 'harvard-cite-them-right',
  acm: 'association-for-computing-machinery',
  acs: 'american-chemical-society',
  ama: 'american-medical-association',
  apsa: 'american-political-science-association',
  cell: 'cell',
};

export const COMMON_STYLES = Object.keys(ALIASES);

/**
 * A style family: what its name alone means, the variants it has, and the edition its ids
 * currently render.
 *
 * `current` is there because the CSL repository keeps a superseded edition under its own id,
 * the current id with `-<n>th-edition` appended (`chicago-author-date-17th-edition`,
 * `apa-6th-edition`, `american-medical-association-10th-edition`), while the bare id moves on
 * to the new edition. So "Chicago 17th edition author-date" has a real answer that is not
 * `chicago-author-date`, which renders the 18th. An edition the repository folded into the
 * current style instead (MLA 8th, APA 5th) gets the same suffixed id, and fetchStyle follows
 * the repository's rename record from there, exactly as it would for an id typed by hand.
 * When the repository moves a family to a new edition, `current` and the ids move with it,
 * the same upkeep the alias table has always needed. A family without `current` has no
 * edition ids at all, so a number in its name (IEEE's "version 11.29.2023") is ignored.
 */
interface StyleFamily {
  /** What the family's name alone resolves to. */
  base: string;
  /** Variant ids, keyed by the variant a name asked for. */
  variants?: Partial<Record<StyleVariant, string>>;
  /** The edition those ids render now, where past editions keep ids of their own. */
  current?: number;
}

type StyleVariant = 'author-date' | 'notes' | 'shortened';

const FAMILIES: Record<string, StyleFamily> = Object.assign(
  Object.create(null) as Record<string, StyleFamily>,
  {
    // The bare name keeps what the "chicago" alias means: shortened notes (#58).
    chicago: {
      base: 'chicago-shortened-notes-bibliography',
      variants: {
        'author-date': 'chicago-author-date',
        notes: 'chicago-notes-bibliography',
        shortened: 'chicago-shortened-notes-bibliography',
      },
      current: 18,
    },
    apa: { base: 'apa', current: 7 },
    mla: {
      base: 'modern-language-association',
      variants: { notes: 'modern-language-association-notes' },
      current: 9,
    },
    ama: { base: 'american-medical-association', current: 11 },
    // Cite Them Right is author-date by definition, and its title says so.
    harvard: {
      base: 'harvard-cite-them-right',
      variants: { 'author-date': 'harvard-cite-them-right' },
      current: 12,
    },
    ieee: { base: 'ieee' },
    vancouver: { base: 'nlm-citation-sequence' },
    acs: { base: 'american-chemical-society' },
    apsa: { base: 'american-political-science-association' },
    acm: { base: 'association-for-computing-machinery' },
    nature: { base: 'nature' },
    science: { base: 'science' },
    cell: { base: 'cell' },
  },
);

/**
 * Multi-word names, rewritten to the one token the rest of the parse reads. The family names
 * become their short form; the phrases that only say "this is a style guide" become nothing.
 * Applied in order, to a lower-cased string whose punctuation is already spaces.
 */
const PHRASES: Array<[RegExp, string]> = [
  [/ (?:chicago manual of style|cmos) /g, ' chicago '],
  [/ manual of style /g, ' '],
  [/ american psychological association /g, ' apa '],
  [/ modern language association(?: of america)? /g, ' mla '],
  [/ institute of electrical and electronics engineers /g, ' ieee '],
  [/ american medical association /g, ' ama '],
  [/ american chemical society /g, ' acs '],
  [/ american political science association /g, ' apsa '],
  [/ association for computing machinery /g, ' acm '],
  [/ cite them right /g, ' harvard '],
  [/ (?:nlm|citing medicine) /g, ' vancouver '],
  // Variants that are the family's default, as the titles of the styles mapped here say it.
  [/ in text citations? /g, ' '],
  [/ citation sequence /g, ' '],
  [/ author (?:date|year) /g, ' authordate '],
];

/** Words that say nothing about which style is meant. */
const FILLER = new Set([
  'the',
  'a',
  'of',
  'and',
  'in',
  'style',
  'styles',
  'edition',
  'ed',
  'edn',
  'format',
  'guide',
  'manual',
  'handbook',
  'reference',
  'references',
  'referencing',
  'citation',
  'citations',
  'citing',
  'version',
  'revised',
  'revision',
  'system',
  'csl',
  'bibliography',
  'biblio',
]);

const ORDINAL_WORDS: Record<string, number> = Object.assign(
  Object.create(null) as Record<string, number>,
  {
    first: 1,
    second: 2,
    third: 3,
    fourth: 4,
    fifth: 5,
    sixth: 6,
    seventh: 7,
    eighth: 8,
    ninth: 9,
    tenth: 10,
    eleventh: 11,
    twelfth: 12,
    thirteenth: 13,
    fourteenth: 14,
    fifteenth: 15,
    sixteenth: 16,
    seventeenth: 17,
    eighteenth: 18,
    nineteenth: 19,
    twentieth: 20,
  },
);

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/**
 * A style name as people write it, and as Zotero's style list titles it, to a CSL id, or
 * undefined when the name is not one this can read with confidence.
 *
 * The 2026-10-01 stress test asked for "Chicago Manual of Style 17th edition author-date"
 * and got a 404 with `available: false`, while zotero_word_document offered "Chicago Manual of
 * Style 17th edition" as an example of what `style` takes. Only the exact short aliases
 * resolved. The parse here lower-cases the name, turns punctuation into spaces, collapses
 * the long family names ("American Psychological Association", "Chicago Manual of Style"),
 * drops words that only say "style guide", and reads what is left as one family, at most one
 * edition, and at most one variant.
 *
 * Every word has to be accounted for, and that is the safety property: a word this does not
 * understand makes the whole name not this function's to reinterpret, so the caller passes it
 * through untouched. That keeps CSL ids that merely start like a family on their own path
 * (`chicago-notes-bibliography-annotated`, `apa-no-ampersand`, `nature-biotechnology`,
 * `harvard-anglia-ruskin-university`), and it keeps a URL a URL.
 *
 * Chicago's variants follow the names Zotero has used for them: "(note)" was the shortened
 * notes style and "(full note)" the full one, while the 18th edition says "notes and
 * bibliography" for full notes and "shortened notes and bibliography" for the short form. So
 * a singular "note" means shortened and a plural "notes" means full, unless "shortened" or
 * "full" says otherwise, which is also what the "chicago note" and "chicago notes" aliases
 * have always meant.
 */
export function resolveLongStyleName(name: string): string | undefined {
  let s = ` ${name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')} `;
  for (const [phrase, replacement] of PHRASES) s = s.replace(phrase, replacement);

  let family: string | undefined;
  const numbers: number[] = [];
  let authorDate = false;
  let shortened = false;
  let full = false;
  let note = false;
  let notes = false;
  for (const raw of s.split(' ').filter(Boolean)) {
    // "apa7", "mla9", "chicago17th": a family and an edition written as one word.
    const glued = raw.match(/^([a-z]+?)(\d+)(?:st|nd|rd|th)?$/);
    const words = glued && FAMILIES[glued[1]!] ? [glued[1]!, glued[2]!] : [raw];
    for (const word of words) {
      if (FAMILIES[word]) {
        if (family && family !== word) return undefined;
        family = word;
        continue;
      }
      const numeric = word.match(/^(\d+)(?:st|nd|rd|th)?$/);
      if (numeric) {
        numbers.push(Number(numeric[1]));
        continue;
      }
      if (ORDINAL_WORDS[word]) {
        numbers.push(ORDINAL_WORDS[word]!);
        continue;
      }
      if (word === 'authordate') authorDate = true;
      else if (word === 'shortened' || word === 'short') shortened = true;
      else if (word === 'full' || word === 'fullnote' || word === 'fullnotes') full = true;
      else if (word === 'note') note = true;
      else if (word === 'notes') notes = true;
      else if (!FILLER.has(word)) return undefined;
    }
  }
  if (!family) return undefined;
  const spec = FAMILIES[family]!;

  let variant: StyleVariant | undefined;
  if (authorDate) variant = 'author-date';
  if (shortened || full || note || notes) {
    // Two variants at once ("author-date notes", "shortened full") is not a name, it is a
    // contradiction, and only Chicago tells a shortened note from a full one.
    if (variant || (shortened && full)) return undefined;
    if (family !== 'chicago' && (shortened || full)) return undefined;
    if (family !== 'chicago') variant = 'notes';
    else variant = shortened ? 'shortened' : full || notes ? 'notes' : 'shortened';
  }
  let id = spec.base;
  if (variant) {
    const named = spec.variants?.[variant];
    if (!named) return undefined;
    id = named;
  }

  if (spec.current === undefined) return id;
  // A year or a second, different edition number is not something to guess an edition from.
  const editions = [...new Set(numbers)];
  if (editions.length > 1 || (editions[0] !== undefined && editions[0] >= 100)) return undefined;
  const edition = editions[0];
  return edition === undefined || edition === spec.current
    ? id
    : `${id}-${ordinal(edition)}-edition`;
}

const STYLE_BASE = 'https://raw.githubusercontent.com/citation-style-language/styles/master';
const LOCALE_BASE = 'https://raw.githubusercontent.com/citation-style-language/locales/master';

export interface StyleResolverOptions {
  fetchImpl?: typeof fetch;
  styleBase?: string;
  localeBase?: string;
}

/** Resolves human style names to CSL ids and fetches (and caches) CSL style + locale XML. */
export class StyleResolver {
  private styleCache = new Map<string, string>();
  private localeCache = new Map<string, string>();
  /** The repository's record of ids it has renamed, read once, on the first id it lacks. */
  private renamed: Promise<Record<string, string>> | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly styleBase: string;
  private readonly localeBase: string;

  constructor(opts: StyleResolverOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
    this.styleBase = opts.styleBase ?? STYLE_BASE;
    this.localeBase = opts.localeBase ?? LOCALE_BASE;
  }

  /**
   * A style name, a CSL id or a CSL URL, to what the style is fetched (or sent to Zotero) as:
   * an exact alias first, then the long-form parse, and otherwise the input as given.
   *
   * The alias lookup is an own-property check because the key comes from the caller and the
   * table is a plain object: `ALIASES['constructor']` answered with a function, which then
   * went out as the style id.
   */
  resolveId(name: string): string {
    const trimmed = name.trim();
    const key = trimmed.toLowerCase();
    if (Object.hasOwn(ALIASES, key)) return ALIASES[key]!;
    return resolveLongStyleName(trimmed) ?? trimmed;
  }

  async fetchStyle(id: string, depth = 0): Promise<string> {
    if (this.styleCache.has(id)) return this.styleCache.get(id)!;
    const res = await this.fetchImpl(`${this.styleBase}/${id}.csl`);
    let xml: string;
    if (res.ok) {
      xml = await res.text();
    } else {
      // The repository renames styles and keeps a record of it (`renamed-styles.json`),
      // which zotero.org applies as a redirect and a raw file fetch does not. An id a user
      // copied from Zotero's own preferences, or one this table carried for years, must
      // not 404 over a rename it could not know about (#58).
      const successor = res.status === 404 && depth < 3 ? (await this.renames())[id] : undefined;
      if (!successor) throw new Error(`CSL style "${id}" not found (HTTP ${res.status}).`);
      xml = await this.fetchStyle(successor, depth + 1);
      this.styleCache.set(id, xml);
      return xml;
    }
    const parent = this.parentId(xml);
    if (parent && parent !== id && depth < 3) {
      xml = await this.fetchStyle(parent, depth + 1);
    }
    this.styleCache.set(id, xml);
    return xml;
  }

  private renames(): Promise<Record<string, string>> {
    this.renamed ??= (async () => {
      try {
        const res = await this.fetchImpl(`${this.styleBase}/renamed-styles.json`);
        if (!res.ok) return {};
        const json: unknown = await res.json();
        return json && typeof json === 'object' ? (json as Record<string, string>) : {};
      } catch {
        // No record is the same as an empty one: the original 404 stands.
        return {};
      }
    })();
    return this.renamed;
  }

  async fetchLocale(lang = 'en-US'): Promise<string> {
    if (this.localeCache.has(lang)) return this.localeCache.get(lang)!;
    const res = await this.fetchImpl(`${this.localeBase}/locales-${lang}.xml`);
    if (!res.ok) {
      if (lang !== 'en-US') return this.fetchLocale('en-US');
      throw new Error(`CSL locale "${lang}" not found (HTTP ${res.status}).`);
    }
    const xml = await res.text();
    this.localeCache.set(lang, xml);
    return xml;
  }

  private parentId(xml: string): string | null {
    const link = xml.match(/<link[^>]*rel="independent-parent"[^>]*>/);
    if (!link) return null;
    const href = link[0].match(/href="([^"]+)"/);
    if (!href) return null;
    const id = href[1]!.match(/styles\/([^/"]+)$/);
    return id ? id[1]! : null;
  }
}
