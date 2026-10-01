import { describe, it, expect, vi } from 'vitest';
import importTool from '../../src/tools/import.js';
import styles from '../../src/tools/styles.js';

function makeCtx(overrides: any = {}): any {
  return {
    config: { translationServerUrl: 'http://127.0.0.1:1969' },
    capabilities: { cloud: { userID: 19552201 }, localApi: false },
    router: { defaultLibrary: () => ({ type: 'user', id: 19552201 }) },
    web: {
      writeItems: vi.fn(async () => ({ successful: [{ index: 0, key: 'NEW1' }], unchanged: [], failed: [], newLibraryVersion: 2 })),
    },
    styles: {
      resolveId: (n: string) => (n.toLowerCase() === 'apa 7th' ? 'apa' : n),
      fetchStyle: vi.fn(async () => '<style/>'),
    },
    translation: {
      isUp: vi.fn(async () => true),
      search: vi.fn(async () => [{ itemType: 'journalArticle', title: 'Resolved Paper' }]),
      web: vi.fn(async () => ({ items: [{ itemType: 'webpage', title: 'Page' }] })),
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...overrides,
  };
}

describe('zotero_import', () => {
  it('degrades gracefully when the translation-server is down', async () => {
    const ctx = makeCtx();
    ctx.translation.isUp = vi.fn(async () => false);
    // An ISBN, which only a translation-server resolves, so the answer names it as the cause.
    const res = await importTool.handler({ action: 'by_identifier', identifier: '978-3-16-148410-0' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/needs a Zotero translation-server/i);
    expect(ctx.translation.search).not.toHaveBeenCalled();
  });

  it('does not blame the translation-server for input that is not an identifier', async () => {
    // "10.1/x" is not a DOI: a DOI prefix has at least four digits. It used to be answered with
    // "Could not parse ... or start a translation-server", which named the wrong remedy.
    const ctx = makeCtx();
    ctx.translation.isUp = vi.fn(async () => false);
    const res = await importTool.handler({ action: 'by_identifier', identifier: '10.1/x' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/"10\.1\/x" is not an identifier Zoteus recognises/);
    expect(res.content[0].text).not.toMatch(/docker/i);
  });

  it('resolves an identifier without saving by default', async () => {
    const ctx = makeCtx();
    const res = await importTool.handler({ action: 'by_identifier', identifier: '10.1/x' }, ctx);
    expect(ctx.translation.search).toHaveBeenCalledWith('10.1/x');
    expect(res.structuredContent?.saved).toBe(false);
    expect((res.structuredContent?.items as any[])[0].title).toBe('Resolved Paper');
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
  });

  it('saves resolved items when save_to_library is set', async () => {
    const ctx = makeCtx();
    const res = await importTool.handler(
      { action: 'by_identifier', identifier: '10.1/x', save_to_library: true, collection_key: 'COLL' },
      ctx,
    );
    expect(ctx.web.writeItems).toHaveBeenCalled();
    const sent = ctx.web.writeItems.mock.calls[0][1];
    expect(sent[0].collections).toContain('COLL');
    expect((res.structuredContent?.created as string[])[0]).toBe('NEW1');
  });

  it('surfaces multiple-choice results from by_url', async () => {
    const ctx = makeCtx();
    ctx.translation.web = vi.fn(async () => ({ multiple: { url: 'u', session: 's', items: { a: 'Choice A' } } }));
    const res = await importTool.handler({ action: 'by_url', url: 'http://x' }, ctx);
    expect(res.structuredContent?.multiple).toBeTruthy();
  });
});

describe('zotero_styles', () => {
  it('lists common aliases', async () => {
    const res = await styles.handler({ action: 'list' }, makeCtx());
    expect(res.structuredContent?.common).toContain('ieee');
  });

  it('resolves a name and confirms availability', async () => {
    const ctx = makeCtx();
    const res = await styles.handler({ action: 'resolve', name: 'APA 7th' }, ctx);
    expect(res.structuredContent?.styleId).toBe('apa');
    expect(res.structuredContent?.available).toBe(true);
  });
});
