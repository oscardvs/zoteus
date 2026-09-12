/**
 * The one place `pdfjs-dist` is imported, because loading it correctly takes a workaround
 * and four copies of that would drift.
 *
 * pdfjs decides ONCE, while its module body runs, whether it is running under Node:
 *
 *   isNodeJS = typeof process === "object" && process + "" === "[object process]" &&
 *              !process.versions.nw &&
 *              !(process.versions.electron && process.type && process.type !== "browser")
 *
 * Claude Desktop runs this server inside Electron, where `process.type` is "utility", so
 * that last clause makes pdfjs conclude it is in a browser. It then evaluates the browser
 * half of its own module body, which touches `DOMMatrix`, and the import throws
 * "DOMMatrix is not defined" before a single byte of any PDF is read.
 *
 * Measured on this machine against Electron 44.2.0 (which ships Node 24.20.0, so neither
 * the Node version nor the native ABI was ever the problem): the same 1.8 MB PDF, the same
 * installed copy of pdfjs 5.6.205, read 14 pages and 9 outline entries under plain Node and
 * failed to import at all with `process.type = "utility"`. Masking `process.type` for the
 * duration of the import restores the Node path and the same file reads normally again.
 *
 * The mask is held only across the import, which is the entire window that matters, since
 * `isNodeJS` is captured then and never read again. The original property descriptor is put
 * back in a `finally`, so nothing else in the process observes a changed `process.type`
 * afterwards. A descriptor that refuses to be removed is left alone rather than forced:
 * deleting a non-configurable property throws in strict mode, and a thrown loader would be
 * a worse failure than the degraded one it is trying to prevent.
 */

import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';

/** Why the last load failed, so callers can say it instead of guessing. */
let loadError: string | null = null;
let cached: Promise<unknown | null> | null = null;

/** The reason `loadPdfjs()` last returned null, or null when it has not failed. */
export function pdfjsLoadError(): string | null {
  return loadError;
}

/** pdfjs, or null when it cannot be loaded here. Never throws. */
export async function loadPdfjs(): Promise<any | null> {
  cached ??= (async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'type');
    const masked = descriptor?.configurable === true;
    if (masked) delete (process as unknown as Record<string, unknown>).type;
    try {
      const mod = await import('pdfjs-dist/legacy/build/pdf.mjs' as any);
      loadError = null;
      return mod;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
      if (masked && descriptor) Object.defineProperty(process, 'type', descriptor);
    }
  })();
  return cached as Promise<any | null>;
}

/**
 * Where pdfjs finds the data files it ships beside its code, for the calls that draw.
 *
 * Text extraction never needed these: it reads the glyph mapping out of the fonts embedded
 * in the file. Rendering does. A PDF that uses one of the standard 14 fonts without
 * embedding it (older LaTeX output, most scanned-and-OCRed books) needs pdfjs's own copy of
 * that font or the text draws as nothing; a JPEG 2000 or JBIG2 image needs the decoders
 * pdfjs 5 ships as wasm; a CJK font needs its CMap. pdfjs 5 reads all of them off disk under
 * Node when told the directories, and it insists on a trailing separator.
 *
 * Resolved from the module the loader imports, not from `pdfjs-dist/package.json`: that is
 * the one path known to be reachable through the package's exports map, and the bundle
 * keeps the same layout as an npm install. `undefined` when pdfjs is not installed, in which
 * case the caller has already failed for a better reason.
 */
export function pdfjsAssetUrls():
  | { standardFontDataUrl: string; cMapUrl: string; cMapPacked: true; wasmUrl: string; iccUrl: string }
  | undefined {
  try {
    const entry = createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.mjs');
    // <pkg>/legacy/build/pdf.mjs -> <pkg>
    const root = join(dirname(entry), '..', '..');
    const dir = (name: string): string => `${join(root, name)}${sep}`;
    return {
      standardFontDataUrl: dir('standard_fonts'),
      cMapUrl: dir('cmaps'),
      cMapPacked: true,
      wasmUrl: dir('wasm'),
      iccUrl: dir('iccs'),
    };
  } catch {
    return undefined;
  }
}

let canvasCached: { mod: any | null; error: string | null } | null = null;

/**
 * The canvas pdfjs draws through under Node (`@napi-rs/canvas`), or null when it is not
 * installed. Resolved from pdfjs's own location rather than from Zoteus, so the copy Zoteus
 * hands pdfjs is the one pdfjs would have loaded itself: it is pdfjs's optional dependency,
 * not ours, and two copies of a native module in one process is a bug waiting to happen.
 */
export function loadCanvas(): any | null {
  canvasCached ??= (() => {
    try {
      const entry = createRequire(import.meta.url).resolve('pdfjs-dist/legacy/build/pdf.mjs');
      return { mod: createRequire(entry)('@napi-rs/canvas'), error: null };
    } catch (e) {
      return { mod: null, error: e instanceof Error ? e.message : String(e) };
    }
  })();
  return canvasCached.mod;
}

/** Why `loadCanvas()` returned null, or null when it has not. */
export function canvasLoadError(): string | null {
  return canvasCached?.error ?? null;
}

/**
 * The parser half of a degradation message, naming the real reason when there is one.
 *
 * "the optional pdfjs-dist parser is missing" was the only thing these messages could say,
 * and it was wrong in the case that actually happened: inside Claude Desktop the parser is
 * installed and it is the environment that stops it loading. A message that names a cause
 * the user cannot act on, and that is not even the cause, costs more than saying nothing.
 */
export function pdfjsUnavailableReason(): string {
  const e = pdfjsLoadError();
  return e
    ? `the pdfjs-dist parser could not be loaded in this environment (${e})`
    : 'the optional pdfjs-dist parser is missing';
}
