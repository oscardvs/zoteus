import { createHash } from 'node:crypto';
import {
  canvasLoadError,
  loadCanvas,
  loadPdfjs,
  pdfjsAssetUrls,
  pdfjsUnavailableReason,
} from './pdfjs-loader.js';
import { DEFAULT_PRECISE_MAX_BYTES } from './pdf-pages.js';

/**
 * PDF pages as pictures, and the pictures inside PDF pages.
 *
 * Everything else in this directory turns a PDF into text, and text is what a figure, a
 * table, an equation and a scanned page all lose: a figure arrives as its caption, a table
 * as its numbers run together, an equation as a few stray glyphs, and a scan with no text
 * layer as nothing at all. This module gives a reader the page instead. `renderPdfPages`
 * draws whole pages to JPEG or PNG at a resolution a model can read; `extractPdfImages`
 * pulls the raster images embedded in a page (photographs, plots, diagrams, the page image
 * of a scan) the way `pdfimages` does, with where each sits on the page.
 *
 * Both draw through pdfjs's own Node canvas, which is `@napi-rs/canvas`: an optional
 * dependency of pdfjs-dist that a plain `npm install` brings in with it, and whose skia
 * binary the desktop bundles already carry for every OS and CPU they name
 * (scripts/mcpb-bundle.ts). So this needs no dependency Zoteus did not already ship; it
 * only starts using one. It is deliberately NOT declared in Zoteus's own package.json: pdfjs
 * pins the range it was tested against, a second declaration could only agree with it or
 * install a second copy, and the bundle audit already fails a release whose lockfile lost
 * the binaries. When the package is missing anyway (`--omit=optional`), the error names it
 * and the one-line fix, instead of the stack trace pdfjs would throw.
 *
 * pdfjs must be loaded through ./pdfjs-loader.ts, or none of this works inside Claude
 * Desktop (see that file).
 *
 * Memory is the constraint that shaped the caps. The hosted tier runs on a 1 GB machine,
 * pdfjs decodes every image on a page to raw pixels before anything is drawn, and a canvas
 * costs four bytes a pixel. Measured on this machine: a letter page holding one
 * 1520x2239 RGBA figure rendered at 1224x1584 peaked at 252 MB RSS for the whole process.
 * So: at most 8 pages a call, a long edge of at most 3508 px (A4 at 300 dpi), an image
 * pixel limit pdfjs enforces while decoding (16 megapixels on a shared server, 40 locally,
 * so a 600 dpi scan still opens on a laptop), and one job at a time per process, since two
 * concurrent peaks on the small machine would be an OOM kill for every user on it.
 */

export type ImageFormat = 'jpeg' | 'png';
export type ImageMime = 'image/jpeg' | 'image/png';
const MIME: Record<ImageFormat, ImageMime> = { jpeg: 'image/jpeg', png: 'image/png' };

/**
 * Default long edge of a rendered page. Claude downsizes anything longer than about
 * 1568 px before it looks at it, so pixels past that are paid for and never seen; measured,
 * a letter page at this size (1212x1568) keeps 9-point body text and inline maths legible.
 */
export const DEFAULT_LONG_EDGE_PX = 1568;
export const MIN_DPI = 36;
export const MAX_DPI = 300;
/** A4 at 300 dpi is 2480x3508; nothing renders longer than that, whatever the dpi asked. */
export const MAX_EDGE_PX = 3508;
export const JPEG_QUALITY = 80;
/** Images shorter than this on either side are icons, rules and bullets, not figures. */
export const DEFAULT_MIN_SIDE_PX = 32;
/** An extracted image longer than this on its long edge is also offered as a smaller JPEG. */
export const PREVIEW_EDGE_PX = 2000;
/** Without an explicit format, an extracted image above this many pixels is a JPEG. */
export const AUTO_JPEG_ABOVE_PX = 2_000_000;
/** pdfjs skips decoding an image with more pixels than this; see the header. */
export const LOCAL_IMAGE_PIXEL_LIMIT = 40_000_000;
export const SHARED_IMAGE_PIXEL_LIMIT = 16_777_216;
/** An image drawn over at least this share of the page is the page: a scan. */
export const COVERS_PAGE_FRACTION = 0.7;
/**
 * A page painting at least this many stencil masks is text scanned glyph by glyph (the
 * measured 2006 paper paints 4390 a page, each a 30 to 75 px letter); the masks are not
 * figures and are reported as what they are rather than returned one letter at a time.
 */
