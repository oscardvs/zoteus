/**
 * Small PDFs built in memory for the image tests, with a real cross-reference table so
 * pdfjs opens them without repairing anything.
 *
 * Every builder returns the bytes of a complete file. Object numbers are positional: the
 * first body is object 1 (always the catalog), the second is object 2, and so on, which is
 * enough for files this small and keeps each fixture readable as the PDF it is.
 */

const enc = new TextEncoder();

export type PdfBody = string | { dict: string; stream: Uint8Array };

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A complete PDF from object bodies; streams get their `/Length` written for them. */
export function buildPdf(bodies: PdfBody[]): Uint8Array {
  const parts: Uint8Array[] = [enc.encode('%PDF-1.4\n%binary\n')];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  const push = (chunk: Uint8Array) => {
    parts.push(chunk);
    length += chunk.length;
  };
  bodies.forEach((body, i) => {
    offsets.push(length);
    push(enc.encode(`${i + 1} 0 obj\n`));
    if (typeof body === 'string') {
      push(enc.encode(`${body}\nendobj\n`));
    } else {
      push(enc.encode(`<< ${body.dict} /Length ${body.stream.length} >>\nstream\n`));
      push(body.stream);
      push(enc.encode('\nendstream\nendobj\n'));
    }
  });
  const startxref = length;
  let xref = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) xref += `${String(o).padStart(10, '0')} 00000 n \n`;
  xref += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  push(enc.encode(xref));
  return concat(parts);
}

const content = (text: string): PdfBody => ({ dict: '', stream: enc.encode(text) });
const HELVETICA = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';

/** A 64x48 RGB gradient: red grows left to right, green top to bottom, blue is fixed. */
export function gradientRgb(width = 64, height = 48): Uint8Array {
  const px = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      px[i] = Math.round((255 * x) / (width - 1));
      px[i + 1] = Math.round((255 * y) / (height - 1));
      px[i + 2] = 96;
    }
  }
  return px;
}

function rgbImage(width: number, height: number, pixels: Uint8Array): PdfBody {
  return {
    dict: `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8`,
    stream: pixels,
  };
}

/** One 200x200 page with "Hello PDF" in Helvetica (a standard font pdfjs must supply itself). */
export function textPagePdf(): Uint8Array {
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    content('BT /F1 24 Tf 20 100 Td (Hello PDF) Tj ET'),
    HELVETICA,
  ]);
}

/**
 * Two 300x300 pages carrying one real figure and the things a figure extractor must not
 * mistake for one.
 *
 * Page 1 draws the 64x48 gradient at 120x90 points with its top-left corner 40 points in
 * and 60 down (so the expected box is x 40, y 60, w 120, h 90), draws the SAME XObject a
 * second time lower right (a repeat), draws an 8x8 red icon (tiny), and prints a caption.
 * Page 2 draws the gradient once more (a repeat across pages) under a line of text.
 */
export function figurePdf(): Uint8Array {
  const red = new Uint8Array(8 * 8 * 3);
  for (let i = 0; i < red.length; i += 3) red[i] = 220;
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 8 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R /Im2 6 0 R >> /Font << /F1 7 0 R >> >> >>',
    content(
      [
        'q 120 0 0 90 40 150 cm /Im1 Do Q',
        'q 120 0 0 90 160 20 cm /Im1 Do Q',
        'q 8 0 0 8 10 10 cm /Im2 Do Q',
        'BT /F1 12 Tf 20 280 Td (Figure 1) Tj ET',
      ].join('\n'),
    ),
    rgbImage(64, 48, gradientRgb()),
    rgbImage(8, 8, red),
    HELVETICA,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 9 0 R /Resources << /XObject << /Im1 5 0 R >> /Font << /F1 7 0 R >> >> >>',
    content(
      ['q 200 0 0 150 50 100 cm /Im1 Do Q', 'BT /F1 12 Tf 20 280 Td (Page two) Tj ET'].join('\n'),
    ),
  ]);
}

/** One page whose only content is a JPEG drawn edge to edge: what a scanner produces. */
export function scannedPagePdf(
  jpeg: Uint8Array,
  width: number,
  height: number,
  pagePoints = { width: 612, height: 792 },
): Uint8Array {
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pagePoints.width} ${pagePoints.height}] /Contents 4 0 R /Resources << /XObject << /Scan 5 0 R >> >> >>`,
    content(`q ${pagePoints.width} 0 0 ${pagePoints.height} 0 0 cm /Scan Do Q`),
    {
      dict: `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
      stream: jpeg,
    },
  ]);
}

/**
 * One page that paints the same 40x40 stencil mask `count` times in a grid, the way a PDF
 * whose text was scanned letter by letter paints its glyphs, with no text layer at all.
 */
export function bitmapTextPdf(count = 250): Uint8Array {
  const rowBytes = 5;
  // All bits set (nothing painted) except the third byte of every row: a vertical stroke.
  const glyph = new Uint8Array(rowBytes * 40).fill(0xff);
  for (let y = 0; y < 40; y++) glyph[y * rowBytes + 2] = 0x00;
  const ops: string[] = [];
  for (let i = 0; i < count; i++) {
    const x = 20 + (i % 25) * 22;
    const y = 760 - Math.floor(i / 25) * 22;
    ops.push(`q 0 0 0 rg 8 0 0 8 ${x} ${y} cm /G Do Q`);
  }
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /G 5 0 R >> >> >>',
    content(ops.join('\n')),
    {
      dict: '/Type /XObject /Subtype /Image /Width 40 /Height 40 /ImageMask true /BitsPerComponent 1',
      stream: glyph,
    },
  ]);
}

/**
 * One page with a 40x40 stencil mask (a checkerboard of 8x8 cells, 1 bit per pixel) drawn
 * at 100x100 points, and a 40x40 8-bit grayscale inline image beside it: the two shapes of
 * raster content that are not image XObjects.
 */
export function maskAndInlinePdf(): Uint8Array {
  const rowBytes = 5;
  const mask = new Uint8Array(rowBytes * 40);
  for (let y = 0; y < 40; y++) {
    for (let b = 0; b < rowBytes; b++) {
      // Cells alternate every 8 pixels, which is one byte, so a row is 0x00/0xFF bytes.
      const cellOn = ((y >> 3) + b) % 2 === 0;
      mask[y * rowBytes + b] = cellOn ? 0x00 : 0xff;
    }
  }
  const gray = new Uint8Array(40 * 40);
  for (let i = 0; i < gray.length; i++) gray[i] = (i % 40) * 6;
  const inline = concat([
    enc.encode('q 100 0 0 100 150 50 cm\nBI /W 40 /H 40 /CS /G /BPC 8 ID '),
    gray,
    enc.encode('\nEI Q'),
  ]);
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /XObject << /M1 5 0 R >> >> >>',
    {
      dict: '',
      stream: concat([enc.encode('q 0 0 0 rg 100 0 0 100 20 50 cm /M1 Do Q\n'), inline]),
    },
    {
      dict: '/Type /XObject /Subtype /Image /Width 40 /Height 40 /ImageMask true /BitsPerComponent 1',
      stream: mask,
    },
  ]);
}
