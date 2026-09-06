import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { plantTransformersStub, type TransformersStub } from '../fixtures/transformers-stub.js';
import {
  ApiEmbeddingProvider,
  DEFAULT_LOCAL_DTYPE,
  DEFAULT_LOCAL_MODEL,
  EMBEDDING_DTYPES,
  type EmbeddingProvider,
  LocalEmbeddingProvider,
  createEmbeddingProvider,
  embedderIdentity,
  resolveTransformers,
} from '../../src/features/search/embeddings.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as any;

/**
 * A quantized model answers the same question with different numbers, so it is a different
 * vector space wearing the same model name (#43). These tests pin the two halves that makes
 * necessary: the precision has to reach the pipeline, and it has to reach the identity the
 * stale-vector guard compares, without declaring every index built before the setting
 * existed stale, all of which are fp32.
 */

describe('the precision in the embedder identity', () => {
  it('leaves full precision unsuffixed, so no existing index is invalidated by this setting', () => {
    // The literal string every local index ever built carries. It must not move.
    expect(embedderIdentity(new LocalEmbeddingProvider())).toBe('local:Xenova/all-MiniLM-L6-v2');
    expect(DEFAULT_LOCAL_DTYPE).toBe('fp32');

    // Explicitly asking for the default is the same configuration, so it is the same identity.
    const explicit = new LocalEmbeddingProvider(DEFAULT_LOCAL_MODEL, undefined, { dtype: 'fp32' });
    expect(embedderIdentity(explicit)).toBe('local:Xenova/all-MiniLM-L6-v2');
  });

  it('names any other precision, so two precisions of one model are never mixed', () => {
    const q8 = new LocalEmbeddingProvider('Xenova/multilingual-e5-small', undefined, { dtype: 'q8' });
    const fp32 = new LocalEmbeddingProvider('Xenova/multilingual-e5-small');

    expect(embedderIdentity(q8)).toBe('local:Xenova/multilingual-e5-small@q8');
    expect(embedderIdentity(fp32)).toBe('local:Xenova/multilingual-e5-small');
    expect(embedderIdentity(q8)).not.toBe(embedderIdentity(fp32));
  });

  it('gives every accepted precision an identity of its own', () => {
    const identities = EMBEDDING_DTYPES.map((dtype) =>
      embedderIdentity(new LocalEmbeddingProvider(DEFAULT_LOCAL_MODEL, undefined, { dtype })),
    );
    expect(new Set(identities).size).toBe(EMBEDDING_DTYPES.length);
  });

  it('says nothing about an API provider, which embeds at a precision that is not ours to pick', () => {
    // Read through the interface: the field is optional there, and the API provider is the
    // reason it is optional rather than a value every provider has to invent.
    const openai: EmbeddingProvider = new ApiEmbeddingProvider('openai', 'k');
    expect(openai.dtype).toBeUndefined();
    expect(embedderIdentity(openai)).toBe('openai:text-embedding-3-small');
  });
});

