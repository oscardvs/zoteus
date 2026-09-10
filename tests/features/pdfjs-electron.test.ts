import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Claude Desktop runs MCP servers inside Electron, where `process.type` is "utility".
 * pdfjs decides once, while its module body runs, whether it is under Node:
 *
 *   !(process.versions.electron && process.type && process.type !== "browser")
 *
 * so it concluded it was in a browser, evaluated the browser half of its own module body,
 * and threw "DOMMatrix is not defined" before reading a byte of any PDF. Every PDF feature
 * degraded at once on that channel: outline, exact page numbers for citation, and the
 * text-anchored highlight placement zotero_annotate depends on. Measured on Electron 44.2.0,
 * which ships Node 24.20.0, so neither the Node version nor the native ABI was ever the
 * cause: the same file read 14 pages and 9 outline entries under plain Node and failed to
 * import at all with process.type set.
 */
describe('pdfjs loads inside Electron', () => {
  const originalType = Object.getOwnPropertyDescriptor(process, 'type');
  const originalElectron = Object.getOwnPropertyDescriptor(process.versions, 'electron');

  afterEach(() => {
    if (originalType) Object.defineProperty(process, 'type', originalType);
    else delete (process as unknown as Record<string, unknown>).type;
    if (originalElectron) Object.defineProperty(process.versions, 'electron', originalElectron);
    else delete (process.versions as unknown as Record<string, unknown>).electron;
    vi.resetModules();
  });

  function pretendElectron() {
    Object.defineProperty(process.versions, 'electron', { value: '44.2.0', configurable: true });
    (process as unknown as Record<string, unknown>).type = 'utility';
  }

  it('loads under a non-browser Electron process type, and puts process.type back', async () => {
    pretendElectron();
    vi.resetModules();
    const { loadPdfjs, pdfjsLoadError } = await import('../../src/features/fulltext/pdfjs-loader.js');
    const pdfjs = await loadPdfjs();
    expect(pdfjsLoadError()).toBeNull();
    expect(pdfjs).toBeTruthy();
    expect(typeof pdfjs.getDocument).toBe('function');
    // The mask is held across the import only; nothing else may observe a changed value.
    expect((process as unknown as Record<string, unknown>).type).toBe('utility');
  });

  it('still loads normally when nothing is pretending to be Electron', async () => {
    vi.resetModules();
    const { loadPdfjs, pdfjsLoadError } = await import('../../src/features/fulltext/pdfjs-loader.js');
    expect(await loadPdfjs()).toBeTruthy();
    expect(pdfjsLoadError()).toBeNull();
  });

  it('names the real reason rather than blaming a missing dependency', async () => {
    vi.resetModules();
    const { pdfjsUnavailableReason } = await import('../../src/features/fulltext/pdfjs-loader.js');
    // With no failure recorded the wording is unchanged, so the message only sharpens when
    // there is something true to say.
    expect(pdfjsUnavailableReason()).toBe('the optional pdfjs-dist parser is missing');
  });
});
