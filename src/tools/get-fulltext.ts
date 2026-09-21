import { z } from 'zod';
import { join } from 'node:path';
import { attachmentIdentity, provenance } from './common-output.js';
import type { ToolContext, ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { okLibraryContent, optionalLibrary } from '../registry/registry.js';
import type { LibraryRef } from '../api/web-client.js';
import { rankPassages, approxPage, type Passage } from '../features/fulltext/passages.js';
import {
  extractPdfOutline,
  extractPdfPages,
  locatePage,
  pageAtOffset,
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
import {
  describePages,
  LOCAL_IMAGE_PIXEL_LIMIT,
  SHARED_IMAGE_PIXEL_LIMIT,
} from '../features/fulltext/pdf-images.js';
import { describeScan, inspectScan, type ScanReport } from '../features/ocr/scan.js';
import { missingOcrHint, OCR_MODULE, resolveOcrModule } from '../features/ocr/engine.js';
import { ocrPageCap, ocrPdfPages, type OcrPagesResult } from '../features/ocr/ocr-pages.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** Cap on outline headings returned, so a densely bookmarked book cannot flood a response. */
const MAX_OUTLINE_ENTRIES = 500;

/** Where OCR language data is cached: `<data dir>/ocr`, beside the embedder's models. */
const OCR_CACHE_SUBDIR = 'ocr';

/**
 * The OCR knobs, read defensively. Every one has a default in src/config.ts, but a handler
 * is also called with contexts assembled by hand, and a missing knob must mean "off"
 * rather than a thrown TypeError halfway through reading somebody's PDF.
 */
function ocrConfig(ctx: ToolContext): {
  on: boolean;
  maxPages: number;
  langs: string;
  ocrPath?: string;
  cacheDir?: string;
} {
  const c = ctx.config as Partial<ToolContext['config']>;
  return {
    on: c.ocr === 'auto',
    maxPages: typeof c.ocrMaxPages === 'number' && c.ocrMaxPages > 0 ? c.ocrMaxPages : 8,
    langs: c.ocrLangs || 'eng',
    ocrPath: c.ocrPath,
    cacheDir: c.dataDir ? join(c.dataDir, OCR_CACHE_SUBDIR) : undefined,
  };
}

/** The two remedies that need no engine, offered in every no-text-layer answer. */
const ENGINE_FREE_REMEDIES =
  'zotero_pdf_images mode:"pages" renders the pages as pictures you can read right now, and running the file ' +
  'through an OCR tool outside Zotero (OCRmyPDF, Acrobat, ABBYY, or the Zotero OCR plugin) writes a real text ' +
  'layer into it, which Zotero then indexes and this tool returns like any other PDF.';

/**
 * What to say about OCR when the caller did not ask for it and the PDF turns out to have
 * no text layer. Four different states, four different remedies: the engine is ready, the
 * engine is switched on but not installed, it is switched off on a machine the caller owns,
 * or it is switched off on somebody else's server.
 */
function ocrOffer(ctx: ToolContext, report: ScanReport): string {
  const cfg = ocrConfig(ctx);
  const cap = ocrPageCap(cfg.maxPages);
  const pages = `${cap} page${cap === 1 ? '' : 's'} a call`;
  if (cfg.on && resolveOcrModule(cfg.ocrPath)) {
    return (
      `Zoteus can read it: call again with ocr:true and it renders each page and recognises the text with ` +
      `${OCR_MODULE} (${pages}; \`page_range\` chooses which, and the result says which pages were read). ` +
      `OCR text is a machine reading of a picture and carries mistakes real text does not. Otherwise, ` +
      `${ENGINE_FREE_REMEDIES}`
    );
  }
  if (cfg.on) {
    return `OCR is switched on here but cannot run: ${missingOcrHint({ dist: ctx.config.dist, ocrPath: cfg.ocrPath })}`;
  }
  if (ctx.remoteCaller) {
    return (
      `OCR is switched off on this shared Zoteus and only its operator can turn it on (ZOTEUS_OCR=auto, with ` +
      `the engine installed on the server): recognising a page costs seconds of CPU on a machine every user ` +
      `shares. In the meantime, ${ENGINE_FREE_REMEDIES}`
    );
  }
  const scanNote =
    report.verdict === 'empty'
      ? ` This file holds no images at all, so OCR will only find something if its text was drawn as vector outlines rather than left blank.`
      : '';
  return (
    `Zoteus can read a scan with OCR, which is off until you switch it on, because the engine is a separate ` +
    `install: \`npm i ${OCR_MODULE}\`, then start Zoteus with ZOTEUS_OCR=auto and call again with ocr:true ` +
    `(${pages}).${scanNote} Otherwise, ${ENGINE_FREE_REMEDIES}`
  );
}

/** Why an `ocr:true` call could not even start. Distinct from a run that started and failed. */
function ocrRefusal(ctx: ToolContext): string {
  if (ctx.remoteCaller) {
    return (
      `OCR is switched off on this shared Zoteus and only its operator can turn it on (ZOTEUS_OCR=auto, with ` +
      `the engine installed on the server): recognising a page costs seconds of CPU on a machine every user ` +
      `shares. In the meantime, ${ENGINE_FREE_REMEDIES}`
    );
  }
  return (
    `\`ocr:true\` was asked for, and OCR is off on this Zoteus. Install the engine (\`npm i ${OCR_MODULE}\`, or ` +
    `point ZOTEUS_OCR_PATH at a directory that has it) and start Zoteus with ZOTEUS_OCR=auto, then call again. ` +
    `Nothing is installed or downloaded for you. In the meantime, ${ENGINE_FREE_REMEDIES}`
  );
}

/** Pixels as megapixels, for a sentence: 16777216 reads as 16.8. */
function megapixels(pixels: number): string {
  return (Math.round(pixels / 100_000) / 10).toFixed(1);
}

/**
 * Why pages that were rendered came back with no text at all.
 *
 * pdfjs REMOVES an image with more pixels than its decode ceiling and paints the page
 * white anyway (it says so on stderr and nowhere else), so a 600 dpi scan above the
 * ceiling OCRs to nothing at all. That is neither of the two causes this sentence used to
 * offer, and it is the one the reader can act on, so it is named whenever the file holds an
 * image big enough for it to be the explanation. `zotero_pdf_images` already says this for
 * the same condition; the OCR path was the one that did not.
 */
function unreadableCause(report: ScanReport | undefined, pixelLimit: number): string {
  const largest = report?.largestImagePixels ?? 0;
  if (largest > pixelLimit) {
    return (
      `this file holds a ${megapixels(largest)} megapixel image and this server decodes at most` +
      ` ${megapixels(pixelLimit)}, so the image was dropped and the page rendered as blank white paper.` +
      ` Only the operator can raise that ceiling; a lower-resolution copy of the file reads here as it is.`
    );
  }
  const maybeLimit =
    !largest && report && report.imageObjects > 0
      ? `, or an image above this server's ${megapixels(pixelLimit)} megapixel decode limit, which pdfjs` +
        ` removes and renders as a blank page`
      : '';
  return `blank pages, or a language ZOTEUS_OCR_LANGS does not name${maybeLimit}.`;
}

/**
 * What an OCR pass did, said plainly enough that nobody mistakes it for publisher text or
 * for something that got indexed.
 */
function ocrNotice(
  run: OcrPagesResult,
  maxPages: number,
  canWriteBack: boolean,
  scan: { report?: ScanReport; pixelLimit: number },
): string {
  const parts = [
    ` Pages ${describePages(run.read)} were read by OCR with ${run.engine} in ${(run.ms / 1000).toFixed(1)} s.` +
      ` OCR text is a machine reading of a picture of the page, not the publisher's text: it carries` +
      ` recognition mistakes, and only the pages listed have any text at all here.`,
  ];
  if (run.deferred.length) {
    const next = run.deferred[0]!;
    const last = Math.min(run.deferred[run.deferred.length - 1]!, next + run.cap - 1);
    parts.push(
      ` Pages ${describePages(run.deferred)} were not read: OCR reads ${run.cap} page(s) a call` +
        `${run.cap === maxPages ? ' (ZOTEUS_OCR_MAX_PAGES)' : ''}; call again with page_range:"${next}-${last}".`,
    );
  }
  if (run.unreadable.length) {
    parts.push(
      ` Pages ${describePages(run.unreadable)} were rendered and recognised as no text at all: ` +
        unreadableCause(scan.report, scan.pixelLimit),
    );
  }
  if (run.capNotice) parts.push(` ${run.capNotice}`);
  // The one thing a reader will assume and that is not true: this did not make the scan
  // searchable. Nothing OCRed is stored, here or in the index.
  parts.push(
    ' This text is returned here and stored nowhere: it does not reach Zotero, and zotero_semantic_search' +
      ' cannot find it.',
  );
  if (canWriteBack) {
    parts.push(
      ' To keep it, hand it to zotero_fulltext action:"set", which writes it into the attachment\'s full' +
        ' text in your Zotero account (a real change to your library, and it needs a Zotero cloud key), then' +
        ' run zotero_index action:"update" so semantic search picks it up.',
    );
  }
  return parts.join('');
}

/**
 * The pages an OCR call should attempt: the asked-for span, else the front of the document.
 *
 * A span that lies wholly past the last page selects nothing, and "no page was asked for"
 * (which is what an empty selection means further down) would be a false answer to a caller
 * who asked for pages 50 to 60 of a 3-page file. The one fact that helps them is the page
 * count, so this says that instead. Clamping `from` would be worse still: it would silently
 * OCR page 3 for a caller who asked for neither.
 */
function ocrPageSelection(
  range: { from: number; to: number } | undefined,
  numPages: number,
): { pages: number[] } | { error: string } {
  const from = Math.max(1, range?.from ?? 1);
  if (from > numPages) {
    const span = range && range.from !== range.to ? `pages ${range.from}-${range.to} are` : `page ${from} is`;
    return {
      error:
        `OCR could not run: ${span} beyond the document, which has ${numPages} page${numPages === 1 ? '' : 's'}. ` +
        `Ask for a page_range inside it, or leave page_range out to read from page 1.`,
    };
  }
  const to = Math.min(range?.to ?? numPages, numPages);
  const pages: number[] = [];
  for (let p = from; p <= to; p++) pages.push(p);
  return { pages };
}

/**
 * Run OCR over a PDF's pages, or explain why it did not run. Returns one string per page of
 * the document, in page order, which is the same shape `extractPdfPages` returns: that is
 * what lets the chunker, `locatePage` and `page_range` treat OCR text like any other.
 */
async function readByOcr(
  ctx: ToolContext,
  bytes: Uint8Array,
  selection: { pages: number[] } | { error: string },
  report: ScanReport,
): Promise<{ pages: string[]; notice: string } | { error: string }> {
  if ('error' in selection) return selection;
  const cfg = ocrConfig(ctx);
  if (!cfg.on) return { error: ocrRefusal(ctx) };
  // The same decode ceiling the image tool applies, for the same reason: a 600 dpi scan
  // is exactly the file an OCR user brings, and it does not decode on a shared server.
  const pixelLimit = ctx.remoteCaller ? SHARED_IMAGE_PIXEL_LIMIT : LOCAL_IMAGE_PIXEL_LIMIT;
  const run = await ocrPdfPages(bytes, {
    pages: selection.pages,
    langs: cfg.langs,
    maxPages: cfg.maxPages,
    ocrPath: cfg.ocrPath,
    cacheDir: cfg.cacheDir,
    maxImagePixels: pixelLimit,
  });
  if (!run.ok) {
    if (run.reason === 'unavailable') return { error: `OCR could not run: ${run.message}` };
    return { error: `OCR could not run: ${run.message}.` };
  }
  return {
    pages: run.pages,
    notice: ocrNotice(run, cfg.maxPages, !ctx.config.readOnly, { report, pixelLimit }),
  };
}

const getFulltext: ToolDefinition = {
  name: 'zotero_get_fulltext',
  title: 'Get attachment full text / passages / outline (read-only)',
  description:
    "Retrieve an item's PDF or EPUB text for grounding. Pass a parent `item_key` (its best PDF/EPUB attachment is resolved automatically) or an attachment key. With `query`, returns the top relevant passages with locators (char offsets, nearest section, and a page); with `page_range` (e.g. \"3-7\"), returns just those pages, re-extracted from the PDF so the span is exact; with `outline:true`, returns the PDF's table of contents with page numbers (the cheapest way to decide which pages to read next); with none of them, returns a truncated head. Text comes from Zotero's full-text index when available; when the attachment is NOT indexed yet, the file itself is read and parsed on the fly (`fallback`, on by default; set `fallback:false` to disable), so a PDF added minutes ago still returns text (marked fulltextSource:\"pdf\" or \"epub\", with fileSource saying where the bytes came from). The file is read from the running Zotero desktop app, else straight out of the local Zotero storage folder, else downloaded from Zotero cloud storage. Page numbers are exact whenever the PDF was parsed, and otherwise an estimate (pageApprox) unless `precise_pages:true`. Read-only; the indexed text is served by the running Zotero desktop app when there is one, otherwise by the cloud Web API. Use this to cite a claim with a page after finding an item via zotero_search_items / zotero_semantic_search. A PDF with no text layer is reported as what it is, with its page count and what would read it, instead of failing vaguely; `ocr:true` reads a few of its pages by rendering them and recognising the text, but only where the operator enabled OCR and installed the engine, and that text is a machine reading of a picture, never saved and never indexed. Text is all this returns: for a figure, a table, an equation or a scanned page with no text layer, zotero_pdf_images renders the page (or extracts the embedded figures) as images you can look at.",
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
    ocr: z
      .boolean()
      .optional()
      .describe(
        'For a scanned PDF with no text layer: render its pages and read them by OCR (default false). Only works when this Zoteus was started with OCR enabled and the engine installed; the answer says exactly what to do when it was not. Reads a few pages a call (`page_range` chooses which), and the text it returns is a machine reading of a picture, so it carries mistakes and is not saved or indexed anywhere.',
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
              page: z
                .number()
                .optional()
                .describe('Exact 1-based page: the page this passage was cut from, or the one whose text carries it.'),
              pageApprox: z
                .number()
                .optional()
                .describe(
                  'Proportional 1-based page estimate, present only when the exact page could not be established. Never returned beside `page`.',
                ),
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
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    const library: LibraryRef | undefined = optionalLibrary(args, ctx);
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
    /**
     * True when `content` is literally `pdfPagesToText(pages)`, which makes a passage's
     * page a pure function of its character offset. False when the text came from Zotero's
     * index and the pages from a separate re-extraction: those offsets do not line up, so
     * the page has to be searched for instead.
     */
    let pagesAreContent = false;
    let fulltextSource: 'zotero' | 'pdf' | 'epub' | 'ocr' = 'zotero';
    let fileSource: AttachmentByteSource | undefined;
    let sourceNotice = '';
    /** What an OCR pass read, and what it did not; empty when none ran. */
    let ocrRunNotice = '';
    const askedRange = args.page_range ? parsePageRange(args.page_range) : undefined;

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
        pagesAreContent = true;
        fulltextSource = 'pdf';
      } else if (extracted) {
        // The PDF opened and holds no text. That is a scan, a file whose text was drawn as
        // outlines, or an empty one, and those have different remedies; saying "scanned or
        // corrupt" and stopping was the old answer to all three at once.
        const report = inspectScan(file.bytes, extracted);
        if (!args.ocr) return err(`${noText}. ${describeScan(report)} ${ocrOffer(ctx, report)}`);
        const run = await readByOcr(ctx, file.bytes, ocrPageSelection(askedRange, extracted.length), report);
        if ('error' in run) return err(`${noText}. ${describeScan(report)} ${run.error}`);
        pages = run.pages;
        content = pdfPagesToText(run.pages);
        totalPages = run.pages.length;
        pagesAreContent = true;
        fulltextSource = 'ocr';
        ocrRunNotice = run.notice;
      } else {
        // Not a readable PDF: an EPUB is a zip of XHTML, which Zoteus unpacks itself.
        const epub = kind === 'pdf' ? null : extractEpubText(file.bytes, { maxBytes: DEFAULT_EPUB_MAX_BYTES });
        if (!epub) {
          return err(
            `${noText}, and the file could not be parsed at all (not a readable PDF or EPUB, ` +
              `or ${pdfjsUnavailableReason()}). Open the file once in Zotero to have it indexed, then retry.`,
          );
        }
        content = epub.text;
        fulltextSource = 'epub';
      }
      totalChars = content.length;
      fileSource = file.source;
      const how =
        fulltextSource === 'ocr'
          ? 'read off the PDF by OCR'
          : `extracted directly from the ${fulltextSource === 'epub' ? 'EPUB' : 'PDF'}`;
      sourceNotice =
        ` Zotero had no indexed full text for this attachment; the text was ${how}` +
        (file.source ? ` (read from ${SOURCE_LABEL[file.source]})` : '') +
        `.` +
        ocrRunNotice;
    }
    const maxChars = args.max_chars ?? 12000;

    // Optionally pull exact pages once (shared by passages / page_range). When the text
    // came from the local fallback we already hold the exact pages.
    //
    // `page_range` asks for specific pages, and slicing indexed text proportionally answers
    // a different question ("roughly this share of the characters"), so a page range
    // re-extracts by default. `precise_pages:false` opts back out. `ocr:true` implies it
    // too: asking for OCR is asking for the file itself to be read.
    const wantsExact = args.precise_pages ?? Boolean(args.page_range || args.ocr);
    let tooLarge = false;
    // Which half failed is known right here, so the notice below names it instead of
    // offering the reader both and letting them guess.
    let hadBytes = false;
    let byteReasons: string[] = [];
    /** Replaces the degrade notice when the PDF parsed and simply holds no text. */
    let blankNotice = '';
    // An EPUB has already been read whole; there are no PDF pages to go back for.
    if (!pages && wantsExact && fulltextSource !== 'epub') {
      const file = await fetchAttachmentBytes(ctx, resolved, library);
      if (file.tooLarge) tooLarge = true;
      else if (file.bytes) {
        hadBytes = true;
        // extractPdfPages self-guards on byte size too (catches unknown-size attachments).
        pages = await extractPdfPages(file.bytes);
        if (!pages && file.bytes.byteLength > DEFAULT_PRECISE_MAX_BYTES) tooLarge = true;
        // Zotero's index can hold a handful of junk characters for a scan, which is enough
        // to keep the fallback above from ever running: the item counts as indexed. So the
        // no-text-layer answer, and OCR, have to be available here as well.
        if (pages && !pages.some((p) => p.trim())) {
          const report = inspectScan(file.bytes, pages);
          const run = args.ocr
            ? await readByOcr(ctx, file.bytes, ocrPageSelection(askedRange, pages.length), report)
            : { error: ocrOffer(ctx, report) };
          if ('error' in run) {
            // Pages that are all empty are not exact pages: every locate would miss and
            // every passage would silently fall back to an estimate under a label saying
            // "exact". Drop them and say what the file is instead.
            pages = null;
            blankNotice = ` Exact pages unavailable. ${describeScan(report)} ${run.error}`;
          } else {
            // The text comes with the pages, deliberately. Matching passages chunked from
            // Zotero's text against OCR'd pages would report a wrong page as an exact one.
            pages = run.pages;
            content = pdfPagesToText(run.pages);
            totalChars = content.length;
            totalPages = run.pages.length;
            pagesAreContent = true;
            fulltextSource = 'ocr';
            ocrRunNotice = run.notice;
            sourceNotice =
              ` Zotero's indexed text for this attachment held no readable text, so the PDF was read off the ` +
              `page by OCR instead` +
              (file.source ? ` (read from ${SOURCE_LABEL[file.source]})` : '') +
              `.` +
              run.notice;
          }
        }
        if (pages) fileSource = file.source;
      } else byteReasons = file.reasons;
    }
    const exact = Boolean(pages && pages.length);
    const pageSource = exact ? 'exact' : 'approximate';
    const degradeNotice = blankNotice
      ? blankNotice
      : indexed && wantsExact && !exact
        ? tooLarge
          ? ` Exact pages skipped: this PDF exceeds the ${maxMb} MB re-extraction limit on this instance; pageApprox is an estimate.`
          : hadBytes
            ? ` Exact pages unavailable: the PDF was read but not parsed (${pdfjsUnavailableReason()}); pageApprox is an estimate.`
            : ` Exact pages unavailable: the PDF bytes could not be read (${byteReasons.join('; ') || 'no source could produce the file'}); pageApprox is an estimate.`
        : '';

    const base = {
      ...identity,
      fulltextSource,
      fileSource,
      totalChars,
      totalPages,
      indexedChars: indexed ? ft.indexedChars : undefined,
      indexedPages: indexed ? ft.indexedPages : undefined,
    };
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
          // Two different questions, and the cheap one is also the exact one. When the text
          // IS these pages joined, the offset says the page outright. When it came from
          // Zotero's index instead, the offsets belong to a different string and the page
          // has to be searched for, with the proportional estimate breaking a tie.
          const estimate = approxPage(p.charStart, totalChars, totalPages);
          const pg = pagesAreContent
            ? pageAtOffset(pages!, p.charStart)
            : locatePage(pages!, p.text, { near: estimate });
          if (pg) {
            p.page = pg;
            // One passage, one page number: a proportional estimate beside an exact page is
            // at best redundant and, over OCR text that covers only the pages the cap read,
            // hundreds of pages wrong.
            delete p.pageApprox;
          } else if (pagesAreContent) {
            // The offset is outside the joined text, which should not happen. An estimate
            // over pages that may hold no characters at all would be fiction, so say nothing.
            delete p.pageApprox;
          } else {
            p.pageApprox = estimate;
          }
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
      ? ` Truncated to ${maxChars} of ${content.length} chars: pass query (for relevant passages), page_range, or a larger max_chars.`
      : '';
    const notice = (sourceNotice + truncNotice).trim() || undefined;
    // OCR text is not "extracted from the PDF directly": that is what this tool says for a
    // real text layer, and a reader who is told it about a machine reading of a picture has
    // been told the one thing this feature exists to prevent. The other two modes append
    // the source notice to their summary as well, so this one does too: the caveat belongs
    // in the sentence a reader sees first, not only in the JSON beneath it.
    const textOrigin =
      fulltextSource === 'zotero'
        ? 'from the Zotero full-text index'
        : fulltextSource === 'ocr'
          ? "read off the page by OCR, not the publisher's text"
          : `extracted from the ${fulltextSource === 'epub' ? 'EPUB' : 'PDF'} directly`;
    return okLibraryContent(
      { ...base, mode: 'document', pageSource, text, truncated, omittedChars: truncated ? content.length - maxChars : 0, notice },
      `Full text of ${args.item_key}: ${content.length} chars${truncated ? `, returned first ${maxChars}` : ''} ` +
        `(${textOrigin}).` +
        sourceNotice,
    );
  },
};

export default getFulltext;
