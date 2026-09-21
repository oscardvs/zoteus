import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LOCAL_MODEL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
  LocalEmbeddingProvider,
  OllamaEmbeddingProvider,
  canonicalOllamaModel,
  connectFailureCode,
  createEmbeddingProvider,
  embedderIdentity,
  missingTransformersHint,
  ollamaPrefixNotice,
  retryableEmbedStatus,
  type EmbeddingProvider,
} from '../../src/features/search/embeddings.js';
import { MemorySearchIndex } from '../../src/features/search/index-manager.js';
import { loadConfig } from '../../src/config.js';
import whoami from '../../src/tools/whoami.js';

/**
 * Ollama is the third embedding provider and the second private one: an HTTP endpoint whose
 * other end is the user's own machine. Everything here runs against a stubbed daemon. The
 * two failures that will actually happen are a daemon that is not running and a model that
 * was never pulled, and most of what follows is about those two producing a sentence naming
 * the cause and the command that fixes it, quickly, instead of five retries and "fetch failed".
 */

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} } as any;

const items = [
  { key: 'A', data: { itemType: 'journalArticle', title: 'Neural networks', abstractNote: 'deep learning' } },
  { key: 'B', data: { itemType: 'book', title: 'Gardening', abstractNote: 'tomatoes' } },
];

interface Call {
  url: string;
  method: string;
  body: any;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * A stubbed Ollama daemon: `GET /api/tags` lists what is pulled, `POST /api/embed` answers
 * one vector per input text. Every request is recorded, so batching and the probe are
 * observable rather than inferred.
 */
function ollamaDaemon(
  options: {
    models?: string[];
    tags?: () => Response;
    embed?: (input: string[], nth: number) => Response;
  } = {},
): Call[] {
  const calls: Call[] = [];
  const models = options.models ?? [`${DEFAULT_OLLAMA_MODEL}:latest`];
  let embedCalls = 0;
  const stub = (async (input: any, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', body });
    if (url.endsWith('/api/tags')) {
      return options.tags ? options.tags() : jsonResponse({ models: models.map((m) => ({ name: m, model: m })) });
    }
    if (url.endsWith('/api/embed')) {
      embedCalls++;
      if (options.embed) return options.embed(body.input as string[], embedCalls);
      // A vector that carries its text's first character, so order across batches is checkable.
      return jsonResponse({ embeddings: (body.input as string[]).map((t) => [t.charCodeAt(0), 0, 1]) });
    }
    return new Response('404 page not found', { status: 404 });
  }) as typeof fetch;
  vi.stubGlobal('fetch', stub);
  return calls;
}

/** What Node's fetch throws when nothing is listening: a bare TypeError with the code in its cause. */
function refused(address = '127.0.0.1:11434'): Error {
  const cause = Object.assign(new Error(`connect ECONNREFUSED ${address}`), { code: 'ECONNREFUSED' });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

/** Drain every timer a backoff schedules, so a retry test costs milliseconds. */
async function withoutWaiting<T>(fn: () => Promise<T>): Promise<T> {
  const result = fn();
  let settled = false;
  void result.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; i < 200 && !settled; i++) await vi.advanceTimersByTimeAsync(60_000);
  return result;
}

function embeds(calls: Call[]): Call[] {
  return calls.filter((c) => c.url.endsWith('/api/embed'));
}

function tags(calls: Call[]): Call[] {
  return calls.filter((c) => c.url.endsWith('/api/tags'));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the Ollama wire shape', () => {
  it('sends one request per batch, with the whole batch in one array', async () => {
    const calls = ollamaDaemon();
    const provider = new OllamaEmbeddingProvider({ batchSize: 2 });

    const vectors = await provider.embed(['a', 'b', 'c', 'd', 'e']);

    expect(vectors).toHaveLength(5);
    // Every vector came back attached to its own text, in order, across three requests.
    expect(vectors.map((v) => String.fromCharCode(v[0]!))).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(embeds(calls)).toHaveLength(3);
    expect(embeds(calls).map((c) => c.body.input)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(embeds(calls)[0]!.method).toBe('POST');
    expect(embeds(calls)[0]!.url).toBe(`${DEFAULT_OLLAMA_URL}/api/embed`);
    expect(embeds(calls)[0]!.body.model).toBe(DEFAULT_OLLAMA_MODEL);
  });

  it('probes the daemon once, not once per batch', async () => {
    const calls = ollamaDaemon();
    const provider = new OllamaEmbeddingProvider({ batchSize: 1 });

    await provider.embed(['a', 'b', 'c']);
    await provider.embed(['d']);

    expect(tags(calls)).toHaveLength(1);
    expect(embeds(calls)).toHaveLength(4);
  });

  it('talks to ZOTEUS_OLLAMA_URL, with exactly one slash in the joined path', async () => {
    const calls = ollamaDaemon();
    const provider = new OllamaEmbeddingProvider({ baseUrl: 'http://gpu.box:11434/' });

    expect(provider.url).toBe('http://gpu.box:11434');
    await provider.embed(['a']);
    expect(calls.map((c) => c.url)).toEqual(['http://gpu.box:11434/api/tags', 'http://gpu.box:11434/api/embed']);
  });

  it('pauses between batches by the configured delay', async () => {
    ollamaDaemon();
    const waits: number[] = [];
    const realTimeout = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', ((fn: () => void, ms?: number) => {
      if (ms) waits.push(ms);
      return realTimeout(fn, ms);
    }) as typeof setTimeout);

    await new OllamaEmbeddingProvider({ batchSize: 1, batchDelayMs: 25 }).embed(['a', 'b', 'c']);

    // Between batches, not after the last one.
    expect(waits.filter((w) => w === 25)).toHaveLength(2);
  });

  it('batches by default instead of posting a whole library in one request', async () => {
    // The deliberate difference from the OpenAI and Gemini providers, whose unset batch
    // size means "everything in one request": the daemon here is this machine, and asking
    // it to hold every passage at once is asking it to fall over.
    const calls = ollamaDaemon();

    await new OllamaEmbeddingProvider().embed(Array.from({ length: 70 }, (_, i) => `t${i}`));

    expect(embeds(calls).map((c) => c.body.input.length)).toEqual([32, 32, 6]);
  });

  it('takes ZOTEUS_EMBED_BATCH_SIZE and ZOTEUS_EMBED_BATCH_DELAY_MS through the config', async () => {
    const calls = ollamaDaemon();
    const waits: number[] = [];
    const realTimeout = globalThis.setTimeout;
    vi.stubGlobal('setTimeout', ((fn: () => void, ms?: number) => {
      if (ms) waits.push(ms);
      return realTimeout(fn, ms);
    }) as typeof setTimeout);
    const selection = createEmbeddingProvider(
      loadConfig({
        ZOTEUS_EMBEDDINGS: 'ollama',
        ZOTEUS_EMBED_BATCH_SIZE: '3',
        ZOTEUS_EMBED_BATCH_DELAY_MS: '15',
        ZOTEUS_DATA_DIR: mkdtempSync(join(tmpdir(), 'zoteus-ollama-')),
      } as any),
      silentLogger,
    );

    await selection.provider!.embed(['a', 'b', 'c', 'd']);

    expect(embeds(calls).map((c) => c.body.input.length)).toEqual([3, 1]);
    expect(waits).toContain(15);
  });

  it('refuses an answer that is not one vector per text rather than indexing a misalignment', async () => {
    ollamaDaemon({ embed: () => jsonResponse({ embeddings: [[1, 0, 0]] }) });

    await expect(new OllamaEmbeddingProvider().embed(['a', 'b'])).rejects.toThrow(
      /^Ollama returned the wrong number of vectors \(1 for 2 texts\)\./,
    );
  });
});

