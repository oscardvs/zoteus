import { bibtexToRecords } from './bibtex.js';
import { cslJsonToRecords } from './csl-json.js';
import { risToRecords } from './ris.js';
import type { BibRecord } from './record.js';

/** The formats parsed in-repo, with no external service. */
export type ImportFormat = 'bibtex' | 'ris' | 'csljson';

/**
 * How much of a payload is read to decide its format.
 *
 * A marker that is not in the first 64 KB would not identify the file anyway, and the bound
 * means no sniff pattern can ever be handed megabytes.
 */
const SNIFF_HEAD_CHARS = 64 * 1024;

/**
 * Which of the three formats a payload is, from the payload itself.
 *
 * Sniffing is cheap and the three are unmistakable: CSL-JSON is JSON, a BibTeX entry opens
 * with `@type{`, and an RIS line is a two-character tag, some spaces, a dash. Returns
 * undefined rather than guessing when none of them matches, so the caller can say what it
 * received instead of parsing it as the wrong thing and reporting zero entries.
 *
 * Both patterns match horizontal whitespace only, and that is load-bearing rather than
 * tidiness. Under the `m` flag `^` matches at every line start, so a `\s*` that can cross
 * newlines makes the engine eat a whole run of blank lines at each line start and then
 * backtrack a character at a time: quadratic in the length of the run. A 2 MB paste of blank
 * lines, which is inside the payload cap, took tens of minutes of a blocked event loop, and
 * Node is single-threaded, so the whole server answered nothing for the duration. A BibTeX
 * entry opener is on one line by definition, so nothing legitimate matched the old pattern
 * and not the new one.
 */
export function sniffFormat(text: string): ImportFormat | undefined {
  const s = text.replace(/^\uFEFF/, '').trimStart();
  if (!s) return undefined;
  if (s.startsWith('[') || s.startsWith('{')) return 'csljson';
  const head = s.length > SNIFF_HEAD_CHARS ? s.slice(0, SNIFF_HEAD_CHARS) : s;
  if (/^[ \t]*@[A-Za-z]+[ \t]*[{(]/m.test(head)) return 'bibtex';
  if (/^(TY|ER|A1|AU|T1|TI|JO|PY|SN|UR|DO|AB|KW)[ \t]{1,3}-/m.test(head)) return 'ris';
  return undefined;
}

export interface ParsedBibliography {
  format: ImportFormat;
  records: BibRecord[];
  warnings: string[];
}

/**
 * Parse a bibliographic payload. Throws only when the format itself is unreadable (invalid
 * JSON); a file whose entries are malformed comes back with whatever could be read and a
 * warning for each entry that could not.
 */
export function parseBibliography(text: string, format: ImportFormat): ParsedBibliography {
  switch (format) {
    case 'bibtex': {
      const { records, warnings } = bibtexToRecords(text);
      return { format, records, warnings };
    }
    case 'ris': {
      const { records, warnings } = risToRecords(text);
      return { format, records, warnings };
    }
    case 'csljson': {
      const { records, warnings } = cslJsonToRecords(text);
      return { format, records, warnings };
    }
  }
}
