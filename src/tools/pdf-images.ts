import { attachmentIdentity, provenance } from './common-output.js';
import { z } from 'zod';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  ImageToolHandlerResult,
  ToolContent,
  ToolDefinition,
  ToolHandlerResult,
} from '../registry/registry.js';
import { okLibraryContent, optionalLibrary } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import type { LibraryRef } from '../api/web-client.js';
import {
  detectKind,
  fetchAttachmentBytes,
  resolveAttachment,
  SOURCE_LABEL,
} from '../features/attachments/resolve.js';
import { DEFAULT_PRECISE_MAX_BYTES, parsePageRange } from '../features/fulltext/pdf-pages.js';
import {
  base64Length,
  describePages,
  extractPdfImages,
  planInline,
  renderPdfPages,
  DEFAULT_MIN_SIDE_PX,
  LOCAL_IMAGE_PIXEL_LIMIT,
  MAX_DPI,
  MIN_DPI,
  SHARED_IMAGE_PIXEL_LIMIT,
  type ExtractedImage,
  type ImageFormat,
  type PdfImageError,
  type RenderedPage,
} from '../features/fulltext/pdf-images.js';

/**
 * Caps that are part of the feature, not an afterthought.
 *
 * Rendering is the most expensive thing this server does per call, and its output travels
 * as base64 inside JSON to claude.ai and ChatGPT. So: a handful of pages per call (four by
 * default, eight at most, which is a section of a paper, not a book), a few dozen figures,
 * and about 5 MB of inline image data per response (four default-resolution JPEG pages are
 * about 1 MB; a client-side limit of 5 MB per image exists on the Claude side and the total
 * keeps a response well inside what the connectors relay). Files above 20 MB are not parsed
 * at all, for the same reason zotero_get_fulltext does not parse them.
 */
export const DEFAULT_MAX_PAGES = 4;
export const HARD_MAX_PAGES = 8;
export const DEFAULT_MAX_IMAGES = 16;
export const HARD_MAX_IMAGES = 40;
export const INLINE_BUDGET_BASE64 = 5 * 1024 * 1024;

/** Where saved images go: `<data dir>/pdf-images/<attachment key>/<file>`. */
export const SAVE_SUBDIR = 'pdf-images';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const toBase64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
const ext = (mimeType: string): string => (mimeType === 'image/png' ? 'png' : 'jpg');
const pad = (n: number): string => String(n).padStart(3, '0');
const mbText = (bytes: number): string =>
  `${(bytes / (1024 * 1024)).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MB`;

/** The pages a call works on: the parsed span, clipped to `max_pages`, with what fell off. */
function selectPages(
  spec: string,
  maxPages: number,
): { pages: number[]; deferred?: { from: number; to: number } } | undefined {
  const r = parsePageRange(spec);
  if (!r) return undefined;
  const pages: number[] = [];
  for (let p = r.from; p <= r.to && pages.length < maxPages; p++) pages.push(p);
  const lastTaken = pages[pages.length - 1]!;
  return { pages, deferred: lastTaken < r.to ? { from: lastTaken + 1, to: r.to } : undefined };
}

/** The error a document-level failure turns into, naming the attachment and the fix. */
function documentError(key: string, e: PdfImageError, maxMb: number): ToolHandlerResult {
  switch (e.kind) {
    case 'too-large':
      return err(
        `The PDF for attachment ${key} was not drawn: ${e.message}. The ${maxMb} MB cap protects the machine running Zoteus; zotero_get_fulltext can still return its indexed text.`,
      );
    case 'password':
      return err(
        `The PDF for attachment ${key} could not be opened: ${e.message}. Remove the password in a PDF tool and re-attach the file, or read whatever text Zotero has indexed with zotero_get_fulltext.`,
      );
    case 'unavailable':
      return err(`The PDF for attachment ${key} could not be drawn: ${e.message}.`);
    case 'canvas':
      return err(`The PDF for attachment ${key} could not be drawn: ${e.message}`);
    default:
      return err(
        `The PDF for attachment ${key} could not be drawn: ${e.message}. If the file opens in Zotero, please report this with the file's producer (zotero_get_fulltext may still return its text).`,
      );
  }
}