it.each([
  [[1, 2], [3]],
  [[], []],
  [[1, 'bad'], [2, 3]],
  [[1, null], [2, 3]],
  [null, [2, 3]],
])('refuses malformed vectors before they can enter the index: %j', async (...vectors) => {
  ollamaDaemon({ embed: () => jsonResponse({ embeddings: vectors }) });
  await expect(new OllamaEmbeddingProvider().embed(['a', 'b'])).rejects.toThrow('malformed embeddings');
});

describe('the query/passage distinction the API providers drop', () => {
  it('prefixes an E5 model on both sides, differently', async () => {
    const calls = ollamaDaemon({ models: ['multilingual-e5-small:latest'] });
    const provider = new OllamaEmbeddingProvider({ model: 'multilingual-e5-small' });

    await provider.embed(['a document'], 'passage');
    await provider.embed(['a question'], 'query');

    expect(embeds(calls).map((c) => c.body.input)).toEqual([['passage: a document'], ['query: a question']]);
  });

  it('adds nothing for the default model, which is trained without prefixes', async () => {
    const calls = ollamaDaemon();
    const provider = new OllamaEmbeddingProvider();

    await provider.embed(['a document'], 'passage');
    await provider.embed(['a question'], 'query');

    expect(embeds(calls).map((c) => c.body.input)).toEqual([['a document'], ['a question']]);
    expect(provider.prefixes).toBeNull();
  });

  it('honours ZOTEUS_EMBEDDING_PREFIXES=off under ollama, as it does under local', async () => {
    const calls = ollamaDaemon({ models: ['multilingual-e5-small:latest'] });
    const provider = new OllamaEmbeddingProvider({ model: 'multilingual-e5-small', prefixes: 'off' });

    await provider.embed(['a document'], 'passage');

    expect(embeds(calls)[0]!.body.input).toEqual(['a document']);
  });

  it('says out loud that a nomic model wants prefixes Zoteus does not add', () => {
    expect(ollamaPrefixNotice(DEFAULT_OLLAMA_MODEL)).toBeUndefined();
    expect(ollamaPrefixNotice('multilingual-e5-small')).toBeUndefined();
    const notice = ollamaPrefixNotice('nomic-embed-text');
    expect(notice).toContain('search_document: ');
    expect(notice).toContain('search_query: ');
    // Honest about the size of it: the model works, it just retrieves below its ability.
    expect(notice).toContain('Nothing fails');
    expect(ollamaPrefixNotice('nomic-embed-text:v1.5')).toBeDefined();
  });
});

