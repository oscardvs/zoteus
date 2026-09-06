import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import indexTool from '../../src/tools/index-tool.js';
import semanticSearch from '../../src/tools/semantic-search.js';
import { LibraryRouter } from '../../src/router/library-router.js';
import { loadConfig } from '../../src/config.js';
import { MemorySearchIndex, type SearchIndex } from '../../src/features/search/index-manager.js';
import { FakeEmbeddingProvider } from '../../src/features/search/embeddings.js';

const sampleItems = [
  { key: 'A', data: { itemType: 'journalArticle', title: 'Neural networks', abstractNote: 'deep learning' } },
  { key: 'B', data: { itemType: 'book', title: 'Gardening', abstractNote: 'tomatoes' } },
];

function makeCtx(search: SearchIndex): any {
  const web = {
    listItems: vi.fn(async () => ({ data: sampleItems, totalResults: 2, lastModifiedVersion: 1 })),
  };
  // No desktop app in reach here, so the router pages the cloud Web API.
  const config = loadConfig({ ZOTEUS_LOCAL: 'off' } as any);
  const capabilities = {
    cloud: { userID: 19552201, username: 'oscardvs', access: {} } as any,
    localApi: false,
    localGroupIds: [],
  };
  return {
    config: { ...config, dataDir: join(tmpdir(), `zoteus-idx-${process.pid}`) },
    capabilities,
    router: new LibraryRouter({ config, capabilities, web: web as any }),
    web,
    search,
    searchIndexPath: join(tmpdir(), `zoteus-idx-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

/** Poll the status action until the background build leaves the "building" state. */
async function pollUntilSettled(ctx: any, attempts = 100): Promise<any> {
  let status;
  for (let i = 0; i < attempts; i++) {
    status = await indexTool.handler({ action: 'status' }, ctx);
    if (status.structuredContent?.state !== 'building') return status;
    await new Promise((r) => setTimeout(r, 5));
  }
  return status;
}

describe('zotero_index', () => {
  it('builds the index from the library and reports status', async () => {
    const search = new MemorySearchIndex({ embedder: new FakeEmbeddingProvider() });
    const ctx = makeCtx(search);
    const res = await indexTool.handler({ action: 'build' }, ctx);
    expect(ctx.web.listItems).toHaveBeenCalled();
    // build is asynchronous now: it starts a background job and returns immediately.
    expect(res.structuredContent?.state).toBe('building');
    const status = await pollUntilSettled(ctx);
    expect(status.structuredContent?.state).toBe('done');
    expect(status.structuredContent?.items).toBe(2);
  });
});

describe('zotero_semantic_search', () => {
  it('does not auto-build an empty index while it is paused', async () => {
    const search = new MemorySearchIndex({ embedder: null });
    await search.setPaused(true);
    const ctx = makeCtx(search);
    const res = await semanticSearch.handler({ q: 'anything' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.structuredContent?.paused).toBe(true);
    expect(res.structuredContent?.autoBuild).toBe(false);
    expect(res.content[0].text).toMatch(/paused.*resume/i);
    expect(ctx.web.listItems).not.toHaveBeenCalled();
  });

  it('auto-builds on first use: empty index starts a background build and says so', async () => {
    const ctx = makeCtx(new MemorySearchIndex({ embedder: null }));
    const res = await semanticSearch.handler({ q: 'anything' }, ctx);
    expect(res.isError).toBe(true); // not a search result — actionable first-use guidance
    expect(res.structuredContent?.autoBuild).toBe(true);
    expect(res.content[0].text).toMatch(/build was started automatically|background build/i);
    expect(ctx.web.listItems).toHaveBeenCalled();
    // once the kicked-off background build settles, the same query returns real hits
    await pollUntilSettled(ctx);
    const retry = await semanticSearch.handler({ q: 'anything' }, ctx);
    expect(retry.isError).toBeUndefined();
    expect(Array.isArray(retry.structuredContent?.hits)).toBe(true);
  });

  it('reports progress instead of double-building when a build is already running', async () => {
    const ctx = makeCtx(new MemorySearchIndex({ embedder: null }));
    await indexTool.handler({ action: 'build' }, ctx); // start one first
    const res = await semanticSearch.handler({ q: 'anything' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/being built right now|status/i);
    await pollUntilSettled(ctx);
  });

  it('returns a plain actionable error (and no build) with auto_build:false', async () => {
    const ctx = makeCtx(new MemorySearchIndex({ embedder: null }));
    const res = await semanticSearch.handler({ q: 'anything', auto_build: false }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/zotero_index/);
    expect(res.content[0].text).toMatch(/build/);
    expect(ctx.web.listItems).not.toHaveBeenCalled();
  });

  it('returns ranked hits once built', async () => {
    const search = new MemorySearchIndex({ embedder: new FakeEmbeddingProvider() });
    await search.build(sampleItems);
    const res = await semanticSearch.handler({ q: 'deep learning', limit: 1 }, makeCtx(search));
    expect(res.isError).toBeUndefined();
    expect((res.structuredContent?.hits as any[])[0].itemKey).toBe('A');
  });
});
