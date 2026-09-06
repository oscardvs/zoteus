import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { ZoteusConfig } from '../../config.js';
import type { Logger } from '../../lib/logger.js';
import { DEFAULT_EMBED_BATCH_SIZE, DEFAULT_EMBED_MAX_RETRIES } from './limits.js';
import { localEmbedBatchNotice, localEmbedBatchSize } from './electron.js';

/**
 * Which side of a search a text belongs to. Symmetric models ignore it; the E5 family does
 * not (see {@link inputPrefixes}), and a provider that needs the distinction cannot recover
 * it from the text itself. `passage` is the default because indexing is what every existing
 * caller does.
 */
export type EmbedKind = 'query' | 'passage';

export interface EmbeddingProvider {
  readonly name: string;
  /** Model producing the vectors; part of the index's embedder identity. */
  readonly model?: string;
  /**
   * Weight precision the model runs at, for a provider where that is ours to choose (the
   * local one). Also part of the identity: a quantized graph answers the same question with
   * different numbers, so its vectors are not the fp32 ones. Unset for an API provider,
   * whose precision is the provider's business and never ours.
   */
  readonly dtype?: EmbeddingDtype;
  /**
   * How this provider folds a model's tokens into one vector, where that is ours to choose.
   * Also part of the identity, and declared here rather than left to the concrete class:
   * `embedderIdentity` reads it through this interface, so a provider that omitted it would
   * compile and quietly stamp the unsuffixed string, which is the defect it exists to close.
   */
  readonly pooling?: PoolingMode;
  embed(texts: string[], kind?: EmbedKind): Promise<number[][]>;
}

/** npm package that provides the on-device model runtime (optional, not bundled; see below). */
export const TRANSFORMERS_MODULE = '@huggingface/transformers';

/** Per-provider default models. ZOTEUS_EMBEDDING_MODEL overrides whichever one is active. */
export const DEFAULT_API_MODELS: Record<'openai' | 'gemini', string> = {
  openai: 'text-embedding-3-small',
  gemini: 'text-embedding-004',
};

/**
 * The on-device default: small, fast, and English-centric. ZOTEUS_EMBEDDING_MODEL names any
 * other transformers.js feature-extraction model instead (#43), which is how a German or
 * otherwise multilingual library gets an embedder trained for it, e.g.
 * `Xenova/multilingual-e5-small`. It stays the default because changing it under an existing
 * index would silently invalidate everyone's vectors.
 */
export const DEFAULT_LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';

/**
 * Weight precisions a transformers.js repo can publish, in the package's own vocabulary:
 * each name maps to a file suffix on the ONNX graph (`fp32` is the bare `model.onnx`, `q8`
 * is `model_quantized.onnx`, and so on), so naming one here reaches exactly the variant the
 * repo uploaded under that name.
 *
 * `auto` is deliberately not among them. It resolves against the runtime's device rather
 * than against anything the user chose (fp32 on CPU, q8 on wasm), and a setting that means a
 * different precision on a different machine cannot be an honest part of a vector identity.
 */
export const EMBEDDING_DTYPES = [
  'fp32',
  'fp16',
  'q8',
  'int8',
  'uint8',
  'q4',
  'q4f16',
  'q2',
  'q2f16',
  'q1',
  'q1f16',
  'bnb4',
] as const;

export type EmbeddingDtype = (typeof EMBEDDING_DTYPES)[number];

/**
 * Full precision, which is what `@huggingface/transformers` 4.2.0 already downloads on CPU
 * and therefore what every index built before this knob existed holds.
 *
 * It is passed to the pipeline *explicitly* rather than left unset. Unset means "the
 * package's default for this device", a value that lives in the package and could move in a
 * release; pinning it keeps `local:<model>` meaning one precision for as long as the index
 * that stamped it exists.
 */
export const DEFAULT_LOCAL_DTYPE: EmbeddingDtype = 'fp32';


/**
 * The E5 family (and the instruct models built on it) is trained with these markers on its
 * inputs, and asymmetrically: a question is a `query: `, a document is a `passage: `.
 * Dropping them does not fail, it just retrieves worse, which is the kind of loss nobody
 * ever attributes to a missing string.
 */
export const E5_PREFIXES: Readonly<Record<EmbedKind, string>> = { query: 'query: ', passage: 'passage: ' };

/** How input prefixes are chosen: from the model id, never, or E5's regardless of the id. */
export type PrefixMode = 'auto' | 'off' | 'e5';

/**
 * `e5` as a segment of the model id, not as two letters inside a word: `Xenova/multilingual-e5-small`
 * and `intfloat/e5-base-v2` are E5 models, `sentence-t5-base` is not.
 */
const E5_MODEL = /(?:^|[/\-_.])e5(?:[/\-_.]|$)/i;

/**
 * The prefixes to put in front of each side's texts, or null for a model that wants none.
 * Auto-detection is the deliverable; `mode` is the escape hatch for a mirrored or renamed
 * checkpoint the id cannot speak for.
 */
export function inputPrefixes(model: string, mode: PrefixMode = 'auto'): Readonly<Record<EmbedKind, string>> | null {
  if (mode === 'off') return null;
  if (mode === 'e5') return E5_PREFIXES;
  return E5_MODEL.test(model) ? E5_PREFIXES : null;
}

/**
 * How a model's per-token outputs are folded into one vector: the average over the tokens,
 * or the first (`[CLS]`) token alone, in the transformers.js pipeline's own names. A model
 * is trained with one of them and the other reads its outputs wrong. Nothing fails: the
 * graph still returns a unit vector of the right width, it just retrieves worse, in the same
 * silent way a missing E5 prefix does.
 */
export const POOLING_MODES = ['mean', 'cls'] as const;

export type PoolingMode = (typeof POOLING_MODES)[number];

/**
 * How the pooling is chosen: from the table below, or one mode regardless of the model.
 * The same two-part shape as {@link PrefixMode}, with a different oracle underneath: for
 * prefixes the default layer infers from the model id, for pooling no inference is
 * possible (see {@link MODEL_POOLING}), so the default layer is a curated table instead.
 */
export type PoolingSetting = 'auto' | PoolingMode;

/**
 * What every local vector ever built was pooled with, and what a model absent from
 * {@link MODEL_POOLING} still is. Right for the default MiniLM and for the E5 family, which
 * is to say for every model this project has recommended; wrong for about half of the
 * multilingual models whose `1_Pooling/config.json` was read for this table, and unlike the E5 prefixes
 * nothing in a model id says which half.
 */