describe('a daemon that is not running', () => {
  it('names the cause first and the command that fixes it, and does not retry', async () => {
    const fetchMock = vi.fn().mockRejectedValue(refused());
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OllamaEmbeddingProvider({ logger: silentLogger, random: () => 0 });
    const err = await provider.embed(['a']).catch((e: Error) => e);

    expect(String(err)).toMatch(/^Error: Ollama is not running at http:\/\/127\.0\.0\.1:11434\./);
    expect(String(err)).toContain('ollama serve');
    expect(String(err)).toContain(`ollama pull ${DEFAULT_OLLAMA_MODEL}`);
    expect(String(err)).toContain('keyword (BM25) search still');
    // The whole point: one attempt, not the 1/2/4/8/16-second ladder against a refused socket.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a refused connection on the embed request either', async () => {
    // The probe succeeds and the daemon then dies, which is the mid-build version of it.
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      if (url.endsWith('/api/tags')) return jsonResponse({ models: [{ model: `${DEFAULT_OLLAMA_MODEL}:latest` }] });
      throw refused();
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await expect(new OllamaEmbeddingProvider({ logger: silentLogger }).embed(['a'])).rejects.toThrow(
      /^Ollama is not running at/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('is not cached, so starting the daemon and trying again works', async () => {
    let up = false;
    const fetchMock = vi.fn(async (input: any, init?: RequestInit) => {
      if (!up) throw refused();
      const url = String(input);
      if (url.endsWith('/api/tags')) return jsonResponse({ models: [{ model: `${DEFAULT_OLLAMA_MODEL}:latest` }] });
      const body = JSON.parse(String(init?.body));
      return jsonResponse({ embeddings: (body.input as string[]).map(() => [1, 0, 0]) });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const provider = new OllamaEmbeddingProvider({ logger: silentLogger });

    await expect(provider.embed(['a'])).rejects.toThrow(/not running/);
    up = true;
    expect(await provider.embed(['a'])).toHaveLength(1);
  });

  it('names the host rather than the daemon when the URL does not resolve', async () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND gpu.box'), { code: 'ENOTFOUND' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause })));

    await expect(new OllamaEmbeddingProvider({ baseUrl: 'http://gpu.box:11434' }).embed(['a'])).rejects.toThrow(
      /^Ollama is not reachable at http:\/\/gpu\.box:11434 \(ENOTFOUND\)\./,
    );
  });

  it('names ZOTEUS_OLLAMA_URL when it is not the default, and does not otherwise', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(refused('10.0.0.4:11434')));
    const remote = await new OllamaEmbeddingProvider({ baseUrl: 'http://10.0.0.4:11434' })
      .embed(['a'])
      .catch((e: Error) => e.message);
    expect(remote).toContain('ZOTEUS_OLLAMA_URL is set to "http://10.0.0.4:11434"');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(refused()));
    const local = await new OllamaEmbeddingProvider().embed(['a']).catch((e: Error) => e.message);
    expect(local).not.toContain('ZOTEUS_OLLAMA_URL is set to');
  });

  it('tells a desktop-extension user where the setting lives, since there is no shell there', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(refused()));

    const message = await new OllamaEmbeddingProvider({ dist: 'mcpb' }).embed(['a']).catch((e: Error) => e.message);

    // Named exactly as the Configure screen spells it, and that field has to exist: see
    // "the desktop extension can reach the setting its own messages name" below.
    expect(message).toContain('the extension\'s "Ollama URL" (ZOTEUS_OLLAMA_URL)');
    expect(message).toContain('Zoteus cannot start Ollama for you');
  });

  it('reads the extension field back rather than telling a user who already moved it to move it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(refused('10.0.0.4:11434')));

    const message = await new OllamaEmbeddingProvider({ dist: 'mcpb', baseUrl: 'http://10.0.0.4:11434' })
      .embed(['a'])
      .catch((e: Error) => e.message);

    expect(message).toContain('The extension\'s "Ollama URL" (ZOTEUS_OLLAMA_URL) is set to "http://10.0.0.4:11434"');
    // The "if it does not listen on the default" instruction is for the user still on the
    // default: repeating it to this one sends them back to a box they have filled in.
    expect(message).not.toContain('If your daemon does not listen on');
  });

  it('reads the errno out of every shape Node wraps it in, and only the fatal ones', () => {
    expect(connectFailureCode(refused())).toBe('ECONNREFUSED');
    const aggregate = Object.assign(new TypeError('fetch failed'), {
      cause: new AggregateError([Object.assign(new Error('boom'), { code: 'ECONNREFUSED' })], 'all failed'),
    });
    expect(connectFailureCode(aggregate)).toBe('ECONNREFUSED');
    // Text-only, for a wrapper that kept the words and dropped the code.
    expect(connectFailureCode(new Error('connect EHOSTUNREACH 10.0.0.4:11434'))).toBe('EHOSTUNREACH');
    // A connection that had a bad moment is NOT one of these: it is what the backoff is for.
    expect(connectFailureCode(new Error('ECONNRESET'))).toBeUndefined();
    expect(connectFailureCode(new Error('socket hang up'))).toBeUndefined();
    // A self-referencing cause chain must not hang the walk.
    const loop: any = new Error('round');
    loop.cause = loop;
    expect(connectFailureCode(loop)).toBeUndefined();
  });
});

