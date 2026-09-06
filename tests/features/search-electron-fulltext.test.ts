import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { MemorySearchIndex } from '../../src/features/search/index-manager.js';
import { plantTransformersStub, type TransformersStub } from '../fixtures/transformers-stub.js';
import {
  ELECTRON_LOCAL_EMBED_BATCH,
  electronVersion,
  localEmbedBatchNotice,
  localEmbedBatchSize,
} from '../../src/features/search/electron.js';
import { createEmbeddingProvider, resolveTransformers } from '../../src/features/search/embeddings.js';
import { DEFAULT_EMBED_BATCH_SIZE } from '../../src/features/search/limits.js';
import { startIndexBuild, startIndexUpdate, PAGE_SIZE } from '../../src/features/search/build.js';
import indexTool from '../../src/tools/index-tool.js';
import { loadConfig } from '../../src/config.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Electron's marker on this process, for the duration of one test. `process.versions` is a
 * writable object on every Node this suite runs on, and everything Electron-aware reads the
 * marker straight off it, so this is what makes the capped path reachable from a runtime
 * that is not Electron.
 */
function pretendElectron(version = '42.10.0'): void {
  (process.versions as Record<string, string | undefined>).electron = version;
}

afterEach(() => {
  delete (process.versions as Record<string, string | undefined>).electron;
});

function makeCtx(env: Record<string, string> = {}) {
  const items = Array.from({ length: 3 }, (_, i) => ({
    key: `K${i}`,
    data: { itemType: 'journalArticle', title: `Item ${i}`, abstractNote: `abstract about topic${i}` },
  }));
  const fullTextSince = vi.fn(async () => ({ ATT1: 7 }));
  const getFullText = vi.fn(async () => ({ content: 'body text' }));
  const searchItems = vi.fn(async (q: any) => {
    const start = q.start ?? 0;
    const source = q.top ? items : [{ key: 'ATT1', data: { key: 'ATT1', itemType: 'attachment', parentItem: 'K1' } }];
    return { data: source.slice(start, start + (q.limit ?? PAGE_SIZE)), totalResults: source.length, lastModifiedVersion: 4 };
  });
  const ctx: any = {
    config: loadConfig(env as any),
    router: {
      fullTextSince,
      getFullText,
      searchItems,
      itemVersions: vi.fn(async () => ({ versions: { K0: 1, K1: 1, K2: 1 }, totalResults: 3 })),
      servesLocally: () => false,
      defaultLibrary: () => ({ type: 'user', id: 1 }),
    },
    search: new MemorySearchIndex({ embedder: null, logger: silentLogger }),
    logger: silentLogger,
    searchIndexPath: '',
  };
  return { ctx, fullTextSince, getFullText, searchItems };
}