describe('the precision the pipeline is asked for', () => {
  let stub: TransformersStub;

  // A stub that records the options it was constructed with, and can refuse a dtype the
  // way a repository that never uploaded that file does: a fetch failure naming a path.
  beforeAll(() => {
    stub = plantTransformersStub('zoteus-dtype-');
    expect(resolveTransformers(stub.root)).not.toBeNull();
  });

  afterAll(() => stub.remove());

  beforeEach(() => stub.reset());

  const config = (env: Record<string, string>) =>
    loadConfig({
      ZOTEUS_EMBEDDINGS: 'local',
      ZOTEUS_TRANSFORMERS_PATH: stub.root,
      ZOTEUS_DATA_DIR: join(stub.root, 'data'),
      ...env,
    } as any);

  const loaded = () => stub.pipelines().map(({ task, model, options }) => ({ task, model, options }));

  it('passes the default precision explicitly, rather than leaving it to the package', async () => {
    const { provider } = createEmbeddingProvider(config({}), silentLogger);
    await provider!.embed(['ein Absatz']);

    // Unset must not mean "whatever this version of transformers picks for this device":
    // that value could move in a release, and `local:<model>` would silently start meaning
    // a different vector space than the index holding that identity was built with.
    expect(loaded()).toHaveLength(1);
    expect(loaded()[0]!.options).toEqual({ dtype: 'fp32' });
  });

  it('loads the quantized weights when ZOTEUS_EMBEDDING_DTYPE asks for them', async () => {
    const { provider } = createEmbeddingProvider(
      config({ ZOTEUS_EMBEDDING_MODEL: 'Xenova/multilingual-e5-small', ZOTEUS_EMBEDDING_DTYPE: 'q8' }),
      silentLogger,
    );
    expect(provider?.dtype).toBe('q8');
    expect(embedderIdentity(provider!)).toBe('local:Xenova/multilingual-e5-small@q8');

    await provider!.embed(['ein Absatz']);
    expect(loaded()[0]).toEqual({
      task: 'feature-extraction',
      model: 'Xenova/multilingual-e5-small',
      options: { dtype: 'q8' },
    });
  });

  it('blames the precision when the repository never published that file', async () => {
    stub.refuse('q8');
    const { provider } = createEmbeddingProvider(
      config({ ZOTEUS_EMBEDDING_MODEL: 'intfloat/multilingual-e5-small', ZOTEUS_EMBEDDING_DTYPE: 'q8' }),
      silentLogger,
    );

    // The failure a user sees is a 404 on a path. Without the setting named, nothing in it
    // says which of their variables to change, or that another repo serves the same model.
    await expect(provider!.embed(['ein Absatz'])).rejects.toThrow(/ZOTEUS_EMBEDDING_DTYPE=q8/);
    await expect(provider!.embed(['ein Absatz'])).rejects.toThrow(/Xenova\/multilingual-e5-small/);
    await expect(provider!.embed(['ein Absatz'])).rejects.toThrow(/model_quantized\.onnx/);
  });

  it('does not blame the precision for a failure at the default one', async () => {
    stub.refuse('fp32');
    const { provider } = createEmbeddingProvider(config({}), silentLogger);
    await expect(provider!.embed(['a passage'])).rejects.toThrow(/Could not load the local embedding model/);
    await expect(provider!.embed(['a passage'])).rejects.not.toThrow(/ZOTEUS_EMBEDDING_DTYPE/);
  });
});

describe('ZOTEUS_EMBEDDING_DTYPE as a setting', () => {
  it('defaults to full precision and takes any published variant', () => {
    expect(loadConfig({} as any).embeddingDtype).toBe('fp32');
    expect(loadConfig({ ZOTEUS_EMBEDDING_DTYPE: 'q8' } as any).embeddingDtype).toBe('q8');
    expect(loadConfig({ ZOTEUS_EMBEDDING_DTYPE: 'fp16' } as any).embeddingDtype).toBe('fp16');
  });

  it('falls back to full precision when it is not a precision', () => {
    // Including `auto`, which transformers.js accepts and this deliberately does not: it
    // resolves against the device, so it would mean fp32 here and q8 somewhere else.
    for (const bad of ['auto', 'quantized', 'int4', '8']) {
      expect(loadConfig({ ZOTEUS_EMBEDDING_DTYPE: bad } as any).embeddingDtype).toBe('fp32');
    }
  });

  it('says it is ignored under an API provider instead of implying a choice', () => {
    const openai = loadConfig({ ZOTEUS_EMBEDDINGS: 'openai', ZOTEUS_EMBEDDING_DTYPE: 'q8' } as any);
    expect(openai.warnings.join(' ')).toMatch(/ZOTEUS_EMBEDDING_DTYPE applies to on-device embeddings only/);

    const local = loadConfig({ ZOTEUS_EMBEDDINGS: 'local', ZOTEUS_EMBEDDING_DTYPE: 'q8' } as any);
    expect(local.warnings.join(' ')).not.toMatch(/ZOTEUS_EMBEDDING_DTYPE/);
    // Nor when it was never set: a default is not a decision worth warning about.
    const unset = loadConfig({ ZOTEUS_EMBEDDINGS: 'openai' } as any);
    expect(unset.warnings.join(' ')).not.toMatch(/ZOTEUS_EMBEDDING_DTYPE/);
  });

  it('reads a desktop host\'s unsubstituted placeholder as "not set", not as a choice', () => {
    // A .mcpb user_config field with no default that the user left empty arrives as the
    // reference itself (#18). That is a field nobody filled in, so it must resolve to fp32
    // and must not warn about a setting the user never made, whatever the provider is.
    for (const embeddings of ['local', 'openai']) {
      const cfg = loadConfig({
        ZOTEUS_EMBEDDINGS: embeddings,
        ZOTEUS_EMBEDDING_DTYPE: '${user_config.embedding_dtype}',
        ZOTEUS_DIST: 'mcpb',
      } as any);
      expect(cfg.embeddingDtype).toBe('fp32');
      expect(cfg.warnings.join(' ')).not.toMatch(/ZOTEUS_EMBEDDING_DTYPE/);
    }
  });
});