describe('a model that is not pulled', () => {
  it('is caught by the probe, before a single batch is sent', async () => {
    const calls = ollamaDaemon({ models: ['llama3:latest', 'mxbai-embed-large:latest'] });

    const err = await new OllamaEmbeddingProvider({ model: 'nomic-embed-text' }).embed(['a']).catch((e: Error) => e);

    expect(String(err)).toMatch(/^Error: The Ollama model "nomic-embed-text" is not pulled\./);
    expect(String(err)).toContain('ollama pull nomic-embed-text');
    // It names what IS there, so a typo in the model name is visible rather than guessed at.
    expect(String(err)).toContain('llama3:latest');
    expect(embeds(calls)).toHaveLength(0);
  });

  it('treats a daemon holding nothing at all as the same answer', async () => {
    const calls = ollamaDaemon({ models: [] });

    await expect(new OllamaEmbeddingProvider().embed(['a'])).rejects.toThrow(/is not pulled\./);
    expect(embeds(calls)).toHaveLength(0);
  });

  it('matches an untagged name against the :latest the daemon lists, and a registry prefix', async () => {
    ollamaDaemon({ models: [`registry.ollama.ai/library/${DEFAULT_OLLAMA_MODEL}:latest`] });
    expect(await new OllamaEmbeddingProvider().embed(['a'])).toHaveLength(1);

    ollamaDaemon({ models: [`${DEFAULT_OLLAMA_MODEL}:latest`] });
    expect(await new OllamaEmbeddingProvider({ model: `${DEFAULT_OLLAMA_MODEL}:latest` }).embed(['a'])).toHaveLength(1);
  });

  it('is fatal, not retried, when it arrives as a 404 on the embed request', async () => {
    const calls = ollamaDaemon({
      embed: () =>
        jsonResponse({ error: `model "${DEFAULT_OLLAMA_MODEL}" not found, try pulling it first` }, 404),
    });

    const err = await new OllamaEmbeddingProvider({ logger: silentLogger, random: () => 0 })
      .embed(['a'])
      .catch((e: Error) => e);

    expect(String(err)).toMatch(/^Error: The Ollama model "all-minilm" is not pulled\./);
    expect(String(err)).toContain('try pulling it first');
    // 404 is already outside the retryable set, and this is the case that depends on it.
    expect(retryableEmbedStatus(404)).toBe(false);
    expect(embeds(calls)).toHaveLength(1);
  });

  it('does not tell a user to pull a model when the 404 is the route, not the model', async () => {
    ollamaDaemon({ embed: () => new Response('404 page not found', { status: 404 }) });

    const message = await new OllamaEmbeddingProvider({ logger: silentLogger })
      .embed(['a'])
      .catch((e: Error) => e.message);

    expect(message).toMatch(/^Ollama at http:\/\/127\.0\.0\.1:11434 has no POST \/api\/embed endpoint/);
    expect(message).not.toContain('ollama pull');
  });

  it('stays quiet when the tags answer is not a model list it can read', async () => {
    // A 500, a different service on the port, or a daemon without the route: none of these
    // is evidence the model is missing, and claiming it would send the user the wrong way.
    for (const tagsAnswer of [
      () => jsonResponse({ nothing: true }),
      () => new Response('nope', { status: 500 }),
      () => new Response('<html>', { status: 200 }),
    ]) {
      const calls = ollamaDaemon({ tags: tagsAnswer });
      expect(await new OllamaEmbeddingProvider().embed(['a'])).toHaveLength(1);
      expect(embeds(calls)).toHaveLength(1);
    }
  });
});

