import type { LibraryRef } from '../../api/web-client.js';
import type { ToolContext } from '../../registry/registry.js';
import { BbtClient } from '../../api/bbt-client.js';
import { loopbackFetch } from '../../api/loopback-fetch.js';
import { citationPreview, cslItemData } from '../notes/citations.js';
import { detectKind, fetchAttachmentBytes, resolveAttachment } from '../attachments/resolve.js';
import { extractPdfPages, pageAtOffset, pdfPagesToText } from '../fulltext/pdf-pages.js';
import { extractEpubText, DEFAULT_EPUB_MAX_BYTES } from '../fulltext/epub.js';
import { approxPage } from '../fulltext/passages.js';
import {
  attachQuotes,
  findQuotes,
  foldName,
  normalizeDoi,
  parseCitations,
  parseReferences,
  referenceSectionStart,
  titleWords,
  type CiteTarget,
  type FoundCitation,
} from './parse.js';
import { matchQuote, normalizeForMatch, type NormalizedText } from './quotes.js';

/** A library item as the report names it. */
export interface ItemSummary {
  key: string;
  title: string;
  citation: string;
}

export type MatchedBy = 'item_key' | 'citation_key' | 'better_bibtex' | 'doi' | 'author_year' | 'author_year_title';

export interface WorkResult {
  cited: Record<string, unknown>;
  status: 'matched' | 'ambiguous' | 'not_in_library' | 'unresolved';
  matchedBy?: MatchedBy;
  item?: ItemSummary;
  candidates?: ItemSummary[];
  note?: string;
}

export interface QuoteResult {
  text: string;
  status: 'found' | 'close_match' | 'not_found' | 'no_fulltext' | 'not_checked';
  itemKey?: string;
  page?: number;
  pageApprox?: number;
  similarity?: number;
  bestSimilarity?: number;
  sourceText?: string;
  note?: string;
}

export interface CitationResult {
  index: number;
  kind: string;
  cite: string;
  line: number;
  works: WorkResult[];
  quotes: QuoteResult[];
}

export interface CheckOptions {
  draft: string;
  references?: string;
  start: number;
  maxCitations: number;
  maxFulltexts: number;
  checkQuotes: boolean;
}

export interface CheckReport {
  citations: CitationResult[];
  totalCitations: number;
  start: number;
  nextStart?: number;
  fulltextsRead: number;
  referenceEntries: number;
  notices: string[];
}

const NOT_CITABLE = new Set(['note', 'attachment', 'annotation']);
const isNotFound = (e: unknown) => (e as { status?: number } | null)?.status === 404;

function summarize(item: any): ItemSummary {
  const d = item?.data ?? item ?? {};
  return { key: d.key ?? item?.key, title: String(d.title ?? ''), citation: citationPreview(cslItemData(item, '')) };
}

function itemYear(item: any): string | undefined {
  const d = item?.data ?? item ?? {};
  return /\b(\d{4})\b/.exec(String(d.date ?? ''))?.[1] ?? /^(\d{4})/.exec(String(item?.meta?.parsedDate ?? ''))?.[1];
}

function surnames(item: any): string[] {
  const d = item?.data ?? item ?? {};
  return (d.creators ?? []).map((c: any) => foldName(String(c?.lastName ?? c?.name ?? ''))).filter(Boolean);
}

/** The DOI an item carries: its DOI field, or a "DOI: ..." line in Extra (where Zotero keeps it for types with no field). */
function itemDoi(item: any): string | undefined {
  const d = item?.data ?? item ?? {};
  if (d.DOI) return normalizeDoi(String(d.DOI));
  const extra = /^DOI:\s*(\S+)/im.exec(String(d.extra ?? ''))?.[1];
  return extra ? normalizeDoi(extra) : undefined;
}

/** What a work was cited as, for the report: only the fields the draft gave. */
function citedAs(t: CiteTarget): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ['itemKey', 'citekey', 'doi', 'author', 'author2', 'year', 'number', 'locator', 'label', 'reference'] as const) {
    if (t[k] != null) out[k] = t[k];
  }
  return out;
}

/** Library lookups for one call, cached so a work cited twenty times costs one search. */
class Resolver {
  private cache = new Map<string, Promise<Omit<WorkResult, 'cited'>>>();
  private bbt: BbtClient | null | undefined;
  bbtUsed = false;

  constructor(
    private ctx: ToolContext,
    private lib: LibraryRef,
  ) {}