async function finished(search: MemorySearchIndex): Promise<void> {
  for (let i = 0; i < 1000 && search.buildStatus().state === 'building'; i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('localEmbedBatchSize', () => {
  it('changes nothing on a standalone Node', () => {
    expect(electronVersion({})).toBeUndefined();
    expect(localEmbedBatchSize(undefined, {})).toBeUndefined();
    expect(localEmbedBatchSize(32, {})).toBe(32);
    expect(localEmbedBatchSize(256, {})).toBe(256);
    // An empty marker is not a version: a host that substitutes a blank string must not be
    // read as "this is Electron".
    expect(localEmbedBatchSize(256, { electron: '  ' })).toBe(256);
  });

  it('caps the default batch under Electron', () => {
    // The whole bug in one assertion: 32 passages of up to 512 tokens is a ~400 MB
    // attention tensor in one block, and Chromium's allocator answers that with SIGTRAP.
    expect(localEmbedBatchSize(undefined, { electron: '42.10.0' })).toBe(ELECTRON_LOCAL_EMBED_BATCH);
    expect(ELECTRON_LOCAL_EMBED_BATCH).toBeLessThan(DEFAULT_EMBED_BATCH_SIZE);
  });

  it('caps a configured batch that is larger, and leaves a smaller one alone', () => {
    expect(localEmbedBatchSize(64, { electron: '42.10.0' })).toBe(ELECTRON_LOCAL_EMBED_BATCH);
    // A ceiling, not a target: someone who already chose to embed two at a time keeps it.
    expect(localEmbedBatchSize(2, { electron: '42.10.0' })).toBe(2);
  });
});

describe('localEmbedBatchNotice', () => {
  it('says nothing when the cap is invisible', () => {
    expect(localEmbedBatchNotice(32, {})).toBeUndefined();
    expect(localEmbedBatchNotice(4, { electron: '42.10.0' })).toBeUndefined();
  });

  it('names the Electron version and both numbers when the cap bites', () => {
    const notice = localEmbedBatchNotice(undefined, { electron: '42.10.0' })!;
    expect(notice).toContain('42.10.0');
    expect(notice).toContain(String(ELECTRON_LOCAL_EMBED_BATCH));
    expect(notice).toContain(String(DEFAULT_EMBED_BATCH_SIZE));
    expect(notice).toContain('#37');
    // The reassurance that matters: a slower build, not a different index.
    expect(notice).toMatch(/same index/);
  });
});

/**
 * The wiring, not the arithmetic: that the number `localEmbedBatchSize` computes is the
 * number the pipeline is actually called with.
 *
 * The transformers package is an optional dependency and not installed here, so this plants
 * a stub of it in a temp directory and points ZOTEUS_TRANSFORMERS_PATH at it, the same
 * resolution path a real out-of-bundle install takes (see embedding-model-cache.test.ts).
 * The stub's extractor records the size of every batch it is handed.
 */
describe('the local embedder under Electron', () => {
  let stub: TransformersStub;

  beforeAll(() => {
    stub = plantTransformersStub('zoteus-electron-batch-');
    expect(resolveTransformers(stub.root)).not.toBeNull();
  });

  afterAll(() => stub.remove());

  beforeEach(() => stub.reset());

  const config = (env: Record<string, string> = {}) =>
    loadConfig({ ZOTEUS_EMBEDDINGS: 'local', ZOTEUS_TRANSFORMERS_PATH: stub.root, ...env } as any);

  const passages = (n: number) => Array.from({ length: n }, (_, i) => `passage ${i}`);
  const batches = () => stub.calls().map((c) => c.input.length);

  it('hands the pipeline no more than the cap per call', async () => {
    pretendElectron();
    const { provider } = createEmbeddingProvider(config(), silentLogger as any);
    await provider!.embed(passages(20));
    expect(batches()).toEqual([8, 8, 4]);
    expect(Math.max(...batches())).toBeLessThanOrEqual(ELECTRON_LOCAL_EMBED_BATCH);
  });

  it('batches by the default off Electron, unchanged', async () => {
    const { provider } = createEmbeddingProvider(config(), silentLogger as any);
    await provider!.embed(passages(40));
    expect(batches()).toEqual([DEFAULT_EMBED_BATCH_SIZE, 40 - DEFAULT_EMBED_BATCH_SIZE]);
  });

  it('refuses to let ZOTEUS_EMBED_BATCH_SIZE raise it back over the cap', async () => {
    pretendElectron();
    const { provider } = createEmbeddingProvider(config({ ZOTEUS_EMBED_BATCH_SIZE: '64' }), silentLogger as any);
    await provider!.embed(passages(20));
    expect(Math.max(...batches())).toBe(ELECTRON_LOCAL_EMBED_BATCH);
  });

  it('logs why the batch shrank, so a slower build is not a mystery', () => {
    pretendElectron();
    const info = vi.fn();
    createEmbeddingProvider(config(), { ...silentLogger, info } as any);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('#37'));
  });

  it('leaves an API provider uncapped: its batch is a request body, not a tensor', () => {
    pretendElectron();
    process.env.OPENAI_API_KEY = 'sk-test';
    try {
      const { provider, configured } = createEmbeddingProvider(
        loadConfig({ ZOTEUS_EMBEDDINGS: 'openai' } as any),
        silentLogger as any,
      );
      expect(configured).toBe('openai');
      // Nothing about the OpenAI path allocates in this process, so nothing about it is
      // capped; asserting the provider exists is as far as this can go without a network.
      expect(provider).not.toBeNull();
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });
});

describe('a full-text build under Electron', () => {
  it('is no longer refused: it starts, crawls and finishes', async () => {
    pretendElectron();
    const { ctx, fullTextSince, getFullText } = makeCtx();
    startIndexBuild(ctx, undefined, undefined, { fulltext: true });
    await finished(ctx.search);

    const s = ctx.search.buildStatus();
    expect(s.state).toBe('done');
    expect(s.items).toBe(3);
    expect(s.fulltextEnabled).toBe(true);
    expect(fullTextSince).toHaveBeenCalled();
    expect(getFullText).toHaveBeenCalled();
  });

  it('needs no override env var to do it', async () => {
    pretendElectron();
    const { ctx } = makeCtx({ ZOTEUS_INDEX_FULLTEXT: 'true' });
    // Would have thrown in 1.12.0 without ZOTEUS_ALLOW_ELECTRON_FULLTEXT=true.
    expect(() => startIndexBuild(ctx)).not.toThrow();
    await finished(ctx.search);
    expect(ctx.search.buildStatus().state).toBe('done');
  });

  it('goes through the tool without an error result', async () => {
    pretendElectron();
    const { ctx, searchItems } = makeCtx();
    const res: any = await indexTool.handler({ action: 'build', fulltext: true }, ctx);
    expect(res.isError).toBeUndefined();
    await finished(ctx.search);
    expect(searchItems).toHaveBeenCalled();
    expect(ctx.search.buildStatus().fulltextEnabled).toBe(true);
  });

  it('still builds metadata only when that is what was asked for', async () => {
    pretendElectron();
    const { ctx, fullTextSince } = makeCtx();
    startIndexBuild(ctx, undefined, undefined, { fulltext: false });
    await finished(ctx.search);

    const s = ctx.search.buildStatus();
    expect(s.state).toBe('done');
    expect(s.fulltextEnabled).toBe(false);
    expect(fullTextSince).not.toHaveBeenCalled();
  });

  it('lets the rebuild an update falls back to run too', async () => {
    pretendElectron();
    const { ctx } = makeCtx();
    // No version stamp on a fresh index, so an update cannot run a delta and falls back to
    // the full build that used to be refused here.
    expect(() => startIndexUpdate(ctx, undefined, undefined, { fulltext: true })).not.toThrow();
    await finished(ctx.search);
    expect(ctx.search.buildStatus().state).toBe('done');
  });

  it('leaves an update itself alone, as before', async () => {
    pretendElectron();
    const { ctx } = makeCtx();
    startIndexBuild(ctx, undefined, undefined, { fulltext: false });
    await finished(ctx.search);
    expect(ctx.search.buildStatus().libraryVersion).toBe(4);

    startIndexUpdate(ctx, undefined, undefined, { fulltext: true });
    await finished(ctx.search);
    const s = ctx.search.buildStatus();
    expect(s.state).toBe('done');
    expect(s.operation).toBe('update');
  });
});
