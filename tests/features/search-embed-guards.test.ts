import { describe, it, expect, beforeEach } from 'vitest';
import { MemorySearchIndex } from '../../src/features/search/index-manager.js';
import { FakeEmbeddingProvider, type EmbeddingProvider } from '../../src/features/search/embeddings.js';
import {
  EmbedBudgetExceededError,
  embedTokensSpent,
  resetEmbedBudgets,
  withEmbedBudget,
} from '../../src/features/search/embed-budget.js';
import { loadConfig } from '../../src/config.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

const items = [
  { key: 'A', data: { key: 'A', itemType: 'journalArticle', title: 'Gated recurrent units', abstractNote: 'A study.' } },
  { key: 'B', data: { key: 'B', itemType: 'journalArticle', title: 'Ablations in practice', abstractNote: 'Another.' } },
];
const body = 'The ablation removes the recurrent gate entirely. '.repeat(20);

/** Records every text it is asked to embed, so a test can see what left the process. */
class RecordingEmbedder extends FakeEmbeddingProvider {
  readonly sent: string[] = [];
  override async embed(texts: string[]): Promise<number[][]> {
    this.sent.push(...texts);
    return super.embed(texts);
  }
}

describe('ZOTEUS_EMBED_FULLTEXT=false: body text stays out of the embedder', () => {
  it('embeds body passages by default', async () => {
    const embedder = new RecordingEmbedder();
    const index = new MemorySearchIndex({ embedder, logger: silentLogger });
    await index.buildIncremental(async () => ({ items, totalResults: items.length }), {
      fulltextFor: async (key) => (key === 'B' ? body : undefined),
    });
    expect(embedder.sent.some((t) => t.includes('recurrent gate entirely'))).toBe(true);
  });

  it('keeps body passages keyword-searchable but sends none of them', async () => {
    const embedder = new RecordingEmbedder();
    const index = new MemorySearchIndex({ embedder, embedFulltext: false, logger: silentLogger });
    const final = await index.buildIncremental(async () => ({ items, totalResults: items.length }), {
      fulltextFor: async (key) => (key === 'B' ? body : undefined),
    });
    expect(final.fulltextPassages).toBeGreaterThan(0);
    expect(embedder.sent.some((t) => t.includes('recurrent gate entirely'))).toBe(false);
    // The metadata passages were still embedded: the rule is about body text only.
    expect(embedder.sent.some((t) => t.includes('Gated recurrent units'))).toBe(true);
    expect(final.vectors).toBe(final.documents - final.fulltextPassages!);
    const hits = await index.query('recurrent gate ablation', { limit: 3, mode: 'keyword' });
    expect(hits[0]!.itemKey).toBe('B');
  });
});

describe('withEmbedBudget: a daily allowance per caller', () => {
  beforeEach(() => resetEmbedBudgets());
  const day1 = () => new Date('2026-11-10T10:00:00Z');
  const day2 = () => new Date('2026-11-11T00:00:01Z');

  it('lets passages through until the allowance is spent, then refuses', async () => {
    const inner = new RecordingEmbedder();
    const limited = withEmbedBudget(inner, 'user:1', 100, day1);
    await limited.embed(['x'.repeat(200)], 'passage'); // 50 tokens
    await limited.embed(['x'.repeat(200)], 'passage'); // 100 tokens
    await expect(limited.embed(['x'.repeat(4)], 'passage')).rejects.toBeInstanceOf(EmbedBudgetExceededError);
    expect(inner.sent).toHaveLength(2);
    expect(embedTokensSpent('user:1', day1())).toBe(100);
  });

  it('never refuses a query, and keeps callers apart', async () => {
    const inner = new RecordingEmbedder();
    const one = withEmbedBudget(inner, 'user:1', 10, day1);
    await expect(one.embed(['x'.repeat(400)], 'passage')).rejects.toBeInstanceOf(EmbedBudgetExceededError);
    await one.embed(['x'.repeat(40)], 'passage');
    await expect(one.embed(['what did I read about gates'], 'query')).resolves.toHaveLength(1);
    const two = withEmbedBudget(inner, 'user:2', 10, day1);
    await expect(two.embed(['x'.repeat(40)], 'passage')).resolves.toHaveLength(1);
  });

  it('survives a rebuilt wrapper (an evicted tenant context) and resets the next day', async () => {
    const inner = new RecordingEmbedder();
    await withEmbedBudget(inner, 'user:1', 10, day1).embed(['x'.repeat(40)], 'passage');
    const again = withEmbedBudget(inner, 'user:1', 10, day1);
    await expect(again.embed(['x'.repeat(4)], 'passage')).rejects.toBeInstanceOf(EmbedBudgetExceededError);
    await expect(withEmbedBudget(inner, 'user:1', 10, day2).embed(['x'.repeat(40)], 'passage')).resolves.toHaveLength(1);
  });

  it('keeps the inner provider identity, which is what an index is stamped with', () => {
    const inner: EmbeddingProvider = Object.assign(new FakeEmbeddingProvider(), { model: 'text-embedding-3-small' });
    const limited = withEmbedBudget(inner, 'user:1', 10, day1);
    expect(limited.name).toBe('fake');
    expect(limited.model).toBe('text-embedding-3-small');
  });

  it('a build that runs out of allowance keeps going keyword-only and says why', async () => {
    const limited = withEmbedBudget(new RecordingEmbedder(), 'user:9', 1, day1);
    const index = new MemorySearchIndex({ embedder: limited, logger: silentLogger });
    const final = await index.buildIncremental(async () => ({ items, totalResults: items.length }), {});
    expect(final.documents).toBeGreaterThan(0);
    expect(final.vectors).toBe(0);
    expect(index.buildStatus().embedderReason).toMatch(/daily allowance/);
  });
});

describe('config', () => {
  it('reads both settings, with safe defaults', () => {
    const base = { ZOTERO_API_KEY: 'k', ZOTERO_USER_ID: '1' };
    const d = loadConfig(base as NodeJS.ProcessEnv);
    expect(d.embedFulltext).toBe(true);
    expect(d.embedDailyTokens).toBeUndefined();
    const c = loadConfig({ ...base, ZOTEUS_EMBED_FULLTEXT: 'false', ZOTEUS_EMBED_DAILY_TOKENS: '5000000' } as NodeJS.ProcessEnv);
    expect(c.embedFulltext).toBe(false);
    expect(c.embedDailyTokens).toBe(5000000);
  });
});
