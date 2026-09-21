/**
 * Why a PDF returned no text, named precisely enough for the reader to do something.
 *
 * Until now `zotero_get_fulltext` answered every unreadable PDF with one sentence that
 * covered four different situations at once: "a scanned or corrupt file, an unsupported
 * format, or the parser is missing". Those have different remedies, and the commonest of
 * them, a scan, has three. This module tells them apart, and it does so unconditionally:
 * no OCR engine, no configuration and no network are involved in answering the question.
 *
 * It reads the file's own object dictionaries instead of rendering anything, because the
 * question is cheap to answer that way and rendering a scan is the expensive thing the
 * answer exists to justify. An image is a stream object, a stream object is never packed
 * into a compressed object stream, and encryption covers strings and stream DATA rather
 * than dictionary keys. So `/Subtype /Image` and the `/Filter` beside it are visible in
 * the raw bytes of every PDF that holds one.
 *
 * What it deliberately does NOT claim: where an image sits on the page. Geometry lives in
 * the content stream, which is compressed, so this cannot say "the image covers the page"
 * the way `zotero_pdf_images` can, because that renders the page and this does not. It
 * reports what the file holds, and says "which is what a scanner produces" rather than
 * "this image is the page".
 */

import { describePages } from '../fulltext/pdf-images.js';

/** What the file turned out to be, once it was established that it has no text. */
export type ScanVerdict =
  /** Pages stored as images in a codec a scanner writes (JPEG, JBIG2, CCITT G4, JPEG 2000). */
  | 'scanned'
  /** Text painted as 1-bit stencil glyphs: a scan stored letter by letter, no text layer. */
  | 'glyph-bitmaps'
  /** Embedded images and no text, in a codec that does not by itself name a scanner. */
  | 'images'
  /** No text and no images: empty, corrupt, or text drawn as vector outlines. */
  | 'empty';

export interface ScanReport {
  /** Pages the document holds. */
  pages: number;
  /** 1-based pages carrying at least one non-space character of text. */
  pagesWithText: number[];
  /**
   * 1-based pages carrying no text at all: the pages OCR would read. A scan whose cover
   * page was OCR'd, or that carries a "Scanned by" stamp, has a page or two in the first
   * list and the rest here, and this is the list a reader acts on.
   */
  pagesWithoutText: number[];
  /** True when not one page carries a character of text. */
  noTextLayer: boolean;
  verdict: ScanVerdict;
  /** Image XObjects declared anywhere in the file. */
  imageObjects: number;
  /** Of those, stencil masks (`/ImageMask true`: 1-bit, drawn in the fill colour). */
  maskObjects: number;
  /** Image codecs found, in PDF's own words; `DCTDecode` is JPEG. */
  codecs: string[];
  /**
   * Pixels in the largest image the file declares (`/Width` x `/Height`), or 0 when no
   * image dictionary could be read. This is the one number that says whether pdfjs will
   * refuse to decode a page's image and render the page blank instead, which is what a 600
   * dpi scan does on a server whose decode ceiling is 16.8 megapixels.
   */
  largestImagePixels: number;
}

/** Filters that only ever carry a raster image, and that scanner software writes. */
const SCAN_CODECS = ['DCTDecode', 'JPXDecode', 'CCITTFaxDecode', 'JBIG2Decode'] as const;

/** Plain-English names for the codecs, since `/DCTDecode` means nothing to a reader. */
const CODEC_NAMES: Record<string, string> = {
  DCTDecode: 'JPEG',
  JPXDecode: 'JPEG 2000',
  CCITTFaxDecode: 'CCITT fax',
  JBIG2Decode: 'JBIG2',
};

/** Occurrences of an ASCII needle in raw bytes, without decoding the file to a string. */
function countAscii(bytes: Uint8Array, needle: string): number {
  const n = needle.length;
  if (!n || bytes.byteLength < n) return 0;
  const first = needle.charCodeAt(0);
  let found = 0;
  outer: for (let i = 0; i + n <= bytes.byteLength; i++) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < n; j++) if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    found++;
    i += n - 1;
  }
  return found;
}

/**
 * Both spellings of a PDF name pair. A writer may put whitespace between the key and its
 * value or run them together, and both are the same dictionary entry.
 */
function countPair(bytes: Uint8Array, key: string, value: string): number {
  return countAscii(bytes, `/${key} /${value}`) + countAscii(bytes, `/${key}/${value}`);
}

