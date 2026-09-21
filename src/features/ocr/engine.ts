/**
 * The OCR engine, which Zoteus does not ship.
 *
 * `tesseract.js` is deliberately NOT a dependency of this package, not even an optional
 * one. `package.json` declares exactly one optional dependency, `pdfjs-dist`, and that one
 * earns its place because four features sit on the default path through it. An OCR engine
 * does not: the wasm core and one language pack together are tens of megabytes that every
 * npm install, every desktop bundle and every Docker image would carry for a feature most
 * libraries never need, including the 1 GB hosted machine.
 *
 * So it is loaded the way `@huggingface/transformers` is (see src/features/search/
 * embeddings.ts): a runtime `import()` of a specifier resolved from node_modules, or from
 * the directory `ZOTEUS_OCR_PATH` names for an install that lives outside a bundle. The
 * absence of the package is a normal, reportable state rather than a crash, and the report
 * names the package, the install line and the setting, because "OCR unavailable" with no
 * cause is the message this pattern exists to avoid.
 *
 * The engine is brought up and torn down per call, unlike the embedder's worker, which is
 * cached for the life of the process. Two reasons: a tesseract worker holds a wasm heap
 * measured in hundreds of megabytes for a language it may never be asked about again, on a
 * machine where one PDF render already peaks at a third of the RAM; and a live worker is a
 * handle that keeps a stdio server from exiting when its client goes away. Worker start-up
 * costs a second or so, against seconds per page of recognition, so the trade is cheap.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The npm package that provides OCR (optional, not bundled; see above). */
export const OCR_MODULE = 'tesseract.js';

