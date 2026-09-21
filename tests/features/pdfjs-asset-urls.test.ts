import { describe, it, expect } from 'vitest';
import { stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { pdfjsAssetUrls, pdfjsAssetUrlsFrom } from '../../src/features/fulltext/pdfjs-loader.js';

/**
 * pdfjs 5 accepts an asset directory only if the string ends with a forward slash: it checks
 * each one with `endsWith("/")` inside `getDocument`, before a byte of the file is parsed,
 * and throws `Invalid factory url: "..." must include trailing slash.` otherwise. Built with
 * `path.sep`, the directories ended in a backslash on Windows, so every zotero_pdf_images
 * call there failed with that message against a perfectly good file (#84, Windows, Zotero
 * 10.0.2, 1.20.0). pdfjs then reads `url + filename` with fs.promises.readFile, and Node's
 * fs on Windows accepts forward slashes, so the forward-slash form is right everywhere.
 */
const WIN_ENTRY =
  'C:\\Users\\ml\\AppData\\Local\\npm-cache\\_npx\\073f05bb9f008685\\node_modules\\pdfjs-dist\\legacy\\build\\pdf.mjs';
const WIN_PKG = 'C:/Users/ml/AppData/Local/npm-cache/_npx/073f05bb9f008685/node_modules/pdfjs-dist';

describe('pdfjsAssetUrlsFrom', () => {
  it('gives pdfjs forward-slash directories ending in "/" from a Windows entry path (#84)', () => {
    const urls = pdfjsAssetUrlsFrom(WIN_ENTRY, win32);
    expect(urls).toEqual({
      standardFontDataUrl: `${WIN_PKG}/standard_fonts/`,
      cMapUrl: `${WIN_PKG}/cmaps/`,
      cMapPacked: true,
      wasmUrl: `${WIN_PKG}/wasm/`,
      iccUrl: `${WIN_PKG}/iccs/`,
    });
    for (const value of Object.values(urls)) {
      if (typeof value !== 'string') continue;
      expect(value).not.toContain('\\');
      expect(value.endsWith('/')).toBe(true);
    }
  });

  it('is unchanged on POSIX, where the separator already was a forward slash', () => {
    const urls = pdfjsAssetUrlsFrom('/opt/app/node_modules/pdfjs-dist/legacy/build/pdf.mjs', posix);
    expect(urls).toEqual({
      standardFontDataUrl: '/opt/app/node_modules/pdfjs-dist/standard_fonts/',
      cMapUrl: '/opt/app/node_modules/pdfjs-dist/cmaps/',
      cMapPacked: true,
      wasmUrl: '/opt/app/node_modules/pdfjs-dist/wasm/',
      iccUrl: '/opt/app/node_modules/pdfjs-dist/iccs/',
    });
  });
});

describe('pdfjsAssetUrls', () => {
  it('points at directories that exist in this checkout, each ending in "/"', async () => {
    const urls = pdfjsAssetUrls();
    expect(urls).toBeDefined();
    const { cMapPacked, ...dirs } = urls!;
    expect(cMapPacked).toBe(true);
    for (const dir of Object.values(dirs)) {
      expect(dir.endsWith('/')).toBe(true);
      expect((await stat(dir)).isDirectory()).toBe(true);
    }
  });
});
