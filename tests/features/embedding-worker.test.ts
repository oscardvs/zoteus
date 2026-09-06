import { describe, it, expect, afterEach } from 'vitest';
import { LocalEmbeddingProvider } from '../../src/features/search/embeddings.js';
import { plantTransformersStub, STUB_KILL_TEXT, type TransformersStub } from '../fixtures/transformers-stub.js';

/**
 * The local model runs on a worker thread, and these tests pin why (#59).
 *
 * onnxruntime-node's `run()` is a synchronous native call behind a `setImmediate`, so a
 * pipeline hosted on the main thread froze the whole process for the length of every
 * batch: with a large model at full precision that is seconds to tens of seconds per
 * batch, during which the HTTP server answered nothing. A plain GET could slip into the
 * one event-loop turn between batches; an `initialize`, which needs several turns, could
 * not complete inside a client's timeout at all, and the server was reported as hung.
 *
 * The stub used here busy-waits synchronously inside each extractor call, which is what
 * the real runtime does. A ticker on the main thread is the witness.
 */

const planted: TransformersStub[] = [];
const providers: LocalEmbeddingProvider[] = [];

function plant(prefix: string, opts: Parameters<typeof plantTransformersStub>[1] = {}): TransformersStub {
  const stub = plantTransformersStub(prefix, opts);
  planted.push(stub);
  return stub;
}

function provider(stub: TransformersStub, model = 'test-org/test-model', batchSize = 2): LocalEmbeddingProvider {
  const p = new LocalEmbeddingProvider(model, undefined, { transformersPath: stub.root, batchSize });
  providers.push(p);
  return p;
}

afterEach(async () => {
  await Promise.all(providers.splice(0).map((p) => p.close()));
  for (const stub of planted.splice(0)) stub.remove();
});

describe('the local embedder runs off the main thread', () => {
  it('keeps the event loop free while a batch is being embedded', async () => {
    const holdMs = 120;
    const stub = plant('zoteus-embed-worker-', { holdMs });
    const p = provider(stub);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const started = Date.now();
    // Three batches of two: at least 360 ms of synchronous work somewhere.
    const vecs = await p.embed(['a', 'b', 'c', 'd', 'e', 'f']);
    const wall = Date.now() - started;
    clearInterval(timer);

    expect(vecs).toHaveLength(6);
    expect(wall).toBeGreaterThanOrEqual(3 * holdMs);
    // On the main thread the ticker would have fired at most once per batch boundary (the
    // yield between batches), i.e. about three times. Off it, it fires throughout.
    expect(ticks).toBeGreaterThan(wall / 10 / 2);
  });

  it('hands back one vector per text, in order, with its values intact', async () => {
    const stub = plant('zoteus-embed-worker-values-', { distinct: true, dim: 2 });
    const p = provider(stub, 'test-org/test-model', 3);
    const texts = ['x', 'yy', 'zzz', 'wwww', 'v'];
    const vecs = await p.embed(texts);
    // Row index within its batch, then the text's length: batches of 3 then 2.
    expect(vecs).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [0, 4],
      [1, 1],
    ]);
    expect(stub.calls().map((c) => c.input)).toEqual([
      ['x', 'yy', 'zzz'],
      ['wwww', 'v'],
    ]);
  });

  it('loads the model once for callers that arrive while it is still loading', async () => {
    const stub = plant('zoteus-embed-worker-shared-');
    const p = provider(stub);
    // A query landing during a build's first batch: both must share one pipeline, not
    // start a worker each with its own copy of the weights.
    const [a, b] = await Promise.all([p.embed(['first']), p.embed(['second'], 'query')]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(stub.pipelines()).toHaveLength(1);
    expect(stub.calls().map((c) => c.input)).toEqual([['first'], ['second']]);
  });

  it('reports a worker that dies, and starts a fresh one on the next call', async () => {
    const stub = plant('zoteus-embed-worker-death-');
    const p = provider(stub);
    await expect(p.embed([STUB_KILL_TEXT])).rejects.toThrow(/embedding worker stopped unexpectedly/);
    // The next call is not poisoned by the last one: a new thread, a new pipeline.
    expect(await p.embed(['after'])).toEqual([[0.5, 0.5]]);
    expect(stub.pipelines()).toHaveLength(2);
  });

  it('can be closed and reopened', async () => {
    const stub = plant('zoteus-embed-worker-close-');
    const p = provider(stub);
    expect(await p.embed(['one'])).toEqual([[0.5, 0.5]]);
    await p.close();
    expect(await p.embed(['two'])).toEqual([[0.5, 0.5]]);
    expect(stub.pipelines()).toHaveLength(2);
  });

  it('says the same thing as before when the package resolves but will not import', async () => {
    const stub = plant('zoteus-embed-worker-abi-');
    // Overwrite the planted stub with one that explodes on import, the way a native
    // onnxruntime binary built for another Node ABI does (#38).
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const pkg = join(stub.root, 'node_modules', '@huggingface', 'transformers');
    writeFileSync(join(pkg, 'index.cjs'), "throw new Error('NODE_MODULE_VERSION 115 vs 127');");
    const p = provider(stub);
    const err = await p.embed(['anything']).then(
      () => new Error('expected the import to fail'),
      (e: unknown) => e as Error,
    );
    expect(err.message).toMatch(/resolved but failed to load \(NODE_MODULE_VERSION 115 vs 127\)/);
    expect(err.message).toContain(join(pkg, 'index.cjs'));
    expect(err.message).toContain(process.version);
  });
});