export const DEFAULT_POOLING: PoolingMode = 'mean';

/**
 * The pooling each known model was trained with, by the ids someone might put in
 * ZOTEUS_EMBEDDING_MODEL: the ONNX repository the pipeline loads and the source repository
 * it mirrors, since both ids name the same weights. Matched exactly, as the setting is
 * passed through.
 *
 * Curated rather than read, because there is nothing to read from. A model's pooling is
 * published in `1_Pooling/config.json`, a sentence-transformers file that lives on the
 * source repository only: the ONNX mirrors the pipeline loads (`Xenova/*`,
 * `onnx-community/*`) do not republish it, so unlike an E5 prefix there is nothing for
 * id-inference to look at, and transformers.js takes whatever pooling the caller names.
 *
 * Every value was read from that file on the repository named beside it, on 2026-09-03,
 * and says so: a pooling copied from a sibling model is how this goes wrong in the first
 * place. `cls` is the half a cross-lingual library pays for. Measured on a 257-passage, 68-query
 * cross-lingual set with pooling as the only variable, at fp32, mean pooling costs
 * `granite-embedding-97m-multilingual-r2` 27.5% of its MRR and 34.6% of its hit@1,
 * `gte-multilingual-base` 12.7% and `arctic-embed-m-v2` 10.3% of theirs, on a cross-lingual
 * set; docs/semantic-search.md carries the rest and where they came from. The `mean` rows are here so a reader can tell "known to be mean" from "unlisted, so
 * mean by default", which the code cannot otherwise distinguish.
 */
export const MODEL_POOLING: Readonly<Record<string, PoolingMode>> = {
  // sentence-transformers/all-MiniLM-L6-v2: pooling_mode_mean_tokens true, every other
  // mode false. The default, whose vectors must not move: this row says what the call
  // site always said.
  'Xenova/all-MiniLM-L6-v2': 'mean',
  'sentence-transformers/all-MiniLM-L6-v2': 'mean',
  // intfloat/multilingual-e5-small, -base and -large, and intfloat/e5-base-v2:
  // pooling_mode_mean_tokens true, every other mode false, on each.
  'Xenova/multilingual-e5-small': 'mean',
  'intfloat/multilingual-e5-small': 'mean',
  'Xenova/multilingual-e5-base': 'mean',
  'intfloat/multilingual-e5-base': 'mean',
  'Xenova/multilingual-e5-large': 'mean',
  'intfloat/multilingual-e5-large': 'mean',
  'intfloat/e5-base-v2': 'mean',
  // sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2 and
  // -mpnet-base-v2: pooling_mode_mean_tokens true, every other mode false, on each.
  'Xenova/paraphrase-multilingual-MiniLM-L12-v2': 'mean',
  'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2': 'mean',
  'Xenova/paraphrase-multilingual-mpnet-base-v2': 'mean',
  'sentence-transformers/paraphrase-multilingual-mpnet-base-v2': 'mean',
  // ibm-granite/granite-embedding-97m-multilingual-r2 and -311m-multilingual-r2:
  // pooling_mode_cls_token true, every other mode false, on each.
  'onnx-community/granite-embedding-97m-multilingual-r2-ONNX': 'cls',
  'ibm-granite/granite-embedding-97m-multilingual-r2': 'cls',
  'onnx-community/granite-embedding-311m-multilingual-r2-ONNX': 'cls',
  'ibm-granite/granite-embedding-311m-multilingual-r2': 'cls',
  // Alibaba-NLP/gte-multilingual-base: pooling_mode_cls_token true, every other mode false.
  'onnx-community/gte-multilingual-base': 'cls',
  'Alibaba-NLP/gte-multilingual-base': 'cls',
  // Snowflake/snowflake-arctic-embed-m-v2.0 and -l-v2.0: pooling_mode_cls_token true, every
  // other mode false, on each. Snowflake publishes the ONNX graph in the source repository
  // itself, so each has one id.
  'Snowflake/snowflake-arctic-embed-m-v2.0': 'cls',
  'Snowflake/snowflake-arctic-embed-l-v2.0': 'cls',
  // BAAI/bge-m3: pooling_mode_cls_token true, every other mode false.
  'onnx-community/bge-m3-ONNX': 'cls',
  'Xenova/bge-m3': 'cls',
  'BAAI/bge-m3': 'cls',
  // BAAI/bge-small-en-v1.5 and -base-en-v1.5: pooling_mode_cls_token true, every other mode
  // false, on each. English only -- named in issue #51 as the live exposure once a model
  // could be named at all.
  'Xenova/bge-small-en-v1.5': 'cls',
  'BAAI/bge-small-en-v1.5': 'cls',
  'Xenova/bge-base-en-v1.5': 'cls',
  'BAAI/bge-base-en-v1.5': 'cls',
  // mixedbread-ai/mxbai-embed-large-v1: pooling_mode_cls_token true, every other mode false.
  // Publishes its own ONNX graph, the way Snowflake does, so there is one id rather than a
  // mirror pair.
  'mixedbread-ai/mxbai-embed-large-v1': 'cls',
  // Snowflake/snowflake-arctic-embed-s: pooling_mode_cls_token true, every other mode false,
  // read the same way as the m/l checkpoints above.
  'Snowflake/snowflake-arctic-embed-s': 'cls',
};

/**
 * The pooling to ask the pipeline for. The table is the deliverable: a model it does not
 * know keeps {@link DEFAULT_POOLING}, which is exactly what it got before the table
 * existed, so no install changes and nobody is refused a model for being unlisted. `mode`
 * is the escape hatch for a mirrored or renamed checkpoint the table cannot speak for,
 * exactly as it is for {@link inputPrefixes}; and as there, a wrong value does not error,
 * it retrieves worse, which is why the table and not the setting is the default layer.
 */
export function poolingFor(model: string, mode: PoolingSetting = 'auto'): PoolingMode {
  if (mode !== 'auto') return mode;
  return MODEL_POOLING[model] ?? DEFAULT_POOLING;
}

/**
 * Identity of the vectors a provider produces. Two models never share a vector space (nor,
 * usually, a dimension), so an index persists this and refuses to rank its stored vectors
 * against queries embedded by a different one. See SearchIndex.loadFromJSON.
 */
