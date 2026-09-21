/**
 * Turning the LaTeX in an exported .bib file back into plain text.
 *
 * Every reference manager that writes BibTeX writes accents as commands, because BibTeX
 * itself predates Unicode: Schrödinger is `Schr\"{o}dinger`, García is `Garc\'{i}a`, and a
 * Turkish surname arrives as `\c{C}elik`. An importer that does not undo that puts the
 * backslashes into the library, where they show up in every bibliography the user renders
 * afterwards. So this is not cosmetic.
 *
 * The approach is deliberately not a lookup table of accented letters. An accent command
 * maps to the Unicode COMBINING mark it stands for, the mark is put after the letter it
 * modifies, and `String.normalize('NFC')` composes the pair into the precomposed character.
 * That covers every letter the accent can legally take, including the ones no hand-written
 * table would have listed, and it degrades honestly: a combination Unicode has no single
 * character for stays as letter-plus-mark, which still renders correctly.
 *
 * What this does NOT do, said plainly: it does not evaluate math mode, it does not expand
 * user-defined macros (a .bib that uses `\newcommand` is beyond any importer that is not a
 * TeX engine), and it does not preserve the capitalisation-protecting meaning of braces.
 * Braces are dropped and their contents kept, which is what a title field wants.
 */

/**
 * A lookup table that cannot answer with something it does not hold.
 *
 * Both tables below are indexed by a command name taken out of the file. On a plain object
 * literal `SYMBOLS['constructor']` answers with `Object.prototype.constructor`, so a .bib
 * containing `\constructor` wrote "function Object() [native code]" into the library. A null
 * prototype has nothing to inherit.
 */
function table<T>(entries: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, entries);
}

/** Accent commands, as the Unicode combining mark each one puts on its argument. */
const COMBINING: Record<string, string> = table({
  "'": '\u0301', // acute
  '`': '\u0300', // grave
  '^': '\u0302', // circumflex
  '"': '\u0308', // diaeresis
  '~': '\u0303', // tilde
  '=': '\u0304', // macron
  '.': '\u0307', // dot above
  u: '\u0306', // breve
  v: '\u030C', // caron
  H: '\u030B', // double acute
  c: '\u0327', // cedilla
  k: '\u0328', // ogonek
  r: '\u030A', // ring above
  b: '\u0331', // macron below
  d: '\u0323', // dot below
  t: '\u0361', // tie
});

/** Commands that stand for a whole character rather than for an accent on one. */
const SYMBOLS: Record<string, string> = table({
  ss: 'ß',
  SS: 'SS',
  o: 'ø',
  O: 'Ø',
  aa: 'å',
  AA: 'Å',
  ae: 'æ',
  AE: 'Æ',
  oe: 'œ',
  OE: 'Œ',
  l: 'ł',
  L: 'Ł',
  i: 'ı', // dotless i, the base an accent is put on
  j: '\u0237', // dotless j
  dh: 'ð',
  DH: 'Ð',
  th: 'þ',
  TH: 'Þ',
  ng: 'ŋ',
  NG: 'Ŋ',
  dag: '†',
  ddag: '‡',
  copyright: '©',
  pounds: '£',
  textendash: '\u2013',
  textemdash: '\u2014',
  textquoteleft: '‘',
  textquoteright: '’',
  textquotedblleft: '“',
  textquotedblright: '”',
  textasciitilde: '~',
  textasciicircum: '^',
  textbackslash: '\\',
  textbullet: '•',
  textdegree: '°',
  textregistered: '®',
  texttrademark: '™',
  ldots: '…',
  dots: '…',
});

/**
 * Commands whose braces only style their argument. The command disappears and the argument
 * survives, which is right for a bibliography: `\emph{in vivo}` is the words, not the italics.
 */
const WRAPPERS = new Set([
  'emph',
  'textit',
  'textbf',
  'textrm',
  'textsc',
  'texttt',
  'textsf',
  'textsl',
  'textup',
  'textmd',
  'textnormal',
  'mbox',
  'hbox',
  'text',
  'mathrm',
  'mathit',
  'url',
  'normalfont',
  'bf',
  'it',
  'sc',
  'rm',
  'tt',
  'em',
]);

/** Characters a backslash escapes into themselves. */
const ESCAPED = new Set(['&', '%', '_', '$', '#', '{', '}']);

const isLetter = (c: string | undefined): boolean => !!c && /[A-Za-z]/.test(c);

/** The text of a `{...}` group starting at `i`, and the index just past its closing brace. */
function readGroup(s: string, i: number): { body: string; next: number } {
  let depth = 0;
  const start = i;
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { body: s.slice(start + 1, i), next: i + 1 };
    }
  }
  return { body: s.slice(start + 1), next: s.length };
}

/**
 * How deep an accent argument may nest before the decoder stops descending into it.
 *
 * The accent argument is the one recursive edge in this file: `\'{...}` decodes its own
 * group, which may hold another accent. That is two stack frames per level, so a value
 * nesting a few thousand deep exhausted the stack and threw a RangeError that took the whole
 * file's import down with it and told the user only "Maximum call stack size exceeded". Real
 * bibliographies nest two or three deep. Past the bound the group is kept as text with its
 * braces removed, which is what an undecodable group would have come to anyway.
 */
const MAX_ACCENT_DEPTH = 64;

/**
 * The argument an accent command takes: a braced group, a single character, or a dotless
 * `\i`/`\j`. Returns the argument already decoded, because it can itself contain commands.
 */
