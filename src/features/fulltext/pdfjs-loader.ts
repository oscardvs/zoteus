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