/** Every offset an ASCII needle occurs at, without decoding the file to a string. */
function findAscii(bytes: Uint8Array, needle: string, out: number[] = []): number[] {
  const n = needle.length;
  if (!n) return out;
  const first = needle.charCodeAt(0);
  outer: for (let i = 0; i + n <= bytes.byteLength; i++) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < n; j++) if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    out.push(i);
    i += n - 1;
  }
  return out;
}

/** How far either side of `/Subtype /Image` its `/Width` and `/Height` are looked for. */
const IMAGE_DICT_WINDOW = 512;

/**
 * The integer value of the `/<key>` entry nearest `anchor` within `IMAGE_DICT_WINDOW`
 * bytes of it, or 0 when there is none.
 *
 * Nearest rather than largest on purpose: a file can pack several image dictionaries into
 * one window, and pairing one object's width with another's height would invent a picture
 * that is not in the file. Being wrong here means telling somebody their scan is too big to
 * decode when it is not, so the reading stays conservative.
 */
function numberNear(bytes: Uint8Array, key: string, anchor: number): number {
  const start = Math.max(0, anchor - IMAGE_DICT_WINDOW);
  const slice = bytes.subarray(start, Math.min(bytes.byteLength, anchor + IMAGE_DICT_WINDOW));
  const offset = anchor - start;
  let best = 0;
  let bestGap = Infinity;
  for (const at of findAscii(slice, `/${key}`)) {
    let i = at + key.length + 1;
    while (i < slice.byteLength && (slice[i] === 0x20 || slice[i] === 0x0a || slice[i] === 0x0d || slice[i] === 0x09))
      i++;
    let value = 0;
    let digits = 0;
    while (i < slice.byteLength && slice[i]! >= 0x30 && slice[i]! <= 0x39) {
      value = value * 10 + (slice[i]! - 0x30);
      digits++;
      i++;
    }
    // A `/Width` written as a reference (`/Width 7 0 R`) cannot be read from here; a plain
    // number can, and every scanner writes a plain one.
    const gap = Math.abs(at - offset);
    if (digits && gap < bestGap) {
      bestGap = gap;
      best = value;
    }
  }
  return best;
}

/**
 * Pixels in the largest image the file declares.
 *
 * Read from the raw bytes for the same reason the rest of this module is: an image is a
 * stream object, so its dictionary is never packed into a compressed object stream and
 * never encrypted, which means `/Subtype /Image` and the `/Width` and `/Height` beside it
 * are visible without opening the document. Nothing is decoded and no page is rendered.
 *
 * Deliberately a ceiling rather than a per-page figure: it answers "could an image in this
 * file be above the decoder's limit", which is the question a blank OCR result raises, and
 * it cannot say which page the image sits on because geometry lives in the content stream.
 */
function largestImagePixels(bytes: Uint8Array): number {
  const at = findAscii(bytes, '/Subtype /Image');
  findAscii(bytes, '/Subtype/Image', at);
  let largest = 0;
  for (const offset of at) {
    const pixels = numberNear(bytes, 'Width', offset) * numberNear(bytes, 'Height', offset);
    if (pixels > largest) largest = pixels;
  }
  return largest;
}

/**
 * What this PDF is, given its bytes and the per-page text already extracted from it.
 *
 * `pageTexts` is exactly what `extractPdfPages` returns: one entry per page, in page
 * order. Passing it in rather than re-extracting keeps this free at the one call site that
 * matters, where the extraction has already happened and produced nothing.
 */
export function inspectScan(bytes: Uint8Array, pageTexts: string[]): ScanReport {
  const pagesWithText: number[] = [];
  const pagesWithoutText: number[] = [];
  pageTexts.forEach((text, i) => {
    (text.trim() ? pagesWithText : pagesWithoutText).push(i + 1);
  });
  const imageObjects = countPair(bytes, 'Subtype', 'Image');
  const maskObjects = countAscii(bytes, '/ImageMask');
  const codecs = SCAN_CODECS.filter((c) => countAscii(bytes, `/${c}`) > 0);
  let verdict: ScanVerdict;
  if (codecs.length) verdict = 'scanned';
  else if (maskObjects > 0 && maskObjects >= imageObjects) verdict = 'glyph-bitmaps';
  else if (imageObjects > 0) verdict = 'images';
  else verdict = 'empty';
  return {
    pages: pageTexts.length,
    pagesWithText,
    pagesWithoutText,
    noTextLayer: pagesWithText.length === 0,
    verdict,
    imageObjects,
    maskObjects,
    codecs: [...codecs],
    largestImagePixels: imageObjects ? largestImagePixels(bytes) : 0,
  };
}