export const BITMAP_TEXT_MASKS = 200;
/** How long to wait for pdfjs to hand over one decoded image before giving up on it. */
const OBJECT_WAIT_MS = 20_000;

/** Why a document could not be drawn from, so the caller can say which. */
export type PdfImageErrorKind = 'unavailable' | 'too-large' | 'password' | 'invalid' | 'canvas';
export interface PdfImageError {
  kind: PdfImageErrorKind;
  message: string;
}
export interface PdfImageFailure {
  error: PdfImageError;
}

export interface RenderedPage {
  /** 1-based page number. */
  page: number;
  width: number;
  height: number;
  /** The resolution actually used, after the caps. */
  dpi: number;
  mimeType: ImageMime;
  bytes: Uint8Array;
}

export interface RenderPagesOptions {
  /** 1-based pages, in the order wanted; pages past the end are reported, not rendered. */
  pages: number[];
  /** Explicit resolution; absent means "fit DEFAULT_LONG_EDGE_PX". Capped by MAX_EDGE_PX. */
  dpi?: number;
  format?: ImageFormat;
  maxBytes?: number;
  maxImagePixels?: number;
}

export interface RenderPagesResult {
  numPages: number;
  rendered: RenderedPage[];
  /** Requested pages the document does not have. */
  missing: number[];
}

/** Where an image sits on its page, in PDF points with the origin at the top left. */
export interface ImageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ExtractedImage {
  page: number;
  /** 1-based position among the images kept from this page. */
  index: number;
  /** Native pixel size of the embedded image, which is what `bytes` holds. */
  width: number;
  height: number;
  mimeType: ImageMime;
  bytes: Uint8Array;
  /** An image XObject, an inline image, or a stencil mask (drawn in the fill colour). */
  source: 'xobject' | 'inline' | 'mask';
  bbox?: ImageBox;
  /** The image is drawn over most of the page: a scanned page rather than a figure on one. */
  coversPage: boolean;
  /** A smaller JPEG of the same image, present when the native one is longer than the preview edge. */
  preview?: { width: number; height: number; mimeType: ImageMime; bytes: Uint8Array };
}

export interface ExtractImagesOptions {
  pages: number[];
  minSide?: number;
  maxImages?: number;
  /** Force a format; absent means PNG up to AUTO_JPEG_ABOVE_PX pixels and JPEG above. */
  format?: ImageFormat;
  /** Long edge above which a preview is produced; null or 0 for no previews. */
  previewEdge?: number | null;
  maxBytes?: number;
  maxImagePixels?: number;
}

export interface ExtractImagesResult {
  numPages: number;
  images: ExtractedImage[];
  missing: number[];
  skipped: { tiny: number; duplicate: number; undecodable: number };
  /** Requested pages that hold no raster image at all (vector figures, or plain text). */
  pagesWithoutImages: number[];
  /** Pages with neither an image nor a character of text: likely an image above the pixel limit. */
  blankPages: number[];
  /** Pages whose text is painted as hundreds of small stencil masks; those masks were left out. */
  bitmapTextPages: Array<{ page: number; masks: number }>;
  /** `maxImages` was reached before the last requested page was finished. */
  truncated: boolean;
}

const IDENTITY: readonly number[] = [1, 0, 0, 1, 0, 0];

// ---------------------------------------------------------------------------------------------
// One job at a time. See the header: this is the cheapest protection the 1 GB host has.

let gate: Promise<void> = Promise.resolve();