describe('what Ollama shares with the other HTTP providers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rides out a 5xx on the same backoff, rather than failing the build', async () => {
    const calls = ollamaDaemon({
      embed: (input, nth) =>
        nth === 1
          ? new Response('server busy', { status: 503 })
          : jsonResponse({ embeddings: input.map(() => [1, 0, 0]) }),
    });
    const provider = new OllamaEmbeddingProvider({ logger: silentLogger, random: () => 0 });

    expect(await withoutWaiting(() => provider.embed(['a']))).toHaveLength(1);
    expect(embeds(calls)).toHaveLength(2);
  });

  it('retries a dropped connection, which is the transient case the fatal codes are not', async () => {
    let attempt = 0;
    const fetchMock = vi.fn(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/tags')) return jsonResponse({ models: [{ model: `${DEFAULT_OLLAMA_MODEL}:latest` }] });
      if (++attempt === 1) throw Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') });
      const body = JSON.parse(String(init?.body));
      return jsonResponse({ embeddings: (body.input as string[]).map(() => [1, 0, 0]) });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const provider = new OllamaEmbeddingProvider({ logger: silentLogger, random: () => 0 });

    expect(await withoutWaiting(() => provider.embed(['a']))).toHaveLength(1);
    expect(attempt).toBe(2);
  });
});

