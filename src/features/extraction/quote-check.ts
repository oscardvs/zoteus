import type { ToolContext } from '../../registry/registry.js';
import type { LibraryRef } from '../../api/web-client.js';
import { detectKind, fetchAttachmentBytes, resolveAttachment } from '../attachments/resolve.js';
import { extractPdfPages } from '../fulltext/pdf-pages.js';
import { extractEpubText } from '../fulltext/epub.js';
import type { QuoteCheck } from './record.js';

/**
 * Checking that a quoted passage really occurs in an item's text, from the same sources
 * zotero_get_fulltext reads: Zotero's own full-text index first, and when it has none, the
 * attachment file itself (PDF or EPUB), read from the desktop app, the local storage folder
 * or cloud storage. No OCR: a scan with no text layer leaves its quotes unchecked, said so.
 */

export type DocumentText = { text: string; pages?: string[]; source: 'zotero index' | 'PDF' | 'EPUB' } | { unavailable: string };

export async function loadDocumentText(ctx: ToolContext, itemKey: string, lib: LibraryRef): Promise<DocumentText> {
  const resolved = await resolveAttachment(ctx, itemKey, lib);
  if ('error' in resolved) return { unavailable: 'no readable attachment' };
  const ft = await ctx.router.getFullText(resolved.attachmentKey, { library: lib });
  if (ft && typeof ft.content === 'string' && ft.content.trim()) return { text: ft.content, source: 'zotero index' };
  const file = await fetchAttachmentBytes(ctx, resolved, lib);
  if (file.tooLarge) return { unavailable: 'not indexed by Zotero, and the file is too large to read on the fly' };
  if (!file.bytes) return { unavailable: 'not indexed by Zotero, and the file could not be read' };
  const kind = detectKind(file.bytes, resolved.contentType, resolved.filename);
  if (kind === 'epub') {
    const epub = extractEpubText(file.bytes);
    return epub?.text.trim() ? { text: epub.text, source: 'EPUB' } : { unavailable: 'the EPUB holds no readable text' };
  }
  if (kind !== 'pdf') return { unavailable: 'the attachment is neither a PDF nor an EPUB, and Zotero has not indexed it' };
  const pages = await extractPdfPages(file.bytes);
  if (!pages?.some((p) => p.trim())) return { unavailable: 'the PDF has no text layer (a scan needs zotero_get_fulltext with ocr)' };
  return { text: pages.join('\n'), pages, source: 'PDF' };
}

/**
 * Text reduced to what survives PDF extraction unchanged: compatibility forms folded (the
 * "fi" ligature becomes two letters), case, typographic quotes and dashes unified, soft
 * hyphens and end-of-line hyphenation removed, whitespace collapsed.
 */
export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\u00ad/g, '')
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/(\p{L})-\s*\n\s*(\p{L})/gu, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Shorter than this, a match proves little: "the" occurs in every paper. */
export const MIN_QUOTE_CHARS = 12;

/**
 * Whether `quote` occurs in `normalizedText` (already passed through normalizeForMatch). An
 * ellipsis ("..." or "…") splits the quote into fragments that must occur in order, which is
 * how a trimmed quotation is written. A second, whitespace-blind pass catches text whose
 * extraction lost or added spaces between words; the characters must still all be there.
 */
export function quoteOccurs(quote: string, normalizedText: string): { found: boolean; at?: number } {
  const fragments = normalizeForMatch(quote.replace(/…/g, '...'))
    .split(/\s*(?:\.\s*){3}\s*|\s*\[\s*\.\.\.\s*\]\s*/)
    .map((f) => f.trim())
    .filter(Boolean);
  if (!fragments.length) return { found: false };
  const inOrder = (hay: string, frags: string[]): number | undefined => {
    let from = 0;
    let first: number | undefined;
    for (const f of frags) {
      const at = hay.indexOf(f, from);
      if (at < 0) return undefined;
      first ??= at;
      from = at + f.length;
    }
    return first;
  };
  const at = inOrder(normalizedText, fragments);
  if (at !== undefined) return { found: true, at };
  const squash = (s: string) => s.replace(/\s+/g, '');
  const loose = inOrder(squash(normalizedText), fragments.map(squash));
  return loose !== undefined ? { found: true } : { found: false };
}

export interface QuoteVerdict {
  check: QuoteCheck;
  checkNote?: string;
  foundPage?: number;
}

/** The verdict for one quote against a loaded document. */
export function checkQuote(quote: string, doc: DocumentText, normalized?: { text: string; pages?: string[] }): QuoteVerdict {
  if ('unavailable' in doc) return { check: 'unchecked', checkNote: doc.unavailable };
  if (normalizeForMatch(quote).length < MIN_QUOTE_CHARS) {
    return { check: 'unchecked', checkNote: `quote shorter than ${MIN_QUOTE_CHARS} characters proves nothing` };
  }
  const text = normalized?.text ?? normalizeForMatch(doc.text);
  const hit = quoteOccurs(quote, text);
  if (!hit.found) return { check: 'not-found', checkNote: `checked against the ${doc.source} text` };
  const verdict: QuoteVerdict = { check: 'verified', checkNote: `checked against the ${doc.source} text` };
  const pages = normalized?.pages ?? doc.pages?.map(normalizeForMatch);
  if (pages) {
    const onPages = pages.flatMap((p, i) => (quoteOccurs(quote, p).found ? [i + 1] : []));
    if (onPages.length === 1) verdict.foundPage = onPages[0];
  }
  return verdict;
}