async function serialized<T>(job: () => Promise<T>): Promise<T> {
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

// ---------------------------------------------------------------------------------------------
// The canvas pool, which is what makes a page of stencil masks affordable.
//
// pdfjs allocates two or three scratch canvases for every stencil mask it paints and drops
// them straight after, and old papers whose text was scanned glyph by glyph paint thousands
// of masks a page (measured: 4390 on one page of a 2006 conference paper, in 150 distinct
// sizes). Under @napi-rs/canvas 0.1.100 a dropped canvas's memory is not returned to the
// operating system: `width = 0`, a forced GC and idle event-loop turns all leave RSS where
// it was. Measured on this machine, 4000 small canvases created and dropped cost 750 MB of
// resident memory that never came back, and rendering that page once took the process from
// 180 MB to 690 MB, twice to 1 GB, which on the hosted 1 GB machine is the end of the
// process for every user on it. Reusing one canvas through `context.reset()` cost 32 MB for
// the same 4000 uses.
//
// So canvases are pooled by exact size and handed back to pdfjs through the `CanvasFactory`
// option of `getDocument`, which is public API: `create` takes from the pool, `destroy`
// returns to it, and `reset` (pdfjs's own cache resizing a canvas it kept) swaps in a pooled
// canvas of the new size instead of reallocating. The pool is bounded in pixels and in
// count; a canvas that would overflow it is dropped the way pdfjs drops them.

/**
 * 16 megapixels is one A4 page canvas at 300 dpi (8.7) plus room for thousands of glyph-sized
 * scratch canvases (the 4390 masks of the measured page pooled at 2.3 megapixels in total).
 * The count cap is the one that binds for glyph pages, and a cap of 512 was measured to
 * saturate on the second such page and leak from there (748 MB after four pages); at this
 * size the same four pages stay flat.
 */
const POOL_MAX_PIXELS = 16_000_000;
const POOL_MAX_CANVASES = 8192;
const pool = new Map<string, any[]>();
let pooledPixels = 0;
let pooledCount = 0;

function poolTake(width: number, height: number): any | undefined {
  const canvas = pool.get(`${width}x${height}`)?.pop();
  if (canvas) {
    pooledPixels -= width * height;
    pooledCount--;
  }
  return canvas;
}

function poolGive(canvas: any): void {
  const pixels = canvas.width * canvas.height;
  if (!pixels || pooledPixels + pixels > POOL_MAX_PIXELS || pooledCount >= POOL_MAX_CANVASES) {
    canvas.width = canvas.height = 0;
    return;
  }
  // A fresh canvas is what pdfjs expects from `create`: transparent, identity transform, no
  // clip, an empty state stack, default styles. Writing the width, even unchanged, is the
  // canvas specification's way of restoring all of that at once, and measured here it does
  // (the binding's `context.reset()` left a clip set outside any `save` in place), at the
  // same memory cost: the pooled workload settled at the same RSS either way.
  const width: number = canvas.width;
  canvas.width = width;
  const key = `${width}x${canvas.height}`;
  let list = pool.get(key);
  if (!list) pool.set(key, (list = []));
  list.push(canvas);
  pooledPixels += pixels;
  pooledCount++;
}

/** Visible for tests: how much the pool currently holds. */
export function canvasPoolStats(): { canvases: number; pixels: number } {
  return { canvases: pooledCount, pixels: pooledPixels };
}

/**
 * The factory class handed to pdfjs. Its instances follow pdfjs's BaseCanvasFactory
 * contract (create, reset, destroy on `{ canvas, context }` pairs), backed by the pool.
 */
function pooledCanvasFactory(canvasModule: any): new (options?: unknown) => unknown {
  const make = (width: number, height: number) => {
    const canvas = poolTake(width, height) ?? canvasModule.createCanvas(width, height);
    return { canvas, context: canvas.getContext('2d') };
  };
  return class PooledCanvasFactory {
    // pdfjs passes `{ ownerDocument, enableHWA }`; neither applies under Node.
    constructor(_options?: unknown) {}
    create(width: number, height: number): { canvas: any; context: any } {
      if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
      return make(width, height);
    }
    reset(entry: { canvas: any; context: any }, width: number, height: number): void {
      if (!entry.canvas) throw new Error('Canvas is not specified');
      if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
      if (entry.canvas.width === width && entry.canvas.height === height) {
        entry.canvas.width = width;
        return;
      }
      poolGive(entry.canvas);
      Object.assign(entry, make(width, height));
    }
    destroy(entry: { canvas: any; context: any }): void {
      if (!entry.canvas) throw new Error('Canvas is not specified');
      poolGive(entry.canvas);
      entry.canvas = null;
      entry.context = null;
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Opening, and saying why it failed.

const mb = (n: number): string => (n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1);

function classifyOpenError(e: unknown): PdfImageError {
  const name = (e as { name?: string } | null)?.name;
  const message = e instanceof Error ? e.message : String(e);
  if (name === 'PasswordException') {
    return {
      kind: 'password',
      message:
        'the PDF is protected by a password that is needed to open it, and Zoteus has no way to ask for one',
    };
  }
  return { kind: 'invalid', message: `the file is not a readable PDF (${message})` };
}

/** The canvas package is the one dependency worth naming with its fix. */
function canvasMissing(reason: string): PdfImageError {
  return {
    kind: 'canvas',
    message:
      `drawing needs the @napi-rs/canvas package that pdfjs-dist draws through, and it could not be ` +
      `loaded here (${reason}). On an npm install, run "npm install @napi-rs/canvas" in the same ` +
      `node_modules as pdfjs-dist (it is an optional dependency of pdfjs-dist, so an install with ` +
      `--omit=optional leaves it out); the Claude Desktop bundle already ships it for every supported OS.`,
  };
}

/** A failure while drawing, after the document opened. */
function classifyDrawError(e: unknown): PdfImageError {
  const message = e instanceof Error ? e.message : String(e);
  if (/napi-rs\/canvas|Cannot find module|MODULE_NOT_FOUND/i.test(message))
    return canvasMissing(message);
  return { kind: 'invalid', message: `the PDF could not be drawn (${message})` };
}

async function openPdf(
  bytes: Uint8Array,
  opts: { maxBytes?: number; maxImagePixels?: number },
): Promise<{ pdfjs: any; doc: any } | PdfImageFailure> {
  const maxBytes = opts.maxBytes ?? DEFAULT_PRECISE_MAX_BYTES;
  if (bytes.byteLength > maxBytes) {
    return {
      error: {
        kind: 'too-large',
        message: `the file is ${mb(bytes.byteLength)} MB, above the ${mb(maxBytes)} MB limit for on-the-fly parsing`,
      },
    };
  }
  // Loaded through the shared loader: pdfjs must not be imported directly, or it breaks
  // inside Electron (Claude Desktop). See pdfjs-loader.ts.
  const pdfjs = await loadPdfjs();
  if (!pdfjs) return { error: { kind: 'unavailable', message: pdfjsUnavailableReason() } };
  // Checked before any byte is parsed: the canvas is the one dependency that can be absent
  // while pdfjs is present, and the failure should name it, not surface as a stack trace
  // from somewhere inside a render.
  const canvas = loadCanvas();
  if (!canvas) return { error: canvasMissing(canvasLoadError() ?? 'not installed') };
  try {
    const doc = await pdfjs.getDocument({
      // pdfjs transfers (detaches) the buffer it is given; hand it a copy.
      data: bytes.slice(),
      isEvalSupported: false,
      maxImageSize: opts.maxImagePixels ?? LOCAL_IMAGE_PIXEL_LIMIT,
      CanvasFactory: pooledCanvasFactory(canvas),
      ...(pdfjsAssetUrls() ?? {}),
    }).promise;
    return { pdfjs, doc };
  } catch (e) {
    return { error: classifyOpenError(e) };
  }
}

/** The requested pages the document has, in request order, and the ones it has not. */
function splitPages(pages: number[], numPages: number): { wanted: number[]; missing: number[] } {
  const wanted: number[] = [];
  const missing: number[] = [];
  for (const p of pages) (p >= 1 && p <= numPages ? wanted : missing).push(p);
  return { wanted, missing };
}

interface CanvasPair {
  canvas: any;
  context: any;
}

function newCanvas(doc: any, width: number, height: number): CanvasPair | PdfImageFailure {
  try {
    return doc.canvasFactory.create(Math.max(1, width), Math.max(1, height)) as CanvasPair;
  } catch (e) {
    return { error: classifyDrawError(e) };
  }
}

async function encodeCanvas(canvas: any, format: ImageFormat): Promise<Uint8Array> {
  const buf: Uint8Array =
    format === 'png' ? await canvas.encode('png') : await canvas.encode('jpeg', JPEG_QUALITY);
  // A copy: the encoder's buffer may be a slice of a pool that the canvas reuses.
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------------------------
// Pages.

/**
 * The scale a page renders at: the caller's dpi when given, otherwise whatever fits the
 * default long edge, and never more than MAX_DPI or a long edge of MAX_EDGE_PX.
 */
export function renderScale(pagePoints: { width: number; height: number }, dpi?: number): number {
  const long = Math.max(pagePoints.width, pagePoints.height) || 1;
  const asked = dpi && dpi > 0 ? dpi / 72 : DEFAULT_LONG_EDGE_PX / long;
  return Math.min(asked, MAX_DPI / 72, MAX_EDGE_PX / long);
}

/**
 * The requested pages, drawn. Never throws: a document that cannot be opened or drawn
 * comes back as `{ error }` with a kind the caller can turn into the right sentence.
 */
export async function renderPdfPages(
  bytes: Uint8Array,
  opts: RenderPagesOptions,
): Promise<RenderPagesResult | PdfImageFailure> {
  return serialized(async () => {
    const opened = await openPdf(bytes, opts);
    if ('error' in opened) return opened;
    const { doc } = opened;
    const format = opts.format ?? 'jpeg';
    try {
      const { wanted, missing } = splitPages(opts.pages, doc.numPages);
      const rendered: RenderedPage[] = [];
      for (const n of wanted) {
        const page = await doc.getPage(n);
        try {
          const scale = renderScale(page.getViewport({ scale: 1 }), opts.dpi);
          const viewport = page.getViewport({ scale });
          const width = Math.max(1, Math.ceil(viewport.width));
          const height = Math.max(1, Math.ceil(viewport.height));
          const cc = newCanvas(doc, width, height);
          if ('error' in cc) return cc;
          try {
            await page.render({ canvasContext: cc.context, viewport }).promise;
            rendered.push({
              page: n,
              width,
              height,
              dpi: Math.round(scale * 72),
              mimeType: MIME[format],
              bytes: await encodeCanvas(cc.canvas, format),
            });
          } finally {
            doc.canvasFactory.destroy(cc);
          }
        } finally {
          // Drops the page's decoded images and fonts before the next page is decoded.
          page.cleanup();
        }
      }
      return { numPages: doc.numPages as number, rendered, missing };
    } catch (e) {
      return { error: classifyDrawError(e) };
    } finally {
      await doc.destroy().catch(() => {});
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Figures.

interface ImageOp {
  /** An object id, or the image (or mask) data pdfjs put straight into the operator list. */
  ref: unknown;
  source: ExtractedImage['source'];
  /** Every matrix the image is drawn under; the unit square under each is where it lands. */
  matrices: number[][];
}

/**
 * Every image-painting operator on the page, each with the transform in force where it is
 * painted. The walk keeps the same state pdfjs's canvas does: `save`/`restore` push and pop
 * the matrix, `transform` multiplies it, and a form XObject is a save plus its own matrix.
 * Nothing is drawn; this is bookkeeping enough to say where an image sits.
 */
function collectImageOps(
  list: { fnArray: number[]; argsArray: any[] },
  OPS: any,
  Util: any,
): ImageOp[] {
  const out: ImageOp[] = [];
  const stack: number[][] = [];
  let ctm: number[] = [...IDENTITY];
  const repeat = (
    base: number[],
    positions: ArrayLike<number>,
    sx: number,
    sy: number,
    kx = 0,
    ky = 0,
  ) => {
    const ms: number[][] = [];
    for (let k = 0; k + 1 < positions.length; k += 2) {
      ms.push(Util.transform(base, [sx, kx, ky, sy, positions[k], positions[k + 1]]));
    }
    return ms.length ? ms : [base];
  };
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i] ?? [];
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.transform:
        if (args.length >= 6) ctm = Util.transform(ctm, args);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(ctm);
        if (Array.isArray(args[0]) && args[0].length >= 6) ctm = Util.transform(ctm, args[0]);
        break;
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.paintImageXObject:
        out.push({ ref: args[0], source: 'xobject', matrices: [ctm] });
        break;
      case OPS.paintImageXObjectRepeat:
        out.push({
          ref: args[0],
          source: 'xobject',
          matrices: repeat(ctm, args[3] ?? [], args[1], args[2]),
        });
        break;
      case OPS.paintInlineImageXObject:
      case OPS.paintInlineImageXObjectGroup:
        out.push({ ref: args[0], source: 'inline', matrices: [ctm] });
        break;
      case OPS.paintImageMaskXObject:
        out.push({ ref: args[0], source: 'mask', matrices: [ctm] });
        break;
      case OPS.paintImageMaskXObjectGroup:
        for (const img of args[0] ?? []) {
          const m = Array.isArray(img?.transform) ? Util.transform(ctm, img.transform) : ctm;
          out.push({ ref: img, source: 'mask', matrices: [m] });
        }
        break;
      case OPS.paintImageMaskXObjectRepeat:
        out.push({
          ref: args[0],
          source: 'mask',
          matrices: repeat(ctm, args[5] ?? [], args[1], args[4], args[2] ?? 0, args[3] ?? 0),
        });
        break;
      default:
        break;
    }
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The decoded image behind an object id, once pdfjs has it; null if it never arrives. */
function waitForObject(page: any, id: string): Promise<any> {
  // Images shared across pages live in the document-wide store under a `g_` prefix.
  const store = id.startsWith('g_') ? page.commonObjs : page.objs;
  return withTimeout(new Promise<any>((resolve) => store.get(id, resolve)), OBJECT_WAIT_MS, null);
}

/**
 * The image an operator refers to, in whichever of pdfjs's three shapes it used: an id
 * into the object store, the image itself, or a mask whose `data` is an id.
 */
async function resolveImage(page: any, ref: unknown): Promise<any | null> {
  if (typeof ref === 'string') return waitForObject(page, ref);
  if (!ref || typeof ref !== 'object') return null;
  const own = ref as { data?: unknown; width?: number; height?: number };
  if (typeof own.data === 'string') {
    const full = await waitForObject(page, own.data);
    return full
      ? { ...full, width: full.width ?? own.width, height: full.height ?? own.height }
      : null;
  }
  return ref;
}

/** pdfjs's ImageKind values (src/shared/util.js). */
const GRAYSCALE_1BPP = 1;
const RGB_24BPP = 2;
const RGBA_32BPP = 3;

/**
 * The image as opaque RGBA, which is the one shape the canvas takes.
 *
 * pdfjs normalises the bit-packed kinds before handing them over, so a 0 bit is black in a
 * 1-bit grayscale image and "paint" in a stencil mask alike (its own canvas code maps both
 * the same way). A translucent image is flattened onto white, because white is the page
 * behind it and a JPEG has no alpha to keep: without this a figure whose background is a
 * soft mask, which is most vector-exported PNGs, comes back on black.
 */
export function toOpaqueRgba(
  img: { width: number; height: number; kind?: number; data: Uint8Array },
  mask: boolean,
): Uint8ClampedArray | null {
  const { width: w, height: h, data } = img;
  if (!(w > 0 && h > 0) || !data) return null;
  const n = w * h;
  const out = new Uint8ClampedArray(n * 4);
  if (mask || img.kind === GRAYSCALE_1BPP) {
    const rowBytes = (w + 7) >> 3;
    if (data.length < rowBytes * h) return null;
    let o = 0;
    for (let y = 0; y < h; y++) {
      const row = y * rowBytes;
      for (let x = 0; x < w; x++) {
        const v = (data[row + (x >> 3)]! >> (7 - (x & 7))) & 1 ? 255 : 0;
        out[o++] = v;
        out[o++] = v;
        out[o++] = v;
        out[o++] = 255;
      }
    }
    return out;
  }
  if (img.kind === RGB_24BPP) {
    if (data.length < n * 3) return null;
    for (let i = 0, o = 0; i < n * 3; i += 3) {
      out[o++] = data[i]!;
      out[o++] = data[i + 1]!;
      out[o++] = data[i + 2]!;
      out[o++] = 255;
    }
    return out;
  }
  if (img.kind === RGBA_32BPP) {
    if (data.length < n * 4) return null;
    for (let i = 0; i < n * 4; i += 4) {
      const a = data[i + 3]!;
      if (a === 255) {
        out[i] = data[i]!;
        out[i + 1] = data[i + 1]!;
        out[i + 2] = data[i + 2]!;
      } else {
        const bg = 255 - a;
        out[i] = (data[i]! * a + 255 * bg) / 255;
        out[i + 1] = (data[i + 1]! * a + 255 * bg) / 255;
        out[i + 2] = (data[i + 2]! * a + 255 * bg) / 255;
      }
      out[i + 3] = 255;
    }
    return out;
  }
  return null;
}

/** Same pixels, same picture: the key that folds a logo repeated on every page into one. */
function fingerprint(img: {
  width: number;
  height: number;
  kind?: number;
  data: Uint8Array;
}): string {
  const d = img.data;
  return createHash('sha1')
    .update(Buffer.from(d.buffer, d.byteOffset, d.byteLength))
    .update(`:${img.width}x${img.height}:${img.kind ?? 'mask'}`)
    .digest('hex');
}

/**
 * Where the unit square lands under each matrix, in the page's own viewport (points, origin
 * top left), as one box around all of them.
 */
function boundingBox(matrices: number[][], viewport: any, Util: any): ImageBox | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const m of matrices) {
    for (const [ux, uy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      const p = [ux, uy];
      Util.applyTransform(p, m);
      Util.applyTransform(p, viewport.transform);
      const [x, y] = p as [number, number];
      if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (!Number.isFinite(minX)) return undefined;
  const r = (v: number): number => Math.round(v * 10) / 10;
  return { x: r(minX), y: r(minY), width: r(maxX - minX), height: r(maxY - minY) };
}

async function encodeRgba(
  doc: any,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  format: ImageFormat | undefined,
  previewEdge: number | null | undefined,
): Promise<
  { mimeType: ImageMime; bytes: Uint8Array; preview?: ExtractedImage['preview'] } | PdfImageFailure
> {
  const cc = newCanvas(doc, width, height);
  if ('error' in cc) return cc;
  try {
    const imageData = cc.context.createImageData(width, height);
    imageData.data.set(rgba);
    cc.context.putImageData(imageData, 0, 0);
    const fmt: ImageFormat = format ?? (width * height > AUTO_JPEG_ABOVE_PX ? 'jpeg' : 'png');
    const bytes = await encodeCanvas(cc.canvas, fmt);
    let preview: ExtractedImage['preview'];
    const long = Math.max(width, height);
    if (previewEdge && long > previewEdge) {
      const s = previewEdge / long;
      const pw = Math.max(1, Math.round(width * s));
      const ph = Math.max(1, Math.round(height * s));
      const pc = newCanvas(doc, pw, ph);
      if ('error' in pc) return pc;
      try {
        pc.context.drawImage(cc.canvas, 0, 0, pw, ph);
        preview = {
          width: pw,
          height: ph,
          mimeType: 'image/jpeg',
          bytes: await encodeCanvas(pc.canvas, 'jpeg'),
        };
      } finally {
        doc.canvasFactory.destroy(pc);
      }
    }
    return { mimeType: MIME[fmt], bytes, preview };
  } finally {
    doc.canvasFactory.destroy(cc);
  }
}

/**
 * The raster images embedded in the requested pages, decoded and re-encoded, each with its
 * place on the page. Never throws; see `renderPdfPages`.
 *
 * What is NOT here, by nature rather than by omission: a figure drawn with vector
 * operators (most plots from matplotlib, TikZ, or a vector PDF export) is lines and text
 * in the content stream, not an image, and only rendering the page shows it. The result
 * says which requested pages held no image at all so the caller can say so too.
 */
export async function extractPdfImages(
  bytes: Uint8Array,
  opts: ExtractImagesOptions,
): Promise<ExtractImagesResult | PdfImageFailure> {
  return serialized(async () => {
    const opened = await openPdf(bytes, opts);
    if ('error' in opened) return opened;
    const { pdfjs, doc } = opened;
    const { OPS, Util } = pdfjs;
    const minSide = opts.minSide ?? DEFAULT_MIN_SIDE_PX;
    const maxImages = opts.maxImages ?? 16;
    const previewEdge = opts.previewEdge === undefined ? PREVIEW_EDGE_PX : opts.previewEdge;
    const seen = new Set<string>();
    const images: ExtractedImage[] = [];
    const skipped = { tiny: 0, duplicate: 0, undecodable: 0 };
    const pagesWithoutImages: number[] = [];
    const blankPages: number[] = [];
    const bitmapTextPages: ExtractImagesResult['bitmapTextPages'] = [];
    let truncated = false;
    try {
      const { wanted, missing } = splitPages(opts.pages, doc.numPages);
      pages: for (const n of wanted) {
        const page = await doc.getPage(n);
        try {
          const viewport = page.getViewport({ scale: 1 });
          const pageArea = viewport.width * viewport.height;
          let ops = collectImageOps(await page.getOperatorList(), OPS, Util);
          const masks = ops.filter((op) => op.source === 'mask').length;
          if (masks >= BITMAP_TEXT_MASKS) {
            bitmapTextPages.push({ page: n, masks });
            ops = ops.filter((op) => op.source !== 'mask');
            if (!ops.length) continue;
          }
          if (!ops.length) {
            pagesWithoutImages.push(n);
            const text = await page.getTextContent().catch(() => null);
            if (!text || !text.items?.length) blankPages.push(n);
            continue;
          }
          let index = 0;
          // A page whose only images are repeats of one already listed still HAS images;
          // it must not be reported as vector-only.
          let repeatsOnPage = 0;
          for (const op of ops) {
            const img = await resolveImage(page, op.ref);
            if (!img || !img.data || !(img.width > 0) || !(img.height > 0)) {
              skipped.undecodable++;
              continue;
            }
            if (img.width < minSide || img.height < minSide) {
              skipped.tiny++;
              continue;
            }
            const key = fingerprint(img);
            if (seen.has(key)) {
              skipped.duplicate++;
              repeatsOnPage++;
              continue;
            }
            if (images.length >= maxImages) {
              truncated = true;
              break pages;
            }
            const rgba = toOpaqueRgba(img, op.source === 'mask');
            if (!rgba) {
              skipped.undecodable++;
              continue;
            }
            seen.add(key);
            const encoded = await encodeRgba(
              doc,
              rgba,
              img.width,
              img.height,
              opts.format,
              previewEdge,
            );
            if ('error' in encoded) return encoded;
            const bbox = boundingBox(op.matrices, viewport, Util);
            images.push({
              page: n,
              index: ++index,
              width: img.width,
              height: img.height,
              mimeType: encoded.mimeType,
              bytes: encoded.bytes,
              source: op.source,
              bbox,
              coversPage: !!bbox && bbox.width * bbox.height >= COVERS_PAGE_FRACTION * pageArea,
              preview: encoded.preview,
            });
          }
          if (index === 0 && repeatsOnPage === 0) pagesWithoutImages.push(n);
        } finally {
          page.cleanup();
        }
      }
      return {
        numPages: doc.numPages as number,
        images,
        missing,
        skipped,
        pagesWithoutImages,
        blankPages,
        bitmapTextPages,
        truncated,
      };
    } catch (e) {
      return { error: classifyDrawError(e) };
    } finally {
      await doc.destroy().catch(() => {});
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Helpers the tool shares with its tests.

/** Characters a byte count occupies once base64-encoded, which is what travels in the JSON. */
export function base64Length(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

/**
 * Which items fit a base64 budget, first come first served: an item that does not fit is
 * left out and the next smaller one may still go in, so one oversized page cannot empty a
 * response of the pages after it.
 */
export function planInline<T>(
  items: T[],
  size: (item: T) => number,
  budgetBase64: number,
): { inline: Set<T>; used: number } {
  const inline = new Set<T>();
  let used = 0;
  for (const item of items) {
    const cost = base64Length(size(item));
    if (used + cost > budgetBase64) continue;
    inline.add(item);
    used += cost;
  }
  return { inline, used };
}

/** "3-5, 8" for [3,4,5,8]: the way pages are named back to the caller. */
export function describePages(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const spans: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    spans.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return spans.join(', ');
}