export function embedderIdentity(p: {
  name: string;
  model?: string;
  dtype?: EmbeddingDtype;
  pooling?: PoolingMode;
}): string {
  const base = p.model ? `${p.name}:${p.model}` : p.name;
  // Full precision stays unsuffixed, and that is a compatibility decision rather than a
  // cosmetic one: `local:Xenova/all-MiniLM-L6-v2` is the identity stamped into every local
  // index ever built, all of them at fp32. Spelling it `...@fp32` now would declare every
  // one of those stale and charge a full re-embed for a setting nobody touched. Any other
  // precision is a different vector space and says so (#43).
  const dtyped = p.dtype && p.dtype !== DEFAULT_LOCAL_DTYPE ? `${base}@${p.dtype}` : base;
  // The pooling earns the same treatment for the same reason, and it needs it more. Two
  // poolings of one model are as different a vector space as two models are -- cosine
  // between the mean and CLS readings of the same text runs around 0.5 on MiniLM, which is
  // barely better aligned than unrelated sentences -- and unlike a dtype they share a
  // dimension, so the width check that catches a foreign vector cannot see this one. Every
  // index ever built was pooled the default way, so the default stays unsuffixed and none
  // of them is disturbed; a model the table moves to `cls`, or an override that departs
  // from the table, is a different space and now says so instead of being left to a
  // release note the reader has to act on.
  return p.pooling && p.pooling !== DEFAULT_POOLING ? `${dtyped}#${p.pooling}` : dtyped;
}

/**
 * Pause between embedding batches. 0 (the default) only yields, so a long build stays
 * interruptible and the event loop breathes; a positive value sleeps, which is how a build
 * stays under an API provider's tokens-per-minute limit.
 */
export function batchPause(delayMs = 0): Promise<void> {
  return new Promise((resolve) => {
    if (delayMs > 0) setTimeout(resolve, delayMs);
    else setImmediate(resolve);
  });
}

/** First wait, doubled per attempt: 1s, 2s, 4s, 8s, 16s. */
export const EMBED_RETRY_BASE_MS = 1_000;

/**
 * Ceiling on ONE wait, honoured Retry-After included. A provider asking for longer than a
 * minute is asking the build to sit idle for longer than it takes to notice something is
 * wrong; the retry budget below is what decides whether to keep trying at all.
 */
export const EMBED_RETRY_MAX_WAIT_MS = 60_000;

/**
 * Ceiling on the TOTAL time one request may spend waiting across all its retries. Bounds
 * the pathological case the per-wait cap does not: a provider that answers every attempt
 * with a large Retry-After would otherwise stall a build for as long as it liked.
 */
export const EMBED_RETRY_TOTAL_MS = 180_000;

/**
 * Whether an HTTP status is worth trying again.
 *
 * 429 is the one this exists for. 5xx joins it because a gateway hiccup is no more the
 * build's fault than a rate limit is, and 408 because a request timeout is the same event
 * seen from the other end.
 *
 * 400 is deliberately absent, and that omission is load-bearing: OpenAI answers 400 when a
 * request carries more tokens than it accepts, which is a batch that will be exactly as
 * oversized on every retry. Retrying it would turn an instant, actionable failure ("lower
 * ZOTEUS_EMBED_BATCH_SIZE") into a slow one. So are 401 and 403: a bad key does not heal.
 */
export function retryableEmbedStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

/**
 * `Retry-After` in milliseconds, in either form the header is allowed to take: a count of
 * seconds, or an HTTP date. Undefined when the header is absent or unparseable, which
 * leaves the caller on its own exponential schedule rather than on a wait of zero.
 */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | undefined {
  const raw = header?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/**
 * How long to wait before retry number `attempt` (1-based).
 *
 * Exponential from {@link EMBED_RETRY_BASE_MS}, plus up to 25% jitter so a build that hit
 * the limit on several concurrent requests does not send them all back at the same
 * instant. A server-supplied `Retry-After` replaces the exponential term outright, because
 * the server knows when its window reopens and this side is guessing; the jitter is still
 * added on top, and the per-wait cap still applies to both.
 */
export function embedBackoffMs(attempt: number, retryAfterMs?: number, random: () => number = Math.random): number {
  const base = retryAfterMs ?? EMBED_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(base, EMBED_RETRY_MAX_WAIT_MS);
  return Math.round(capped * (1 + 0.25 * random()));
}

/** How a wait reads in a log line: seconds, to one decimal, because that is the unit people wait in. */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The numbers a user staring at a 429 needs, and the two variables that produce them.
 *
 * Verbatim from #48, where a 10,428-item library rode exactly at OpenAI's Tier 2 ceiling of
 * 1M tokens/min with the default batching and 429'd on six consecutive builds, and these
 * settings then carried the same library through in one uninterrupted 45-minute run. A
 * concrete pair of numbers that is known to have worked is worth more here than advice to
 * "lower the batch size", which is what the docs already said and what the reporter could
 * not find.
 */
export const RATE_LIMIT_HINT =
  'If it keeps happening, pace the build: ZOTEUS_EMBED_BATCH_SIZE=256 with ' +
  'ZOTEUS_EMBED_BATCH_DELAY_MS=8000 holds a large full-text build at roughly 400k tokens/min, ' +
  "comfortably under OpenAI's 1M tokens/min Tier 2 limit.";

const DIM = 64;

/** Deterministic, dependency-free embedder. Not semantic — used for tests/plumbing. */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'fake';
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array(DIM).fill(0);
      const tokens = t.toLowerCase().match(/[a-z0-9]+/g) ?? [];
      for (const tok of tokens) {
        let h = 2166136261;
        for (let i = 0; i < tok.length; i++) h = (h ^ tok.charCodeAt(i)) * 16777619;
        v[Math.abs(h) % DIM] += 1;
      }
      const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / mag);
    });
  }
}

/**
 * Directories to resolve {@link TRANSFORMERS_MODULE} from when ZOTEUS_TRANSFORMERS_PATH is
 * set. Node's own walk-up covers the two common answers (a `node_modules` directory, or the
 * package directory itself, whose ancestors include one); the `lib` candidate additionally
 * accepts an npm *prefix* such as `/usr`, where globals live in `/usr/lib/node_modules`.
 */
function overrideRoots(dir: string): string[] {
  return [dir, join(dir, 'lib')];
}

