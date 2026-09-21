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

/**
 * A scanned book whose text layer covers only `textPages`: what a scan looks like once
 * its cover page was OCR'd or a "Scanned by" stamp was laid over one page. Each page in
 * `textPages` draws "Text layer of page N" in Helvetica and nothing else; every other page
 * is the same full-page JPEG `scannedBookPdf` uses. The mixed case is the one a text
 * extractor cannot tell from a text PDF by "does any page have text", which is why it
 * needs a fixture of its own.
 */
export function mixedBookPdf(
  jpeg: Uint8Array,
  width: number,
  height: number,
  count: number,
  textPages: number[],
  pagePoints = { width: 120, height: 160 },
): Uint8Array {
  const enc = new TextEncoder();
  const firstPage = 3;
  const scanContentObj = firstPage + count;
  const imageObj = scanContentObj + 1;
  const fontObj = imageObj + 1;
  const firstTextContentObj = fontObj + 1;
  const kids = Array.from({ length: count }, (_, i) => `${firstPage + i} 0 R`).join(' ');
  const bodies: PdfBody[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${count} >>`,
  ];
  const textContents: PdfBody[] = [];
  for (let i = 0; i < count; i++) {
    const page = i + 1;
    const box = `/MediaBox [0 0 ${pagePoints.width} ${pagePoints.height}]`;
    if (textPages.includes(page)) {
      const contentObj = firstTextContentObj + textContents.length;
      bodies.push(
        `<< /Type /Page /Parent 2 0 R ${box} /Contents ${contentObj} 0 R ` +
          `/Resources << /Font << /F1 ${fontObj} 0 R >> >> >>`,
      );
      textContents.push({
        dict: '',
        stream: enc.encode(`BT /F1 8 Tf 8 ${Math.round(pagePoints.height / 2)} Td (Text layer of page ${page}) Tj ET`),
      });
    } else {
      bodies.push(
        `<< /Type /Page /Parent 2 0 R ${box} /Contents ${scanContentObj} 0 R ` +
          `/Resources << /XObject << /Scan ${imageObj} 0 R >> >> >>`,
      );
    }
  }
  bodies.push({
    dict: '',
    stream: enc.encode(`q ${pagePoints.width} 0 0 ${pagePoints.height} 0 0 cm /Scan Do Q`),
  });
  bodies.push({
    dict:
      `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
    stream: jpeg,
  });
  bodies.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  bodies.push(...textContents);
  return buildPdf(bodies);
}
