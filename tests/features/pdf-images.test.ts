import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  renderPdfPages,
  extractPdfImages,
  renderScale,
  toOpaqueRgba,
  planInline,
  base64Length,
  describePages,
  canvasPoolStats,
  DEFAULT_LONG_EDGE_PX,
  MAX_DPI,
  MAX_EDGE_PX,
} from '../../src/features/fulltext/pdf-images.js';
import {
  bitmapTextPdf,
  figurePdf,
  maskAndInlinePdf,
  scannedPagePdf,
  textPagePdf,
} from '../fixtures/pdf.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const startsWith = (bytes: Uint8Array, magic: number[]) => magic.every((b, i) => bytes[i] === b);

/**
 * Decode an encoded image back to pixels through the same canvas pdfjs draws with, so a
 * test can look at what was drawn rather than trust a byte count. Skips (returns null)
 * where the optional canvas package is absent, in which case rendering itself has already
 * failed with its own clear error and those tests return early.
 */
async function pixels(
  bytes: Uint8Array,
): Promise<{ at: (x: number, y: number) => number[] } | null> {
  let canvas: any;
  try {
    canvas = await import('@napi-rs/canvas');
  } catch {
    return null;
  }
  const img = await canvas.loadImage(Buffer.from(bytes));
  const c = canvas.createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;
  return {
    at: (x, y) => Array.from(data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)),
  };
}

const isWhite = (rgb: number[]) => rgb.every((c) => c >= 250);

describe('renderScale', () => {
  it('fits a letter page to the default long edge when no dpi is asked', () => {
    const s = renderScale({ width: 612, height: 792 });
    expect(Math.round(792 * s)).toBe(DEFAULT_LONG_EDGE_PX);
  });
  it('honours an explicit dpi below the caps', () => {
    expect(renderScale({ width: 612, height: 792 }, 144)).toBeCloseTo(2, 5);
  });
  it('never exceeds MAX_DPI, even for a tiny page', () => {
    expect(renderScale({ width: 100, height: 100 })).toBeCloseTo(MAX_DPI / 72, 5);
  });
  it('never exceeds MAX_EDGE_PX on the long edge, whatever the dpi', () => {
    const s = renderScale({ width: 2000, height: 3000 }, 300);
    expect(3000 * s).toBeLessThanOrEqual(MAX_EDGE_PX + 1e-6);
  });
});