/**
 * Resolve the transformers entry point WITHOUT executing it: a cheap, side-effect-free
 * probe of whether on-device embeddings can actually load. Returns the URL to import, or
 * null when the package is not reachable from this process.
 *
 * This is what makes the degradation reportable *before* a build: a bundled install
 * (.mcpb) resolves only from inside its own folder, which cannot carry the package (the
 * resolved tree is roughly 700 MB, onnxruntime's native binaries included; see
 * docs/semantic-search.md), so status can say so up front instead of silently indexing 0
 * vectors. ZOTEUS_TRANSFORMERS_PATH is the escape hatch: it points at an install that
 * lives outside the bundle and therefore survives extension updates.
 */
export function resolveTransformers(transformersPath?: string): string | null {
  const dir = transformersPath?.trim();
  if (dir) {
    for (const root of overrideRoots(dir)) {
      try {
        // A non-existent package.json is fine: createRequire only needs a base path to
        // start the node_modules walk-up from.
        const req = createRequire(pathToFileURL(join(root, 'package.json')));
        return pathToFileURL(req.resolve(TRANSFORMERS_MODULE)).href;
      } catch {
        // Try the next reading of the configured path.
      }
    }
    return null;
  }
  try {
    return import.meta.resolve(TRANSFORMERS_MODULE);
  } catch {
    return null;
  }
}

/**
 * Where the resolver was told to look, in the words of the setting that sent it there.
 *
 * A wrong ZOTEUS_TRANSFORMERS_PATH is the commonest way local embeddings fail on a desktop
 * install (#38), and until now the path appeared in nothing the user could read: it lives
 * in a settings pane, its only other copy is in an environment nobody can print, and every
 * message said "not installed" whether the package was absent or merely somewhere else.
 * Naming the directory turns an unfalsifiable claim into one `ls` away from an answer.
 */
function searchedHint(transformersPath?: string): string {
  const dir = transformersPath?.trim();
  if (!dir) return '';
  return (
    ` ZOTEUS_TRANSFORMERS_PATH is set to "${dir}", and ${TRANSFORMERS_MODULE} resolves from ` +
    `neither it nor "${join(dir, 'lib')}".`
  );
}

/** The same fact as {@link searchedHint}, in the middle of a sentence rather than after one. */
function searchedFrom(transformersPath?: string): string {
  const dir = transformersPath?.trim();
  return dir ? ` (ZOTEUS_TRANSFORMERS_PATH=${dir})` : '';
}

/** A resolved specifier as a path someone can paste into `ls`, not as a file:// URL. */
function modulePath(specifier: string): string {
  try {
    return specifier.startsWith('file:') ? fileURLToPath(specifier) : specifier;
  } catch {
    return specifier;
  }
}

/**
 * Actionable, install-channel-aware explanation for "local embeddings requested but
 * unavailable". Desktop bundles get different advice from npm installs because there is
 * no `npm i` step to have skipped: the package has to live outside the bundle.
 */
export function missingTransformersHint(config?: Pick<ZoteusConfig, 'dist' | 'transformersPath'>): string {
  const bundled = config?.dist === 'mcpb' || config?.dist === 'dxt';
  // The FIRST sentence is the short cause that ends up in the one-line embedder label
  // (see shortCause in index-manager); everything after it is the remedy. Keep it short.
  const cause = `${TRANSFORMERS_MODULE} is not installed.`;
  const searched = searchedHint(config?.transformersPath);
  const fallbacks =
    `Otherwise set ZOTEUS_EMBEDDINGS=openai or gemini to embed through an API instead (your ` +
    `library text leaves the machine), or ZOTEUS_EMBEDDINGS=off to accept keyword-only search.`;
  if (bundled) {
    // Deliberately NOT `npm i -g`. Claude Desktop runs the server with its own built-in
    // Node, not the one on the user's PATH, so a global root under a version manager holds
    // onnxruntime binaries built for a Node this process never executes, and an nvm switch
    // later moves the directory out from under the setting (#38). A directory of its own,
    // owned by nobody's version manager, is the install that keeps working.
    return (
      `${cause} Semantic ranking is off; keyword (BM25) search still works.${searched} Desktop-extension ` +
      `bundles cannot ship it: the resolved dependency tree, onnxruntime's native binaries included, is ` +
      `about 700 MB. Install it into a directory of its own, outside any Node version manager (the ` +
      `desktop app runs this server with its own built-in Node, not the one on your PATH): ` +
      `\`mkdir -p ~/.zoteus-deps && cd ~/.zoteus-deps && npm init -y && npm i ${TRANSFORMERS_MODULE}\`, ` +
      `then set the extension's "Local embeddings path" (ZOTEUS_TRANSFORMERS_PATH) to that folder's ` +
      `node_modules. It survives extension updates and Node version switches alike. ${fallbacks}`
    );
  }
  return (
    `${cause} Semantic ranking is off; keyword (BM25) search still works.${searched} Install it with ` +
    `\`npm i ${TRANSFORMERS_MODULE}\`, or point ZOTEUS_TRANSFORMERS_PATH at a directory that ` +
    `already has it. ${fallbacks}`
  );
}

/**
 * Why a pipeline failed to construct, with the precision named when the precision is the
 * likely reason.
 *
 * A dtype is not a knob on the model, it is a *file*: `q8` asks the repo for
 * `onnx/model_quantized.onnx`, and a repo that never uploaded that file answers with a
 * fetch failure naming a path, not with "this model has no q8". The two repos serving the
 * same model differ here (#43): the community mirrors under `Xenova/` publish the whole
 * suffixed set, while a model's own repo often publishes the plain fp32 graph alone. So the
 * user who set one variable gets told which variable to unset, and which repo does carry
 * what they asked for.
 */
export function dtypeLoadHint(model: string, dtype: EmbeddingDtype, cause: unknown): string {
  const why = cause instanceof Error ? cause.message : String(cause);
  if (dtype === DEFAULT_LOCAL_DTYPE) {
    return `Could not load the local embedding model "${model}" (${why}).`;
  }
  return (
    `Could not load the local embedding model "${model}" at ZOTEUS_EMBEDDING_DTYPE=${dtype} (${why}). ` +
    `A dtype names a file the repository has to publish, not a conversion Zoteus performs, so a ` +
    `repository that uploaded only full-precision weights fails here and would load with ` +
    `ZOTEUS_EMBEDDING_DTYPE unset. The Xenova mirrors publish the quantized variants: ` +
    `Xenova/multilingual-e5-small and Xenova/all-MiniLM-L6-v2 both serve ${dtype}.`
  );
}

