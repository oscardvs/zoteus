import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A stand-in for `@huggingface/transformers`, planted as a real package under a temp
 * directory so ZOTEUS_TRANSFORMERS_PATH resolves it the way an out-of-bundle install is
 * resolved. The package itself is an optional dependency and not installed in the suite.
 *
 * It reports through a FILE, not through module state. The local provider hosts the
 * module, the pipeline and every inference in a worker thread (#59), so the instance a
 * test could import on the main thread is not the one the provider talks to; what the
 * pipeline was constructed with and what each call handed it can only be seen from where
 * it ran. The record is appended synchronously before the call answers, so by the time
 * `embed()` resolves it is on disk.
 */

export const STUB_DEFAULT_CACHE = '/stub/default/.cache';

export interface PipelineRecord {
  kind: 'pipeline';
  task: string;
  model: string;
  options: Record<string, unknown> | undefined;
  /** What `env.cacheDir` held when the pipeline was constructed. */
  cacheDir: string;
}

export interface CallRecord {
  kind: 'call';
  model: string;
  input: string[];
  options: Record<string, unknown> | undefined;
}

export type StubRecord = PipelineRecord | CallRecord;

export interface TransformersStub {
  /** The directory to hand to ZOTEUS_TRANSFORMERS_PATH. */
  root: string;
  records(): StubRecord[];
  pipelines(): PipelineRecord[];
  calls(): CallRecord[];
  /** Forget everything recorded so far. */
  reset(): void;
  /**
   * Make pipeline() refuse that dtype the way a repository that never uploaded the file
   * does: a fetch failure naming a path. `null` accepts everything again.
   */
  refuse(dtype: string | null): void;
  remove(): void;
}

export interface StubOptions {
  /**
   * Milliseconds each extractor call spends busy-waiting, synchronously, the way
   * onnxruntime's `run()` does. What a test of event-loop freedom needs.
   */
  holdMs?: number;
  /** Vector width (2 by default). */
  dim?: number;
  /**
   * Give every vector its own values (row index, then text length) rather than 0.5
   * everywhere, so a test can tell whether the rows crossed the thread boundary intact.
   */
  distinct?: boolean;
}

/** The text an extractor call answers by exiting its thread, for the worker-death test. */
export const STUB_KILL_TEXT = '__kill the embedding thread__';

export function plantTransformersStub(prefix = 'zoteus-hf-stub-', opts: StubOptions = {}): TransformersStub {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const pkg = join(root, 'node_modules', '@huggingface', 'transformers');
  mkdirSync(pkg, { recursive: true });
  const log = join(root, 'stub-records.jsonl');
  const refuseFile = join(root, 'stub-refuse.txt');
  const dim = opts.dim ?? 2;
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@huggingface/transformers', main: 'index.cjs' }));
  writeFileSync(
    join(pkg, 'index.cjs'),
    `const fs = require('node:fs');
const LOG = ${JSON.stringify(log)};
const REFUSE = ${JSON.stringify(refuseFile)};
const HOLD_MS = ${opts.holdMs ?? 0};
const DIM = ${dim};
const DISTINCT = ${opts.distinct ? 'true' : 'false'};
const KILL = ${JSON.stringify(STUB_KILL_TEXT)};
const env = { cacheDir: ${JSON.stringify(STUB_DEFAULT_CACHE)} };
const record = (r) => fs.appendFileSync(LOG, JSON.stringify(r) + '\\n');
const missing = () => {
  try {
    return fs.readFileSync(REFUSE, 'utf8').trim() || null;
  } catch {
    return null;
  }
};
async function pipeline(task, model, options) {
  record({ kind: 'pipeline', task, model, options, cacheDir: env.cacheDir });
  const refused = missing();
  if (refused && options && options.dtype === refused) {
    throw new Error('Could not locate file: "https://huggingface.co/' + model + '/resolve/main/onnx/model_quantized.onnx".');
  }
  return async (input, callOptions) => {
    const batch = Array.isArray(input) ? input : [input];
    record({ kind: 'call', model, input: batch, options: callOptions });
    if (batch.includes(KILL)) process.exit(7);
    if (HOLD_MS > 0) {
      const end = Date.now() + HOLD_MS;
      while (Date.now() < end) {}
    }
    const data = new Float32Array(batch.length * DIM);
    for (let b = 0; b < batch.length; b++) {
      for (let i = 0; i < DIM; i++) data[b * DIM + i] = DISTINCT ? (i === 0 ? b : batch[b].length) : 0.5;
    }
    return { data, dims: [batch.length, DIM] };
  };
}
module.exports = { env, pipeline };
`,
  );
  const records = (): StubRecord[] => {
    let text: string;
    try {
      text = readFileSync(log, 'utf8');
    } catch {
      return [];
    }
    return text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as StubRecord);
  };
  return {
    root,
    records,
    pipelines: () => records().filter((r): r is PipelineRecord => r.kind === 'pipeline'),
    calls: () => records().filter((r): r is CallRecord => r.kind === 'call'),
    reset: () => {
      rmSync(log, { force: true });
      rmSync(refuseFile, { force: true });
    },
    refuse: (dtype) => {
      if (dtype) writeFileSync(refuseFile, dtype);
      else rmSync(refuseFile, { force: true });
    },
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}
