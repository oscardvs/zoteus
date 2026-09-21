/**
 * Reading a scanned PDF by rendering its pages and recognising the text in the pictures.
 *
 * The whole design goal is that OCR text arrives in the SAME shape text-layer extraction
 * arrives in: one string per page, in page order, one entry per page the document has.
 * `extractPdfPages` (src/features/fulltext/pdf-pages.ts) returns exactly that, and every
 * locator downstream is built on it: `pdfPagesToText` joins it into the document,
 * `chunkWithOffsets` and `rankPassages` chunk and rank that, `locatePage` turns a ranked
 * passage back into a 1-based page, and `page_range` slices it. Match the shape and all of
 * that works unchanged and reports an exact page. Deviate from it and every one of those
 * would need its own OCR branch.
 *
 * Pages the call did not read are '' rather than absent, which is what keeps the array
 * indexed by page: page 9 of a 40-page scan is `pages[8]` whether or not the cap let it be
 * read. `locatePage` never matches an empty page, so an unread page cannot be cited.
 *
 * ON THE SERIALIZATION GATE, because getting this wrong hangs the process forever.
 * `serialized()` in pdf-images.ts is a bare, NON-REENTRANT promise chain, and
 * `renderPdfPages` already enters it. An OCR job that took that gate and then called
 * `renderPdfPages` would wait for a gate it holds itself, with no error and no timeout, and
 * every later PDF operation in the process would queue behind it. So this file inherits
 * that gate through the render call and never wraps it.
 *
 * The recognition half still has to be bounded, because a wasm OCR heap is the second
 * large allocation in this process and the hosted machine has 1 GB. It gets its own gate
 * here. The two can never deadlock: this gate is taken first and released last, nothing
 * holding the pdf-images gate ever asks for this one, so there is no cycle to close.
 */

import { renderPdfPages, MAX_DPI } from '../fulltext/pdf-images.js';
import { DEFAULT_PRECISE_MAX_BYTES } from '../fulltext/pdf-pages.js';
import { electronVersion, type RuntimeVersions } from '../search/electron.js';
import { loadOcrEngine, OcrEngineUnavailable, type OcrEngine } from './engine.js';

/**
 * Resolution pages are rendered at for recognition. Tesseract is trained on roughly 300
 * dpi input and reads small print materially worse below it; MAX_DPI in the renderer is
 * 300 as well, so this asks for exactly as much as that path will ever give.
 */
export const OCR_DPI = MAX_DPI;

/**
 * Pages one OCR call may read under Electron, whatever ZOTEUS_OCR_MAX_PAGES says.
 *
 * Chromium replaces the process allocator, and an allocation it will not serve kills the
 * process outright with SIGTRAP: no error, no stack, nothing on stderr (see
 * src/features/search/electron.ts, where the same thing was diagnosed for the embedder). A
 * wasm OCR heap plus a 300 dpi canvas is exactly the shape of allocation that does it. The
 * answer there was a cap rather than a refusal, and it is the answer here: fewer pages per
 * call, the feature still available, and the change said out loud.
 */
export const ELECTRON_OCR_MAX_PAGES = 2;

export interface OcrPagesOptions {
  /** 1-based pages wanted, in order. Pages past the end are reported, not read. */
  pages: number[];
  /** Tesseract language codes, `+`-separated. */
  langs: string;
  /** Pages this call may read (ZOTEUS_OCR_MAX_PAGES); the Electron cap may lower it. */
  maxPages: number;
  ocrPath?: string;
  /** Where language data is cached between runs. */
  cacheDir?: string;
  dpi?: number;
  maxBytes?: number;
  /** pdfjs's decode ceiling, lower on a shared server (see pdf-images.ts). */
  maxImagePixels?: number;
  /**
   * An engine to use instead of loading one. The injection seam: every test passes a fake
   * here, so the page-mapping path is exercised with no wasm, no language download and no
   * network, exactly as EmbeddingProvider.loadExtractor does for the embedder.
   */
  engine?: OcrEngine;
  /** Runtime versions, injectable so the Electron cap can be tested from plain Node. */
  versions?: RuntimeVersions;
}

export interface OcrPagesResult {
  ok: true;
  /** One entry per page the document holds, in page order; '' where the page was not read. */
  pages: string[];
  numPages: number;
  /** Pages actually read, in order. */
  read: number[];
  /** Requested pages the document does not have. */
  missing: number[];
  /** Requested pages the per-call cap left for a later call. */
  deferred: number[];
  /** Pages that were read and came back with no text at all. */
  unreadable: number[];
  /** The engine's own name, for the notice: OCR text must never look like publisher text. */
  engine: string;
  /** Pages the cap allowed, and why it is not the configured number when it is not. */
  cap: number;
  capNotice?: string;
  /** Wall-clock milliseconds the whole pass took, rendering included. */
  ms: number;
}

export interface OcrPagesFailure {
  ok: false;
  /** `unavailable` is "no engine here"; the others are about this particular file. */
  reason: 'unavailable' | 'too-large' | 'render' | 'no-pages';
  message: string;
}