/**
 * What one pipeline call answers with, and all the main thread ever sees of it: the
 * row-major vectors of one batch, and their shape when the pipeline reports one.
 */
interface EmbedOutput {
  data: ArrayLike<number>;
  dims?: number[];
}

/** One feature-extraction call, wherever it actually runs. */
type Extractor = (input: string[], options: { pooling: PoolingMode; normalize: true }) => Promise<EmbedOutput>;

/**
 * Why the transformers module could not be brought up, in the worker's own words: which
 * step failed and what it said. The message the user reads is composed on this side, from
 * these two facts, so that it is the same sentence whichever thread did the loading.
 */
type LoadFailure = { stage: 'import' | 'shape' | 'pipeline'; error: string };

/**
 * The thread that hosts the model. Everything from the import of the transformers package
 * to the last inference happens here, and the reason is onnxruntime-node: its `run()` is a
 * synchronous native call behind a `setImmediate`, so on the main thread every batch froze
 * the whole process for as long as the model took (seconds for a small model, tens of
 * seconds for a large one at full precision). While a build or update was embedding, the
 * HTTP server answered nothing, a status poll waited for the batch to end, and an
 * `initialize`, which needs several turns of the event loop, could not complete inside a
 * client's timeout at all (#59). In here the same call blocks only this thread.
 *
 * Plain CommonJS handed to `new Worker(source, { eval: true })` rather than a file of its
 * own: there is then nothing to resolve relative to `import.meta.url`, which points at a
 * `.ts` source under the test runner and at `dist/` in production, and nothing extra for a
 * desktop bundle to ship. The transformers package itself is imported dynamically from the
 * URL the main thread already resolved, so the worker never repeats the search for it.
 *
 * Requests are answered in the order they arrive: one model, one thread, so a query that
 * lands while a build is embedding waits for the batch in flight and no longer. The
 * vectors travel back as one Float32Array whose buffer is transferred, not copied.
 */
const EMBED_WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { specifier, model, dtype, cacheDir } = workerData;
const fail = (id, stage, e) =>
  parentPort.postMessage({ id, ok: false, stage, error: e instanceof Error ? e.message : String(e) });
