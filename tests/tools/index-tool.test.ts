import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import indexTool from '../../src/tools/index-tool.js';
import { LibraryRouter } from '../../src/router/library-router.js';
import { loadConfig } from '../../src/config.js';
import { MemorySearchIndex, type SearchIndex } from '../../src/features/search/index-manager.js';
import { FakeEmbeddingProvider } from '../../src/features/search/embeddings.js';
import type { EmbeddingProvider } from '../../src/features/search/embeddings.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Generate `n` library items. */
function makeLibrary(n: number): any[] {
  return Array.from({ length: n }, (_, i) => ({
    key: `K${i}`,
    data: { itemType: 'journalArticle', title: `Item ${i}`, abstractNote: `abstract body ${i}` },
  }));
}

/**
 * Paginating Web API mock mirroring listItems({ limit, start, top }): slices the
 * library 100-at-a-time so the background build actually pages through it.
 */
function makeWeb(library: any[], attachments: any[] = [], fulltext: Record<string, string> = {}) {
  return {
    listItems: vi.fn(async (_lib: any, query: { limit?: number; start?: number; itemType?: string; top?: boolean }) => {
      const source = query.itemType === 'attachment' ? attachments : library;
      const limit = query.limit ?? 100;
      const start = query.start ?? 0;
      return { data: source.slice(start, start + limit), totalResults: source.length, lastModifiedVersion: 1 };
    }),
    fullTextSince: vi.fn(async () => Object.fromEntries(Object.keys(fulltext).map((k, i) => [k, i + 1]))),
    getFullText: vi.fn(async (_lib: any, key: string) => (fulltext[key] ? { content: fulltext[key] } : null)),
  };
}

/**
 * Context around a real LibraryRouter with no desktop app in reach, so the build pages
 * the cloud Web API. Local-first routing has its own coverage in
 * tests/features/search-build-routing.test.ts.
 */