describe('renderPdfPages', () => {
  it('draws a text page as a JPEG of the expected size, with the text actually on it', async () => {
    const res = await renderPdfPages(textPagePdf(), { pages: [1], dpi: 144 });
    if ('error' in res && res.error.kind === 'unavailable') return; // pdfjs-dist is optional
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    expect(res.numPages).toBe(1);
    expect(res.missing).toEqual([]);
    const [page] = res.rendered;
    expect(page).toMatchObject({
      page: 1,
      width: 400,
      height: 400,
      dpi: 144,
      mimeType: 'image/jpeg',
    });
    expect(startsWith(page!.bytes, JPEG_MAGIC)).toBe(true);
    const px = await pixels(page!.bytes);
    if (!px) return;
    // Helvetica is not embedded: pdfjs had to load its own copy of the standard font to
    // draw anything. The glyphs sit around y=100pt from the bottom, x from 20pt.
    let inked = 0;
    for (let x = 40; x < 320; x += 2)
      for (let y = 170; y < 210; y += 2) if (!isWhite(px.at(x, y))) inked++;
    expect(inked).toBeGreaterThan(20);
    expect(isWhite(px.at(5, 5))).toBe(true);
  });

  it('draws PNG on request and puts the figure where the page puts it', async () => {
    const res = await renderPdfPages(figurePdf(), { pages: [1], dpi: 72, format: 'png' });
    if ('error' in res) return;
    const [page] = res.rendered;
    expect(page).toMatchObject({ width: 300, height: 300, mimeType: 'image/png' });
    expect(startsWith(page!.bytes, PNG_MAGIC)).toBe(true);
    const px = await pixels(page!.bytes);
    if (!px) return;
    // The gradient occupies x 40..160, y 60..150 (top-left origin); its bottom-right is
    // red+green heavy, its top-left dark. Right of both copies the page is white.
    expect(isWhite(px.at(100, 100))).toBe(false);
    expect(isWhite(px.at(290, 150))).toBe(true);
    const [r0, g0] = px.at(42, 62);
    const [r1, g1] = px.at(158, 148);
    expect(r1).toBeGreaterThan(r0! + 100);
    expect(g1).toBeGreaterThan(g0! + 100);
  });

  it('caps the long edge at MAX_EDGE_PX and reports the dpi actually used', async () => {
    const res = await renderPdfPages(textPagePdf(), { pages: [1] });
    if ('error' in res) return;
    const [page] = res.rendered;
    // A 200pt page fitted to 1568px would be 564 dpi; MAX_DPI wins.
    expect(page!.dpi).toBe(MAX_DPI);
    expect(Math.max(page!.width, page!.height)).toBeLessThanOrEqual(MAX_EDGE_PX);
  });

  it('renders the pages that exist and names the ones that do not', async () => {
    const res = await renderPdfPages(figurePdf(), { pages: [2, 3, 9], dpi: 36 });
    if ('error' in res) return;
    expect(res.rendered.map((p) => p.page)).toEqual([2]);
    expect(res.missing).toEqual([3, 9]);
  });

  it('refuses a file above the byte cap without opening it', async () => {
    const res = await renderPdfPages(figurePdf(), { pages: [1], maxBytes: 100 });
    expect(res).toMatchObject({ error: { kind: 'too-large' } });
  });

  it('reports bytes that are not a PDF as invalid, never throws', async () => {
    const res = await renderPdfPages(new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4]), {
      pages: [1],
    }).catch(() => 'THREW');
    expect(res).not.toBe('THREW');
    expect((res as any).error?.kind).toMatch(/invalid|unavailable/);
  });

  it('reports a truncated PDF as invalid (or as having no pages), never throws', async () => {
    const whole = figurePdf();
    const res = await renderPdfPages(whole.slice(0, 140), { pages: [1] }).catch(() => 'THREW');
    expect(res).not.toBe('THREW');
    if ('error' in (res as any)) expect((res as any).error.kind).toMatch(/invalid|unavailable/);
    else expect((res as any).rendered).toEqual([]);
  });

  it('opens a PDF whose encryption only carries an owner password (the publisher case)', async () => {
    const bytes = new Uint8Array(await readFile(join(FIXTURES, 'encrypted-owner-only.pdf')));
    const res = await renderPdfPages(bytes, { pages: [1], dpi: 72 });
    if ('error' in res && res.error.kind === 'unavailable') return;
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    expect(res.rendered[0]).toMatchObject({ width: 200, height: 200 });
  });

  it('refuses a PDF that needs a user password, and says that is why', async () => {
    const bytes = new Uint8Array(await readFile(join(FIXTURES, 'encrypted-user-password.pdf')));
    const res = await renderPdfPages(bytes, { pages: [1] });
    if ('error' in res && res.error.kind === 'unavailable') return;
    expect(res).toMatchObject({ error: { kind: 'password' } });
    expect((res as any).error.message).toMatch(/password/);
  });
});

