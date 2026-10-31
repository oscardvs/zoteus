/**
 * Markdown to the HTML a Zotero note stores, with no dependency beyond Node itself.
 *
 * The target is the note editor's own schema (Zotero 7 and later, the one 10.0.6 ships):
 * headings, paragraphs, bullet and ordered lists, blockquotes, `<pre>` code blocks,
 * horizontal rules, tables, and the marks strong, em, code, link and strikethrough, which the
 * editor serializes as `<span style="text-decoration: line-through">`. Math uses the editor's
 * own nodes, `<span class="math">$...$</span>` inline and `<pre class="math">$$...$$</pre>`
 * as a block, so a formula written in a note by Zoteus renders the way one typed into Zotero
 * does.
 *
 * Raw HTML in the Markdown is escaped, never passed through: the text arrives from a model,
 * and a note is read back by every Zotero client and by zotero.org. Link targets are held to
 * http(s), mailto, ftp and zotero:, so a `javascript:` URL comes out as plain text.
 *
 * `[@ABCD2345]` names a library item by its key. With a `citation` renderer the converter
 * hands each such group to it and emits what it returns; without one the brackets stay as
 * text. Inside code spans and code blocks they are never touched.
 */

/** One item named inside a `[@KEY ...]` group. */
export interface CitationRef {
  /** The 8-character Zotero item key. */
  key: string;
  /** Where in the work, e.g. "12" or "12-14". */
  locator?: string;
  /** CSL locator label when it is not a page ("chapter", "figure", ...). */
  label?: string;
  /** Text before the key inside the brackets, e.g. "see". */
  prefix?: string;
  /** Text after the locator that is not a locator. */
  suffix?: string;
}

export interface MarkdownOptions {
  /**
   * Renders one bracketed citation group to HTML. Return null to leave the group as the
   * text it was written as.
   */
  citation?: (refs: CitationRef[], source: string) => string | null;
}

const ESCAPABLE = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

/** Text for an HTML text node. Quotes are left alone; only attributes need them escaped. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Text for a double-quoted HTML attribute value. */
export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

const isWhitespace = (c: string | undefined): boolean => c === undefined || /\s/u.test(c);
const isPunctuation = (c: string | undefined): boolean => c !== undefined && /[\p{P}\p{S}]/u.test(c);
const isAlphanumeric = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** CommonMark's flanking rules for a delimiter run from `start` to `end`. */
function flanking(s: string, start: number, end: number): { left: boolean; right: boolean } {
  const before = s[start - 1];
  const after = s[end];
  const left = !isWhitespace(after) && (!isPunctuation(after) || isWhitespace(before) || isPunctuation(before));
  const right = !isWhitespace(before) && (!isPunctuation(before) || isWhitespace(after) || isPunctuation(after));
  return { left, right };
}

function canOpen(s: string, start: number, end: number): boolean {
  const { left, right } = flanking(s, start, end);
  if (s[start] === '_') return left && (!right || isPunctuation(s[start - 1]));
  return left;
}

function canClose(s: string, start: number, end: number): boolean {
  const { left, right } = flanking(s, start, end);
  if (s[start] === '_') return right && (!left || isPunctuation(s[end]));
  return right;
}

function runLength(s: string, i: number, c: string): number {
  let n = 0;
  while (s[i + n] === c) n++;
  return n;
}

/** A code span opening at `i`: its content and the index after it, or null when it never closes. */
function codeSpan(s: string, i: number): { content: string; end: number } | null {
  const n = runLength(s, i, '`');
  let k = i + n;
  while (k < s.length) {
    const j = s.indexOf('`', k);
    if (j === -1) return null;
    const m = runLength(s, j, '`');
    if (m === n) {
      let content = s.slice(i + n, j).replace(/\n/g, ' ');
      if (content.length > 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim()) {
        content = content.slice(1, -1);
      }
      return { content, end: j + m };
    }
    k = j + m;
  }
  return null;
}

