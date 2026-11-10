import { citationGroup, parseLocator } from '../notes/markdown.js';

/**
 * Deterministic citation parsing for a draft: Markdown (pandoc), LaTeX or plain prose.
 *
 * Nothing here guesses with a model. Each form has one grammar, the forms are tried in a
 * fixed order, and a span of text claimed by one form is never read again by another, so
 * the same draft always yields the same list.
 */

export type CitationKind = 'zotero-key' | 'pandoc' | 'latex' | 'numeric' | 'doi' | 'author-year';

/** One cited work inside a citation, as written. */
export interface CiteTarget {
  /** An 8-character Zotero item key (`[@ABCD2345]`). Also tried as a citation key. */
  itemKey?: string;
  /** A citation key (pandoc `@key`, LaTeX `\cite{key}`). */
  citekey?: string;
  doi?: string;
  /** First author's surname, for author-year forms. */
  author?: string;
  /** Second author's surname, for "Smith & Jones". */
  author2?: string;
  /** Four-digit year (a trailing disambiguation letter is dropped). */
  year?: string;
  /** Number in a numeric citation. */
  number?: number;
  /** Title words taken from the matching reference-list entry, when there is one. */
  titleWords?: string[];
  /** The reference-list entry this target was read from, verbatim. */
  reference?: string;
  locator?: string;
  label?: string;
}

/** One citation in the draft: a bracketed group, a \cite command, a DOI, a parenthetical. */
export interface FoundCitation {
  kind: CitationKind;
  /** The citation as written. */
  source: string;
  start: number;
  end: number;
  /** 1-based line of `start`. */
  line: number;
  targets: CiteTarget[];
}

/** One entry of a reference list, with what can be read off it without a model. */
export interface ReferenceEntry {
  text: string;
  number?: number;
  doi?: string;
  author?: string;
  year?: string;
  titleWords: string[];
}

const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>{}]+)/g;

/** A DOI as written, without the trailing punctuation a sentence puts after it. */
export function cleanDoi(raw: string): string {
  let d = raw.replace(/[.,;:]+$/, '');
  // A closing bracket belongs to the DOI only when the DOI opened one.
  while (/[)\]]$/.test(d)) {
    const close = d.slice(-1);
    const open = close === ')' ? '(' : '[';
    if (d.split(open).length >= d.split(close).length) break;
    d = d.slice(0, -1).replace(/[.,;:]+$/, '');
  }
  return d;
}

/** Lowercased, prefix-free DOI for comparison: DOIs are case-insensitive. */
export function normalizeDoi(raw: string): string {
  return cleanDoi(raw.trim())
    .replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, '')
    .replace(/^doi:\s*/i, '')
    .toLowerCase();
}

/** Lowercase, accents removed: "Müller" and "Muller" are the same surname here. */
export function foldName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u2019']/g, "'")
    .toLowerCase()
    .trim();
}

const STOP = new Set(
  'a an and are as at be by for from in into is it of on or the to with without via using its their this that'.split(' '),
);

