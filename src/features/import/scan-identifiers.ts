import { bareDoi, parseIdentifier } from '../resolve/resolve.js';

/**
 * Finding a DOI or an arXiv id inside a page of prose.
 *
 * `parseIdentifier` (src/features/resolve/resolve.ts) classifies a WHOLE string and every
 * one of its branches is `^...$` anchored, so it cannot be pointed at a page of text: it
 * would match nothing, and "matched nothing" looks exactly like "this PDF has no DOI". The
 * scanning is therefore new code, and it hands every candidate it finds back to
 * `parseIdentifier` for canonicalisation so there is still only one definition of what a
 * valid identifier is.
 *
 * The reason for the `confidence` field: a paper's first page routinely carries DOIs that
 * are not its own. A "cite as" block names a different version, a footnote cites a related
 * work, and journal boilerplate carries the publisher's prefix. A hit introduced by `doi:`
 * or `https://doi.org/` is the paper's own far more often than a bare `10.x` string is, so
 * the two are ranked differently and both are reported. Nothing here decides for the user:
 * the identifier, the page it was on and the words around it are all returned, and saving is
 * opt-in.
 */

export type ScannedIdentifierType = 'doi' | 'arxiv';

export interface IdentifierHit {
  type: ScannedIdentifierType;
  /** Canonical form: a bare DOI, or an arXiv id without its "arXiv:" prefix. */
  value: string;
  /** 1-based page of the scanned text the hit was on. */
  page: number;
  /** The text that introduced it ("doi:", "https://doi.org/", "arXiv:"), or "" for a bare match. */
  label: string;
  /** A short window of the page around the hit, so a caller can see the claim in context. */
  context: string;
  /**
   * "high" when a label introduced the identifier, "low" for a bare match. Low is a real
   * answer, not a failure: it is how an identifier printed alone in a header reads.
   */
  confidence: 'high' | 'low';
}

/** A DOI as it appears in running text. Trailing punctuation is trimmed afterwards. */
const DOI_PATTERN = /10\.\d{4,9}\/[^\s"'<>(){}[\]]+/g;

/** `arXiv:2301.12345v2`, `arxiv.org/abs/2301.12345`, and the legacy `math.GT/0309136` form. */
const ARXIV_PATTERN =
  /(?:arxiv\s*:\s*|arxiv\.org\/(?:abs|pdf)\/)((?:\d{4}\.\d{4,5}(?:v\d+)?)|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?))/gi;

/** What introduces a DOI when a document bothers to say. */
const DOI_LABEL = /(https?:\/\/(?:dx\.)?doi\.org\/|\bdoi\s*:?\s*|\bDOI\b\s*:?\s*)$/i;

const CONTEXT_CHARS = 60;

/**
 * Trailing characters that belong to the sentence rather than to the DOI. A DOI may legally
 * end in almost anything, so this is a heuristic and it errs towards trimming: a DOI that
 * really ends in a full stop is rarer than a sentence that ends after one.
 */
function trimDoi(raw: string): string {
  let value = raw;
  while (value.length > 1 && /[.,;:)\]}>'"]$/.test(value)) value = value.slice(0, -1);
  return value;
}

function contextAround(text: string, at: number, length: number): string {
  const from = Math.max(0, at - CONTEXT_CHARS);
  const to = Math.min(text.length, at + length + CONTEXT_CHARS);
  return text.slice(from, to).replace(/\s+/g, ' ').trim();
}

/**
 * Every DOI and arXiv id in `pages` (index 0 is page 1), strongest first.
 *
 * Ordering: labelled hits before bare ones, then by page, then by position on the page. That
 * puts the identifier a document states about itself ahead of one it merely mentions, which
 * is the order a caller wants to read them in. Duplicates are collapsed, keeping the
 * strongest occurrence of each value.
 */
export function scanIdentifiers(pages: string[]): IdentifierHit[] {
  const hits: IdentifierHit[] = [];
  pages.forEach((text, index) => {
    if (!text) return;
    const page = index + 1;

    DOI_PATTERN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DOI_PATTERN.exec(text))) {
      const value = trimDoi(m[0]);
      const parsed = parseIdentifier(value);
      if (!parsed || parsed.type !== 'doi') continue;
      const before = text.slice(Math.max(0, m.index - 30), m.index);
      const label = DOI_LABEL.exec(before)?.[0]?.trim() ?? '';
      hits.push({
        type: 'doi',
        value: bareDoi(parsed.value),
        page,
        label,
        context: contextAround(text, m.index, m[0].length),
        confidence: label ? 'high' : 'low',
      });
    }

    ARXIV_PATTERN.lastIndex = 0;
    while ((m = ARXIV_PATTERN.exec(text))) {
      const raw = m[1];
      if (!raw) continue;
      const parsed = parseIdentifier(raw);
      if (!parsed || parsed.type !== 'arxiv') continue;
      hits.push({
        type: 'arxiv',
        value: parsed.value,
        page,
        // The whole match minus the id is what introduced it, which is always something here.
        label: m[0].slice(0, m[0].length - raw.length).trim(),
        context: contextAround(text, m.index, m[0].length),
        confidence: 'high',
      });
    }
  });

  const best = new Map<string, IdentifierHit>();
  for (const hit of hits) {
    const id = `${hit.type}:${hit.value.toLowerCase()}`;
    const seen = best.get(id);
    if (!seen || (seen.confidence === 'low' && hit.confidence === 'high')) best.set(id, hit);
  }
  return [...best.values()].sort((a, b) => {
    if (a.confidence !== b.confidence) return a.confidence === 'high' ? -1 : 1;
    return a.page - b.page;
  });
}

/** True when nothing on any scanned page carried text, i.e. the PDF has no text layer. */
export function hasTextLayer(pages: string[]): boolean {
  return pages.some((p) => p.trim().length > 0);
}