const pdfImages: ToolDefinition<ImageToolHandlerResult> = {
  name: 'zotero_pdf_images',
  title: 'Look at PDF pages and figures as images (read-only)',
  description:
    'See a PDF the way a reader does. Text extraction (zotero_get_fulltext) loses figures, turns tables into run-together numbers, drops most equations, and returns nothing for a scanned page with no text layer; this tool returns pictures instead. Pass a parent `item_key` (its PDF attachment is resolved automatically, exactly as zotero_get_fulltext does) or an attachment key, a `mode`, and `pages` ("3" or "3-7", 1-based; default "1"). `mode:"pages"` renders whole pages and returns them as image content blocks you can look at, followed by a JSON block with each page\'s pixel size and byte count: the default resolution keeps body text legible (about 1568 px on the long edge, which is also as much as the model is shown), `dpi` (36 to 300) overrides it for small print, and `format` is "jpeg" (default, quality 80) or "png" (sharper line art, larger). `mode:"figures"` extracts the raster images embedded in those pages, the way pdfimages does: photographs, plots and diagrams stored as images, and on a scanned PDF the page image itself (reported with coversPage:true); each comes back with its page, pixel size, position on the page in points from the top left, the image inline (`inline`, default true; very large ones as a 2000 px preview) and, on a local install, the file it was saved to under the Zoteus data directory (`save`, on by default locally, not offered on a shared server). A figure drawn as vectors (most matplotlib, TikZ and PDF-exported plots) is lines in the content stream, not an image, so it does not appear in figures mode; render the page with mode:"pages" to see it. Caps: `max_pages` per call (default 4, at most 8; a longer span is cut and the notice says how to continue), `max_images` (default 16, at most 40), images under `min_size` px on a side skipped (default 32: icons, rules, bullets), an image repeated across pages returned once, files above 20 MB not parsed, and about 5 MB of inline image data per response, beyond which pages or figures are left out with a notice naming them and the remedy (fewer pages, lower `dpi`, format:"jpeg", or the next span). A PDF whose encryption only restricts printing opens normally; one that needs a password to open is refused with a clear message; an EPUB has no pages to draw. The file is read from the running Zotero desktop app, else the local Zotero storage folder, else Zotero cloud storage. Read-only: nothing in the library changes. Use it when a question is about a figure, a table, an equation, a diagram or a scanned document; use zotero_get_fulltext when the words are what matters.',
  inputSchema: {
    item_key: z.string().describe('Parent item key or attachment key.'),
    mode: z
      .enum(['pages', 'figures'])
      .describe(
        '"pages" renders whole pages to images; "figures" extracts the raster images embedded in them.',
      ),
    pages: z
      .string()
      .optional()
      .describe(
        'Page span like "3" or "3-7" (1-based, inclusive). Default "1". Longer than max_pages is cut, with a notice.',
      ),
    dpi: z
      .number()
      .int()
      .min(MIN_DPI)
      .max(MAX_DPI)
      .optional()
      .describe(
        'Render resolution for mode:"pages" (36 to 300). Default fits the long edge to about 1568 px (roughly 140 dpi on a letter page).',
      ),
    format: z
      .enum(['jpeg', 'png'])
      .optional()
      .describe(
        'Image encoding. Pages default to jpeg; figures default to png up to 2 megapixels and jpeg above.',
      ),
    max_pages: z
      .number()
      .int()
      .min(1)
      .max(HARD_MAX_PAGES)
      .optional()
      .describe(
        `Pages processed per call (default ${DEFAULT_MAX_PAGES}, at most ${HARD_MAX_PAGES}).`,
      ),
    max_images: z
      .number()
      .int()
      .min(1)
      .max(HARD_MAX_IMAGES)
      .optional()
      .describe(
        `Figures returned per call in mode:"figures" (default ${DEFAULT_MAX_IMAGES}, at most ${HARD_MAX_IMAGES}).`,
      ),
    min_size: z
      .number()
      .int()
      .min(1)
      .max(4096)
      .optional()
      .describe(
        `Skip embedded images narrower or shorter than this many pixels in mode:"figures" (default ${DEFAULT_MIN_SIDE_PX}).`,
      ),
    inline: z
      .boolean()
      .optional()
      .describe(
        'Return the images themselves as image content blocks (default true). With false, only metadata and saved paths.',
      ),
    save: z
      .boolean()
      .optional()
      .describe(
        'Also write each image under the Zoteus data directory and return its path. Default: true for figures on a local install, false otherwise. Not available on a shared server.',
      ),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      ...attachmentIdentity,
      mode: z.string().describe('"pages" for rendered pages, "figures" for the raster images embedded in them.'),
      numPages: z.number().describe('Pages the PDF holds.'),
      requested: z.string().describe('The page span asked for, echoed back, e.g. "3-7".'),
      pages: z
        .array(
          z
            .object({
              page: z.number().describe('1-based page number.'),
              width: z.number().describe('Rendered width in pixels.'),
              height: z.number().describe('Rendered height in pixels.'),
              dpi: z.number().describe('Resolution it was rendered at.'),
              mimeType: z.string().describe('"image/jpeg" or "image/png".'),
              bytes: z.number().describe('Size of the rendered image.'),
              inline: z.boolean().describe('Whether this page is also one of the image blocks in `content`.'),
              path: z.string().optional().describe('File it was saved to, when `save` was on.'),
            })
            .passthrough(),
        )
        .optional()
        .describe('mode "pages": one entry per rendered page, in page order.'),
      images: z
        .array(
          z
            .object({
              page: z.number().describe('1-based page the image sits on.'),
              index: z.number().describe('Position of the image on that page.'),
              width: z.number().describe('Pixel width of the stored image.'),
              height: z.number().describe('Pixel height.'),
              mimeType: z.string().describe('"image/jpeg" or "image/png".'),
              bytes: z.number().describe('Size of the stored image.'),
              source: z.string().optional().describe('How it was obtained from the page.'),
              bbox: z.unknown().optional().describe('Where it sits on the page, in points from the top left.'),
              coversPage: z.boolean().optional().describe('True when the image is the whole page, i.e. a scan.'),
              inline: z.boolean().describe('Whether it is also one of the image blocks in `content`.'),
              preview: z
                .object({
                  width: z.number().describe('Pixel width of the preview.'),
                  height: z.number().describe('Pixel height of the preview.'),
                  mimeType: z.string().describe('"image/jpeg" or "image/png".'),
                  bytes: z.number().describe('Size of the preview in bytes.'),
                })
                .passthrough()
                .optional()
                .describe('The smaller copy actually shown inline, when the original was too large.'),
              path: z.string().optional().describe('File it was saved to, when `save` was on.'),
            })
            .passthrough(),
        )
        .optional()
        .describe('mode "figures": one entry per embedded image returned.'),
      skipped: z
        .record(z.number())
        .optional()
        .describe('Images left out, by reason: tiny, duplicate, undecodable.'),
      pagesWithoutImages: z.array(z.number()).optional().describe('Pages that embed no raster image; a figure there is drawn as vectors.'),
      bitmapTextPages: z
        .array(z.record(z.unknown()))
        .optional()
        .describe('Pages painting their text as small stencil bitmaps (a scan with no text layer), with how many.'),
      inlineBase64Chars: z.number().describe('Base64 characters of image data in this response, against the inline budget.'),
      notice: z.string().optional().describe('Scanned pages, vector-only pages, caps hit and files saved, in one sentence.'),
      provenance,
    })
    .passthrough(),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const library: LibraryRef | undefined = optionalLibrary(args);
    const mode: 'pages' | 'figures' = args.mode;
    const wantInline: boolean = args.inline ?? true;
    const shared = Boolean(ctx.remoteCaller);
    if (args.save && shared) {
      return err(
        "This Zoteus is a shared server, so a file it saved would sit on the operator's disk, not on yours. Omit `save` and read the images inline (the default), or run Zoteus locally to keep files.",
      );
    }
    const save: boolean = args.save ?? (mode === 'figures' && !shared);

    const selection = selectPages(args.pages ?? '1', args.max_pages ?? DEFAULT_MAX_PAGES);
    if (!selection) return err('`pages` must look like "3" or "3-7".');

    const resolved = await resolveAttachment(ctx, args.item_key, library);
    if ('error' in resolved) return err(resolved.error);
    const key = resolved.attachmentKey;
    const maxMb = Math.round(DEFAULT_PRECISE_MAX_BYTES / (1024 * 1024));

    const file = await fetchAttachmentBytes(ctx, resolved, library);
    if (file.tooLarge) {
      return err(
        `The PDF for attachment ${key} was not drawn: the file is larger than the ${maxMb} MB limit for on-the-fly parsing.`,
      );
    }
    if (!file.bytes) {
      return err(
        `The PDF for attachment ${key} could not be read (${file.reasons.join('; ') || 'no source could produce the file'}). It may be a linked file with no stored copy.`,
      );
    }
    const kind = detectKind(file.bytes, resolved.contentType, resolved.filename);
    if (kind !== 'pdf') {
      return err(
        kind === 'epub'
          ? `Attachment ${key} is an EPUB. An EPUB reflows and has no pages to draw; its text is available through zotero_get_fulltext.`
          : `Attachment ${key} is not a PDF, so it has no pages to draw. Only PDFs are supported here.`,
      );
    }

    const identity = {
      item_key: args.item_key,
      attachmentKey: key,
      parentKey: resolved.parentKey,
      filename: resolved.filename,
      title: resolved.title,
      fileSource: file.source,
    };
    const readFrom = file.source ? ` Read from ${SOURCE_LABEL[file.source]}.` : '';
    const saveDir = join(ctx.config.dataDir, SAVE_SUBDIR, basename(key));
    const format: ImageFormat | undefined = args.format;
    const maxImagePixels = shared ? SHARED_IMAGE_PIXEL_LIMIT : LOCAL_IMAGE_PIXEL_LIMIT;
    const notices: string[] = [];
    const continueWith = selection.deferred
      ? ` Pages ${describePages(range(selection.deferred))} were not processed: max_pages is ${args.max_pages ?? DEFAULT_MAX_PAGES} per call (at most ${HARD_MAX_PAGES}); call again with pages:"${selection.deferred.from}-${Math.min(selection.deferred.to, selection.deferred.from + HARD_MAX_PAGES - 1)}".`
      : '';

    // ------------------------------------------------------------------ pages -------------
    if (mode === 'pages') {
      const result = await renderPdfPages(file.bytes, {
        pages: selection.pages,
        dpi: args.dpi,
        format,
        maxImagePixels,
      });
      if ('error' in result) return documentError(key, result.error, maxMb);
      if (result.missing.length) {
        notices.push(
          result.rendered.length
            ? `Pages ${describePages(result.missing)} are beyond the document (${result.numPages} pages).`
            : `Pages ${describePages(result.missing)} are beyond the document: it has ${result.numPages} page(s).`,
        );
      }
      if (!result.rendered.length) {
        return err(
          `Nothing to draw for ${key}: ${notices.join(' ') || 'no requested page exists.'}`,
        );
      }
      const plan = wantInline
        ? planInline(result.rendered, (p) => p.bytes.byteLength, INLINE_BUDGET_BASE64)
        : { inline: new Set<RenderedPage>(), used: 0 };
      const dropped = wantInline ? result.rendered.filter((p) => !plan.inline.has(p)) : [];
      if (dropped.length) {
        notices.push(
          `Pages ${describePages(dropped.map((p) => p.page))} were rendered but not returned inline: the response budget is about ${mbText(INLINE_BUDGET_BASE64)} of image data and these would exceed it. Ask for fewer pages, a lower dpi, or format:"jpeg"${save ? '; the saved files hold them at full size' : ', or pass save:true on a local install to keep the files'}.`,
        );
      }
      if (save) await mkdir(saveDir, { recursive: true });
      const pages = [];
      const images: ToolContent[] = [];
      for (const p of result.rendered) {
        let path: string | undefined;
        if (save) {
          path = join(saveDir, `page-${pad(p.page)}.${ext(p.mimeType)}`);
          await writeFile(path, p.bytes);
        }
        const inline = plan.inline.has(p);
        if (inline) images.push({ type: 'image', data: toBase64(p.bytes), mimeType: p.mimeType });
        pages.push({
          page: p.page,
          width: p.width,
          height: p.height,
          dpi: p.dpi,
          mimeType: p.mimeType,
          bytes: p.bytes.byteLength,
          inline,
          path,
        });
      }
      if (save) notices.push(`Files saved under ${saveDir}.`);
      if (continueWith) notices.push(continueWith.trim());
      const first = result.rendered[0]!;
      const notice = notices.join(' ') || undefined;
      const summary =
        `Rendered ${result.rendered.length} page(s) of ${args.item_key} (pages ${describePages(result.rendered.map((p) => p.page))} of ${result.numPages}) at ${first.dpi} dpi as ${first.mimeType === 'image/png' ? 'PNG' : 'JPEG'}, ${first.width}x${first.height} px` +
        (images.length
          ? `, ${images.length} returned inline (${mbText(plan.used)} base64).`
          : ', none returned inline.') +
        readFrom +
        (notice ? ` ${notice}` : '');
      return withImages(
        okLibraryContent(
          {
            ...identity,
            mode: 'pages',
            numPages: result.numPages,
            requested: args.pages ?? '1',
            pages,
            inlineBase64Chars: plan.used,
            notice,
          },
          summary,
        ),
        images,
      );
    }

    // ------------------------------------------------------------------ figures -----------
    const result = await extractPdfImages(file.bytes, {
      pages: selection.pages,
      minSide: args.min_size,
      maxImages: args.max_images ?? DEFAULT_MAX_IMAGES,
      format,
      previewEdge: wantInline ? undefined : null,
      maxImagePixels,
    });
    if ('error' in result) return documentError(key, result.error, maxMb);
    if (result.missing.length) {
      notices.push(
        `Pages ${describePages(result.missing)} are beyond the document (${result.numPages} pages).`,
      );
    }
    const processed = selection.pages.filter((p) => !result.missing.includes(p));
    if (!processed.length) return err(`Nothing to read for ${key}: ${notices.join(' ')}`);

    const inlineSize = (img: ExtractedImage): number => (img.preview ?? img).bytes.byteLength;
    const plan = wantInline
      ? planInline(result.images, inlineSize, INLINE_BUDGET_BASE64)
      : { inline: new Set<ExtractedImage>(), used: 0 };
    const dropped = wantInline ? result.images.filter((img) => !plan.inline.has(img)) : [];
    if (save && result.images.length) await mkdir(saveDir, { recursive: true });
    const images: ToolContent[] = [];
    const listed = [];
    for (const img of result.images) {
      let path: string | undefined;
      if (save) {
        path = join(saveDir, `page-${pad(img.page)}-image-${pad(img.index)}.${ext(img.mimeType)}`);
        await writeFile(path, img.bytes);
      }
      const inline = plan.inline.has(img);
      if (inline) {
        const shown = img.preview ?? img;
        images.push({ type: 'image', data: toBase64(shown.bytes), mimeType: shown.mimeType });
      }
      listed.push({
        page: img.page,
        index: img.index,
        width: img.width,
        height: img.height,
        mimeType: img.mimeType,
        bytes: img.bytes.byteLength,
        source: img.source,
        bbox: img.bbox,
        coversPage: img.coversPage,
        inline,
        preview:
          inline && img.preview
            ? {
                width: img.preview.width,
                height: img.preview.height,
                mimeType: img.preview.mimeType,
                bytes: img.preview.bytes.byteLength,
              }
            : undefined,
        path,
      });
    }

    const scans = result.images.filter((img) => img.coversPage);
    const scannedPages = new Set(scans.map((img) => img.page));
    if (processed.length && processed.every((p) => scannedPages.has(p))) {
      notices.push(
        `Every page here is one full-page image: this is a scanned PDF. mode:"pages" shows the same picture at a resolution you choose, and zotero_get_fulltext has no text for it unless Zotero has OCRed the file.`,
      );
    } else if (scans.length) {
      notices.push(
        `Pages ${describePages([...scannedPages])} are each one full-page image (scanned pages).`,
      );
    }
    const vectorOnly = result.pagesWithoutImages.filter((p) => !result.blankPages.includes(p));
    if (vectorOnly.length) {
      notices.push(
        `Pages ${describePages(vectorOnly)} embed no raster image${result.skipped.tiny ? ' larger than min_size' : ''}: a figure there is drawn as vectors, which only mode:"pages" shows.`,
      );
    }
    if (result.blankPages.length) {
      notices.push(
        `Pages ${describePages(result.blankPages)} hold neither text nor a decodable image; an image above this server's ${Math.round(maxImagePixels / 1_000_000)}-megapixel decode limit (a 600 dpi scan, say) would look like this.`,
      );
    }
    if (result.bitmapTextPages.length) {
      const total = result.bitmapTextPages.reduce((n, p) => n + p.masks, 0);
      notices.push(
        `Pages ${describePages(result.bitmapTextPages.map((p) => p.page))} paint their text as ${total} small stencil bitmaps (a scan stored letter by letter, with no text layer); those are not figures and were left out. mode:"pages" shows the page, and zotero_get_fulltext has no text for it unless Zotero has OCRed the file.`,
      );
    }
    if (result.skipped.tiny)
      notices.push(
        `Skipped ${result.skipped.tiny} image(s) under ${args.min_size ?? DEFAULT_MIN_SIDE_PX} px (icons, rules).`,
      );
    if (result.skipped.duplicate)
      notices.push(`Folded ${result.skipped.duplicate} repeat(s) of an image already listed.`);
    if (result.skipped.undecodable)
      notices.push(
        `${result.skipped.undecodable} image(s) could not be decoded and were left out.`,
      );
    if (result.truncated) {
      notices.push(
        `Stopped at max_images (${args.max_images ?? DEFAULT_MAX_IMAGES}); raise it (up to ${HARD_MAX_IMAGES}) or ask for fewer pages to see the rest.`,
      );
    }
    if (dropped.length) {
      notices.push(
        `${dropped.length} image(s) (pages ${describePages(dropped.map((d) => d.page))}) were not returned inline: the response budget is about ${mbText(INLINE_BUDGET_BASE64)} of image data. Ask for fewer pages or a smaller max_images${save ? '; the saved files hold them' : ''}.`,
      );
    }
    if (save && result.images.length) notices.push(`Files saved under ${saveDir}.`);
    if (continueWith) notices.push(continueWith.trim());
    const notice = notices.join(' ') || undefined;
    const summary =
      `${result.images.length} embedded image(s) on pages ${describePages(processed)} of ${args.item_key} (${result.numPages} pages)` +
      (result.images.length
        ? `: ${images.length} returned inline${save ? `, ${result.images.length} saved` : ''}.`
        : '.') +
      readFrom +
      (notice ? ` ${notice}` : '');
    return withImages(
      okLibraryContent(
        {
          ...identity,
          mode: 'figures',
          numPages: result.numPages,
          requested: args.pages ?? '1',
          images: listed,
          skipped: result.skipped,
          pagesWithoutImages: result.pagesWithoutImages,
          bitmapTextPages: result.bitmapTextPages,
          inlineBase64Chars: plan.used,
          notice,
        },
        summary,
      ),
      images,
    );
  },
};

/** The pages of a span, for naming them back. */
function range(r: { from: number; to: number }): number[] {
  const out: number[] = [];
  for (let p = r.from; p <= r.to; p++) out.push(p);
  return out;
}

/**
 * The image blocks go between the summary line and the JSON mirror: a client that shows
 * the model everything reads "what this is", then the pictures, then the metadata; one
 * that drops images still gets both text blocks, and the provenance marker rides the
 * mirror as it does for every other library-content result.
 */
function withImages(result: ToolHandlerResult, images: ToolContent[]): ImageToolHandlerResult {
  if (!images.length) return result;
  const [summary, ...rest] = result.content;
  return { ...result, content: [summary!, ...images, ...rest] };
}

// Exported for the tests that check the budget arithmetic against the real constant.
export { base64Length };

export default pdfImages;