describe('extractPdfImages', () => {
  it('returns the real figure once, with its size and place, and skips the icon and the repeats', async () => {
    const res = await extractPdfImages(figurePdf(), { pages: [1, 2] });
    if ('error' in res && res.error.kind === 'unavailable') return;
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    expect(res.numPages).toBe(2);
    expect(res.images).toHaveLength(1);
    const [fig] = res.images;
    expect(fig).toMatchObject({
      page: 1,
      index: 1,
      width: 64,
      height: 48,
      mimeType: 'image/png',
      source: 'xobject',
      coversPage: false,
    });
    expect(fig!.bbox).toEqual({ x: 40, y: 60, width: 120, height: 90 });
    expect(startsWith(fig!.bytes, PNG_MAGIC)).toBe(true);
    // Same XObject drawn twice on page 1 and once on page 2: two repeats folded.
    expect(res.skipped).toEqual({ tiny: 1, duplicate: 2, undecodable: 0 });
    // Page 2 does hold a raster image (a repeat), so it is not "without images".
    expect(res.pagesWithoutImages).toEqual([]);
    expect(res.blankPages).toEqual([]);
    expect(res.truncated).toBe(false);
    const px = await pixels(fig!.bytes);
    if (!px) return;
    // Native pixels, not the page: 64 wide, red rising along x, green along y.
    expect(px.at(63, 0)[0]).toBeGreaterThan(240);
    expect(px.at(0, 47)[1]).toBeGreaterThan(240);
    expect(px.at(0, 0)[2]).toBeGreaterThan(80);
  });

  it('honours min_size, so the icon is a figure when asked for', async () => {
    const res = await extractPdfImages(figurePdf(), { pages: [1], minSide: 4 });
    if ('error' in res) return;
    expect(res.images.map((i) => [i.width, i.height])).toEqual([
      [64, 48],
      [8, 8],
    ]);
    expect(res.skipped.tiny).toBe(0);
  });

  it('stops at maxImages and says so', async () => {
    const res = await extractPdfImages(figurePdf(), { pages: [1], minSide: 4, maxImages: 1 });
    if ('error' in res) return;
    expect(res.images).toHaveLength(1);
    expect(res.truncated).toBe(true);
  });

  it('reads stencil masks and inline images too', async () => {
    const res = await extractPdfImages(maskAndInlinePdf(), { pages: [1] });
    if ('error' in res && res.error.kind === 'unavailable') return;
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    const sources = res.images.map((i) => i.source).sort();
    expect(sources).toEqual(['inline', 'mask']);
    for (const img of res.images) expect([img.width, img.height]).toEqual([40, 40]);
    const mask = res.images.find((i) => i.source === 'mask')!;
    expect(mask.bbox).toEqual({ x: 20, y: 50, width: 100, height: 100 });
    const px = await pixels(mask.bytes);
    if (!px) return;
    // Checkerboard of 8x8 cells: the first cell is painted (black), the next is not.
    expect(isWhite(px.at(2, 2))).toBe(false);
    expect(isWhite(px.at(10, 2))).toBe(true);
  });

  it('reports text painted as hundreds of stencil masks as bitmap text, not as figures', async () => {
    const res = await extractPdfImages(bitmapTextPdf(250), { pages: [1], minSide: 4 });
    if ('error' in res && res.error.kind === 'unavailable') return;
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    expect(res.images).toEqual([]);
    expect(res.bitmapTextPages).toEqual([{ page: 1, masks: 250 }]);
    // Not "without images" either: the page is full of them, they are just letters.
    expect(res.pagesWithoutImages).toEqual([]);
    expect(res.blankPages).toEqual([]);
  });

  it('keeps the canvas pool bounded across renders of a mask-heavy page', async () => {
    const before = canvasPoolStats();
    for (let i = 0; i < 3; i++) {
      const res = await renderPdfPages(bitmapTextPdf(600), { pages: [1], dpi: 72 });
      if ('error' in res) return;
      expect(res.rendered[0]!.width).toBe(612);
    }
    const after = canvasPoolStats();
    expect(after.canvases).toBeLessThanOrEqual(8192);
    expect(after.pixels).toBeLessThanOrEqual(16_000_000);
    // Three identical renders must not grow the pool three times over: sizes repeat.
    expect(after.canvases - before.canvases).toBeLessThan(200);
  });

  it('round-trips a scanned page: one full-page image, flagged as covering the page', async () => {
    // Make the "scan" by rendering a real page, then wrap that JPEG as the whole content
    // of a new PDF, which is exactly what a scanner's software produces.
    const rendered = await renderPdfPages(textPagePdf(), { pages: [1], dpi: 144 });
    if ('error' in rendered) return;
    const scan = rendered.rendered[0]!;
    const pdf = scannedPagePdf(scan.bytes, scan.width, scan.height, { width: 200, height: 200 });
    const res = await extractPdfImages(pdf, { pages: [1], previewEdge: 100 });
    expect('error' in res).toBe(false);
    if ('error' in res) return;
    expect(res.images).toHaveLength(1);
    const [img] = res.images;
    expect(img).toMatchObject({
      page: 1,
      width: 400,
      height: 400,
      coversPage: true,
      source: 'xobject',
    });
    expect(img!.bbox).toEqual({ x: 0, y: 0, width: 200, height: 200 });
    // Longer than the preview edge asked for, so a smaller JPEG rides along.
    expect(img!.preview).toMatchObject({ width: 100, height: 100, mimeType: 'image/jpeg' });
    expect(startsWith(img!.preview!.bytes, JPEG_MAGIC)).toBe(true);
  });

  it('forces JPEG when asked, whatever the size', async () => {
    const res = await extractPdfImages(figurePdf(), { pages: [1], format: 'jpeg' });
    if ('error' in res) return;
    expect(res.images[0]!.mimeType).toBe('image/jpeg');
    expect(startsWith(res.images[0]!.bytes, JPEG_MAGIC)).toBe(true);
  });

  it('tells a text-only page apart from a blank one, and names pages past the end', async () => {
    const res = await extractPdfImages(textPagePdf(), { pages: [1, 4] });
    if ('error' in res) return;
    expect(res.images).toEqual([]);
    expect(res.pagesWithoutImages).toEqual([1]);
    expect(res.blankPages).toEqual([]); // it has text
    expect(res.missing).toEqual([4]);
  });

  it('fails the same way the renderer does on bad input', async () => {
    expect(await extractPdfImages(figurePdf(), { pages: [1], maxBytes: 10 })).toMatchObject({
      error: { kind: 'too-large' },
    });
    const bad = await extractPdfImages(new Uint8Array([1, 2, 3]), { pages: [1] }).catch(
      () => 'THREW',
    );
    expect(bad).not.toBe('THREW');
    expect((bad as any).error?.kind).toMatch(/invalid|unavailable/);
  });
});