/** One rendered page, handed to the engine as a picture to read. */
export interface OcrPageImage {
  /** 1-based page of the document this is a picture of. */
  page: number;
  bytes: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * Something that turns a picture of a page into text. The real one wraps tesseract.js;
 * tests inject their own, which is what keeps the page-mapping path testable without wasm,
 * a language download or a network.
 */
export interface OcrEngine {
  /** What to call it in a notice, e.g. "tesseract.js (eng)". */
  readonly name: string;
  /** Text read off one page. Returns '' for a page it could not read; never throws. */
  readPage(image: OcrPageImage): Promise<string>;
  /** Release the worker and its heap. Called exactly once, and never throws. */
  close(): Promise<void>;
}

/**
 * Directories to resolve {@link OCR_MODULE} from when ZOTEUS_OCR_PATH is set. Node's own
 * walk-up covers a `node_modules` directory and a package directory; the `lib` candidate
 * additionally accepts an npm prefix such as `/usr`, where globals live in
 * `/usr/lib/node_modules`. Same two readings ZOTEUS_TRANSFORMERS_PATH accepts.
 */
function overrideRoots(dir: string): string[] {
  return [dir, join(dir, 'lib')];
}

/**
 * The OCR module's entry point WITHOUT executing it: a side-effect-free probe of whether
 * OCR can load at all, so the answer to "can this scan be read?" costs nothing when it is
 * no. Returns the specifier to import, or null when the package is not reachable.
 */
export function resolveOcrModule(ocrPath?: string): string | null {
  const dir = ocrPath?.trim();
  if (dir) {
    for (const root of overrideRoots(dir)) {
      try {
        // A non-existent package.json is fine: createRequire only needs a base path to
        // start the node_modules walk-up from.
        const req = createRequire(pathToFileURL(join(root, 'package.json')));
        return pathToFileURL(req.resolve(OCR_MODULE)).href;
      } catch {
        // Try the next reading of the configured path.
      }
    }
    return null;
  }
  try {
    return import.meta.resolve(OCR_MODULE);
  } catch {
    return null;
  }
}

/** Where the resolver was told to look, in the words of the setting that sent it there. */
function searchedHint(ocrPath?: string): string {
  const dir = ocrPath?.trim();
  if (!dir) return '';
  return (
    ` ZOTEUS_OCR_PATH is set to "${dir}", and ${OCR_MODULE} resolves from neither it nor ` +
    `"${join(dir, 'lib')}".`
  );
}

/**
 * What to install and where, for "OCR was asked for and the engine is not here".
 *
 * Install-channel aware for the same reason the embedder's hint is: a desktop bundle has no
 * `npm i` step to have skipped, and the extension folder is replaced on every update, so
 * the package has to live somewhere else and be pointed at.
 */
export function missingOcrHint(config: { dist?: string; ocrPath?: string } = {}): string {
  const bundled = config.dist === 'mcpb' || config.dist === 'dxt';
  const cause = `${OCR_MODULE} is not installed.`;
  const searched = searchedHint(config.ocrPath);
  const shipping =
    `Zoteus does not ship an OCR engine: the wasm core and one language pack are tens of ` +
    `megabytes that every install would carry for a feature most libraries never need.`;
  if (bundled) {
    return (
      `${cause}${searched} ${shipping} Desktop-extension bundles cannot carry it either, and the ` +
      `bundle folder is replaced on every update, so install it somewhere of its own: ` +
      `\`mkdir -p ~/.zoteus-deps && cd ~/.zoteus-deps && npm init -y && npm i ${OCR_MODULE}\`, then ` +
      `set ZOTEUS_OCR_PATH to that folder's node_modules and ZOTEUS_OCR=auto. Until then, ` +
      `zotero_pdf_images mode:"pages" renders the pages as images you can read yourself.`
    );
  }
  return (
    `${cause}${searched} ${shipping} Install it with \`npm i ${OCR_MODULE}\`, or point ZOTEUS_OCR_PATH ` +
    `at a directory that already has it, and set ZOTEUS_OCR=auto. Until then, zotero_pdf_images ` +
    `mode:"pages" renders the pages as images you can read yourself.`
  );
}

/** Whether OCR is both switched on and able to load here. Costs nothing when it is not. */
export function ocrAvailable(config: { ocr?: string; ocrPath?: string }): boolean {
  return config.ocr === 'auto' && resolveOcrModule(config.ocrPath) !== null;
}

export interface LoadOcrEngineOptions {
  /** Tesseract language codes, `+`-separated: "eng", "eng+deu". */
  langs: string;
  /** ZOTEUS_OCR_PATH, when the install cannot see the package itself. */
  ocrPath?: string;
  /**
   * Where language data is kept between runs. Pinned under the Zoteus data directory for
   * the same reason the embedder's model cache is: deleting the data directory is supposed
   * to be the whole uninstall, and tesseract.js's default is the process's working
   * directory, which on a desktop install is somebody else's folder.
   */
  cacheDir?: string;
}

/** Why loading failed, kept separate so the caller can say "missing" rather than "broken". */
export class OcrEngineUnavailable extends Error {}

/**
 * Bring an engine up, or throw {@link OcrEngineUnavailable} with a message that names the
 * remedy. The caller turns that into the tool's answer; nothing here logs or retries.
 *
 * Targets tesseract.js v5 and newer, whose `createWorker(langs, oem, options)` loads the
 * language itself. A v4 worker still exposes `loadLanguage`/`initialize`, which v5 removed,
 * so those are called when they are there rather than assuming a version.
 */
export async function loadOcrEngine(opts: LoadOcrEngineOptions): Promise<OcrEngine> {
  const specifier = resolveOcrModule(opts.ocrPath);
  if (!specifier) throw new OcrEngineUnavailable(missingOcrHint({ ocrPath: opts.ocrPath }));
  let mod: any;
  try {
    mod = await import(specifier);
  } catch (e) {
    throw new OcrEngineUnavailable(
      `${OCR_MODULE} is installed but could not be loaded (${e instanceof Error ? e.message : String(e)}).`,
    );
  }
  const createWorker = mod?.createWorker ?? mod?.default?.createWorker;
  if (typeof createWorker !== 'function') {
    throw new OcrEngineUnavailable(
      `${OCR_MODULE} loaded but exposes no createWorker(); Zoteus needs tesseract.js v5 or newer.`,
    );
  }
  const langs = opts.langs.trim() || 'eng';
  let worker: any;
  try {
    worker = await createWorker(langs, 1, opts.cacheDir ? { cachePath: opts.cacheDir } : {});
    // v4 and earlier hand back a worker that has not loaded its language yet, and say so by
    // still having the two methods v5 deleted.
    if (typeof worker?.loadLanguage === 'function') {
      await worker.load?.();
      await worker.loadLanguage(langs);
      await worker.initialize?.(langs);
    }
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    throw new OcrEngineUnavailable(
      `${OCR_MODULE} could not start a worker for language "${langs}" (${cause}). The language data is ` +
        `downloaded once, so this also fails when the machine is offline and the pack is not cached yet; ` +
        `ZOTEUS_OCR_LANGS names the languages, and each is a separate download.`,
    );
  }
  return {
    name: `${OCR_MODULE} (${langs})`,
    async readPage(image: OcrPageImage): Promise<string> {
      try {
        const out = await worker.recognize(
          Buffer.from(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength),
        );
        const text = out?.data?.text;
        return typeof text === 'string' ? text : '';
      } catch {
        // One page that will not read costs that page, not the call.
        return '';
      }
    },
    async close(): Promise<void> {
      try {
        await worker.terminate?.();
      } catch {
        // Nothing useful to do about a worker that will not stop; the process outlives it.
      }
    },
  };
}
