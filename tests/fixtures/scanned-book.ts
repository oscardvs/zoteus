import { buildPdf, type PdfBody } from './pdf.js';

/**
 * A scanned book: `count` pages, each one full-page JPEG and nothing else, the way a
 * document feeder produces them. `scannedPagePdf` in ./pdf.ts is the one-page version; OCR
 * needs several so a page cap, a page range and a page locator have something to be about.
 *
 * Every page shares one content stream and one image XObject, which is legal and keeps the
 * fixture small: what matters here is the page COUNT and that no page carries any text.
 */
export function scannedBookPdf(
  jpeg: Uint8Array,
  width: number,
  height: number,
  count: number,
  pagePoints = { width: 120, height: 160 },
): Uint8Array {
  const firstPage = 3;
  const contentObj = firstPage + count;
  const imageObj = contentObj + 1;
  const kids = Array.from({ length: count }, (_, i) => `${firstPage + i} 0 R`).join(' ');
  const bodies: PdfBody[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${count} >>`,
  ];
  for (let i = 0; i < count; i++) {
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pagePoints.width} ${pagePoints.height}] ` +
        `/Contents ${contentObj} 0 R /Resources << /XObject << /Scan ${imageObj} 0 R >> >> >>`,
    );
  }
  bodies.push({
    dict: '',
    stream: new TextEncoder().encode(`q ${pagePoints.width} 0 0 ${pagePoints.height} 0 0 cm /Scan Do Q`),
  });
  bodies.push({
    dict:
      `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
    stream: jpeg,
  });
  return buildPdf(bodies);
}