/** "pages 2, 4-9", or "page 3": a list of pages the way the rest of the tool names them. */
export function namePages(pages: number[]): string {
  return `${pages.length === 1 ? 'page' : 'pages'} ${describePages(pages)}`;
}

/** The same, starting a sentence. */
export function namePagesCapitalised(pages: number[]): string {
  const named = namePages(pages);
  return named.charAt(0).toUpperCase() + named.slice(1);
}

/**
 * The finding, in one or two sentences: how many pages, how many of them hold text, and
 * what the file stores instead. No remedy here; the caller owns that half, because what
 * can be offered depends on whether an OCR engine is present.
 *
 * A file with a text layer on SOME pages gets a different, more careful sentence. The
 * verdict a no-text file earns ("it is a scan, not a corrupt file") rests on the whole
 * file holding nothing but images; a file with text on page 1 and JPEGs elsewhere may be
 * a scan whose cover page was OCR'd, or a text PDF with a picture for a cover and a JPEG
 * figure on page 4, and the object dictionaries cannot tell those apart. So that sentence
 * names the pages that lack a text layer, says what the file holds, and claims no more.
 */
export function describeScan(report: ScanReport): string {
  const { pages, pagesWithText, pagesWithoutText, imageObjects, maskObjects, codecs } = report;
  const count = `${pages} page${pages === 1 ? '' : 's'}`;
  const codecNames = codecs.map((c) => CODEC_NAMES[c] ?? c).join(' and ');
  if (pagesWithText.length) {
    const lack =
      `${namePagesCapitalised(pagesWithoutText)} of ${count} ` +
      `${pagesWithoutText.length === 1 ? 'carries' : 'carry'} no text layer ` +
      `(only ${namePages(pagesWithText)} ${pagesWithText.length === 1 ? 'does' : 'do'})`;
    switch (report.verdict) {
      case 'scanned':
        return (
          `${lack}; the file holds ${codecNames} images, which is what a scanner writes, so those pages ` +
          `may be pictures of text, or blank.`
        );
      case 'glyph-bitmaps':
        return (
          `${lack}; the file paints text as ${maskObjects} 1-bit bitmap glyph${maskObjects === 1 ? '' : 's'}, ` +
          `a scan stored letter by letter, so those pages may be text with no text layer at all.`
        );
      case 'images':
        return (
          `${lack}; the file holds ${imageObjects} embedded image${imageObjects === 1 ? '' : 's'}, so those ` +
          `pages may be pictures of text, or blank.`
        );
      case 'empty':
      default:
        return (
          `${lack}; the file holds no embedded images, so those pages are blank, or their text was ` +
          `converted to vector outlines, which print-ready PDFs do and which no text extractor can read.`
        );
    }
  }
  const textPart = `not one of its ${count} carries a text layer`;
  switch (report.verdict) {
    case 'scanned':
      return (
        `This PDF has no text to extract: ${textPart}, and the file stores its pages as ` +
        `${codecNames} images, which is what a scanner produces. It is a scan, not a corrupt file.`
      );
    case 'glyph-bitmaps':
      return (
        `This PDF has no text to extract: ${textPart}, and it paints its text as ${maskObjects} ` +
        `1-bit bitmap glyph${maskObjects === 1 ? '' : 's'} instead: a scan stored letter by letter, ` +
        `with no text layer at all. It is a scan, not a corrupt file.`
      );
    case 'images':
      return (
        `This PDF has no text to extract: ${textPart}, and the file holds ${imageObjects} ` +
        `embedded image${imageObjects === 1 ? '' : 's'} and nothing else, which is what a scan looks ` +
        `like. It is very unlikely to be corrupt.`
      );
    case 'empty':
    default:
      return (
        `This PDF has no text to extract: ${textPart}, and it holds no embedded images either. ` +
        `That is either an empty or corrupt file, or one whose text was converted to vector ` +
        `outlines, which print-ready PDFs do and which no text extractor can read.`
      );
  }
}
