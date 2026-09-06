import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { MemorySearchIndex } from '../../src/features/search/index-manager.js';
import { plantTransformersStub, type TransformersStub } from '../fixtures/transformers-stub.js';
import {
  DEFAULT_LOCAL_MODEL,
  DEFAULT_POOLING,
  LocalEmbeddingProvider,
  MODEL_POOLING,
  createEmbeddingProvider,
  embedderIdentity,
  inputPrefixes,
  poolingFor,
  resolveTransformers,
} from '../../src/features/search/embeddings.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as any;

/**
 * Pooling is decided when a model is trained, published only on its source repository, and
 * stood as a literal at the one call site the pipeline has. That literal was right for
 * MiniLM and E5 and wrong for every CLS-pooled model ZOTEUS_EMBEDDING_MODEL can now name,
 * which retrieves worse without ever failing. These tests pin the table that replaces the
 * literal: what it says, that what it says reaches the pipeline call, and that a model it
 * does not know, the default included, is treated exactly as before.
 */

/** An extractor that records every batch and the options it was called with. */
function recordingExtractor(dim = 4): {
  calls: { input: string[]; options: unknown }[];
  extractor: (input: string | string[], options: unknown) => Promise<any>;
} {
  const calls: { input: string[]; options: unknown }[] = [];
  return {
    calls,
    extractor: async (input: string | string[], options: unknown) => {
      const batch = Array.isArray(input) ? input : [input];
      calls.push({ input: batch, options });
      return { data: new Float32Array(batch.length * dim).fill(0.5), dims: [batch.length, dim] };
    },
  };
}

describe('the pooling table', () => {
  it('lists the default and the documented multilingual pick as mean, which is what they always got', () => {
    expect(poolingFor(DEFAULT_LOCAL_MODEL)).toBe('mean');
    expect(poolingFor('Xenova/multilingual-e5-small')).toBe('mean');
    expect(poolingFor('intfloat/e5-base-v2')).toBe('mean');
    expect(DEFAULT_POOLING).toBe('mean');
  });

  it('lists the CLS-pooled models the literal was measured to hurt, under either id', () => {
    for (const id of [
      'onnx-community/granite-embedding-97m-multilingual-r2-ONNX',
      'ibm-granite/granite-embedding-97m-multilingual-r2',
      'onnx-community/gte-multilingual-base',
      'Alibaba-NLP/gte-multilingual-base',
      'Snowflake/snowflake-arctic-embed-m-v2.0',
    ]) {
      expect(poolingFor(id), id).toBe('cls');
    }
  });

  it('lists the models issue #51 named as the live exposure, English-only and cls-pooled', () => {
    // BAAI/bge-small and -base, mxbai-embed-large and arctic-embed-s: the models #51 flagged
    // as reachable now that a model can be named at all, verified against each source
    // repository's own 1_Pooling/config.json. mxbai and arctic-embed-s publish their own ONNX
    // graph, so each has one id rather than a mirror pair.
    for (const id of [
      'Xenova/bge-small-en-v1.5',
      'BAAI/bge-small-en-v1.5',
      'Xenova/bge-base-en-v1.5',
      'BAAI/bge-base-en-v1.5',
      'mixedbread-ai/mxbai-embed-large-v1',
      'Snowflake/snowflake-arctic-embed-s',
    ]) {
      expect(poolingFor(id), id).toBe('cls');
    }
  });

  it('keeps the historical mean for a model it does not know, rather than refusing it', () => {
    expect(MODEL_POOLING['some-org/a-model-published-yesterday']).toBeUndefined();
    expect(poolingFor('some-org/a-model-published-yesterday')).toBe('mean');
    expect(poolingFor('')).toBe('mean');
  });

  it('spells every id the way transformers.js resolves it: an org, a slash, a repository', () => {
    for (const id of Object.keys(MODEL_POOLING)) {
      expect(id, id).toMatch(/^[\w.-]+\/[\w.-]+$/);
    }
  });
});