/** Content words of a title, for overlap scoring. */
export function titleWords(s: string): string[] {
  return foldName(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** A surname: a capitalised word, possibly hyphenated, possibly with a particle before it. */
const NAME = "(?:(?:van|von|de|der|den|da|di|du|le|la|del|dos|ten|ter)\\s+)*\\p{Lu}[\\p{L}'\u2019-]*\\p{L}";
const YEAR = '(?:1[5-9]|20)\\d{2}[a-z]?';

const yearOf = (y: string): string => y.slice(0, 4);

/** The text before `at` on its own line, for the line number. */
function lineAt(text: string, at: number): number {
  let n = 1;
  for (let i = 0; i < at; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Where the reference list starts, by its heading, or -1. */
export function referenceSectionStart(text: string): number {
  const re =
    /^(?:#{1,6}\s*|\\section\*?\{|\\chapter\*?\{)?\s*(?:references|bibliography|works cited|literature cited|literature|sources)\s*\}?\s*:?\s*$/gim;
  let last = -1;
  for (let m = re.exec(text); m; m = re.exec(text)) last = m.index;
  if (last !== -1) return last;
  const bib = text.search(/\\begin\{thebibliography\}/);
  return bib;
}

/** Split a reference list into entries and read each one. */
export function parseReferences(list: string): ReferenceEntry[] {
  const lines = list.replace(/\r\n?/g, '\n').split('\n');
  const raw: Array<{ text: string; number?: number }> = [];
  let current: { text: string; number?: number } | null = null;
  const NUMBERED = /^\s*(?:\[(\d{1,4})\]|(\d{1,4})[.)])\s+(.*)$/;
  const BIBITEM = /^\s*\\bibitem(?:\[[^\]]*\])?\{[^}]*\}\s*(.*)$/;
  let bibitems = 0;
  for (const line of lines) {
    if (/^\s*(?:#{1,6}\s*)?(?:references|bibliography|works cited|literature cited)\s*:?\s*$/i.test(line)) continue;
    if (/\\(?:begin|end)\{thebibliography\}/.test(line)) continue;
    const num = NUMBERED.exec(line);
    const bib = BIBITEM.exec(line);
    if (num) {
      current = { text: num[3]!.trim(), number: Number(num[1] ?? num[2]) };
      raw.push(current);
    } else if (bib) {
      bibitems++;
      current = { text: bib[1]!.trim(), number: bibitems };
      raw.push(current);
    } else if (!line.trim()) {
      current = null;
    } else if (current && /^\s+/.test(line)) {
      current.text += ' ' + line.trim();
    } else if (current && current.number != null) {
      // A wrapped line of a numbered entry: it continues until the next number.
      current.text += ' ' + line.trim();
    } else {
      current = { text: line.replace(/^\s*[-*]\s+/, '').trim() };
      raw.push(current);
    }
  }
  return raw.filter((r) => r.text).map((r) => readEntry(r.text, r.number));
}

function readEntry(text: string, number?: number): ReferenceEntry {
  DOI_RE.lastIndex = 0;
  const doiMatch = DOI_RE.exec(text);
  const yearMatch = new RegExp(`\\b(${YEAR})\\b`).exec(text);
  const author = new RegExp(`^\\s*(${NAME})`, 'u').exec(text)?.[1];
  // The title: after the year in author-year styles ("Smith, J. (2020). Title. Journal."),
  // otherwise the first quoted span or the second sentence.
  let title = '';
  const quoted = /[\u201c"]([^\u201d"]{8,})[\u201d"]/.exec(text);
  if (quoted) title = quoted[1]!;
  else if (yearMatch) {
    const after = text.slice(yearMatch.index + yearMatch[0].length).replace(/^[a-z]?\)?[.,:]?\s*/, '');
    title = after.split(/\.\s/)[0] ?? '';
  } else title = text.split(/\.\s/)[1] ?? '';
  return {
    text,
    ...(number != null ? { number } : {}),
    ...(doiMatch ? { doi: cleanDoi(doiMatch[1]!) } : {}),
    ...(author ? { author } : {}),
    ...(yearMatch ? { year: yearOf(yearMatch[1]!) } : {}),
    titleWords: titleWords(title),
  };
}

/** What a reference entry says about the work it names, as a target. */
export function targetFromReference(entry: ReferenceEntry): CiteTarget {
  return {
    ...(entry.doi ? { doi: entry.doi } : {}),
    ...(entry.author ? { author: entry.author } : {}),
    ...(entry.year ? { year: entry.year } : {}),
    ...(entry.titleWords.length ? { titleWords: entry.titleWords } : {}),
    reference: entry.text,
  };
}

/** Code spans and fenced or indented code blocks, which hold no citations. */
function codeRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of text.matchAll(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm)) out.push([m.index!, m.index! + m[0].length]);
  for (const m of text.matchAll(/`[^`\n]+`/g)) out.push([m.index!, m.index! + m[0].length]);
  for (const m of text.matchAll(/\\begin\{(verbatim|lstlisting|minted)\}[\s\S]*?\\end\{\1\}/g))
    out.push([m.index!, m.index! + m[0].length]);
  return out;
}

const PANDOC_KEY = /^\s*(.*?)\s*-?@([\p{L}\p{N}_][\p{L}\p{N}_:.#$%&+?<>~/-]*?)(?=[,\s]|$)\s*(?:,(.*))?$/su;

/** A pandoc group that is not an item-key group: `[@smith2020, p. 4; see @jones2019]`. */
function pandocGroup(inner: string): CiteTarget[] | null {
  if (!inner.includes('@') || /[[\]]/.test(inner)) return null;
  const targets: CiteTarget[] = [];
  for (const part of inner.split(';')) {
    const m = PANDOC_KEY.exec(part);
    if (!m) return null;
    const key = m[2]!.replace(/[.:]+$/, '');
    // An e-mail address in brackets is not a citation.
    if (/\S@/.test(part.trim().slice(0, part.trim().indexOf('@') + 1))) return null;
    const loc = parseLocator(m[3] ?? '');
    targets.push({ citekey: key, ...(loc.locator ? { locator: loc.locator } : {}), ...(loc.label ? { label: loc.label } : {}) });
  }
  return targets;
}

/** One `Smith`, `Smith & Jones`, `Smith et al.`, `Smith, Jones, and Lee` author run. */
const AUTHORS = `(${NAME})(?:(?:,\\s*${NAME})*,?\\s+(?:&|and)\\s+(${NAME})|\\s+et\\s+al\\.?)?`;
const PAREN_PART = new RegExp(
  `^\\s*(?:(?:see\\s+also|see|e\\.g\\.|cf\\.|i\\.e\\.)\\s*,?\\s*)?${AUTHORS},?\\s+(${YEAR})(?:\\s*,\\s*(.*))?\\s*$`,
  'iu',
);
const NARRATIVE = new RegExp(`${AUTHORS}(?:'s|\u2019s)?\\s+\\((${YEAR})(?:\\s*,\\s*([^)]*))?\\)`, 'gu');

/** Parse every citation in `draft`, in document order. */
export function parseCitations(draft: string, references: ReferenceEntry[] = []): FoundCitation[] {
  const taken: Array<[number, number]> = codeRanges(draft);
  const free = (s: number, e: number) => !taken.some(([a, b]) => s < b && e > a);
  const found: FoundCitation[] = [];
  const add = (kind: CitationKind, start: number, end: number, targets: CiteTarget[]) => {
    taken.push([start, end]);
    found.push({ kind, source: draft.slice(start, end), start, end, line: lineAt(draft, start), targets });
  };
  const byNumber = new Map(references.filter((r) => r.number != null).map((r) => [r.number!, r]));

  // 1. Bracketed groups: Zotero item keys first, with the notes feature's own grammar, then
  //    any other pandoc citation keys.
  for (let i = draft.indexOf('['); i !== -1; i = draft.indexOf('[', i + 1)) {
    if (!free(i, i + 1)) continue;
    const zotero = citationGroup(draft, i);
    if (zotero && free(i, zotero.end)) {
      add(
        'zotero-key',
        i,
        zotero.end,
        zotero.refs.map((r) => ({ itemKey: r.key, ...(r.locator ? { locator: r.locator } : {}), ...(r.label ? { label: r.label } : {}) })),
      );
      continue;
    }
    const close = draft.indexOf(']', i);
    if (close === -1) break;
    const inner = draft.slice(i + 1, close);
    if (draft[close + 1] === '(' || inner.startsWith('^')) continue; // a link or a footnote
    const pandoc = pandocGroup(inner);
    if (pandoc && free(i, close + 1)) add('pandoc', i, close + 1, pandoc);
  }

  // 2. LaTeX: \cite, \citep, \citet, \parencite, \textcite, \autocite, \footcite, ...
  for (const m of draft.matchAll(/\\([A-Za-z]*cite[A-Za-z]*)\*?((?:\s*\[[^\]]*\]){0,2})\s*\{([^}]*)\}/g)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (!free(start, end) || /^(?:nocite)$/.test(m[1]!)) continue;
    const opts = [...m[2]!.matchAll(/\[([^\]]*)\]/g)].map((o) => o[1]!);
    const loc = parseLocator(opts.length ? opts[opts.length - 1]! : '');
    const keys = m[3]!.split(',').map((k) => k.trim()).filter(Boolean);
    add(
      'latex',
      start,
      end,
      keys.map((k, idx) => ({
        ...(/^[A-Z0-9]{8}$/.test(k) ? { itemKey: k } : { citekey: k }),
        // A postnote applies to the last key of a multi-key \cite in biblatex.
        ...(idx === keys.length - 1 && loc.locator ? { locator: loc.locator } : {}),
        ...(idx === keys.length - 1 && loc.label ? { label: loc.label } : {}),
      })),
    );
  }

  // 3. Bare in-text pandoc keys: "@smith2020 argues".
  for (const m of draft.matchAll(/(?<![\p{L}\p{N}_.@/\\-])@([\p{L}_][\p{L}\p{N}_:.#$%&+?<>~/-]*[\p{L}\p{N}_])/gu)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (!free(start, end)) continue;
    add('pandoc', start, end, [/^[A-Z0-9]{8}$/.test(m[1]!) ? { itemKey: m[1]! } : { citekey: m[1]! }]);
  }

  // 4. Numeric: [3], [1, 4-6].
  for (const m of draft.matchAll(/\[(\d{1,4}(?:\s*[-\u2013,]\s*\d{1,4})*)\](?!\()/g)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (!free(start, end)) continue;
    const numbers: number[] = [];
    for (const part of m[1]!.split(',')) {
      const [a, b] = part.split(/[-\u2013]/).map((x) => Number(x.trim()));
      if (b != null && b >= a! && b - a! <= 50) for (let n = a!; n <= b; n++) numbers.push(n);
      else numbers.push(a!);
    }
    add(
      'numeric',
      start,
      end,
      numbers.map((n) => {
        const entry = byNumber.get(n);
        return entry ? { number: n, ...targetFromReference(entry) } : { number: n };
      }),
    );
  }

  // 5. Bare DOIs.
  for (const m of draft.matchAll(DOI_RE)) {
    const doi = cleanDoi(m[1]!);
    const start = m.index!;
    const end = start + doi.length;
    if (!free(start, end)) continue;
    add('doi', start, end, [{ doi }]);
  }

  // 6. Narrative author-year: Smith (2020), Smith and Jones (2020, p. 4), Smith et al. (2020).
  for (const m of draft.matchAll(NARRATIVE)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (!free(start, end)) continue;
    const loc = parseLocator(m[4] ?? '');
    add('author-year', start, end, [
      withReference(
        {
          author: m[1]!,
          ...(m[2] ? { author2: m[2] } : {}),
          year: yearOf(m[3]!),
          ...(loc.locator ? { locator: loc.locator } : {}),
          ...(loc.label ? { label: loc.label } : {}),
        },
        references,
      ),
    ]);
  }

  // 7. Parenthetical author-year: (Smith, 2020), (Smith & Jones, 2020, p. 4; Lee 2019).
  for (const m of draft.matchAll(/\(([^()]*?\b(?:1[5-9]|20)\d{2}[a-z]?\b[^()]*)\)/g)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (!free(start, end)) continue;
    const targets: CiteTarget[] = [];
    for (const part of m[1]!.split(';')) {
      const p = PAREN_PART.exec(part);
      if (!p) continue;
      const loc = parseLocator(p[4] ?? '');
      targets.push(
        withReference(
          {
            author: p[1]!,
            ...(p[2] ? { author2: p[2] } : {}),
            year: yearOf(p[3]!),
            ...(loc.locator ? { locator: loc.locator } : {}),
            ...(loc.label ? { label: loc.label } : {}),
          },
          references,
        ),
      );
    }
    if (targets.length) add('author-year', start, end, targets);
  }

  return found.sort((a, b) => a.start - b.start);
}

/** Attach the reference-list entry an author-year target names, when exactly one does. */
function withReference(target: CiteTarget, references: ReferenceEntry[]): CiteTarget {
  const hits = references.filter(
    (r) => r.author && r.year === target.year && foldName(r.author) === foldName(target.author ?? ''),
  );
  if (hits.length !== 1) return target;
  const r = hits[0]!;
  return {
    ...target,
    ...(r.doi ? { doi: r.doi } : {}),
    ...(r.titleWords.length ? { titleWords: r.titleWords } : {}),
    reference: r.text,
  };
}

/** A direct quotation in the draft. */
export interface DraftQuote {
  text: string;
  start: number;
  end: number;
  block: boolean;
}

/** Quotations long enough to be a quotation rather than a scare-quoted term. */
export function findQuotes(draft: string, minWords = 4): DraftQuote[] {
  const quotes: DraftQuote[] = [];
  const push = (text: string, start: number, end: number, block: boolean) => {
    const t = text.trim();
    if (t.split(/\s+/).length >= minWords) quotes.push({ text: t, start, end, block });
  };
  // Markdown block quotes: runs of lines starting with ">".
  for (const m of draft.matchAll(/(?:^[ \t]*>[^\n]*(?:\n|$))+/gm)) {
    const text = m[0].replace(/^[ \t]*>[ \t]?/gm, '');
    push(text, m.index!, m.index! + m[0].length, true);
  }
  // LaTeX quote environments.
  for (const m of draft.matchAll(/\\begin\{(quote|quotation|displayquote)\}([\s\S]*?)\\end\{\1\}/g)) {
    push(m[2]!, m.index!, m.index! + m[0].length, true);
  }
  const inBlock = (i: number) => quotes.some((q) => q.block && i >= q.start && i < q.end);
  // Inline: "...", curly double quotes, LaTeX ``...'', \enquote{...}.
  const INLINE = /"([^"\n]+(?:\n[^"\n]+)*)"|\u201c([^\u201d]+)\u201d|``([^`']+(?:'[^'][^`']*)*)''|\\enquote\{([^}]+)\}/g;
  for (const m of draft.matchAll(INLINE)) {
    if (inBlock(m.index!)) continue;
    push(m[1] ?? m[2] ?? m[3] ?? m[4] ?? '', m.index!, m.index! + m[0].length, false);
  }
  return quotes.sort((a, b) => a.start - b.start);
}

/**
 * Which citation each quotation belongs to: the nearest one in the same sentence. A cite
 * right after the closing quote mark ("..." (Smith, 2020, p. 4)) or right before the opening
 * one (Smith (2020) writes that "...") qualifies; a cite in the next sentence does not. A
 * block quote belongs to a cite on its own last line or on the line right after it.
 */
export function attachQuotes(draft: string, quotes: DraftQuote[], cites: FoundCitation[]): Map<number, DraftQuote[]> {
  const out = new Map<number, DraftQuote[]>();
  for (const q of quotes) {
    let best = -1;
    let bestGap = Infinity;
    cites.forEach((c, idx) => {
      let gap = Infinity;
      if (c.start >= q.end) {
        const between = draft.slice(q.end, c.start);
        const limit = q.block ? 3 : 80;
        if (between.length <= limit && (q.block ? !/\n\s*\n/.test(between) : !/[.!?]\s|\n\s*\n/.test(between))) gap = between.length;
      } else if (c.end <= q.start && !q.block) {
        const between = draft.slice(c.end, q.start);
        if (between.length <= 60 && !/[.!?]\s|\n\s*\n/.test(between)) gap = between.length + 0.5;
      } else if (q.block && c.start >= q.start && c.end <= q.end) {
        // A cite inside the block quote, on its last line.
        const rest = draft.slice(c.end, q.end);
        if (!rest.trim() || /^[\s.)]*$/.test(rest)) gap = 0;
      }
      if (gap < bestGap) {
        bestGap = gap;
        best = idx;
      }
    });
    if (best === -1) continue;
    const cite = cites[best]!;
    let text = q.text;
    // A cite inside a block quote is not part of the quotation.
    if (q.block && cite.start >= q.start && cite.end <= q.end) text = text.replace(cite.source, '').trim();
    const list = out.get(best) ?? [];
    list.push({ ...q, text });
    out.set(best, list);
  }
  return out;
}