let extractor;
let chain = Promise.resolve();
(async () => {
  let transformers;
  try {
    transformers = await import(specifier);
  } catch (e) {
    return fail(0, 'import', e);
  }
  const pipeline = transformers.pipeline ?? (transformers.default && transformers.default.pipeline);
  if (typeof pipeline !== 'function') return fail(0, 'shape', new Error('no pipeline()'));
  const env = transformers.env ?? (transformers.default && transformers.default.env);
  if (env && cacheDir) env.cacheDir = cacheDir;
  try {
    extractor = await pipeline('feature-extraction', model, { dtype });
  } catch (e) {
    return fail(0, 'pipeline', e);
  }
  parentPort.postMessage({ id: 0, ok: true });
})();
parentPort.on('message', (msg) => {
  chain = chain.then(async () => {
    try {
      const tensor = await extractor(msg.input, msg.options);
      const data = Float32Array.from(tensor.data);
      const dims = Array.isArray(tensor.dims) ? Array.from(tensor.dims) : undefined;
      parentPort.postMessage({ id: msg.id, ok: true, data, dims }, [data.buffer]);
    } catch (e) {
      fail(msg.id, 'embed', e);
    }
  });
});
`;

/** What the worker posts back: the load verdict (id 0), or one batch's answer. */
type WorkerReply =
  | { id: number; ok: true; data?: Float32Array; dims?: number[] }
  | { id: number; ok: false; stage: LoadFailure['stage'] | 'embed'; error: string };

/**
 * A worker that never came up at all, as opposed to one that came up and reported that the
 * transformers package would not load. The first is a property of the runtime and the
 * in-thread loader is tried instead; the second would fail there identically.
 */
class EmbedWorkerUnavailable extends Error {}

/**
 * The sentence for a package that resolved and then blew up on import. Almost always a
 * native onnxruntime binary that does not match this platform/Node ABI. Say that, rather
 * than "not installed", and say WHICH file was loaded, under which Node. That is the whole
 * diagnosis for the desktop failure in #38: the extension runs its own built-in Node, so a
 * package installed under a version manager (or left behind by an nvm switch) resolves
 * perfectly and then fails on a binary compiled for a different runtime. Without the path
 * and the version, the two halves of that sentence are invisible.
 */
function importFailureHint(specifier: string, transformersPath: string | undefined, cause: string): string {
  return (
    `${TRANSFORMERS_MODULE} resolved but failed to load (${cause}). ` +
    `Loaded from ${modulePath(specifier)}${searchedFrom(transformersPath)}, running Node ` +
    `${process.version} on ${process.platform}-${process.arch}. ` +
    'Reinstall it for this platform and Node version, or set ZOTEUS_EMBEDDINGS=off for keyword-only search.'
  );
}

const NO_PIPELINE_HINT = `${TRANSFORMERS_MODULE} loaded but exposes no pipeline(). Is the install complete?`;

/** Local on-device embeddings via @huggingface/transformers (optional, lazy). */
export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local';
  /** Texts handed to the transformers pipeline in a single call. */
  static readonly BATCH_SIZE = DEFAULT_EMBED_BATCH_SIZE;
  private extractor: Extractor | undefined;
  /**
   * The load in progress, shared by every caller that arrives while it runs. Without it a
   * query landing during a build's first batch started a second pipeline, which under the
   * worker would be a second thread holding a second copy of the weights.
   */
  private loading: Promise<Extractor> | undefined;
  private worker: Worker | undefined;
  /** Batches posted to the worker and not yet answered, by request id. */
  private readonly pending = new Map<number, { resolve: (out: EmbedOutput) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  constructor(
    readonly model: string = DEFAULT_LOCAL_MODEL,
    /** Injectable extractor factory (tests); defaults to the transformers.js pipeline. */
    private readonly loadExtractor?: () => Promise<any>,
    private readonly opts: {
      transformersPath?: string;
      dist?: string;
      /** Where downloaded model weights live (see modelCacheDir); unset keeps the package's default. */
      modelCacheDir?: string;
      /** Texts per pipeline call (defaults to BATCH_SIZE). */
      batchSize?: number;
      /** Pause between batches in ms (see batchPause). */
      batchDelayMs?: number;
      /** Input-prefix policy for this model (see inputPrefixes); unset means auto. */
      prefixes?: PrefixMode;
      /** Weight precision to load (see DEFAULT_LOCAL_DTYPE); unset means full precision. */
      dtype?: EmbeddingDtype;
      /** Pooling policy for this model (see poolingFor); unset means auto, i.e. the table. */
      pooling?: PoolingSetting;
      /** Where a fallback to in-thread loading announces itself; without one it is silent. */
      logger?: Logger;
    } = {},
  ) {}

  /** The precision this provider loads at, and the one its identity is stamped with. */
  get dtype(): EmbeddingDtype {
    return this.opts.dtype ?? DEFAULT_LOCAL_DTYPE;
  }

  /**
   * What this model wants in front of a query and in front of a passage, or null. Computed
   * from the model id, so it never reaches the embedder identity or the stored text: the
   * prefix is an argument to the model, not a property of the vectors it returns.
   */
  get prefixes(): Readonly<Record<EmbedKind, string>> | null {
    return inputPrefixes(this.model, this.opts.prefixes ?? 'auto');
  }

  /**
   * How the pipeline folds this model's tokens into one vector (see {@link MODEL_POOLING}).
   * Decided by the model id with the setting as the override, like the prefixes; unlike
   * them it reaches the identity, because the two readings of one model are two vector
   * spaces of the same width and nothing downstream could otherwise tell them apart. See
   * {@link embedderIdentity}, where anything but the default is suffixed.
   */
  get pooling(): PoolingMode {
    return poolingFor(this.model, this.opts.pooling ?? 'auto');
  }

  private ensure(): Promise<Extractor> {
    if (this.extractor) return Promise.resolve(this.extractor);
    this.loading ??= this.load().then(
      (extractor) => (this.extractor = extractor),
      (e) => {
        // Not cached: the next call retries, exactly as the in-thread loader always did.
        this.loading = undefined;
        throw e;
      },
    );
    return this.loading;
  }

  /**
   * Bring the model up: through an injected factory (tests), in a worker thread (the
   * production path, see EMBED_WORKER_SOURCE), or on this thread when a worker cannot be
   * started at all. A worker that starts and then reports that the package will not load is
   * not a reason to try the other loader: it would fail there identically, and it would
   * cost the failing import a second time.
   */
  private async load(): Promise<Extractor> {
    if (this.loadExtractor) return this.loadExtractor();
    const specifier = resolveTransformers(this.opts.transformersPath);
    if (!specifier)
      throw new Error(
        missingTransformersHint({ dist: this.opts.dist, transformersPath: this.opts.transformersPath }),
      );
    try {
      return await this.spawn(specifier);
    } catch (e) {
      if (!(e instanceof EmbedWorkerUnavailable)) throw e;
      this.opts.logger?.warn(
        `Local embeddings could not be moved to a worker thread (${e.message}); the model runs on the ` +
          "server's main thread instead, which pauses every request for as long as one batch takes to embed.",
      );
      return this.loadInThread(specifier);
    }
  }

  /** The worker, up and holding a pipeline, wrapped as an extractor the main thread can call. */
  private spawn(specifier: string): Promise<Extractor> {
    return new Promise((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(EMBED_WORKER_SOURCE, {
          eval: true,
          workerData: { specifier, model: this.model, dtype: this.dtype, cacheDir: this.opts.modelCacheDir },
        });
      } catch (e) {
        reject(new EmbedWorkerUnavailable(e instanceof Error ? e.message : String(e)));
        return;
      }
      let ready = false;
      worker.on('message', (msg: WorkerReply) => {
        if (msg.id === 0) {
          if (msg.ok) {
            ready = true;
            this.worker = worker;
            // Never the reason the process stays alive: an idle model is not pending work.
            worker.unref();
            resolve(this.remoteExtractor(worker));
          } else {
            reject(new Error(this.loadFailureHint(specifier, msg)));
            void worker.terminate();
          }
          return;
        }
        const waiter = this.pending.get(msg.id);
        if (!waiter) return;
        this.pending.delete(msg.id);
        if (this.pending.size === 0) worker.unref();
        if (msg.ok) waiter.resolve({ data: msg.data ?? new Float32Array(0), dims: msg.dims });
        else waiter.reject(new Error(msg.error));
      });
      const died = (cause: string): void => {
        if (this.worker === worker) {
          this.worker = undefined;
          this.extractor = undefined;
          this.loading = undefined;
        }
        const waiting = [...this.pending.values()];
        this.pending.clear();
        const error = new Error(`The local embedding worker stopped unexpectedly (${cause}).`);
        for (const w of waiting) w.reject(error);
        if (!ready) reject(new EmbedWorkerUnavailable(cause));
      };
      worker.on('error', (e) => died(e instanceof Error ? e.message : String(e)));
      worker.on('exit', (code) => died(`exit code ${code}`));
    });
  }

  private remoteExtractor(worker: Worker): Extractor {
    return (input, options) =>
      new Promise((resolve, reject) => {
        const id = this.nextId++;
        this.pending.set(id, { resolve, reject });
        // Referenced only while a batch is in flight, so a caller awaiting vectors is never
        // left with an exited process, and an idle worker never holds it open.
        if (this.pending.size === 1) worker.ref();
        worker.postMessage({ id, input, options });
      });
  }

  private loadFailureHint(specifier: string, failure: { stage: LoadFailure['stage'] | 'embed'; error: string }): string {
    switch (failure.stage) {
      case 'import':
        return importFailureHint(specifier, this.opts.transformersPath, failure.error);
      case 'shape':
        return NO_PIPELINE_HINT;
      default:
        return dtypeLoadHint(this.model, this.dtype, failure.error);
    }
  }

  /**
   * The loader the worker replaced, kept for a runtime that cannot start one. Every step
   * matches the worker's, message for message.
   */
  private async loadInThread(specifier: string): Promise<Extractor> {
    let transformers: any;
    try {
      transformers = await import(specifier);
    } catch (e) {
      throw new Error(importFailureHint(specifier, this.opts.transformersPath, e instanceof Error ? e.message : String(e)));
    }
    // The package ships both an ESM and a CJS build; a resolved CJS entry arrives under `default`.
    const pipeline = transformers.pipeline ?? transformers.default?.pipeline;
    if (typeof pipeline !== 'function') throw new Error(NO_PIPELINE_HINT);
    // Pin the model cache before the pipeline downloads anything. The package's default
    // caches weights inside its own install directory, which outlives the data directory,
    // and for a bundled desktop install pointed at a global module via
    // ZOTEUS_TRANSFORMERS_PATH, outlives the extension too. Deleting the data directory
    // is supposed to be the whole uninstall, and the weights are its largest artifact.
    const env = transformers.env ?? transformers.default?.env;
    if (env && this.opts.modelCacheDir) env.cacheDir = this.opts.modelCacheDir;
    try {
      return await pipeline('feature-extraction', this.model, { dtype: this.dtype });
    } catch (e) {
      throw new Error(dtypeLoadHint(this.model, this.dtype, e));
    }
  }

  /**
   * Stop the worker and forget the model. Anything still waiting on a batch is told so.
   * The next embed() starts over, which is also what happens after a worker dies on its own.
   */
  async close(): Promise<void> {
    // A load still in flight settles first: killing its worker halfway would read as a
    // runtime that cannot start one, and send the loader down the in-thread path.
    if (this.loading) await this.loading.catch(() => {});
    const worker = this.worker;
    this.worker = undefined;
    this.extractor = undefined;
    this.loading = undefined;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const w of waiting) w.reject(new Error('The local embedding worker was closed.'));
    await worker?.terminate();
  }

  /**
   * Embed texts in batches through the pipeline (one call per batch instead of one
   * per text), yielding to the event loop between batches so long builds stay
   * responsive and interruptible. Returns exactly one vector per input text.
   */
  async embed(texts: string[], kind: EmbedKind = 'passage'): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.ensure();
    const size = Math.max(1, this.opts.batchSize ?? LocalEmbeddingProvider.BATCH_SIZE);
    const prefix = this.prefixes?.[kind] ?? '';
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += size) {
      const batch = texts.slice(i, i + size);
      const input = prefix ? batch.map((t) => prefix + t) : batch;
      // The pooling is the model's, not this call site's: the literal `mean` that stood
      // here was right for MiniLM and E5 and silently wrong for every CLS-pooled model
      // ZOTEUS_EMBEDDING_MODEL can name. Normalization stays unconditional, and the reason
      // is not that scale cannot matter: the SQLite codes are sign bits taken after a corpus
      // mean is subtracted, and subtracting a constant is precisely what a rescaling does not
      // survive. It is that this line is the only place vectors are produced, so index and
      // query are scaled alike and the corpus mean is measured on the same scale it is
      // subtracted from. Cosine is scale-free besides. A model that publishes no Normalize
      // module is therefore not mis-served here the way a CLS model was.
      const tensor = await extractor(input, { pooling: this.pooling, normalize: true });
      const data = tensor.data;
      const dims = tensor.dims;
      const dim = dims && dims.length > 1 ? dims[dims.length - 1]! : data.length / batch.length;
      for (let b = 0; b < batch.length; b++) {
        const row = new Array<number>(dim);
        for (let i = 0; i < dim; i++) row[i] = data[b * dim + i]!;
        out.push(row);
      }
      if (i + size < texts.length) await batchPause(this.opts.batchDelayMs);
    }
    return out;
  }
}

export interface ApiEmbeddingOptions {
  /** Model to embed with; defaults to the provider's own (see DEFAULT_API_MODELS). */
  model?: string;
  /** Max texts per request. Unset sends them all in one request, as before. */
  batchSize?: number;
  /** Pause between requests in ms (see batchPause). */
  batchDelayMs?: number;
  /** Retries a rate-limited or 5xx request gets (see DEFAULT_EMBED_MAX_RETRIES). */
  maxRetries?: number;
  /** Where the backoff announces itself; without one the waits are silent. */
  logger?: Logger;
  /** Injectable jitter source (tests). Defaults to Math.random. */
  random?: () => number;
}

/** OpenAI/Gemini embeddings (opt-in; data leaves the machine). */
export class ApiEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  /** Bare model name: the `models/` prefix is Gemini wire format, not part of the identity. */
  readonly model: string;
  constructor(
    private readonly kind: 'openai' | 'gemini',
    private readonly apiKey: string,
    private readonly opts: ApiEmbeddingOptions = {},
  ) {
    this.name = kind;
    this.model = (opts.model?.trim() || DEFAULT_API_MODELS[kind]).replace(/^models\//, '');
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const size = Math.max(1, this.opts.batchSize ?? texts.length);
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += size) {
      out.push(...(await this.embedBatch(texts.slice(i, i + size))));
      if (i + size < texts.length) await batchPause(this.opts.batchDelayMs);
    }
    return out;
  }

  /**
   * One request, retried through the backoff both providers share.
   *
   * `send` is called afresh per attempt (a Response body is consumed once, and a retry is a
   * new request, not a replayed one). Everything about *when* to try again lives here, so
   * the two provider bodies below stay a URL, a header and a payload shape.
   *
   * What is NOT retried is as deliberate as what is: see `retryableEmbedStatus`. A network
   * error is, because a dropped connection mid-build is the same transient event as a 503
   * and the alternative is losing an hours-long build to one flaky second.
   */
  private async request(label: string, send: () => Promise<Response>): Promise<Response> {
    const retries = Math.max(0, this.opts.maxRetries ?? DEFAULT_EMBED_MAX_RETRIES);
    const random = this.opts.random ?? Math.random;
    let waited = 0;
    for (let attempt = 1; ; attempt++) {
      let res: Response | undefined;
      let networkError: unknown;
      try {
        res = await send();
        if (res.ok) return res;
      } catch (e) {
        networkError = e;
      }
      const status = res?.status;
      const fatal = res !== undefined && !retryableEmbedStatus(res.status);
      const wait = embedBackoffMs(attempt, parseRetryAfter(res?.headers.get('retry-after')), random);
      const spent = waited + wait;
      if (fatal || attempt > retries || spent > EMBED_RETRY_TOTAL_MS) {
        if (networkError) throw networkError;
        // The same first sentence this has always thrown, so the one-line embedder label
        // ("openai requested; OpenAI embeddings failed (429)") reads exactly as before and
        // anything matching on it keeps working. The remedy is a second sentence.
        const gaveUp = attempt > 1 ? ` Gave up after ${attempt} attempts over ${seconds(waited)}.` : '';
        const advice = status === 429 ? ` ${RATE_LIMIT_HINT}` : '';
        throw new Error(`${label} embeddings failed (${status}).${gaveUp}${advice}`);
      }
      // Info rather than warn: a wait that the build then recovers from is progress being
      // reported, not a problem. It has to be visible all the same, because from the
      // outside an embedding pass that pauses for 16 seconds is indistinguishable from one
      // that has hung.
      const cause = networkError
        ? `could not be reached (${networkError instanceof Error ? networkError.message : String(networkError)})`
        : `answered ${status}`;
      const hint = status === 429 && attempt === 1 ? ` ${RATE_LIMIT_HINT}` : '';
      this.opts.logger?.info(
        `${label} ${cause}; waiting ${seconds(wait)} before retry ${attempt} of ${retries}.${hint}`,
      );
      await batchPause(wait);
      waited = spent;
    }
  }

  /** One request. Providers reject an oversized batch whole, hence the caller's batching. */
  private async embedBatch(texts: string[]): Promise<number[][]> {
    if (this.kind === 'openai') {
      const res = await this.request('OpenAI', () =>
        fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify({ model: this.model, input: texts }),
        }),
      );
      const json = (await res.json()) as any;
      return json.data.map((d: any) => d.embedding);
    }
    // The key travels in a header, like the OpenAI one above, never in the URL: URLs are
    // the part of a request that gets logged — by proxies, by error causes, by anything
    // that prints which endpoint failed — and Google accepts x-goog-api-key everywhere
    // ?key= works.
    const res = await this.request('Gemini', () =>
      fetch(`https://generativelanguage.googleapis.com/v1beta/models/${this.model}:batchEmbedContents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          requests: texts.map((t) => ({ model: `models/${this.model}`, content: { parts: [{ text: t }] } })),
        }),
      }),
    );
    const json = (await res.json()) as any;
    return json.embeddings.map((e: any) => e.values);
  }
}