  resolve(t: CiteTarget): Promise<Omit<WorkResult, 'cited'>> {
    const sig = JSON.stringify([t.itemKey, t.citekey, t.doi, t.author, t.author2, t.year, t.titleWords, t.number]);
    let hit = this.cache.get(sig);
    if (!hit) {
      hit = this.run(t);
      this.cache.set(sig, hit);
    }
    return hit;
  }

  private async search(q: string, qmode: 'titleCreatorYear' | 'everything', limit = 50): Promise<any[]> {
    const res = await this.ctx.router.searchItems({ q, qmode, top: true, limit, library: this.lib });
    return ((res as any)?.data ?? []).filter((i: any) => !NOT_CITABLE.has((i?.data ?? i)?.itemType));
  }

  private async run(t: CiteTarget): Promise<Omit<WorkResult, 'cited'>> {
    if (t.itemKey) {
      let item: any = null;
      try {
        item = await this.ctx.router.getItem(t.itemKey, { library: this.lib });
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
      const d = item?.data ?? item;
      if (d?.itemType && !NOT_CITABLE.has(d.itemType)) return { status: 'matched', matchedBy: 'item_key', item: summarize(item) };
      if (d?.itemType) {
        return {
          status: 'not_in_library',
          note: `${t.itemKey} is ${d.itemType === 'attachment' || d.itemType === 'annotation' ? 'an' : 'a'} ${d.itemType}, not a citable work${d.parentItem ? `; cite its parent ${d.parentItem}` : ''}.`,
        };
      }
      // Eight capitals and digits can also be a citation key; fall through.
      return this.byCitekey(t.itemKey, true);
    }
    if (t.citekey) return this.byCitekey(t.citekey, false);
    if (t.doi) {
      const r = await this.byDoi(t.doi);
      if (r.status !== 'not_in_library' || !t.author) return r;
    }
    if (t.author && t.year) return this.byAuthorYear(t);
    if (t.number != null) {
      return {
        status: 'unresolved',
        note: t.reference
          ? 'The reference-list entry names neither a DOI nor an author and year that could be read.'
          : `No reference-list entry numbered ${t.number}: pass the reference list as \`references\`, or keep it at the end of the draft under a "References" heading.`,
      };
    }
    return { status: 'unresolved', note: 'Nothing in the citation could be looked up.' };
  }

  private async byCitekey(key: string, wasItemKey: boolean): Promise<Omit<WorkResult, 'cited'>> {
    const hits = (await this.search(key, 'titleCreatorYear', 25)).filter((i) => (i?.data ?? i)?.citationKey === key);
    if (hits.length === 1) return { status: 'matched', matchedBy: 'citation_key', item: summarize(hits[0]) };
    if (hits.length > 1) return { status: 'ambiguous', candidates: hits.slice(0, 5).map(summarize), note: 'Several items carry this citation key.' };
    const viaBbt = await this.byBbt(key);
    if (viaBbt) return viaBbt;
    return {
      status: 'not_in_library',
      note: wasItemKey
        ? `No item has the key ${key}, and no item carries it as a citation key.`
        : `No item carries the citation key "${key}" in its Citation Key field${this.bbtNote()}.`,
    };
  }

  private bbtNote(): string {
    return this.bbt ? ' or in Better BibTeX' : '';
  }

  private async byBbt(key: string): Promise<Omit<WorkResult, 'cited'> | null> {
    if (this.bbt === undefined) {
      this.bbt =
        this.ctx.local && !this.ctx.remoteCaller && this.lib.type === 'user'
          ? new BbtClient({ port: this.ctx.config.localPort, fetchImpl: loopbackFetch })
          : null;
    }
    if (!this.bbt) return null;
    let keys: string[];
    try {
      keys = await this.bbt.itemKeysForCitationKey(key);
    } catch {
      this.bbt = null; // not installed, or Zotero not running: stop asking for this call
      return null;
    }
    this.bbtUsed = true;
    if (!keys.length) return null;
    const items: any[] = [];
    for (const k of keys.slice(0, 5)) {
      try {
        items.push(await this.ctx.router.getItem(k, { library: this.lib }));
      } catch (e) {
        if (!isNotFound(e)) throw e;
      }
    }
    if (items.length === 1) return { status: 'matched', matchedBy: 'better_bibtex', item: summarize(items[0]) };
    if (items.length > 1) return { status: 'ambiguous', candidates: items.map(summarize), note: 'Better BibTeX gives several items this key.' };
    return null;
  }

  private async byDoi(doi: string): Promise<Omit<WorkResult, 'cited'>> {
    const want = normalizeDoi(doi);
    const hits = (await this.search(doi, 'everything', 25)).filter((i) => itemDoi(i) === want);
    if (hits.length === 1) return { status: 'matched', matchedBy: 'doi', item: summarize(hits[0]) };
    if (hits.length > 1) return { status: 'ambiguous', candidates: hits.slice(0, 5).map(summarize), note: 'Several items carry this DOI (duplicates?).' };
    return { status: 'not_in_library', note: `No item carries the DOI ${doi}.` };
  }

  private async byAuthorYear(t: CiteTarget): Promise<Omit<WorkResult, 'cited'>> {
    const author = foldName(t.author!);
    const author2 = t.author2 ? foldName(t.author2) : undefined;
    const surname = t.author!.split(/\s+/).pop()!;
    let hits = (await this.search(`${surname} ${t.year}`, 'titleCreatorYear')).filter((i) => {
      const names = surnames(i);
      return itemYear(i) === t.year && names.includes(author) && (!author2 || names.includes(author2));
    });
    if (!hits.length) return { status: 'not_in_library', note: `No item by ${t.author}${t.author2 ? ` and ${t.author2}` : ''} dated ${t.year}.` };
    if (hits.length === 1) return { status: 'matched', matchedBy: 'author_year', item: summarize(hits[0]) };
    // Several: a title from the reference list decides, when it clearly does.
    if (t.titleWords?.length) {
      const want = new Set(t.titleWords);
      const scored = hits
        .map((i) => {
          const words = titleWords(String((i?.data ?? i)?.title ?? ''));
          const overlap = words.filter((w) => want.has(w)).length / Math.max(1, Math.min(want.size, words.length));
          return { i, overlap };
        })
        .sort((a, b) => b.overlap - a.overlap);
      if (scored[0]!.overlap >= 0.6 && (scored.length < 2 || scored[1]!.overlap < scored[0]!.overlap - 0.2)) {
        return { status: 'matched', matchedBy: 'author_year_title', item: summarize(scored[0]!.i) };
      }
      hits = scored.map((s) => s.i);
    }
    return {
      status: 'ambiguous',
      candidates: hits.slice(0, 5).map(summarize),
      note: `${hits.length} items by ${t.author} dated ${t.year}; cite one by its item key ([@ITEMKEY]) to make it unambiguous.`,
    };
  }
}

/** The text a quotation is checked against, and how to place an offset on a page. */
interface SourceText {
  attachmentKey: string;
  norm: NormalizedText;
  raw: string;
  pages?: string[];
  totalPages?: number;
}

async function readSource(ctx: ToolContext, itemKey: string, lib: LibraryRef): Promise<SourceText | { missing: string }> {
  try {
    const resolved = await resolveAttachment(ctx, itemKey, lib);
    if ('error' in resolved) return { missing: resolved.error };
    const ft = await ctx.router.getFullText(resolved.attachmentKey, { library: lib });
    if (ft && typeof ft.content === 'string' && ft.content.trim()) {
      return {
        attachmentKey: resolved.attachmentKey,
        raw: ft.content,
        norm: normalizeForMatch(ft.content),
        totalPages: typeof ft.totalPages === 'number' ? ft.totalPages : undefined,
      };
    }
    // Not indexed: read the file itself, as zotero_get_fulltext does.
    const file = await fetchAttachmentBytes(ctx, resolved, lib);
    if (file.tooLarge) return { missing: 'Zotero has not indexed it and the file is over the size limit for reading on the fly.' };
    if (!file.bytes) return { missing: `Zotero has not indexed it and the file could not be read (${file.reasons.join('; ') || 'no stored copy'}).` };
    const kind = detectKind(file.bytes, resolved.contentType, resolved.filename);
    if (kind !== 'epub') {
      const pages = await extractPdfPages(file.bytes);
      if (pages?.some((p) => p.trim())) {
        const raw = pdfPagesToText(pages);
        return { attachmentKey: resolved.attachmentKey, raw, norm: normalizeForMatch(raw), pages, totalPages: pages.length };
      }
      if (pages) return { missing: 'The PDF has no text layer (a scan); zotero_get_fulltext explains what would read it.' };
    }
    const epub = kind === 'pdf' ? null : extractEpubText(file.bytes, { maxBytes: DEFAULT_EPUB_MAX_BYTES });
    if (epub) return { attachmentKey: resolved.attachmentKey, raw: epub.text, norm: normalizeForMatch(epub.text) };
    return { missing: 'The attachment could not be parsed as a PDF or EPUB.' };
  } catch (e) {
    if (isNotFound(e)) return { missing: 'The item or its attachment was not found.' };
    return { missing: `Reading its full text failed: ${(e as Error).message}` };
  }
}

function checkQuote(text: string, src: SourceText, itemKey: string): QuoteResult {
  const m = matchQuote(text, src.norm);
  const place = (start: number) => {
    if (src.pages) {
      const page = pageAtOffset(src.pages, start);
      return page ? { page } : {};
    }
    const est = approxPage(start, src.raw.length, src.totalPages);
    return est ? { pageApprox: est } : {};
  };
  if (m.status === 'found') return { text, status: 'found', itemKey, ...place(m.start) };
  if (m.status === 'close_match') {
    return {
      text,
      status: 'close_match',
      itemKey,
      similarity: m.similarity,
      sourceText: src.raw.slice(m.start, m.end).replace(/\s+/g, ' ').trim(),
      ...place(m.start),
    };
  }
  return { text, status: 'not_found', itemKey, ...(m.bestSimilarity != null ? { bestSimilarity: m.bestSimilarity } : {}) };
}

/** Split off the reference list: the one passed in, or the draft's own trailing section. */
export function splitDraft(draft: string, references?: string): { body: string; refs: string; fromDraft: boolean } {
  if (references?.trim()) return { body: draft, refs: references, fromDraft: false };
  const at = referenceSectionStart(draft);
  if (at > 0) return { body: draft.slice(0, at), refs: draft.slice(at), fromDraft: true };
  return { body: draft, refs: '', fromDraft: false };
}

export async function checkCitations(ctx: ToolContext, lib: LibraryRef, opts: CheckOptions): Promise<CheckReport> {
  const { body, refs, fromDraft } = splitDraft(opts.draft, opts.references);
  const entries = refs ? parseReferences(refs) : [];
  const cites: FoundCitation[] = parseCitations(body, entries);
  const quotesByCite = attachQuotes(body, findQuotes(body), cites);
  const notices: string[] = [];
  if (fromDraft) notices.push(`Read ${entries.length} reference-list entr${entries.length === 1 ? 'y' : 'ies'} from the end of the draft.`);

  const resolver = new Resolver(ctx, lib);
  const sources = new Map<string, Promise<SourceText | { missing: string }>>();
  let fulltextsRead = 0;
  const out: CitationResult[] = [];
  let nextStart: number | undefined;
  const end = Math.min(cites.length, opts.start + opts.maxCitations);

  for (let i = opts.start; i < end; i++) {
    const cite = cites[i]!;
    const quotes = quotesByCite.get(i) ?? [];
    const works: WorkResult[] = [];
    for (const t of cite.targets) works.push({ cited: citedAs(t), ...(await resolver.resolve(t)) });

    const matchedKeys = [...new Set(works.filter((w) => w.status === 'matched').map((w) => w.item!.key))];
    // The full-text budget: a citation that needs texts not yet read, once it is spent,
    // is left for the next call rather than half-checked.
    const needed = opts.checkQuotes && quotes.length ? matchedKeys.filter((k) => !sources.has(k)) : [];
    if (needed.length && fulltextsRead + needed.length > opts.maxFulltexts && i > opts.start) {
      nextStart = i;
      break;
    }
    for (const k of needed) {
      sources.set(k, readSource(ctx, k, lib));
      fulltextsRead++;
    }

    const quoteResults: QuoteResult[] = [];
    for (const q of quotes) {
      if (!opts.checkQuotes) {
        quoteResults.push({ text: q.text, status: 'not_checked', note: 'check_quotes was false.' });
        continue;
      }
      if (!matchedKeys.length) {
        quoteResults.push({ text: q.text, status: 'not_checked', note: 'The citation did not resolve to a single library item.' });
        continue;
      }
      let best: QuoteResult | null = null;
      const rank = { found: 4, close_match: 3, not_found: 2, no_fulltext: 1, not_checked: 0 } as const;
      for (const k of matchedKeys) {
        const src = await sources.get(k)!;
        const r: QuoteResult = 'missing' in src ? { text: q.text, status: 'no_fulltext', itemKey: k, note: src.missing } : checkQuote(q.text, src, k);
        if (!best || rank[r.status] > rank[best.status]) best = r;
      }
      quoteResults.push(best!);
    }
    out.push({ index: i, kind: cite.kind, cite: cite.source, line: cite.line, works, quotes: quoteResults });
  }
  if (nextStart == null && end < cites.length) nextStart = end;
  if (resolver.bbtUsed) notices.push('Citation keys not found in the Citation Key field were also looked up in Better BibTeX.');
  return { citations: out, totalCitations: cites.length, start: opts.start, nextStart, fulltextsRead, referenceEntries: entries.length, notices };
}