describe('the pooling the pipeline is asked for', () => {
  it('is the table’s, not the call site’s', async () => {
    const { calls, extractor } = recordingExtractor();
    const provider = new LocalEmbeddingProvider('onnx-community/gte-multilingual-base', async () => extractor);
    await provider.embed(['une pompe à chaleur']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toEqual({ pooling: 'cls', normalize: true });
  });

  it('is exactly what the incumbent always got, for the default model and for E5', async () => {
    // The literal that stood at the call site was `{ pooling: 'mean', normalize: true }`.
    // For the models every existing index was built with, the table must reproduce it key
    // for key, or those indexes silently stop matching the queries run against them.
    for (const model of [DEFAULT_LOCAL_MODEL, 'Xenova/multilingual-e5-small']) {
      const { calls, extractor } = recordingExtractor();
      await new LocalEmbeddingProvider(model, async () => extractor).embed(['a passage'], 'passage');
      expect(calls[0]!.options, model).toEqual({ pooling: 'mean', normalize: true });
    }
  });

  it('is the historical mean for a model the table does not know', async () => {
    const { calls, extractor } = recordingExtractor();
    await new LocalEmbeddingProvider('some-org/a-model-published-yesterday', async () => extractor).embed(['x']);
    expect(calls[0]!.options).toEqual({ pooling: 'mean', normalize: true });
  });

  it('leaves the identity of every model pooled the default way exactly as it was', () => {
    // The compatibility half, and the reason the suffix is conditional: every local index
    // ever built was mean-pooled, so none of these strings may move. `fp32` is spelt out
    // here for the same reason it is unsuffixed in the identity -- to pin that an untouched
    // setting adds nothing.
    for (const model of [
      DEFAULT_LOCAL_MODEL,
      'Xenova/multilingual-e5-small',
      'sentence-transformers/paraphrase-multilingual-mpnet-base-v2',
      'some-org/a-model-the-table-has-never-heard-of',
    ]) {
      const p = new LocalEmbeddingProvider(model, undefined, { dtype: 'fp32' });
      expect(p.pooling, model).toBe('mean');
      expect(embedderIdentity(p), model).toBe(`local:${model}`);
    }
  });

  it('makes a CLS model a different vector space, because that is what it is', () => {
    // The width check that catches a foreign vector cannot see this one: mean and cls share
    // a dimension. Without the suffix an index built before this change is queried with the
    // other reading of the same model under an identity that did not move, and nothing in
    // the codebase can tell. This is what turns that into the drop-with-notice the server
    // already emits.
    const cls = new LocalEmbeddingProvider('onnx-community/gte-multilingual-base');
    expect(cls.pooling).toBe('cls');
    expect(embedderIdentity(cls)).toBe('local:onnx-community/gte-multilingual-base#cls');
    expect(cls.prefixes).toBe(inputPrefixes('onnx-community/gte-multilingual-base'));
  });

  it('stamps an override that departs from the table, and only then', () => {
    // The override is the one way a user can change the vectors of a model the table
    // already knows. Departing from the table is a new space and says so; agreeing with it
    // is the same space and must not restamp an index that is already correct.
    const forced = new LocalEmbeddingProvider(DEFAULT_LOCAL_MODEL, undefined, { pooling: 'cls' });
    expect(embedderIdentity(forced)).toBe(`local:${DEFAULT_LOCAL_MODEL}#cls`);

    const agreeing = new LocalEmbeddingProvider(DEFAULT_LOCAL_MODEL, undefined, { pooling: 'mean' });
    expect(embedderIdentity(agreeing)).toBe(`local:${DEFAULT_LOCAL_MODEL}`);

    // And it composes with the precision, which is the other half of the same stamp.
    const both = new LocalEmbeddingProvider('onnx-community/gte-multilingual-base', undefined, {
      dtype: 'q8',
    });
    expect(embedderIdentity(both)).toBe('local:onnx-community/gte-multilingual-base@q8#cls');
  });
});

describe('from ZOTEUS_EMBEDDING_MODEL to the pipeline call', () => {
  let stub: TransformersStub;

  // A stub whose extractor records the options each call is made with: the pooling is an
  // argument to that call, not to pipeline(), so this is the only place it can be seen.
  beforeAll(() => {
    stub = plantTransformersStub('zoteus-pooling-');
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

  const calls = () => stub.calls().map(({ model, input, options }) => ({ model, input, options }));

  it('pools a listed CLS model with cls, from the model setting alone', async () => {
    const { provider } = createEmbeddingProvider(
      config({ ZOTEUS_EMBEDDING_MODEL: 'onnx-community/gte-multilingual-base' }),
      silentLogger,
    );
    await provider!.embed(['une pompe à chaleur']);
    expect(calls()).toEqual([
      {
        model: 'onnx-community/gte-multilingual-base',
        input: ['une pompe à chaleur'],
        options: { pooling: 'cls', normalize: true },
      },
    ]);
  });

  it('pools the default exactly as it always was, with nothing configured', async () => {
    const { provider } = createEmbeddingProvider(config({}), silentLogger);
    await provider!.embed(['a passage']);
    expect(calls()).toEqual([
      { model: DEFAULT_LOCAL_MODEL, input: ['a passage'], options: { pooling: 'mean', normalize: true } },
    ]);
  });

  it('lets ZOTEUS_EMBEDDING_POOLING speak for a checkpoint the table does not know', async () => {
    const { provider } = createEmbeddingProvider(
      config({ ZOTEUS_EMBEDDING_MODEL: 'some-org/private-mirror-of-gte', ZOTEUS_EMBEDDING_POOLING: 'cls' }),
      silentLogger,
    );
    await provider!.embed(['une pompe à chaleur']);
    expect(calls()[0]!.options).toEqual({ pooling: 'cls', normalize: true });
  });
});

describe('ZOTEUS_EMBEDDING_POOLING as a setting', () => {
  it('reads auto, mean and cls, and defaults to auto', () => {
    expect(loadConfig({} as any).embeddingPooling).toBe('auto');
    expect(loadConfig({ ZOTEUS_EMBEDDING_POOLING: 'cls' } as any).embeddingPooling).toBe('cls');
    expect(loadConfig({ ZOTEUS_EMBEDDING_POOLING: 'mean' } as any).embeddingPooling).toBe('mean');
  });

  it('overrides the table in both directions, exactly as the prefixes setting overrides the id test', () => {
    const gte = 'onnx-community/gte-multilingual-base';
    expect(new LocalEmbeddingProvider(gte, undefined, { pooling: 'mean' }).pooling).toBe('mean');
    expect(new LocalEmbeddingProvider(DEFAULT_LOCAL_MODEL, undefined, { pooling: 'cls' }).pooling).toBe('cls');
    expect(new LocalEmbeddingProvider('some-org/unknown', undefined, { pooling: 'cls' }).pooling).toBe('cls');
    // `auto` is the table, and unset is `auto`.
    expect(new LocalEmbeddingProvider(gte, undefined, { pooling: 'auto' }).pooling).toBe('cls');
    expect(new LocalEmbeddingProvider(gte).pooling).toBe('cls');
  });

  it('falls back to the table when it is not a pooling, and says so', () => {
    // `max` and `average` are real poolings the pipeline does not have and `CLS` is the
    // right one misspelt, so each is a value the user believed in and none of them may
    // pass silently.
    for (const bad of ['max', 'average', 'CLS', 'yes']) {
      const cfg = loadConfig({ ZOTEUS_EMBEDDING_POOLING: bad } as any);
      expect(cfg.embeddingPooling, bad).toBe('auto');
      const warned = cfg.warnings.join(' ');
      expect(warned).toContain('ZOTEUS_EMBEDDING_POOLING');
    }
    expect(loadConfig({ ZOTEUS_EMBEDDING_POOLING: 'cls' } as any).warnings.join(' ')).not.toMatch(
      /ZOTEUS_EMBEDDING_POOLING/,
    );
  });

  it('says it is ignored under an API provider instead of implying a choice', () => {
    const openai = loadConfig({ ZOTEUS_EMBEDDINGS: 'openai', ZOTEUS_EMBEDDING_POOLING: 'cls' } as any);
    expect(openai.warnings.join(' ')).toMatch(/ZOTEUS_EMBEDDING_POOLING applies to on-device embeddings only/);

    const local = loadConfig({ ZOTEUS_EMBEDDINGS: 'local', ZOTEUS_EMBEDDING_POOLING: 'cls' } as any);
    expect(local.warnings.join(' ')).not.toMatch(/ZOTEUS_EMBEDDING_POOLING/);
    const unset = loadConfig({ ZOTEUS_EMBEDDINGS: 'openai' } as any);
    expect(unset.warnings.join(' ')).not.toMatch(/ZOTEUS_EMBEDDING_POOLING/);
  });
});

describe('what the identity is for', () => {
  // Asserting the string is not asserting the behaviour. These drive the real index
  // through the path the suffix exists to trigger: vectors built under one pooling,
  // reopened under the other. With the suffix removed from embedderIdentity they pass
  // silently, which is the defect this whole change is about.
  const CLS_MODEL = 'onnx-community/gte-multilingual-base';

  const items = [
    { key: 'A', title: 'transformers for retrieval', abstractNote: 'dense passage retrieval' },
    { key: 'B', title: 'a history of typography', abstractNote: 'movable type in Europe' },
  ] as any[];

  // A stand-in for the local provider: it is the identity fields that matter here, not
  // the arithmetic, and a real model would make this a network test.
  function embedder(pooling: 'mean' | 'cls') {
    return {
      name: 'local',
      model: CLS_MODEL,
      pooling,
      async embed(texts: string[]) {
        return texts.map((t) => [t.length % 7, (t.length % 5) + 1, 1]);
      },
    } as any;
  }

  async function builtWith(pooling: 'mean' | 'cls') {
    const index = new MemorySearchIndex({ embedder: embedder(pooling), configured: 'local' });
    await index.build(items);
    return JSON.parse(JSON.stringify(index.toJSON()));
  }

  function opened(pooling: 'mean' | 'cls') {
    return new MemorySearchIndex({
      embedder: embedder(pooling),
      configured: 'local',
      logger: silentLogger,
    });
  }

  it('stamps the pooling it embedded with into the saved index', async () => {
    expect((await builtWith('mean')).embedderId).toBe(`local:${CLS_MODEL}`);
    expect((await builtWith('cls')).embedderId).toBe(`local:${CLS_MODEL}#cls`);
  });

  it('drops vectors pooled the other way, which is the whole point of the suffix', async () => {
    // The 1.13.0 case: an index of this model built before the table existed holds
    // mean-pooled vectors, and this server now embeds it with cls.
    const saved = await builtWith('mean');
    expect(saved.vectors.length).toBeGreaterThan(0);

    const index = opened('cls');
    index.loadFromJSON(saved);
    const status = index.buildStatus();

    expect(status.vectors).toBe(0);
    expect(status.vectorsStaleReason).toContain(`local:${CLS_MODEL}`);
    expect(status.vectorsStaleReason).toContain(`local:${CLS_MODEL}#cls`);
    // The notice must not claim the models differ: here they are the same model.
    expect(status.vectorsStaleReason).not.toContain('different models');
    // Keyword search is untouched, as it is for any other stale-vector cause.
    expect(status.documents).toBeGreaterThan(0);
  });

  it('keeps them when the pooling agrees, so no untouched index is restamped', async () => {
    const saved = await builtWith('mean');
    const index = opened('mean');
    index.loadFromJSON(saved);
    expect(index.buildStatus().vectors).toBe(saved.vectors.length);
    expect(index.buildStatus().vectorsStaleReason).toBeUndefined();
  });
});