describe('the embedder identity keeps the two vector spaces apart', () => {
  it('carries the provider name, so ollama and local are different stamps', () => {
    expect(embedderIdentity({ name: 'ollama', model: DEFAULT_OLLAMA_MODEL })).toBe('ollama:all-minilm');
    expect(embedderIdentity({ name: 'local', model: DEFAULT_OLLAMA_MODEL })).toBe('local:all-minilm');
    expect(new OllamaEmbeddingProvider().name).toBe('ollama');
  });

  it('discards vectors built by another provider even when the model name is identical', async () => {
    // The hazard this exists for: `all-minilm` on Ollama and `all-MiniLM-L6-v2` on device
    // are the same weights under different runtimes, and nothing else downstream could tell
    // two stored spaces apart if the name did not.
    const stamp = (name: string, model: string): EmbeddingProvider => ({
      name,
      model,
      embed: async (texts: string[]) => texts.map(() => [1, 0, 0]),
    });
    const built = new MemorySearchIndex({ embedder: stamp('ollama', 'all-minilm'), configured: 'ollama' });
    await built.build(items);
    const saved = JSON.parse(JSON.stringify(built.toJSON()));
    expect(saved.embedderId).toBe('ollama:all-minilm');
    expect(saved.vectors.length).toBeGreaterThan(0);

    const reopened = new MemorySearchIndex({
      embedder: stamp('local', 'all-minilm'),
      configured: 'local',
      logger: silentLogger,
    });
    reopened.loadFromJSON(saved);
    const status = reopened.buildStatus();

    expect(status.vectors).toBe(0);
    expect(status.vectorsStaleReason).toContain('ollama:all-minilm');
    expect(status.vectorsStaleReason).toContain('local:all-minilm');
    // Keyword search is untouched: the passages are not model-specific.
    expect(status.documents).toBeGreaterThan(0);
  });

  it('is one stamp per pull, however the tag was spelled', () => {
    // `ollama list` prints the NAME column tagged, the API lists models registry-qualified,
    // and `ollama pull` takes the bare name: three spellings of one pull. Stamping them
    // apart discarded every stored vector the moment a user copied a different one.
    for (const spelling of [
      'all-minilm',
      'all-minilm:latest',
      '  All-MiniLM:Latest  ',
      'library/all-minilm',
      'ollama.com/library/all-minilm',
      'registry.ollama.ai/library/all-minilm:latest',
    ]) {
      expect(canonicalOllamaModel(spelling), spelling).toBe(DEFAULT_OLLAMA_MODEL);
      expect(embedderIdentity({ name: 'ollama', model: spelling }), spelling).toBe('ollama:all-minilm');
      expect(embedderIdentity(new OllamaEmbeddingProvider({ model: spelling })), spelling).toBe('ollama:all-minilm');
    }
  });

  it('keeps the raw spelling on the wire and in the remedies, and canonicalises only the stamp', async () => {
    // The daemon must receive what the user named: a tag or a registry prefix can be
    // load-bearing there, and `ollama pull <what you typed>` is the remedy that works.
    const calls = ollamaDaemon({ models: ['registry.ollama.ai/library/all-minilm:latest'] });
    const provider = new OllamaEmbeddingProvider({ model: 'registry.ollama.ai/library/all-minilm:latest' });

    await provider.embed(['a']);

    expect(provider.model).toBe('registry.ollama.ai/library/all-minilm:latest');
    expect(embeds(calls)[0]!.body.model).toBe('registry.ollama.ai/library/all-minilm:latest');
    expect(embedderIdentity(provider)).toBe('ollama:all-minilm');
  });

  it('still separates two genuinely different Ollama models', () => {
    expect(embedderIdentity({ name: 'ollama', model: 'mxbai-embed-large' })).toBe('ollama:mxbai-embed-large');
    expect(embedderIdentity({ name: 'ollama', model: 'nomic-embed-text:v1.5' })).toBe('ollama:nomic-embed-text:v1.5');
    // A third-party namespace is part of the identity: the probe tolerates a shared suffix
    // across namespaces, but two namespaces are not two spellings of one pull.
    expect(embedderIdentity({ name: 'ollama', model: 'hf.co/someone/all-minilm' })).toBe(
      'ollama:hf.co/someone/all-minilm',
    );
  });

  it('gives ollama and local different stamps for the same weights, as the two runtimes require', () => {
    // The collision to rule out: `all-minilm` on Ollama and Xenova/all-MiniLM-L6-v2 on
    // device are the same checkpoint, and if they shared a stamp one runtime's vectors
    // would silently answer the other's queries.
    const ollama = embedderIdentity(new OllamaEmbeddingProvider());
    const local = embedderIdentity(new LocalEmbeddingProvider());

    expect(ollama).toBe('ollama:all-minilm');
    expect(local).toBe(`local:${DEFAULT_LOCAL_MODEL}`);
    expect(ollama).not.toBe(local);
    // Canonicalising the Ollama tag must not reach the other providers: lower-casing a
    // local model id would restamp, and re-embed, every local index ever built.
    expect(embedderIdentity({ name: 'local', model: DEFAULT_LOCAL_MODEL })).toBe('local:Xenova/all-MiniLM-L6-v2');
    expect(embedderIdentity({ name: 'openai', model: 'Text-Embedding-3-Small:latest' })).toBe(
      'openai:Text-Embedding-3-Small:latest',
    );
  });

  it('does not discard the index when the user retypes the tag the way `ollama list` prints it', async () => {
    // The failure this fix exists for: the docs said to name the model as `ollama list`
    // spells it, and doing so dropped every vector and charged a full re-embed.
    const stamp = (model: string): EmbeddingProvider => ({
      name: 'ollama',
      model,
      embed: async (texts: string[]) => texts.map(() => [1, 0, 0]),
    });
    const built = new MemorySearchIndex({ embedder: stamp(DEFAULT_OLLAMA_MODEL), configured: 'ollama' });
    await built.build(items);
    const saved = JSON.parse(JSON.stringify(built.toJSON()));
    expect(saved.embedderId).toBe('ollama:all-minilm');
    expect(saved.vectors.length).toBeGreaterThan(0);

    const retyped = new MemorySearchIndex({
      embedder: stamp('all-minilm:latest'),
      configured: 'ollama',
      logger: silentLogger,
    });
    retyped.loadFromJSON(JSON.parse(JSON.stringify(saved)));

    expect(retyped.buildStatus().vectorsStaleReason).toBeUndefined();
    expect(retyped.buildStatus().vectors).toBeGreaterThan(0);

    // A real model change is still caught, which is what the stamp is for.
    const different = new MemorySearchIndex({
      embedder: stamp('mxbai-embed-large'),
      configured: 'ollama',
      logger: silentLogger,
    });
    different.loadFromJSON(JSON.parse(JSON.stringify(saved)));

    expect(different.buildStatus().vectors).toBe(0);
    expect(different.buildStatus().vectorsStaleReason).toContain('ollama:mxbai-embed-large');
  });

  it('keeps them when the same Ollama model is still in force', async () => {
    const stamp = (): EmbeddingProvider => ({
      name: 'ollama',
      model: 'all-minilm',
      embed: async (texts: string[]) => texts.map(() => [1, 0, 0]),
    });
    const built = new MemorySearchIndex({ embedder: stamp(), configured: 'ollama' });
    await built.build(items);
    const reopened = new MemorySearchIndex({ embedder: stamp(), configured: 'ollama', logger: silentLogger });
    reopened.loadFromJSON(JSON.parse(JSON.stringify(built.toJSON())));

    expect(reopened.buildStatus().vectorsStaleReason).toBeUndefined();
    expect(reopened.buildStatus().vectors).toBeGreaterThan(0);
  });
});