/**
 * One OCR job at a time in this process. NOT the pdf-images gate: see the header. A bare
 * promise chain, like that one, and non-reentrant in the same way, so nothing inside a job
 * may call `ocrSerialized` again.
 */
let gate: Promise<void> = Promise.resolve();

async function ocrSerialized<T>(job: () => Promise<T>): Promise<T> {
  const previous = gate;
  let release!: () => void;
  gate = new Promise<void>((resolve) => (release = resolve));
  await previous;
  try {
    return await job();
  } finally {
    release();
  }
}

/** Pages one call may read here, which is the configured cap unless Electron lowers it. */
export function ocrPageCap(configured: number, versions?: RuntimeVersions): number {
  const asked = Math.max(1, Math.floor(configured));
  return electronVersion(versions ?? (process.versions as unknown as RuntimeVersions))
    ? Math.min(asked, ELECTRON_OCR_MAX_PAGES)
    : asked;
}

/** The line to say when Electron lowered the cap, and nothing when it did not. */
export function ocrCapNotice(configured: number, versions?: RuntimeVersions): string | undefined {
  const version = electronVersion(versions ?? (process.versions as unknown as RuntimeVersions));
  if (!version) return undefined;
  const effective = ocrPageCap(configured, versions);
  if (effective >= Math.max(1, Math.floor(configured))) return undefined;
  return (
    `OCR is capped at ${effective} page(s) a call here (ZOTEUS_OCR_MAX_PAGES asks for ${configured}): this ` +
    `server runs on Electron ${version}'s Node, where one allocation large enough is refused by ` +
    `Chromium's allocator and kills the process outright, with nothing logged.`
  );
}

/** OCR output as one page's worth of text: trailing space stripped, blank lines collapsed. */
function tidy(text: string): string {
  return text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The requested pages of a scanned PDF, read by OCR, as one string per page of the whole
 * document. Never throws: a document that cannot be opened, an engine that will not load
 * and a cap that cut the request short all come back as data the caller can turn into a
 * sentence.
 */
export async function ocrPdfPages(
  bytes: Uint8Array,
  opts: OcrPagesOptions,
): Promise<OcrPagesResult | OcrPagesFailure> {
  const maxBytes = opts.maxBytes ?? DEFAULT_PRECISE_MAX_BYTES;
  if (bytes.byteLength > maxBytes) {
    return {
      ok: false,
      reason: 'too-large',
      message: `the file is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB limit for on-the-fly parsing`,
    };
  }
  const cap = ocrPageCap(opts.maxPages, opts.versions);
  const capNotice = ocrCapNotice(opts.maxPages, opts.versions);
  const wanted = [...new Set(opts.pages.filter((p) => Number.isInteger(p) && p > 0))].sort((a, b) => a - b);
  if (!wanted.length) return { ok: false, reason: 'no-pages', message: 'no page was asked for' };
  const selected = wanted.slice(0, cap);
  const deferred = wanted.slice(cap);

  return ocrSerialized(async () => {
    const started = Date.now();
    // NOT wrapped in the pdf-images gate: renderPdfPages enters it itself, and that gate is
    // not reentrant. See the header.
    const drawn = await renderPdfPages(bytes, {
      pages: selected,
      dpi: opts.dpi ?? OCR_DPI,
      // PNG rather than JPEG: recognition reads letter edges, and JPEG's ringing around
      // black-on-white text is the one artefact that costs accuracy.
      format: 'png',
      maxBytes,
      maxImagePixels: opts.maxImagePixels,
    });
    if ('error' in drawn) return { ok: false as const, reason: 'render' as const, message: drawn.error.message };
    if (!drawn.rendered.length) {
      return {
        ok: false as const,
        reason: 'no-pages' as const,
        message:
          `${selected.length === 1 ? 'page' : 'pages'} ${selected.join(', ')} ` +
          `${selected.length === 1 ? 'is' : 'are'} beyond the document, which has ${drawn.numPages}`,
      };
    }
    let engine = opts.engine;
    const ours = !engine;
    if (!engine) {
      try {
        engine = await loadOcrEngine({ langs: opts.langs, ocrPath: opts.ocrPath, cacheDir: opts.cacheDir });
      } catch (e) {
        return {
          ok: false as const,
          reason: 'unavailable' as const,
          message: e instanceof OcrEngineUnavailable || e instanceof Error ? e.message : String(e),
        };
      }
    }
    try {
      const pages: string[] = new Array<string>(drawn.numPages).fill('');
      const read: number[] = [];
      const unreadable: number[] = [];
      for (const page of drawn.rendered) {
        const text = tidy(
          await engine.readPage({
            page: page.page,
            bytes: page.bytes,
            mimeType: page.mimeType,
            width: page.width,
            height: page.height,
          }),
        );
        pages[page.page - 1] = text;
        read.push(page.page);
        if (!text) unreadable.push(page.page);
      }
      return {
        ok: true as const,
        pages,
        numPages: drawn.numPages,
        read,
        missing: drawn.missing,
        deferred,
        unreadable,
        engine: engine.name,
        cap,
        capNotice,
        ms: Date.now() - started,
      };
    } finally {
      // An injected engine belongs to the caller; one this call started does not outlive it.
      if (ours) await engine.close().catch(() => {});
    }
  });
}