function readAccentArgument(s: string, i: number, depth: number): { base: string; next: number } {
  while (i < s.length && (s[i] === ' ' || s[i] === '\n' || s[i] === '\t')) i++;
  if (s[i] === '{') {
    const { body, next } = readGroup(s, i);
    // The bound, applied. Past it the group is kept as text with its braces removed rather
    // than descended into: an undecodable group comes to the same thing, and the alternative
    // is a RangeError that takes down the whole file's import.
    if (depth >= MAX_ACCENT_DEPTH) return { base: body, next };
    return { base: decode(body, depth + 1), next };
  }
  if (s[i] === '\\' && isLetter(s[i + 1])) {
    let j = i + 1;
    while (j < s.length && isLetter(s[j])) j++;
    const name = s.slice(i + 1, j);
    return { base: SYMBOLS[name] ?? name, next: j };
  }
  if (i >= s.length) return { base: '', next: i };
  return { base: s[i]!, next: i + 1 };
}

/** Put a combining mark on the first character of `base`, undotting a dotless i/j first. */
function accent(base: string, mark: string): string {
  if (!base) return mark;
  const head = base[0] === 'ı' ? 'i' : base[0] === '\u0237' ? 'j' : base[0]!;
  return head + mark + base.slice(1);
}

/**
 * Decode one LaTeX-escaped string to plain text.
 *
 * Whitespace is collapsed and the result trimmed, because a BibTeX value is routinely
 * wrapped across several lines and Zotero stores single-line fields.
 */
export function decodeLatex(raw: string): string {
  return decode(raw, 0);
}

/** The decoder proper. `depth` counts the accent groups it is already inside. */
function decode(raw: string, depth: number): string {
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const c = raw[i]!;
    if (c === '{' || c === '}') {
      // Grouping braces carry no text of their own. Dropping them loses BibTeX's
      // capitalisation protection, which Zotero does not have a field for anyway.
      i++;
      continue;
    }
    if (c === '~') {
      out += ' '; // a non-breaking space; the field is stored as plain text
      i++;
      continue;
    }
    if (c === '-') {
      if (raw.startsWith('---', i)) {
        out += '\u2014';
        i += 3;
        continue;
      }
      if (raw.startsWith('--', i)) {
        out += '\u2013';
        i += 2;
        continue;
      }
      out += '-';
      i++;
      continue;
    }
    if (c !== '\\') {
      out += c;
      i++;
      continue;
    }

    // A command.
    const next = raw[i + 1];
    if (next === undefined) {
      i++;
      continue;
    }
    if (!isLetter(next)) {
      const mark = COMBINING[next];
      if (mark) {
        const arg = readAccentArgument(raw, i + 2, depth);
        out += accent(arg.base, mark);
        i = arg.next;
        continue;
      }
      if (ESCAPED.has(next)) {
        out += next;
        i += 2;
        continue;
      }
      if (next === '\\') {
        out += ' '; // a forced line break inside a field
        i += 2;
        continue;
      }
      if (next === ' ' || next === '\n' || next === '\t') {
        out += ' '; // an escaped space
        i += 2;
        continue;
      }
      out += next;
      i += 2;
      continue;
    }

    let j = i + 1;
    while (j < raw.length && isLetter(raw[j])) j++;
    const name = raw.slice(i + 1, j);
    const mark = name.length === 1 ? COMBINING[name] : undefined;
    if (mark) {
      const arg = readAccentArgument(raw, j, depth);
      out += accent(arg.base, mark);
      i = arg.next;
      continue;
    }
    const symbol = SYMBOLS[name];
    if (symbol !== undefined) {
      out += symbol;
      i = j;
      // `\ss{}` and `\ss` mean the same thing; an empty group after the command is its
      // terminator rather than an argument.
      if (raw[i] === '{' && raw[i + 1] === '}') i += 2;
      continue;
    }
    if (WRAPPERS.has(name)) {
      // Drop the command and let the main loop walk into its group: the braces are skipped
      // and the argument text survives, which is all a wrapper ever meant.
      i = j;
      continue;
    }
    // An unknown command. Dropping the name keeps whatever it wrapped, which loses less
    // than printing a backslash into the user's library.
    i = j;
  }
  return out.normalize('NFC').replace(/[ \t\r\n]+/g, ' ').trim();
}

/**
 * Split on the top-level separator, ignoring any inside `{...}`.
 *
 * Both callers need this and both break without it: `author = {{Institute of Physics} and
 * Ada Lovelace}` is two authors, not three, and `{Smith, Jr., John}` is one name whose
 * commas matter.
 */
export function splitTopLevel(raw: string, separator: RegExp | string): string[] {
  const depth: number[] = new Array(raw.length).fill(0);
  let d = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\') {
      depth[i] = d;
      if (i + 1 < raw.length) depth[i + 1] = d;
      i++;
      continue;
    }
    if (c === '{') {
      depth[i] = d;
      d++;
      continue;
    }
    if (c === '}') {
      d = Math.max(0, d - 1);
      depth[i] = d;
      continue;
    }
    depth[i] = d;
  }
  const re =
    typeof separator === 'string'
      ? new RegExp(separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
      : new RegExp(separator.source, separator.flags.includes('g') ? separator.flags : `${separator.flags}g`);
  const out: string[] = [];
  let at = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    if (depth[m.index] !== 0) {
      re.lastIndex = m.index + 1;
      continue;
    }
    out.push(raw.slice(at, m.index));
    at = m.index + m[0].length;
    re.lastIndex = at;
  }
  out.push(raw.slice(at));
  return out;
}