describe('ZOTEUS_EMBEDDINGS=ollama actually selects Ollama', () => {
  const dataDir = () => mkdtempSync(join(tmpdir(), 'zoteus-ollama-'));

  it('builds an Ollama provider rather than quietly running the on-device model', () => {
    const selection = createEmbeddingProvider(
      loadConfig({ ZOTEUS_EMBEDDINGS: 'ollama', ZOTEUS_DATA_DIR: dataDir() } as any),
      silentLogger,
    );

    expect(selection.configured).toBe('ollama');
    expect(selection.unavailable).toBeUndefined();
    expect(selection.provider).toBeInstanceOf(OllamaEmbeddingProvider);
    expect(selection.provider?.name).toBe('ollama');
    expect(selection.provider?.model).toBe(DEFAULT_OLLAMA_MODEL);
    expect((selection.provider as OllamaEmbeddingProvider).url).toBe(DEFAULT_OLLAMA_URL);
  });

  it('is not swallowed into local by the tolerant knob any more', () => {
    const cfg = loadConfig({ ZOTEUS_EMBEDDINGS: 'ollama', ZOTEUS_DATA_DIR: dataDir() } as any);
    expect(cfg.embeddings).toBe('ollama');
    expect(cfg.warnings.join('\n')).not.toContain('is not usable');
  });

  it('reads the URL and the model from the environment', () => {
    const selection = createEmbeddingProvider(
      loadConfig({
        ZOTEUS_EMBEDDINGS: 'ollama',
        ZOTEUS_OLLAMA_URL: 'http://gpu.box:11434',
        ZOTEUS_EMBEDDING_MODEL: 'mxbai-embed-large',
        ZOTEUS_DATA_DIR: dataDir(),
      } as any),
      silentLogger,
    );
    const provider = selection.provider as OllamaEmbeddingProvider;

    expect(provider.url).toBe('http://gpu.box:11434');
    expect(provider.model).toBe('mxbai-embed-large');
  });

  it('warns at startup when the configured model wants prefixes that are not added', () => {
    const warn = vi.fn();
    createEmbeddingProvider(
      loadConfig({
        ZOTEUS_EMBEDDINGS: 'ollama',
        ZOTEUS_EMBEDDING_MODEL: 'nomic-embed-text',
        ZOTEUS_DATA_DIR: dataDir(),
      } as any),
      { ...silentLogger, warn },
    );

    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('search_document: ');
  });

  it('warns that the on-device-only knobs are ignored under ollama', () => {
    const cfg = loadConfig({
      ZOTEUS_EMBEDDINGS: 'ollama',
      ZOTEUS_EMBEDDING_DTYPE: 'q8',
      ZOTEUS_EMBEDDING_POOLING: 'cls',
      ZOTEUS_DATA_DIR: dataDir(),
    } as any);
    const warnings = cfg.warnings.join('\n');

    expect(warnings).toContain('ZOTEUS_EMBEDDING_DTYPE applies to on-device embeddings only');
    expect(warnings).toContain('ignored under ZOTEUS_EMBEDDINGS=ollama');
    expect(warnings).toContain('ZOTEUS_EMBEDDING_POOLING applies to on-device embeddings only');
  });

  it('offers ollama to the user whose on-device runtime is missing, before the two APIs', () => {
    const hint = missingTransformersHint({ dist: 'mcpb' });
    expect(hint).toContain('ZOTEUS_EMBEDDINGS=ollama');
    expect(hint.indexOf('ZOTEUS_EMBEDDINGS=ollama')).toBeLessThan(hint.indexOf('ZOTEUS_EMBEDDINGS=openai'));
    // Still honest about which of the three sends library text away.
    expect(hint).toContain('your library text leaves the machine');
  });
});

describe('the desktop extension can reach the setting its own messages name', () => {
  const manifest = () => JSON.parse(readFileSync('mcpb/manifest.json', 'utf8'));

  it('has an Ollama URL field wired to ZOTEUS_OLLAMA_URL', () => {
    // The bundled hint sends this user to a box in the Configure screen, and that screen is
    // generated from this manifest alone: no shell, no .env, no second channel. Without
    // both halves the instruction names a control that does not exist.
    const m = manifest();
    expect(m.server.mcp_config.env.ZOTEUS_OLLAMA_URL).toBe('${user_config.ollama_url}');
    expect(m.user_config.ollama_url).toMatchObject({ type: 'string', title: 'Ollama URL', required: false });
  });

  it('spells the field the way the failure message spells it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(refused()));
    const message = await new OllamaEmbeddingProvider({ dist: 'mcpb' }).embed(['a']).catch((e: Error) => e.message);

    expect(message).toContain(`"${manifest().user_config.ollama_url.title}"`);
  });

  it('is the field docs/ollama.md sends the extension user to, under the same name', () => {
    const doc = readFileSync('docs/ollama.md', 'utf8');
    expect(doc).toContain(manifest().user_config.ollama_url.title);
    // The instruction that caused the vector loss: `ollama list` prints the tagged spelling.
    expect(doc).not.toContain('name it exactly as `ollama list` spells it');
  });

  it('declares a user_config field for every reference its env map interpolates', () => {
    const m = manifest();
    const referenced = Object.values(m.server.mcp_config.env as Record<string, string>)
      .map((v) => /^\$\{user_config\.([a-z0-9_]+)\}$/.exec(v)?.[1])
      .filter((k): k is string => Boolean(k));

    expect(referenced.length).toBeGreaterThan(0);
    for (const key of referenced) expect(Object.keys(m.user_config), key).toContain(key);
  });

  it('boots on what the host passes for an Ollama URL box the user left empty', () => {
    // A field with no manifest default is not substituted at all by Claude Desktop: the
    // reference arrives verbatim (#18). Both that and a blank have to mean "use the
    // default", not "reject a URL that does not parse".
    for (const value of ['${user_config.ollama_url}', '', '   ']) {
      const cfg = loadConfig({
        ZOTEUS_EMBEDDINGS: 'ollama',
        ZOTEUS_OLLAMA_URL: value,
        ZOTEUS_DIST: 'mcpb',
        ZOTEUS_DATA_DIR: mkdtempSync(join(tmpdir(), 'zoteus-ollama-')),
      } as any);

      expect(cfg.ollamaUrl, JSON.stringify(value)).toBe(DEFAULT_OLLAMA_URL);
      expect(cfg.warnings.join('\n'), JSON.stringify(value)).not.toContain('ZOTEUS_OLLAMA_URL');
    }
  });

  it('carries a URL the user did type all the way to the provider', () => {
    const selection = createEmbeddingProvider(
      loadConfig({
        ZOTEUS_EMBEDDINGS: 'ollama',
        ZOTEUS_OLLAMA_URL: 'http://10.0.0.4:11434',
        ZOTEUS_DIST: 'mcpb',
        ZOTEUS_DATA_DIR: mkdtempSync(join(tmpdir(), 'zoteus-ollama-')),
      } as any),
      silentLogger,
    );

    expect((selection.provider as OllamaEmbeddingProvider).url).toBe('http://10.0.0.4:11434');
  });
});

