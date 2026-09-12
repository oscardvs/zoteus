import { attachmentIdentity, provenance } from './common-output.js';
import { z } from 'zod';
import type { ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { okLibraryContent, optionalLibrary } from '../registry/registry.js';
import type { LibraryRef } from '../api/web-client.js';
import { rankPassages, approxPage, type Passage } from '../features/fulltext/passages.js';
import {
  extractPdfOutline,
  extractPdfPages,
  locatePage,
  parsePageRange,
  pdfPagesToText,
  DEFAULT_PRECISE_MAX_BYTES,
  type OutlineEntry,
} from '../features/fulltext/pdf-pages.js';
import { extractEpubText, DEFAULT_EPUB_MAX_BYTES } from '../features/fulltext/epub.js';
import type { AttachmentByteSource } from '../features/attachments/bytes.js';
import {
  detectKind,
  fetchAttachmentBytes,
  resolveAttachment,
  SOURCE_LABEL,
} from '../features/attachments/resolve.js';
import { pdfjsUnavailableReason } from '../features/fulltext/pdfjs-loader.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Cap on outline headings returned, so a densely bookmarked book cannot flood a response. */
const MAX_OUTLINE_ENTRIES = 500;

const getFulltext: ToolDefinition = {
  name: 'zotero_get_fulltext',
  title: 'Get attachment full text / passages / outline (read-only)',
  description:
    "Retrieve an item's PDF or EPUB text for grounding. Pass a parent `item_key` (its best PDF/EPUB attachment is resolved automatically) or an attachment key. With `query`, returns the top relevant passages with locators (char offsets, nearest section, and a page); with `page_range` (e.g. \"3-7\"), returns just those pages, re-extracted from the PDF so the span is exact; with `outline:true`, returns the PDF's table of contents with page numbers (the cheapest way to decide which pages to read next); with none of them, returns a truncated head. Text comes from Zotero's full-text index when available; when the attachment is NOT indexed yet, the file itself is read and parsed on the fly (`fallback`, on by default; set `fallback:false` to disable), so a PDF added minutes ago still returns text (marked fulltextSource:\"pdf\" or \"epub\", with fileSource saying where the bytes came from). The file is read from the running Zotero desktop app, else straight out of the local Zotero storage folder, else downloaded from Zotero cloud storage. Page numbers are exact whenever the PDF was parsed, and otherwise an estimate (pageApprox) unless `precise_pages:true`. Read-only; the indexed text is served by the running Zotero desktop app when there is one, otherwise by the cloud Web API. Use this to cite a claim with a page after finding an item via zotero_search_items / zotero_semantic_search. Text is all this returns: for a figure, a table, an equation or a scanned page with no text layer, zotero_pdf_images renders the page (or extracts the embedded figures) as images you can look at.",
  inputSchema: {
    item_key: z.string().describe('Parent item key or attachment key.'),
    query: z.string().optional().describe('Return top passages relevant to this query.'),
    page_range: z.string().optional().describe('Page span like "3-7" (1-based, inclusive). PDFs only.'),
    outline: z
      .boolean()
      .optional()
      .describe("Return the PDF's table of contents (heading, page, nesting level) instead of text."),
    max_passages: z.number().int().min(1).max(20).optional().describe('Max passages (default 5).'),
    max_chars: z
      .number()
      .int()
      .min(500)
      .max(100000)
      .optional()
      .describe(
        'Best-effort cap on total returned text (default 12000); a single passage is never split, so one passage may slightly exceed it.',
      ),
    precise_pages: z
      .boolean()
      .optional()
      .describe('Re-extract the PDF for exact page numbers (already the default with `page_range`).'),
    fallback: z
      .boolean()
      .optional()
      .describe(
        'When Zotero has no indexed full text for the attachment, read the file itself and extract it directly (default true).',
      ),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      ...attachmentIdentity,
      mode: z.string().describe('Which reading this is: "passages", "page_range", "document" or "outline".'),
      fulltextSource: z.string().optional().describe('Where the text came from: Zotero\'s index, or the file itself.'),
      fileSource: z.string().optional().describe('Where the file was read from: the desktop app, local Zotero storage, or cloud storage.'),
      pageSource: z.string().optional().describe('How page numbers were arrived at: "exact" from re-extraction, or an estimate.'),
      totalChars: z.number().optional().describe('Characters the document holds.'),
      totalPages: z.number().optional().describe('Pages the document holds.'),
      indexedChars: z.number().optional().describe('Characters Zotero had indexed.'),
      indexedPages: z.number().optional().describe('Pages Zotero had indexed.'),
      passages: z
        .array(
          z
            .object({
              text: z.string().describe('The passage itself.'),
              charStart: z.number().describe('Character offset where it starts in the document text.'),
              charEnd: z.number().describe('Character offset where it ends.'),
              score: z.number().describe('Relevance to `query`; higher is better.'),
              page: z.number().optional().describe('Exact 1-based page, when the PDF was re-extracted.'),
              pageApprox: z.number().optional().describe('Proportional 1-based page estimate, when it was not.'),
              section: z.string().optional().describe('Nearest heading above the passage, when one was found.'),
            })
            .passthrough(),
        )
        .optional()
        .describe('mode "passages": the best-matching passages for `query`, in rank order.'),
      text: z.string().optional().describe('mode "page_range" or "document": the text itself.'),
      page_range: z.string().optional().describe('The span returned, echoed back.'),
      outline: z
        .array(
          z
            .object({
              title: z.string().describe('Heading text.'),
              page: z.number().optional().describe('1-based page it points at, when the destination resolved.'),
              level: z.number().describe('Nesting depth: 0 for a top-level heading.'),
            })
            .passthrough(),
        )
        .optional()
        .describe("mode \"outline\": the PDF's own table of contents."),
      entries: z.number().optional().describe('How many outline headings are listed.'),
      truncated: z.boolean().optional().describe('True when max_chars (or the outline cap) left something out.'),
      omittedChars: z.number().optional().describe('Characters left out by that cap.'),
      notice: z.string().optional().describe('What was degraded, estimated or left out, in one sentence.'),
      provenance,
    })
    .passthrough(),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const library: LibraryRef | undefined = optionalLibrary(args);
    const resolved = await resolveAttachment(ctx, args.item_key, library);
    if ('error' in resolved) return err(resolved.error);

    const maxMb = Math.round(DEFAULT_PRECISE_MAX_BYTES / (1024 * 1024));
    const identity = {
      item_key: args.item_key,
      attachmentKey: resolved.attachmentKey,
      parentKey: resolved.parentKey,
      filename: resolved.filename,
      title: resolved.title,
    };

    // --- outline mode: the document's own table of contents, read from the file ---
    if (args.outline) {
      const file = await fetchAttachmentBytes(ctx, resolved, library);
      if (file.tooLarge) {
        return err(
          `The outline of ${resolved.attachmentKey} was not read: the file is larger than the ${maxMb} MB limit for on-the-fly parsing.`,
        );
      }
      if (!file.bytes) {
        return err(
          `The PDF for attachment ${resolved.attachmentKey} could not be read, so it has no outline to report ` +
            `(${file.reasons.join('; ') || 'no source could produce the file'}). It may be a linked file with no stored copy.`,
        );
      }
      const kind = detectKind(file.bytes, resolved.contentType, resolved.filename);
      if (kind !== 'pdf') {
        return err(
          `Outlines are read from PDFs; attachment ${resolved.attachmentKey} is ${kind === 'epub' ? 'an EPUB' : 'not a PDF'}. ` +
            `Call zotero_get_fulltext without \`outline\` to read its text.`,
        );
      }
      const outline = await extractPdfOutline(file.bytes);
      if (!outline) {
        return err(
          `The outline of ${resolved.attachmentKey} could not be read (corrupt PDF, or ${pdfjsUnavailableReason()}).`,
        );
      }
      const truncated = outline.length > MAX_OUTLINE_ENTRIES;
      const entries: OutlineEntry[] = truncated ? outline.slice(0, MAX_OUTLINE_ENTRIES) : outline;
      const notice = !entries.length
        ? 'This PDF carries no embedded table of contents. Use `query` to find passages, or `page_range` to read pages.'
        : truncated
          ? `Only the first ${MAX_OUTLINE_ENTRIES} of ${outline.length} headings are listed.`
          : undefined;
      return okLibraryContent(
        {
          ...identity,
          mode: 'outline',
          fileSource: file.source,
          outline: entries,
          entries: entries.length,
          truncated,
          notice,
        },
        `${entries.length} outline heading(s) in ${args.item_key}` +
          (file.source ? ` (read from ${SOURCE_LABEL[file.source]}).` : '.') +
          (notice ? ` ${notice}` : ''),
      );
    }

    // Routed, not cloud-only: Zotero 7+ serves /fulltext locally, so a running desktop app
    // answers this without a cloud key (and for items that never synced).
    const ft = await ctx.router.getFullText(resolved.attachmentKey, { library });
    const indexed = Boolean(ft && typeof ft.content === 'string' && ft.content.length);

    // Where the text comes from: Zotero's index when available, otherwise (fallback, on by
    // default) the attachment file itself, read locally and parsed on the fly.
    let content: string;
    let totalChars: number;
    let totalPages: number | undefined;
    let pages: string[] | null = null;
    let fulltextSource: 'zotero' | 'pdf' | 'epub' = 'zotero';
    let fileSource: AttachmentByteSource | undefined;
    let sourceNotice = '';

    if (indexed) {
      content = ft.content;
      totalChars = typeof ft.totalChars === 'number' && ft.totalChars > 0 ? ft.totalChars : content.length;
      totalPages = typeof ft.totalPages === 'number' ? ft.totalPages : undefined;
    } else if (args.fallback === false) {
      return err(
        `No extracted full text for attachment ${resolved.attachmentKey}. Zotero has not indexed it yet ` +
          `(open it once in Zotero to index it, or retry with fallback enabled to parse the file directly).`,
      );
    } else {
      // --- local extraction fallback: read the attachment file and extract text from it ---
      const noText = `No extracted full text for attachment ${resolved.attachmentKey} (Zotero has not indexed it)`;
      const file = await fetchAttachmentBytes(ctx, resolved, library);
      if (file.tooLarge) {
        return err(
          `${noText}, and direct extraction is skipped: the file is larger than the ${maxMb} MB limit for on-the-fly parsing. ` +
            `Open the file once in Zotero to have it indexed, then retry.`,
        );
      }
      if (!file.bytes) {
        return err(
          `${noText}, and the attachment file could not be read or downloaded either ` +
            `(${file.reasons.join('; ') || 'no source could produce the file'}). ` +
            `It may be a linked file with no stored copy.`,
        );
      }
      const kind = detectKind(file.bytes, resolved.contentType, resolved.filename);
      const extracted = kind === 'epub' ? null : await extractPdfPages(file.bytes);
      if (extracted && extracted.some((p) => p.trim())) {
        pages = extracted;
        content = pdfPagesToText(extracted);
        totalPages = extracted.length;
        fulltextSource = 'pdf';
      } else {
        // Not a readable PDF: an EPUB is a zip of XHTML, which Zoteus unpacks itself.
        const epub = kind === 'pdf' ? null : extractEpubText(file.bytes, { maxBytes: DEFAULT_EPUB_MAX_BYTES });
        if (!epub) {
          return err(
            `${noText}, and direct extraction yielded nothing (a scanned or corrupt file, an unsupported format, ` +
              `or ${pdfjsUnavailableReason()}). Open the file once in Zotero to have it indexed, then retry.`,
          );
        }
        content = epub.text;
        fulltextSource = 'epub';
      }
      totalChars = content.length;
      fileSource = file.source;
      sourceNotice =
        ` Zotero had no indexed full text for this attachment; the text was extracted directly from the ` +
        `${fulltextSource === 'epub' ? 'EPUB' : 'PDF'}` +
        (file.source ? ` (read from ${SOURCE_LABEL[file.source]})` : '') +
        `.`;
    }
    const maxChars = args.max_chars ?? 12000;

    const base = {
      ...identity,
      fulltextSource,
      fileSource,
      totalChars,
      totalPages,
      indexedChars: indexed ? ft.indexedChars : undefined,
      indexedPages: indexed ? ft.indexedPages : undefined,
    };

    // Optionally pull exact pages once (shared by passages / page_range). When the text
    // came from the local fallback we already hold the exact pages.
    //
    // `page_range` asks for specific pages, and slicing indexed text proportionally answers
    // a different question ("roughly this share of the characters"), so a page range
    // re-extracts by default. `precise_pages:false` opts back out.
    const wantsExact = args.precise_pages ?? Boolean(args.page_range);
    let tooLarge = false;
    // Which half failed is known right here, so the notice below names it instead of
    // offering the reader both and letting them guess.
    let hadBytes = false;
    let byteReasons: string[] = [];
    // An EPUB has already been read whole; there are no PDF pages to go back for.
    if (!pages && wantsExact && fulltextSource !== 'epub') {
      const file = await fetchAttachmentBytes(ctx, resolved, library);
      if (file.tooLarge) tooLarge = true;
      else if (file.bytes) {
        hadBytes = true;
        // extractPdfPages self-guards on byte size too (catches unknown-size attachments).
        pages = await extractPdfPages(file.bytes);
        if (!pages && file.bytes.byteLength > DEFAULT_PRECISE_MAX_BYTES) tooLarge = true;
        if (pages) fileSource = file.source;
      } else byteReasons = file.reasons;
    }
    const exact = Boolean(pages && pages.length);
    const pageSource = exact ? 'exact' : 'approximate';
    const degradeNotice =
      indexed && wantsExact && !exact
        ? tooLarge
          ? ` Exact pages skipped: this PDF exceeds the ${maxMb} MB re-extraction limit on this instance; pageApprox is an estimate.`
          : hadBytes
            ? ` Exact pages unavailable: the PDF was read but not parsed (${pdfjsUnavailableReason()}); pageApprox is an estimate.`
            : ` Exact pages unavailable: the PDF bytes could not be read (${byteReasons.join('; ') || 'no source could produce the file'}); pageApprox is an estimate.`
        : '';
    if (exact && fileSource) base.fileSource = fileSource;

    // --- passages mode ---
    if (args.query) {
      const maxPassages = args.max_passages ?? 5;
      const ranked: Passage[] = await rankPassages({
        content,
        query: args.query,
        maxPassages,
        totalChars,
        totalPages,
        embed: ctx.search.hasEmbedder ? (texts, kind) => ctx.search.embed(texts, kind) : undefined,
      });
      let used = 0;
      let truncated = false;
      const passages: Passage[] = [];
      for (const p of ranked) {
        if (used + p.text.length > maxChars && passages.length) {
          truncated = true;
          break;
        }
        if (exact) {
          const pg = locatePage(pages!, p.text);
          if (pg) p.page = pg;
          else p.pageApprox = approxPage(p.charStart, totalChars, totalPages);
        }
        passages.push(p);
        used += p.text.length;
      }
      const summary =
        `${passages.length} passage(s) for "${args.query}" in ${args.item_key}` +
        (totalPages ? ` (${pageSource} pages).` : '.') +
        (truncated ? ' Some lower-ranked passages omitted (max_chars).' : '') +
        sourceNotice +
        degradeNotice;
      return okLibraryContent(
        { ...base, mode: 'passages', pageSource, passages, truncated, notice: (sourceNotice + degradeNotice).trim() || undefined },
        summary,
      );
    }

    // --- page_range mode ---
    if (args.page_range) {
      const r = parsePageRange(args.page_range);
      if (!r) return err('`page_range` must look like "3" or "3-7".');
      let slice: string;
      let pagelessNotice = '';
      if (exact && pages) {
        slice = pages.slice(r.from - 1, r.to).join('\n\n');
      } else if (fulltextSource === 'epub') {
        // An EPUB has no pages at all: it reflows, which is why Zotero cites it by
        // location rather than page. Saying so beats returning a made-up span.
        slice = content;
        pagelessNotice = ' An EPUB has no fixed pages, so `page_range` does not apply; the document head is returned instead.';
      } else if (totalPages) {
        const s = Math.floor(((r.from - 1) / totalPages) * totalChars);
        const e = Math.ceil((r.to / totalPages) * totalChars);
        slice = content.slice(Math.max(0, s), Math.min(content.length, e));
      } else {
        slice = content;
      }
      const truncated = slice.length > maxChars;
      const text = truncated ? slice.slice(0, maxChars) : slice;
      const emptyNotice =
        !text && totalPages ? ` Pages ${args.page_range} appear to be beyond the document (~${totalPages} pages).` : '';
      return okLibraryContent(
        {
          ...base,
          mode: 'page_range',
          pageSource,
          page_range: args.page_range,
          text,
          truncated,
          omittedChars: truncated ? slice.length - maxChars : 0,
          notice: (sourceNotice + degradeNotice + pagelessNotice + emptyNotice).trim() || undefined,
        },
        `Text for pages ${args.page_range} of ${args.item_key} (${pageSource}).` +
          (truncated ? ' Truncated (max_chars).' : '') +
          sourceNotice +
          degradeNotice +
          pagelessNotice +
          emptyNotice,
      );
    }

    // --- document mode ---
    const truncated = content.length > maxChars;
    const text = truncated ? content.slice(0, maxChars) : content;
    const truncNotice = truncated
      ? ` Truncated to ${maxChars} of ${content.length} chars — pass query (for relevant passages), page_range, or a larger max_chars.`
      : '';
    const notice = (sourceNotice + truncNotice).trim() || undefined;
    const textOrigin =
      fulltextSource === 'zotero'
        ? 'from the Zotero full-text index'
        : `extracted from the ${fulltextSource === 'epub' ? 'EPUB' : 'PDF'} directly`;
    return okLibraryContent(
      { ...base, mode: 'document', pageSource, text, truncated, omittedChars: truncated ? content.length - maxChars : 0, notice },
      `Full text of ${args.item_key}: ${content.length} chars${truncated ? `, returned first ${maxChars}` : ''} ` +
        `(${textOrigin}).`,
    );
  },
};

export default getFulltext;
