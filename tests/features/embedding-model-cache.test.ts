import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { createEmbeddingProvider, LocalEmbeddingProvider, resolveTransformers } from '../../src/features/search/embeddings.js';
import { plantTransformersStub, STUB_DEFAULT_CACHE, type TransformersStub } from '../fixtures/transformers-stub.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as any;

/**
 * The weights are the index's largest artifact, and the transformers package caches them
 * inside its own install by default, which outlives the data directory, whose deletion is
 * supposed to be the whole uninstall. These tests pin the contract: the cache directory is
 * set under <dataDir> BEFORE the pipeline is constructed, i.e. before anything downloads.
 *
 * The package itself is an optional dependency and not installed here, so the tests plant
 * a stub of it in a temp directory and point ZOTEUS_TRANSFORMERS_PATH at it, the same
 * resolution path a real out-of-bundle install takes. The stub's pipeline() records what
 * env.cacheDir held at construction time, from the thread it was constructed on.
 */

let stub: TransformersStub;

beforeAll(() => {
  stub = plantTransformersStub('zoteus-model-cache-');
  expect(resolveTransformers(stub.root)).not.toBeNull();
});

afterAll(() => stub.remove());

beforeEach(() => stub.reset());

describe('model weights land under the data directory', () => {
  it('pins the cache under <dataDir>/models before the pipeline is constructed', async () => {
    const dataDir = join(stub.root, 'data');
    const config = loadConfig({
      ZOTEUS_EMBEDDINGS: 'local',
      ZOTEUS_TRANSFORMERS_PATH: stub.root,
      ZOTEUS_DATA_DIR: dataDir,
    } as any);
    const { provider, unavailable } = createEmbeddingProvider(config, silentLogger);
    expect(unavailable).toBeUndefined();

    const vecs = await provider!.embed(['a passage']);
    expect(vecs).toEqual([[0.5, 0.5]]);
    // Deleting dataDir now removes the weights along with the index.
    expect(stub.pipelines().map((p) => p.cacheDir)).toEqual([join(dataDir, 'models')]);
    await (provider as LocalEmbeddingProvider).close();
  });

  it('leaves the package default alone when no cache directory is given', async () => {
    // Direct construction without the option: existing callers see no behaviour change.
    const provider = new LocalEmbeddingProvider(undefined, undefined, { transformersPath: stub.root });
    await provider.embed(['a passage']);
    expect(stub.pipelines().map((p) => p.cacheDir)).toEqual([STUB_DEFAULT_CACHE]);
    await provider.close();
  });
});