describe('how an ollama embedder is reported', () => {
  it('names itself while it is working', async () => {
    ollamaDaemon();
    const search = new MemorySearchIndex({
      embedder: new OllamaEmbeddingProvider({ logger: silentLogger }),
      configured: 'ollama',
      logger: silentLogger,
    });

    await search.build(items);
    const status = search.buildStatus();

    expect(status.embedderActive).toBe(true);
    expect(status.embedder).toBe('ollama');
    expect(status.embedderModel).toBe(DEFAULT_OLLAMA_MODEL);
    expect(status.vectors).toBeGreaterThan(0);
    // A local daemon answers to no tokens-per-minute ceiling, so there is no rate to report.
    expect(status.embedRate).toBeUndefined();
  });

  it('reports the cause and the remedy in zotero_index status when the daemon is down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(refused()));
    const search = new MemorySearchIndex({
      embedder: new OllamaEmbeddingProvider({ logger: silentLogger }),
      configured: 'ollama',
      logger: silentLogger,
    });

    await search.build(items);
    const status = search.buildStatus();

    expect(status.vectors).toBe(0);
    expect(status.embedderConfigured).toBe('ollama');
    expect(status.embedderActive).toBe(false);
    // The one-line label is the FIRST sentence of the reason, so that sentence has to be
    // the cause and nothing else.
    expect(status.embedder).toBe('none (ollama requested; Ollama is not running at http://127.0.0.1:11434)');
    expect(status.embedderReason).toContain('ollama serve');
    // The build itself still completed, on keyword data.
    expect(status.documents).toBeGreaterThan(0);
    expect((await search.query('deep learning', { mode: 'keyword' })).length).toBeGreaterThan(0);
  });

  it('shows ollama in zotero_whoami, active and degraded alike', async () => {
    ollamaDaemon();
    const healthy = new MemorySearchIndex({
      embedder: new OllamaEmbeddingProvider({ logger: silentLogger }),
      configured: 'ollama',
      logger: silentLogger,
    });
    await healthy.build(items);
    const good = await whoami.handler({}, whoamiCtx(healthy));

    expect((good.structuredContent as any).embeddings).toMatchObject({
      configured: 'ollama',
      active: true,
      effective: 'ollama',
    });
    expect(good.content[0]!.text).not.toContain('degraded to keyword-only');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(refused()));
    const down = new MemorySearchIndex({
      embedder: new OllamaEmbeddingProvider({ logger: silentLogger }),
      configured: 'ollama',
      logger: silentLogger,
    });
    await down.build(items);
    const bad = await whoami.handler({}, whoamiCtx(down));

    expect((bad.structuredContent as any).embeddings).toMatchObject({ configured: 'ollama', active: false });
    expect(bad.content[0]!.text).toContain('embeddings=ollama requested but not active');
    expect(bad.content[0]!.text).toContain(`ollama pull ${DEFAULT_OLLAMA_MODEL}`);
  });
});

/** The minimum zotero_whoami reads: an identity, capabilities and a search index. */
function whoamiCtx(search: unknown): any {
  return {
    router: { whoami: () => null, defaultLibrary: () => ({ type: 'user', id: 0 }) },
    capabilities: { cloud: null, localApi: true },
    search,
  };
}