/** The index of the `]` matching the `[` at `i`, skipping code spans and escapes, or -1. */
function closingBracket(s: string, i: number): number {
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (c === '\\') {
      k++;
      continue;
    }
    if (c === '`') {
      const span = codeSpan(s, k);
      if (span) k = span.end - 1;
      else k += runLength(s, k, '`') - 1;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** `[text](destination "title")` starting at the `[` at `i`. */
function inlineLink(s: string, i: number): { text: string; dest: string; end: number } | null {
  const close = closingBracket(s, i);
  if (close === -1 || s[close + 1] !== '(') return null;
  let k = close + 2;
  while (s[k] === ' ' || s[k] === '\n') k++;
  let dest = '';
  if (s[k] === '<') {
    const gt = s.indexOf('>', k);
    if (gt === -1 || s.slice(k, gt).includes('\n')) return null;
    dest = s.slice(k + 1, gt);
    k = gt + 1;
  } else {
    let depth = 0;
    const from = k;
    for (; k < s.length; k++) {
      const c = s[k]!;
      if (c === '\\' && k + 1 < s.length) {
        k++;
        continue;
      }
      if (/\s/.test(c)) break;
      if (c === '(') depth++;
      if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
    }
    dest = s.slice(from, k).replace(/\\(.)/g, '$1');
  }
  while (s[k] === ' ' || s[k] === '\n') k++;
  // An optional title, which a note has nowhere to show; it is read past and dropped.
  const quote = s[k];
  if (quote === '"' || quote === "'" || quote === '(') {
    const end = s.indexOf(quote === '(' ? ')' : quote, k + 1);
    if (end === -1) return null;
    k = end + 1;
    while (s[k] === ' ' || s[k] === '\n') k++;
  }
  if (s[k] !== ')') return null;
  return { text: s.slice(i + 1, close), dest, end: k + 1 };
}

/**
 * The URL a link may carry into a note, or null when it may not.
 *
 * `www.` gains a scheme and `doi:` becomes its resolver URL, because both are how people
 * write links in prose. Anything else without an allowed scheme is refused, which keeps a
 * `javascript:` or `data:` URL out of a stored note.
 */
export function safeUrl(raw: string): string | null {
  const url = raw.trim();
  if (!url) return null;
  if (/^www\./i.test(url)) return `https://${url}`;
  const doi = /^doi:\s*(10\.\S+)$/i.exec(url);
  if (doi) return `https://doi.org/${doi[1]}`;
  if (/^(https?|mailto|ftp|zotero):/i.test(url)) return url;
  return null;
}

function anchor(url: string, html: string): string {
  return `<a href="${escapeAttr(url)}" rel="noopener noreferrer nofollow">${html}</a>`;
}

/** Zotero item keys: eight characters, upper-case letters and digits. */
const ITEM_KEY = '[A-Z0-9]{8}';

/**
 * Locator labels people write, mapped to the CSL label Zotero stores. "p." and "pp." map to
 * no label at all, which is what Zotero itself stores for a page and what lets its preview
 * choose between "p." and "pp.".
 */
const LOCATOR_LABELS: Array<[RegExp, string | undefined]> = [
  [/^(?:pp?|pages?)\.?\s*/i, undefined],
  [/^(?:ch|chap|chapters?)\.?\s*/i, 'chapter'],
  [/^(?:sec|sections?|\u00a7)\.?\s*/i, 'section'],
  [/^(?:figs?|figures?)\.?\s*/i, 'figure'],
  [/^(?:tab|tables?)\.?\s*/i, 'table'],
  [/^(?:para|paragraphs?)\.?\s*/i, 'paragraph'],
  [/^(?:vol|volumes?)\.?\s*/i, 'volume'],
  [/^(?:ll?|lines?)\.?\s*/i, 'line'],
  [/^(?:nn?|notes?)\.?\s*/i, 'note'],
  [/^(?:eq|equations?)\.?\s*/i, 'equation'],
];

/** One locator value: "12", "12-14", "xii", "3, 7-9". */
const LOCATOR_VALUE = /^([0-9A-Za-z]+(?:\s*[-\u2013]\s*[0-9A-Za-z]+)?(?:\s*,\s*[0-9]+(?:\s*[-\u2013]\s*[0-9]+)?)*)(.*)$/s;

function parseLocator(text: string): Pick<CitationRef, 'locator' | 'label' | 'suffix'> {
  const t = text.trim();
  if (!t) return {};
  for (const [re, label] of LOCATOR_LABELS) {
    const m = re.exec(t);
    if (!m) continue;
    const value = LOCATOR_VALUE.exec(t.slice(m[0].length));
    if (!value || !/\d|^[ivxlcdm]+$/i.test(value[1]!)) continue;
    const suffix = value[2]!.replace(/^\s*,?\s*/, '').trim();
    return { locator: value[1]!.trim(), ...(label ? { label } : {}), ...(suffix ? { suffix } : {}) };
  }
  const bare = /^\d/.test(t) ? LOCATOR_VALUE.exec(t) : null;
  if (bare) {
    const suffix = bare[2]!.replace(/^\s*,?\s*/, '').trim();
    return { locator: bare[1]!.trim(), ...(suffix ? { suffix } : {}) };
  }
  return { suffix: t };
}

const CITATION_PART = new RegExp(`^\\s*(.*?)\\s*@(${ITEM_KEY})(?![A-Za-z0-9])\\s*(?:,(.*))?$`, 's');

/** `[@KEY]`, `[see @KEY, p. 4]`, `[@KEY1; @KEY2, pp. 3-5]` starting at the `[` at `i`. */
function citationGroup(s: string, i: number): { refs: CitationRef[]; source: string; end: number } | null {
  const close = closingBracket(s, i);
  if (close === -1) return null;
  const inner = s.slice(i + 1, close);
  if (!inner.includes('@') || /[[\]]/.test(inner)) return null;
  const refs: CitationRef[] = [];
  for (const part of inner.split(';')) {
    const m = CITATION_PART.exec(part);
    if (!m) return null;
    const prefix = m[1]!.trim();
    refs.push({ key: m[2]!, ...(prefix ? { prefix } : {}), ...parseLocator(m[3] ?? '') });
  }
  return { refs, source: s.slice(i, close + 1), end: close + 1 };
}

/**
 * Where the delimiter run opened at `from` closes: the index of its closer, or -1.
 *
 * A run only closes with a run of the same character that can close (CommonMark's flanking
 * rules). Runs that open in between are stacked and closed first, so `*a **b** c*` and
 * `**a **b** c**` pair from the inside out, and a closing run longer than the one it closes
 * lends what is left over, which is how `**a *b***` closes both.
 */
function findCloser(s: string, from: number, c: string, n: number): number {
  const open: number[] = [];
  for (let k = from; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\') {
      k++;
      continue;
    }
    if (ch === '`') {
      const span = codeSpan(s, k);
      k = (span ? span.end : k + runLength(s, k, '`')) - 1;
      continue;
    }
    if (ch === ']' && s[k + 1] === '(') {
      // A link destination is not prose: an underscore in a URL closes nothing.
      const close = s.indexOf(')', k + 2);
      if (close !== -1) k = close;
      continue;
    }
    if (ch !== c) continue;
    const m = runLength(s, k, c);
    if (k > from && canClose(s, k, k + m)) {
      let left = m;
      while (open.length && left > 0) {
        const top = open.pop()!;
        if (top > left) {
          open.push(top - left);
          left = 0;
        } else {
          left -= top;
        }
      }
      if (!open.length && left >= n) return k + m - n;
    } else if (canOpen(s, k, k + m)) {
      open.push(m);
    }
    k += m - 1;
  }
  return -1;
}

const BARE_URL = /^(?:https?:\/\/|www\.)[^\s<>"]+/i;

/** A bare URL with the trailing punctuation that belongs to the sentence taken back off. */
function bareUrl(s: string, i: number): string | null {
  const m = BARE_URL.exec(s.slice(i));
  if (!m) return null;
  let url = m[0];
  for (;;) {
    const last = url[url.length - 1];
    if (last && '.,:;!?\'"*_~'.includes(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ')' && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
      url = url.slice(0, -1);
      continue;
    }
    break;
  }
  return url.length > 'https://'.length - 1 ? url : null;
}

/**
 * Inline math in Pandoc's sense: the opening `$` has a non-space on its right, the closing
 * one a non-space on its left and no digit after it. That is what keeps "$5 and $10" text.
 */
function inlineMath(s: string, i: number): { tex: string; end: number } | null {
  if (s[i + 1] === '$') {
    const close = s.indexOf('$$', i + 2);
    if (close === -1 || !s.slice(i + 2, close).trim()) return null;
    return { tex: s.slice(i + 2, close).trim(), end: close + 2 };
  }
  if (isWhitespace(s[i + 1])) return null;
  for (let k = i + 1; k < s.length; k++) {
    if (s[k] === '\\') {
      k++;
      continue;
    }
    if (s[k] !== '$') continue;
    if (isWhitespace(s[k - 1]) || /\d/.test(s[k + 1] ?? '')) return null;
    return { tex: s.slice(i + 1, k), end: k + 1 };
  }
  return null;
}

/**
 * Where the last run of `c` that could close an emphasis sits, or -1. An opener past it has
 * nothing to close with, so it is text without a scan: without this, a paragraph of a
 * thousand stray asterisks scanned to its end once per asterisk.
 */
function lastCloser(s: string, c: string): number {
  for (let k = s.length - 1; k >= 0; k--) {
    if (s[k] !== c) continue;
    let start = k;
    while (s[start - 1] === c) start--;
    if (canClose(s, start, k + 1)) return start;
    k = start;
  }
  return -1;
}

/** Markdown inline content to HTML. */
export function renderInline(s: string, opts: MarkdownOptions = {}): string {
  const closers = new Map<string, number>();
  let out = '';
  let text = '';
  const flush = (): void => {
    out += escapeHtml(text);
    text = '';
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;

    if (c === '\\') {
      const next = s[i + 1];
      if (next === '\n') {
        flush();
        out += '<br>';
        i += 2;
        continue;
      }
      if (next !== undefined && ESCAPABLE.includes(next)) {
        text += next;
        i += 2;
        continue;
      }
    }

    if (c === '\n') {
      const hard = / {2,}$/.test(text);
      text = text.replace(/ +$/, '');
      if (hard) {
        flush();
        out += '<br>';
      } else {
        text += '\n';
      }
      i++;
      while (s[i] === ' ') i++;
      continue;
    }

    if (c === '`') {
      const span = codeSpan(s, i);
      if (span) {
        flush();
        out += `<code>${escapeHtml(span.content)}</code>`;
        i = span.end;
      } else {
        const n = runLength(s, i, '`');
        text += s.slice(i, i + n);
        i += n;
      }
      continue;
    }

    if (c === '[' || (c === '!' && s[i + 1] === '[')) {
      const at = c === '!' ? i + 1 : i;
      if (c === '[' && opts.citation) {
        const group = citationGroup(s, at);
        const html = group ? opts.citation(group.refs, group.source) : null;
        if (group && html != null) {
          flush();
          out += html;
          i = group.end;
          continue;
        }
      }
      const link = inlineLink(s, at);
      if (link) {
        const url = safeUrl(link.dest);
        flush();
        // A note cannot hotlink a remote image, so an image becomes a link to it, labelled
        // with its alt text.
        const label = c === '!' ? escapeHtml(link.text || link.dest) : renderInline(link.text, opts);
        out += url ? anchor(url, label) : label;
        i = link.end;
        continue;
      }
    }

    if (c === '<') {
      const m = /^<((?:https?|mailto|ftp|zotero):[^\s<>]*)>/i.exec(s.slice(i)) ?? /^<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/.exec(s.slice(i));
      if (m) {
        const target = m[1]!.includes(':') ? m[1]! : `mailto:${m[1]}`;
        flush();
        out += anchor(target, escapeHtml(m[1]!));
        i += m[0].length;
        continue;
      }
    }

    if ((c === 'h' || c === 'w' || c === 'H' || c === 'W') && !isAlphanumeric(s[i - 1]) && s[i - 1] !== '/') {
      const url = bareUrl(s, i);
      if (url) {
        flush();
        out += anchor(safeUrl(url)!, escapeHtml(url));
        i += url.length;
        continue;
      }
    }

    if (c === '$') {
      const math = inlineMath(s, i);
      if (math) {
        flush();
        out += `<span class="math">$${escapeHtml(math.tex)}$</span>`;
        i = math.end;
        continue;
      }
    }

    if (c === '*' || c === '_' || c === '~') {
      const run = runLength(s, i, c);
      const n = c === '~' ? (run === 2 ? 2 : 0) : run <= 3 ? run : 0;
      if (!closers.has(c)) closers.set(c, lastCloser(s, c));
      const reachable = closers.get(c)! > i;
      const close = n && reachable && canOpen(s, i, i + run) ? findCloser(s, i + run, c, n) : -1;
      if (close !== -1) {
        const inner = renderInline(s.slice(i + n, close), opts);
        flush();
        if (c === '~') out += `<span style="text-decoration: line-through">${inner}</span>`;
        else if (n === 1) out += `<em>${inner}</em>`;
        else if (n === 2) out += `<strong>${inner}</strong>`;
        else out += `<strong><em>${inner}</em></strong>`;
        i = close + n;
        continue;
      }
      text += s.slice(i, i + run);
      i += run;
      continue;
    }

    text += c;
    i++;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------------------
// Blocks

const BLANK = /^\s*$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}> ?/;
const BULLET = /^( {0,3})([-+*])(?:([ \t]+)(.*))?$/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])(?:([ \t]+)(.*))?$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const DISPLAY_MATH = /^ {0,3}\$\$/;

interface ListMarker {
  indent: number;
  /** "-", "+", "*" for a bullet; "." or ")" for an ordered list. */
  kind: string;
  ordered: boolean;
  start: number;
  /** Columns from the line start to the item's content. */
  contentIndent: number;
  rest: string;
}

function listMarker(line: string): ListMarker | null {
  const b = BULLET.exec(line);
  if (b && !HR.test(line)) {
    const gap = b[3] ?? '';
    const indent = b[1]!.length;
    // Five or more spaces after the marker would open an indented code block; that is read
    // as one space plus content, the way CommonMark reads it.
    const pad = gap.length >= 5 || !b[4] ? 1 : gap.length;
    return { indent, kind: b[2]!, ordered: false, start: 1, contentIndent: indent + 1 + pad, rest: gap.length >= 5 ? gap.slice(1) + b[4] : b[4] ?? '' };
  }
  const o = ORDERED.exec(line);
  if (o) {
    const gap = o[4] ?? '';
    const indent = o[1]!.length;
    const width = o[2]!.length + 1;
    const pad = gap.length >= 5 || !o[5] ? 1 : gap.length;
    return { indent, kind: o[3]!, ordered: true, start: Number(o[2]), contentIndent: indent + width + pad, rest: gap.length >= 5 ? gap.slice(1) + o[5] : o[5] ?? '' };
  }
  return null;
}

function indentOf(line: string): number {
  return /^ */.exec(line)![0].length;
}

/** Table cells of one row, split on pipes that are neither escaped nor inside a code span. */
function tableCells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let k = 0; k < row.length; k++) {
    const c = row[k]!;
    if (c === '\\' && row[k + 1] === '|') {
      cell += '|';
      k++;
      continue;
    }
    if (c === '`') {
      const span = codeSpan(row, k);
      if (span) {
        cell += row.slice(k, span.end);
        k = span.end - 1;
        continue;
      }
    }
    if (c === '|') {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += c;
  }
  cells.push(cell.trim());
  return cells;
}

function isTableStart(line: string | undefined, next: string | undefined): boolean {
  if (!line || !next || !line.includes('|') || !TABLE_DELIMITER.test(next)) return false;
  if (!next.includes('|') && !line.trim().startsWith('|')) return false;
  return tableCells(line).length === tableCells(next).length;
}

/** Whether `line` ends a paragraph by starting a block of its own. */
function interruptsParagraph(line: string, next: string | undefined): boolean {
  if (ATX.test(line) || FENCE.test(line) || QUOTE.test(line) || HR.test(line) || DISPLAY_MATH.test(line)) return true;
  if (isTableStart(line, next)) return true;
  const marker = listMarker(line);
  // CommonMark: an empty item, or an ordered list that does not start at 1, cannot
  // interrupt a paragraph, so "the year\n2019. was good" stays one paragraph.
  return !!marker && marker.rest.trim() !== '' && (!marker.ordered || marker.start === 1);
}

/** A paragraph-shaped chunk, which a tight list item renders without its `<p>`. */
const PARAGRAPH_HTML = /^<p>([\s\S]*)<\/p>$/;

function renderList(lines: string[], i: number, opts: MarkdownOptions): { html: string; next: number } {
  const first = listMarker(lines[i]!)!;
  const items: string[][] = [];
  let loose = false;
  let blankBetweenItems = false;

  while (i < lines.length) {
    const marker = listMarker(lines[i]!);
    if (!marker || marker.ordered !== first.ordered || marker.kind !== first.kind) break;
    if (items.length && blankBetweenItems) loose = true;
    const body: string[] = [marker.rest];
    i++;
    let sawBlank = false;
    while (i < lines.length) {
      const line = lines[i]!;
      if (BLANK.test(line)) {
        sawBlank = true;
        body.push('');
        i++;
        continue;
      }
      if (indentOf(line) >= marker.contentIndent) {
        if (sawBlank && body.some((l) => l.trim())) loose = true;
        body.push(line.slice(marker.contentIndent));
        sawBlank = false;
        i++;
        continue;
      }
      if (sawBlank) break;
      if (listMarker(line) || ATX.test(line) || FENCE.test(line) || QUOTE.test(line) || HR.test(line)) break;
      // A lazy continuation line: CommonMark lets a paragraph inside an item go on without
      // the indent.
      body.push(line.trimStart());
      i++;
    }
    let trailing = 0;
    while (body.length && BLANK.test(body[body.length - 1]!)) {
      body.pop();
      trailing++;
    }
    blankBetweenItems = trailing > 0;
    items.push(body);
  }

  const tag = first.ordered ? 'ol' : 'ul';
  const start = first.ordered && first.start !== 1 ? ` start="${first.start}"` : '';
  const rendered = items.map((body) => {
    // A task-list box, which the note editor has no node for, keeps its meaning as a glyph.
    if (body[0] !== undefined) body[0] = body[0].replace(/^\[( |x|X)\][ \t]+/, (_m, x: string) => (x === ' ' ? '\u2610 ' : '\u2611 '));
    const blocks = renderBlocks(body, opts);
    const parts = loose ? blocks : blocks.map((b) => PARAGRAPH_HTML.exec(b)?.[1] ?? b);
    return `<li>${parts.join(loose ? '\n' : '')}</li>`;
  });
  return { html: `<${tag}${start}>\n${rendered.join('\n')}\n</${tag}>`, next: i };
}

function renderTable(lines: string[], i: number, opts: MarkdownOptions): { html: string; next: number } {
  const header = tableCells(lines[i]!);
  const width = header.length;
  const rows: string[] = [`<tr>${header.map((c) => `<th>${renderInline(c, opts)}</th>`).join('')}</tr>`];
  i += 2;
  while (i < lines.length && !BLANK.test(lines[i]!) && lines[i]!.includes('|')) {
    const cells = tableCells(lines[i]!);
    const row: string[] = [];
    for (let k = 0; k < width; k++) row.push(`<td>${renderInline(cells[k] ?? '', opts)}</td>`);
    rows.push(`<tr>${row.join('')}</tr>`);
    i++;
  }
  return { html: `<table>\n<tbody>\n${rows.join('\n')}\n</tbody>\n</table>`, next: i };
}

/** Markdown lines to HTML block chunks, one per block. */
function renderBlocks(lines: string[], opts: MarkdownOptions): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (BLANK.test(line)) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence && !(fence[2]![0] === '`' && fence[3]!.includes('`'))) {
      const indent = fence[1]!.length;
      const mark = fence[2]!;
      const closing = new RegExp(`^ {0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}[ \\t]*$`);
      const code: string[] = [];
      i++;
      while (i < lines.length && !closing.test(lines[i]!)) {
        const l = lines[i]!;
        code.push(l.slice(Math.min(indent, indentOf(l))));
        i++;
      }
      i++; // the closing fence, or past the end when the block never closed
      out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`);
      continue;
    }

    if (DISPLAY_MATH.test(line)) {
      const startLine = line.trim().slice(2);
      let tex: string | null = null;
      let next = i + 1;
      if (startLine.endsWith('$$') && startLine.length > 2) {
        tex = startLine.slice(0, -2);
      } else {
        const body = [startLine];
        for (let k = i + 1; k < lines.length; k++) {
          const l = lines[k]!.trim();
          if (l.endsWith('$$')) {
            body.push(l.slice(0, -2));
            tex = body.join('\n');
            next = k + 1;
            break;
          }
          if (BLANK.test(l)) break;
          body.push(l);
        }
      }
      if (tex !== null && tex.trim()) {
        out.push(`<pre class="math">$$${escapeHtml(tex.trim())}$$</pre>`);
        i = next;
        continue;
      }
    }

    const atx = ATX.exec(line);
    if (atx) {
      const level = atx[1]!.length;
      out.push(`<h${level}>${renderInline((atx[2] ?? '').trim(), opts)}</h${level}>`);
      i++;
      continue;
    }

    if (HR.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        if (QUOTE.test(l)) inner.push(l.replace(QUOTE, ''));
        else if (!BLANK.test(l) && inner.length && !BLANK.test(inner[inner.length - 1]!) && !interruptsParagraph(l, lines[i + 1])) inner.push(l);
        else break;
        i++;
      }
      out.push(`<blockquote>\n${renderBlocks(inner, opts).join('\n')}\n</blockquote>`);
      continue;
    }

    if (listMarker(line)) {
      const list = renderList(lines, i, opts);
      out.push(list.html);
      i = list.next;
      continue;
    }

    if (isTableStart(line, lines[i + 1])) {
      const table = renderTable(lines, i, opts);
      out.push(table.html);
      i = table.next;
      continue;
    }

    const para: string[] = [line.trimStart()];
    i++;
    while (i < lines.length && !BLANK.test(lines[i]!)) {
      const l = lines[i]!;
      const setext = SETEXT.exec(l);
      if (setext) {
        const level = setext[1]![0] === '=' ? 1 : 2;
        out.push(`<h${level}>${renderInline(para.join('\n').trim(), opts)}</h${level}>`);
        para.length = 0;
        i++;
        break;
      }
      if (interruptsParagraph(l, lines[i + 1])) break;
      para.push(l.trimStart());
      i++;
    }
    if (para.length) {
      // Trailing spaces on the last line are not a hard break; there is no line after it.
      out.push(`<p>${renderInline(para.join('\n').replace(/[ \t]+$/, ''), opts)}</p>`);
    }
  }
  return out;
}

/** Leading tabs as four columns each, so indentation means the same whichever was typed. */
function expandIndent(line: string): string {
  return line.replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, '    '));
}

/** Markdown to the body HTML of a Zotero note (no wrapper; see note-html.ts). */
export function markdownToNoteHtml(markdown: string, opts: MarkdownOptions = {}): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n').map(expandIndent);
  return renderBlocks(lines, opts).join('\n');
}

/**
 * The item keys a Markdown text cites with `[@KEY]`, in first-seen order, outside code
 * spans and code blocks: exactly the groups `markdownToNoteHtml` would hand to its
 * `citation` renderer.
 */
export function citedKeys(markdown: string): string[] {
  const keys: string[] = [];
  markdownToNoteHtml(markdown, {
    citation: (refs) => {
      for (const ref of refs) if (!keys.includes(ref.key)) keys.push(ref.key);
      return '';
    },
  });
  return keys;
}