/**
 * What ZOTEUS_EMBEDDINGS asked for, and whether it can actually be honoured. Keeping the
 * two apart is the point: reporting the *configured* provider as if it were active is what
 * turned a missing optional dependency into an invisible "0 vectors" failure (#7).
 */
export interface EmbedderSelection {
  /** Provider that will produce vectors, or null for keyword-only search. */
  provider: EmbeddingProvider | null;
  /** The requested ZOTEUS_EMBEDDINGS value. */
  configured: ZoteusConfig['embeddings'];
  /** Why no provider, when `configured` asked for one. Absent when nothing is wrong. */
  unavailable?: string;
}

/**
 * Build the configured provider. Preflights the local runtime so an install that cannot
 * embed is known at startup, before a build silently produces an index with 0 vectors.
 */
export function createEmbeddingProvider(config: ZoteusConfig, logger?: Logger): EmbedderSelection {
  // ZOTEUS_EMBEDDING_MODEL names the model of whichever provider is active, local included
  // (#43); the batch and delay dials apply to every provider that batches.
  const api: ApiEmbeddingOptions = {
    model: config.embeddingModel,
    batchSize: config.embedBatchSize,
    batchDelayMs: config.embedBatchDelayMs,
    maxRetries: config.embedMaxRetries,
    ...(logger ? { logger } : {}),
  };
  switch (config.embeddings) {
    case 'off':
      return { provider: null, configured: 'off' };
    case 'openai':
      if (!process.env.OPENAI_API_KEY) {
        const unavailable =
          'OPENAI_API_KEY is unset. No vectors are produced; keyword (BM25) search still works. ' +
          'Set the key, or pick another ZOTEUS_EMBEDDINGS provider.';
        logger?.warn(`ZOTEUS_EMBEDDINGS=openai but OPENAI_API_KEY is unset; using keyword-only search.`);
        return { provider: null, configured: 'openai', unavailable };
      }
      return { provider: new ApiEmbeddingProvider('openai', process.env.OPENAI_API_KEY, api), configured: 'openai' };
    case 'gemini':
      if (!process.env.GEMINI_API_KEY) {
        const unavailable =
          'GEMINI_API_KEY is unset. No vectors are produced; keyword (BM25) search still works. ' +
          'Set the key, or pick another ZOTEUS_EMBEDDINGS provider.';
        logger?.warn(`ZOTEUS_EMBEDDINGS=gemini but GEMINI_API_KEY is unset; using keyword-only search.`);
        return { provider: null, configured: 'gemini', unavailable };
      }
      return { provider: new ApiEmbeddingProvider('gemini', process.env.GEMINI_API_KEY, api), configured: 'gemini' };
    case 'local':
    default: {
      if (!resolveTransformers(config.transformersPath)) {
        logger?.warn(
          `ZOTEUS_EMBEDDINGS=local but ${TRANSFORMERS_MODULE} is not installed` +
            `${searchedFrom(config.transformersPath)}; using keyword-only search.`,
        );
        return { provider: null, configured: 'local', unavailable: missingTransformersHint(config) };
      }
      // Under Electron the batch is capped, because a single pipeline call big enough to
      // need a gigabyte in one block is refused by Chromium's allocator and takes the
      // process down with it (#37; see electron.ts). Off Electron this is the configured
      // value unchanged.
      const localBatchNotice = localEmbedBatchNotice(config.embedBatchSize);
      if (localBatchNotice) logger?.info(localBatchNotice);
      return {
        // The same knob as every other provider's: ZOTEUS_EMBEDDING_MODEL names the model of
        // whichever one is active, and unset means this provider's own default (#43).
        provider: new LocalEmbeddingProvider(config.embeddingModel || DEFAULT_LOCAL_MODEL, undefined, {
          transformersPath: config.transformersPath,
          dist: config.dist,
          modelCacheDir: join(config.dataDir, 'models'),
          batchSize: localEmbedBatchSize(config.embedBatchSize),
          batchDelayMs: config.embedBatchDelayMs,
          prefixes: config.embeddingPrefixes,
          // The precision the weights are downloaded and run at. It reaches the identity,
          // so switching it costs one rebuild rather than quietly mixing two vector spaces.
          dtype: config.embeddingDtype,
          pooling: config.embeddingPooling,
          ...(logger ? { logger } : {}),
        }),
        configured: 'local',
      };
    }
  }
}