describe('toOpaqueRgba', () => {
  it('expands 1-bit rows (0 is black, rows padded to a byte)', () => {
    // width 10: two bytes a row; first row 1000000000, second row all ones.
    const out = toOpaqueRgba(
      { width: 10, height: 2, kind: 1, data: new Uint8Array([0x80, 0x00, 0xff, 0xc0]) },
      false,
    )!;
    expect(Array.from(out.slice(0, 4))).toEqual([255, 255, 255, 255]); // bit 1: white
    expect(Array.from(out.slice(4, 8))).toEqual([0, 0, 0, 255]); // bit 0: black
    expect(Array.from(out.slice(10 * 4, 10 * 4 + 4))).toEqual([255, 255, 255, 255]);
    expect(out.length).toBe(10 * 2 * 4);
  });
  it('treats a stencil mask the same way pdfjs does: 0 bits are painted', () => {
    // 0x0f is 0000 1111 from the leftmost pixel: four painted, then four left alone.
    const out = toOpaqueRgba({ width: 8, height: 1, data: new Uint8Array([0x0f]) }, true)!;
    expect(out[0]).toBe(0); // bit 0: painted, black
    expect(out[7 * 4]).toBe(255); // bit 1: not painted, white
  });
  it('expands RGB and flattens RGBA onto white', () => {
    const rgb = toOpaqueRgba(
      { width: 1, height: 1, kind: 2, data: new Uint8Array([10, 20, 30]) },
      false,
    )!;
    expect(Array.from(rgb)).toEqual([10, 20, 30, 255]);
    const rgba = toOpaqueRgba(
      { width: 1, height: 1, kind: 3, data: new Uint8Array([0, 0, 0, 0]) },
      false,
    )!;
    expect(Array.from(rgba)).toEqual([255, 255, 255, 255]); // fully transparent shows the page
    const half = toOpaqueRgba(
      { width: 1, height: 1, kind: 3, data: new Uint8Array([0, 0, 0, 128]) },
      false,
    )!;
    expect(half[0]).toBeGreaterThan(120);
    expect(half[0]).toBeLessThan(135);
  });
  it('refuses data that is too short for its declared size', () => {
    expect(
      toOpaqueRgba({ width: 4, height: 4, kind: 2, data: new Uint8Array(3) }, false),
    ).toBeNull();
  });
});

describe('planInline and friends', () => {
  it('counts base64 growth, not raw bytes', () => {
    expect(base64Length(3)).toBe(4);
    expect(base64Length(4)).toBe(8);
    expect(base64Length(0)).toBe(0);
  });
  it('keeps what fits, skips what does not, and keeps going after a skip', () => {
    const items = [{ n: 300 }, { n: 900 }, { n: 300 }];
    const plan = planInline(items, (i) => i.n, base64Length(300) * 2 + 1);
    expect([...plan.inline]).toEqual([items[0], items[2]]);
    expect(plan.used).toBe(base64Length(300) * 2);
  });
  it('names page lists as spans', () => {
    expect(describePages([3, 4, 5, 8])).toBe('3-5, 8');
    expect(describePages([2])).toBe('2');
    expect(describePages([5, 1, 2])).toBe('1-2, 5');
  });
});