function makeCtx(search: SearchIndex, library: any[], fullext?: { attachments: any[]; text: Record<string, string> }): any {
  const web = makeWeb(library, fullext?.attachments, fullext?.text);
  const config = loadConfig({ ZOTEUS_LOCAL: 'off' } as any);
  const capabilities = {
    cloud: { userID: 19552201, username: 'oscardvs', access: {} } as any,
    localApi: false,
    localGroupIds: [],
  };
  return {
    config: { ...config, dataDir: join(tmpdir(), `zoteus-index-tool-${process.pid}`) },
    capabilities,
    router: new LibraryRouter({ config, capabilities, web: web as any }),
    web,
    search,
    searchIndexPath: join(tmpdir(), `zoteus-index-tool-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
    logger: silentLogger,
  };
}

/** An embedder that blocks each embed() call until opened — lets us pause a build. */
function gatedEmbedder() {
  const gates: Array<() => void> = [];
  let open = false;
  const provider: EmbeddingProvider = {
    name: 'gated',
    embed: vi.fn(async (texts: string[]) => {
      if (!open) await new Promise<void>((resolve) => gates.push(resolve));
      return texts.map(() => [1, 0, 0]);
    }),
  };
  return {
    provider,
    /** Open the gate: resolves all paused embeds and lets future ones through. */
    open: () => {
      open = true;
      for (const g of gates.splice(0)) g();
    },
    pending: () => gates.length,
    calls: () => (provider.embed as any).mock?.calls?.length ?? 0,
  };
}

async function pollStatus(ctx: any, attempts = 200): Promise<any> {
  let status: any;
  for (let i = 0; i < attempts; i++) {
    status = await indexTool.handler({ action: 'status' }, ctx);
    if (status.structuredContent?.state !== 'building') return status;
    await new Promise((r) => setTimeout(r, 2));
  }
  return status;
}

describe('zotero_index async build', () => {
  it('returns immediately with state=building, then completes via poll-status', async () => {
    const library = makeLibrary(250);
    const search = new MemorySearchIndex({ embedder: new FakeEmbeddingProvider(), logger: silentLogger });
    const ctx = makeCtx(search, library);
    const res = await indexTool.handler({ action: 'build' }, ctx);
    expect(res.structuredContent?.state).toBe('building');
    expect(res.content[0].text).toMatch(/poll/i);
    const final = await pollStatus(ctx);
    expect(final.structuredContent?.state).toBe('done');
    expect(final.structuredContent?.items).toBe(250);
    expect(final.structuredContent?.itemsFetched).toBe(250);
    expect(final.structuredContent?.itemsTotal).toBe(250);
    expect(final.structuredContent?.vectors).toBeGreaterThan(0);
    // backward-compatible fields present
    expect(final.structuredContent?.documents).toBeGreaterThan(0);
    expect(final.structuredContent?.embedder).toBe('fake');
  });

  it('does not start a second build while one is running (returns progress)', async () => {
    const library = makeLibrary(250);
    const gate = gatedEmbedder();
    const search = new MemorySearchIndex({ embedder: gate.provider, logger: silentLogger });
    const ctx = makeCtx(search, library);
    await indexTool.handler({ action: 'build' }, ctx);
    // Wait until the build pauses inside the first embed call.
    for (let i = 0; i < 200 && gate.pending() === 0; i++) await new Promise((r) => setTimeout(r, 2));
    expect(search.isBuilding).toBe(true);
    const before = gate.calls();
    const dup = await indexTool.handler({ action: 'build' }, ctx);
    expect(dup.structuredContent?.state).toBe('building');
    expect(dup.content[0].text).toMatch(/already/i);
    expect(gate.calls()).toBe(before); // no new embed work kicked off
    gate.open();
    await pollStatus(ctx);
    expect(search.buildStatus().state).toBe('done');
  });

  it('stop cancels the running build and keeps partial data', async () => {
    const library = makeLibrary(250); // 3 pages of 100
    const gate = gatedEmbedder();
    const search = new MemorySearchIndex({ embedder: gate.provider, logger: silentLogger });
    const ctx = makeCtx(search, library);
    await indexTool.handler({ action: 'build' }, ctx);
    // Let it fetch the first page and pause on the first embed batch.
    for (let i = 0; i < 200 && gate.pending() === 0; i++) await new Promise((r) => setTimeout(r, 2));
    expect(search.isBuilding).toBe(true);
    const stopRes = await indexTool.handler({ action: 'stop' }, ctx);
    expect(stopRes.content[0].text).toMatch(/stop/i);
    gate.open(); // allow the paused embed to finish so the loop can observe cancellation
    const final = await pollStatus(ctx);
    expect(final.structuredContent?.state).toBe('done');
    // Only the first page was indexed before cancellation — partial, not the full 250.
    expect(final.structuredContent?.items).toBeLessThan(250);
    expect(final.structuredContent?.items).toBeGreaterThan(0);
    expect(search.isBuilding).toBe(false);
  });

  it('stop is a no-op when nothing is building', async () => {
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    const ctx = makeCtx(search, []);
    const res = await indexTool.handler({ action: 'stop' }, ctx);
    expect(res.content[0].text).toMatch(/no build/i);
  });

  it('pauses while idle, refuses every writer, and resumes without starting work', async () => {
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    const ctx = makeCtx(search, makeLibrary(3));

    const paused = await indexTool.handler({ action: 'pause' }, ctx);
    expect(paused.structuredContent?.paused).toBe(true);
    expect(search.isBuilding).toBe(false);
    for (const action of ['build', 'refresh', 'update'] as const) {
      const refused = await indexTool.handler({ action }, ctx);
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toMatch(/paused.*resume/i);
    }
    expect(ctx.web.listItems).not.toHaveBeenCalled();

    const resumed = await indexTool.handler({ action: 'resume' }, ctx);
    expect(resumed.structuredContent?.paused).toBe(false);
    expect(search.isBuilding).toBe(false);
    expect(resumed.content[0].text).toMatch(/no job was started/i);
  });

  it('pause also stops a running build and leaves the durable hold set', async () => {
    const gate = gatedEmbedder();
    const search = new MemorySearchIndex({ embedder: gate.provider, logger: silentLogger });
    const ctx = makeCtx(search, makeLibrary(250));
    await indexTool.handler({ action: 'build' }, ctx);
    for (let i = 0; i < 200 && gate.pending() === 0; i++) await new Promise((r) => setTimeout(r, 2));

    const paused = await indexTool.handler({ action: 'pause' }, ctx);
    expect(paused.structuredContent?.paused).toBe(true);
    gate.open();
    await pollStatus(ctx);
    expect(search.isBuilding).toBe(false);
    expect(search.isPaused).toBe(true);
    expect(search.buildStatus().items).toBeLessThan(250);
  });

  it('honours the limit input', async () => {
    const library = makeLibrary(50);
    const search = new MemorySearchIndex({ embedder: new FakeEmbeddingProvider(), logger: silentLogger });
    const ctx = makeCtx(search, library);
    await indexTool.handler({ action: 'build', limit: 5 }, ctx);
    const final = await pollStatus(ctx);
    expect(final.structuredContent?.items).toBe(5);
    expect(final.structuredContent?.itemsTotal).toBe(5);
  });

  it('exposes the stop action and limit in the schema and mentions polling in the description', () => {
    expect(indexTool.inputSchema.action._def.values).toContain('stop');
    expect(indexTool.inputSchema.action._def.values).toContain('pause');
    expect(indexTool.inputSchema.action._def.values).toContain('resume');
    expect(indexTool.inputSchema.limit).toBeDefined();
    expect(indexTool.description).toMatch(/background/i);
    expect(indexTool.description).toMatch(/poll/i);
    expect(indexTool.description).toMatch(/5000/);
  });

  it('advertises full-text indexing as an opt-in with a cost', () => {
    expect(indexTool.inputSchema.fulltext).toBeDefined();
    expect(indexTool.inputSchema.fulltext_max_chars).toBeDefined();
    expect(indexTool.description).toMatch(/fulltext:true/);
    expect(indexTool.description).toMatch(/off by default/i);
  });

  it('does not touch the full-text endpoints unless asked', async () => {
    const ctx = makeCtx(new MemorySearchIndex({ embedder: null, logger: silentLogger }), makeLibrary(3));
    await indexTool.handler({ action: 'build' }, ctx);
    const final = await pollStatus(ctx);
    expect(ctx.web.fullTextSince).not.toHaveBeenCalled();
    expect(final.structuredContent?.fulltextEnabled).toBe(false);
  });

  it('indexes attachment bodies with fulltext:true and reports the cost up front', async () => {
    const attachments = [
      { key: 'ATT1', data: { key: 'ATT1', itemType: 'attachment', parentItem: 'K1' } },
      { key: 'ATT2', data: { key: 'ATT2', itemType: 'attachment', parentItem: 'K2' } },
    ];
    const text = { ATT1: 'diffusion schedules under a cosine noise budget. '.repeat(30) };
    const search = new MemorySearchIndex({ embedder: null, logger: silentLogger });
    const ctx = makeCtx(search, makeLibrary(3), { attachments, text });

    const started = await indexTool.handler({ action: 'build', fulltext: true }, ctx);
    expect(started.content[0].text).toMatch(/full text is included/i);

    const final = await pollStatus(ctx);
    expect(final.structuredContent?.fulltextEnabled).toBe(true);
    expect(final.structuredContent?.fulltextItems).toBe(1);
    // ATT2 has no extracted text, so it is never fetched.
    expect(ctx.web.getFullText).toHaveBeenCalledTimes(1);

    const hits = await search.query('cosine noise budget', { limit: 1 });
    expect(hits[0]!.itemKey).toBe('K1');
    expect(hits[0]!.source).toBe('fulltext');
  });
});
