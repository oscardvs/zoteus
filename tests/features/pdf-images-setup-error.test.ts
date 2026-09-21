import { describe, it, expect, vi } from 'vitest';
import { renderPdfPages } from '../../src/features/fulltext/pdf-images.js';
import { textPagePdf } from '../fixtures/pdf.js';

// The loader stays real (pdfjs and the canvas load exactly as in production); only the asset
// directories are replaced by the strings 1.20.0 produced on Windows, so the real pdfjs raises
// the real error the reporter saw (#84) and the classification is what is under test.
vi.mock('../../src/features/fulltext/pdfjs-loader.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/features/fulltext/pdfjs-loader.js')>();
  const pkg =
    'C:\\Users\\ml\\AppData\\Local\\npm-cache\\_npx\\073f05bb9f008685\\node_modules\\pdfjs-dist\\';
  return {
    ...real,
    pdfjsAssetUrls: () => ({
      standardFontDataUrl: `${pkg}standard_fonts\\`,
      cMapUrl: `${pkg}cmaps\\`,
      cMapPacked: true,
      wasmUrl: `${pkg}wasm\\`,
      iccUrl: `${pkg}iccs\\`,
    }),
  };
});

describe('a pdfjs configuration fault is not blamed on the file (#84)', () => {
  it('classifies "Invalid factory url" as a Zoteus setup problem, not as an unreadable PDF', async () => {
    const res = await renderPdfPages(textPagePdf(), { pages: [1], dpi: 72 });
    if ('error' in res && res.error.kind === 'unavailable') return; // pdfjs-dist is optional
    if ('error' in res && res.error.kind === 'canvas') return; // @napi-rs/canvas is optional
    expect(res).toMatchObject({ error: { kind: 'setup' } });
    const message = (res as { error: { message: string } }).error.message;
    expect(message).toMatch(/Invalid factory url/);
    expect(message).toMatch(/must include trailing slash/);
    expect(message).not.toMatch(/readable PDF/);
  });
});
