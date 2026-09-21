import { buildPdf, type PdfBody } from './pdf.js';

/**
 * Multi-page text PDFs for the metadata-recovery tests, built with the same `buildPdf`
 * helper the image tests use so there is one PDF builder in the suite.
 *
 * Object numbers are positional, which is what `buildPdf` documents: 1 is the catalog, 2 the
 * page tree, then a (page, contents) pair per page, and the font last.
 */

const enc = new TextEncoder();
const HELVETICA = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

/** A PDF string literal escapes its own delimiters and the backslash. */
const pdfString = (s: string): string => s.replace(/([\\()])/g, '\\$1');

/**
 * One page per entry, each holding its lines of Helvetica text. An entry with no lines
 * produces a page that draws nothing, which is what a scanned page with no text layer looks
 * like to a text extractor.
 */
export function textPagesPdf(pages: string[][]): Uint8Array {
  const pageCount = pages.length;
  const fontObject = 2 + pageCount * 2 + 1;
  const kids = pages.map((_lines, i) => `${3 + i * 2} 0 R`).join(' ');
  const bodies: PdfBody[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`,
  ];
  pages.forEach((lines, i) => {
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R ` +
        `/Resources << /Font << /F1 ${fontObject} 0 R >> >> >>`,
    );
    const ops = lines
      .map((line, row) => `BT /F1 11 Tf 40 ${740 - row * 18} Td (${pdfString(line)}) Tj ET`)
      .join('\n');
    bodies.push({ dict: '', stream: enc.encode(ops) });
  });
  bodies.push(HELVETICA);
  return buildPdf(bodies);
}

/** A title page that states its DOI the way a publisher's template does. */
export const DOI_PDF_DOI = '10.1103/PhysRev.28.1049';

export function doiTitlePagePdf(): Uint8Array {
  return textPagesPdf([
    [
      'An Undulatory Theory of the Mechanics of Atoms',
      'Erwin Schrodinger, Institute of Physics',
      'Published online 12 December 1926',
      `https://doi.org/${DOI_PDF_DOI}`,
    ],
    ['1 Introduction', 'The body of the paper begins here.'],
  ]);
}

/** A title page with no identifier anywhere on it. */
export function noIdentifierPdf(): Uint8Array {
  return textPagesPdf([
    ['A Paper With No Identifier', 'Anonymous', 'Submitted for review, 2026'],
    ['1 Introduction', 'Still no identifier on this page either.'],
  ]);
}

/** An arXiv stamp, which sits on the title page but is worth finding on a later one too. */
export function arxivStampPdf(): Uint8Array {
  return textPagesPdf([
    ['A Preprint About Something', 'Ada Lovelace'],
    ['arXiv:2201.00001v1 [cs.SE] 3 Jan 2022'],
  ]);
}

/** Pages that draw nothing: a scan, as far as a text extractor is concerned. */
export function noTextLayerPdf(): Uint8Array {
  return textPagesPdf([[], []]);
}
