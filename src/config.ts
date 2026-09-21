import { z } from 'zod';
import { defaultDataDir, defaultZoteroDataDir } from './lib/paths.js';
import { isUnset, looksUnexpanded } from './lib/env.js';
import { DEFAULT_FULLTEXT_MAX_CHARS } from './features/search/fulltext-source.js';
import {
  DEFAULT_ANN_MIN_CANDIDATES,
  DEFAULT_ANN_OVERSAMPLE,
  DEFAULT_EMBED_MAX_RETRIES,
  DEFAULT_INDEX_MAX_ITEMS,
} from './features/search/limits.js';
import {
  EMBEDDING_DTYPES,
  POOLING_MODES,
  type EmbeddingDtype,
  type PoolingSetting,
} from './features/search/embeddings.js';

export interface ZoteusConfig {
  apiKey?: string;
  /** Pre-provisioned Zotero 10+ desktop local-API key (skips the grant dialog). */
  localApiKey?: string;
  libraryId?: number;
  libraryType: 'user' | 'group';
  local: 'auto' | 'on' | 'off';
  localPort: number;
  /**
   * Per-request time budget for reads against the Zotero DESKTOP app, in milliseconds.
   * Unset on purpose: the fetcher's own 25 s default stands, and only an explicit value
   * overrides it, for a machine whose local API is slow enough that a build's attachment
   * map cannot finish inside it (#78). Never applied to the cloud Web API.
   */
  zoteroDeadlineMs?: number;
  translationServerUrl: string;
  embeddings: 'local' | 'openai' | 'gemini' | 'ollama' | 'off';
  /** Base URL of the Ollama daemon an `ollama` embedder talks to (ZOTEUS_OLLAMA_URL). */
  ollamaUrl: string;
  /** Model for the active embedder, local included (unset = that provider's own default). */
  embeddingModel?: string;
  /** Whether embedding inputs carry E5's `query: `/`passage: ` markers (see embeddings.ts). */
  embeddingPrefixes: 'auto' | 'off' | 'e5';
  /** Weight precision the local model loads at; part of the embedder identity above fp32. */
  embeddingDtype: EmbeddingDtype;
  /** How the local model's tokens are pooled: from the curated table, or one mode (see embeddings.ts). */
  embeddingPooling: PoolingSetting;
  /** Passages per embedding call (unset = DEFAULT_EMBED_BATCH_SIZE where one is batched). */
  embedBatchSize?: number;
  /** Pause between embedding batches in ms; 0 only yields to the event loop. */
  embedBatchDelayMs: number;
  /** Retries a rate-limited or 5xx embedding request gets before the build gives up. */
  embedMaxRetries: number;
  /** Where to resolve @huggingface/transformers from when the install cannot see it itself. */
  transformersPath?: string;
  /** Whether a PDF with no text layer may be read by OCR: `off`, or `auto` when an engine resolves. */
  ocr: 'off' | 'auto';
  /** Where to resolve the OCR engine from when the install cannot see it itself. */
  ocrPath?: string;
  /** Pages one OCR call may read before it stops and tells the caller to ask for the rest. */
  ocrMaxPages: number;
  /** Tesseract language codes for OCR, `+`-separated (e.g. "eng+deu"). */
  ocrLangs: string;
  /** Index attachment full text (PDF bodies) alongside metadata. Opt-in: it is costly. */
  indexFulltext: boolean;
  /** Index child notes and PDF annotations as extra passages (ZOTEUS_INDEX_OWN_WORDS). */
  indexOwnWords: boolean;
  /** Cap on indexed full-text characters per item (0 = no cap). */
  indexFulltextMaxChars: number;
  /**
   * Concurrent attachment full-text fetches during an index build. Unset on purpose: the
   * default depends on which Zotero API is serving the crawl (see limits.ts), and only an
   * explicit value overrides that choice.
   */
  indexFulltextConcurrency?: number;
  /** Cap on items per index build. Raise it for libraries larger than the default. */
  indexMaxItems: number;
  /**
   * Where the search index is stored: `sqlite` (node:sqlite, Node 22.13+), `memory` (the
   * legacy JSON file), or `auto` to take SQLite whenever the runtime provides it.
   */
  indexBackend: 'auto' | 'sqlite' | 'memory';
  /** Library indexes one context keeps open at once before closing the least recently used. */
  indexMaxOpen: number;
  /**
   * Two-stage vector search on the SQLite backend: binary codes scanned first, then an
   * exact cosine rescore of the candidates. False forces the exact scan of every vector.
   */
  indexAnn: boolean;
  /**
   * Unaccented keyword-query terms also match the dominant accented spellings
   * (ZOTEUS_ACCENT_EXPANSION). False answers every query strictly as typed.
   */
  accentExpansion: boolean;
  /** Candidates the code stage hands that rescore, per vector hit asked for. */
  indexAnnOversample: number;
  /** Floor on that candidate set, so a small page still rescores a real neighbourhood. */
  indexAnnMinCandidates: number;
  scholarProviders: string[];
  /** Whether open-access discovery may download bytes, or only report the link it found. */
  oaFetch: boolean;
  /** Ceiling on entries accepted from one bibliographic file import. */
  importMaxEntries: number;
  dataDir: string;
  /**
   * The ZOTERO desktop app's data directory, whose `storage/<key>/` folders hold the
   * attachment files. Read when the app is not running but Zoteus shares its machine.
   */
  zoteroDataDir: string;
  contactEmail?: string;
  /** An OpenAlex API key for `zotero_scholar`, sent as a bearer header. Optional (#76). */
  openalexApiKey?: string;
  allowDelete: boolean;
  readOnly: boolean;
  /**
   * Number of items above which a bulk write (trash, tag add/remove, collection removal)
   * refuses unless the call also passes `confirm: true`. `0` (the default) disables the
   * gate entirely, so an existing working call keeps working. See docs/threat-model.md.
   */
  confirmBulkWrites: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logFormat: 'text' | 'json';
  /** A file every log line is appended to as well as stderr (ZOTEUS_LOG_FILE). */
  logFile?: string;
  /** Daily check against GitHub releases for a newer version (surfaced via zotero_whoami). */
  updateCheck: boolean;
  /** Distribution channel marker (the .dxt manifest sets "dxt"); tailors the update notice. */
  dist?: string;
  allowInsecureHttp: boolean;
  metricsEnabled: boolean;
  /** Bearer token demanded by /metrics and /usage.json; unset leaves both open. */
  metricsToken?: string;
  /**
   * The usage log: one row per tool call and request in `<dataDir>/usage.sqlite`.
   *
   * Off unless asked for, and it never leaves the machine that wrote it. Zoteus is mostly
   * a local desktop server and PRIVACY.md promises no analytics; an operator running a
   * shared instance is a different case, and this is how they opt in.
   */
  usage: {
    enabled: boolean;
    /** Days of raw events kept. Daily rollups are kept regardless. */
    retentionDays: number;
    /** Whether a caller is recorded as their Zotero id, a salted hash of it, or not at all. */
    identify: 'user' | 'hash' | 'none';
  };
  readyzCheckZotero: boolean;
  mcpRateLimit: { windowMs: number; max: number };
  oauth: {
    enabled: boolean;
    publicUrl?: string;
    passcode?: string;
    accessTokenTtlSec: number;
    refreshTokenTtlSec: number;
    allowedHosts: string[];
    mode: 'passcode' | 'zotero';
    zoteroClientKey?: string;
    zoteroClientSecret?: string;
    store: 'memory' | 'file';
    tokenSecret?: string;
  };
  cimd: {
    enabled: boolean;
    cacheTtlSec: number;
    maxBytes: number;
    allowedRedirectSchemes: string[];
    allowedHosts: string[];
  };
  /**
   * Settings that could not be used and fell back to their default. Reported once the
   * logger exists, because `loadConfig` runs before it.
   */
  warnings: string[];
}

/** Minimum length for the consent passcode (defense-in-depth alongside /consent throttling). */
export const MIN_PASSCODE_LENGTH = 12;

/** An optional flag. Absent, or unset in the sense of `isUnset`, keeps `def`. */
const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v.toLowerCase() === 'true' || v === '1'));

/** What `knob` collects: the readable warnings, and the keys a schema actually refused. */
interface Rejections {
  warnings: string[];
  rejected: Set<string>;
}

/**
 * One setting, and the promise that no knob among them can stop the server from starting.
 * A value that is present but unusable (a host marker this version does not recognise, a
 * typo, a negative cap) is collected and replaced by what the variable's absence would
 * have given.
 *
 * `loadConfig` runs before the logger exists, so a `ZodError` here is a `FATAL` line on
 * stderr and a dead process: exactly how #18 crashed, and a mistyped tuning knob is not
 * worth that. It is the reasoning of #20 (a damaged index stopped being fatal) applied to
 * configuration. The exceptions are deliberate and listed at the end of `loadConfig`:
 * settings that choose a scope or a security model are not knobs, and none of them can be
 * reached by a desktop host filling in a settings pane.
 */
const knob = <T extends z.ZodTypeAny>(key: string, schema: T, into: Rejections) => {
  const absent = schema.safeParse(undefined);
  if (!absent.success) {
    // Not reachable from configuration: it means a field was declared with no answer for
    // an unset variable, which would make the cast in `tolerant` untrue. Fail on the first
    // load rather than on the first person to mistype that field.
    throw new Error(`${key} must accept an absent variable: give it .default() or .optional()`);
  }
  return z
    .preprocess((v) => (isUnset(v) ? undefined : v), schema)
    .catch((ctx) => {
      into.rejected.add(key);
      into.warnings.push(
        `${key}=${JSON.stringify(ctx.input)} is not usable, ` +
          (absent.data === undefined ? 'ignoring it' : `using ${JSON.stringify(absent.data)}`),
      );
      return absent.data as z.output<T>;
    });
};

/**
 * Wraps every field in `knob`, so the key a warning names is the key that failed and the
 * two cannot drift apart. The cast restates the wrapper's output type, which is what
 * `z.object` reads and which `knob` leaves exactly as the wrapped schema's. `knob` checks
 * the invariant that makes that true.
 */
const tolerant = <S extends z.ZodRawShape>(fields: S, into: Rejections): S =>
  Object.fromEntries(
    Object.entries(fields).map(([key, schema]) => [key, knob(key, schema, into)]),
  ) as unknown as S;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ZoteusConfig {
  const warnings: string[] = [];
  const rejected = new Set<string>();
  const schema = z.object(
    tolerant(
      {
        ZOTERO_API_KEY: z.string().min(1).optional(),
        ZOTEUS_LOCAL_API_KEY: z.string().min(1).optional(),
        ZOTERO_LIBRARY_ID: z.coerce.number().int().positive().optional(),
        ZOTERO_LIBRARY_TYPE: z.enum(['user', 'group']).default('user'),
        ZOTEUS_LOCAL: z.enum(['auto', 'on', 'off']).default('auto'),
        ZOTERO_LOCAL_PORT: z.coerce.number().int().positive().default(23119),
        // Bounded at both ends, and unusable values are ignored rather than clamped. Below
        // the floor every desktop read fails; above the ceiling a hung read outlives the
        // MCP host's own per-call timeout, which is the failure this budget exists to turn
        // into an actionable message (see DEFAULT_DEADLINE_MS in api/http.ts).
        ZOTEUS_ZOTERO_DEADLINE_MS: z.coerce
          .number()
          .int()
          .min(5_000)
          .max(600_000)
          .optional(),
        ZOTEUS_TRANSLATION_SERVER_URL: z.string().url().default('http://127.0.0.1:1969'),
        ZOTEUS_EMBEDDINGS: z.enum(['local', 'openai', 'gemini', 'ollama', 'off']).default('local'),
        // Where an `ollama` provider reaches its daemon. Ollama serves embeddings from the
        // same port as everything else, and it is loopback by default, so this is only ever
        // changed to point at another machine on the network.
        ZOTEUS_OLLAMA_URL: z.string().url().default('http://127.0.0.1:11434'),
        ZOTEUS_EMBEDDING_MODEL: z.string().min(1).optional(),
        ZOTEUS_EMBEDDING_PREFIXES: z.enum(['auto', 'off', 'e5']).default('auto'),
        // Local only: an API provider's precision is decided on the provider's hardware.
        ZOTEUS_EMBEDDING_DTYPE: z.enum(EMBEDDING_DTYPES).default('fp32'),
        // Local only, like the dtype. `auto` is the curated per-model table; a mode is the
        // escape hatch for a checkpoint the table cannot speak for (see poolingFor).
        ZOTEUS_EMBEDDING_POOLING: z.enum(['auto', ...POOLING_MODES]).default('auto'),
        ZOTEUS_EMBED_BATCH_SIZE: z.coerce.number().int().positive().optional(),
        ZOTEUS_EMBED_BATCH_DELAY_MS: z.coerce.number().int().nonnegative().default(0),
        // 0 restores the pre-#48 behaviour: one 429 ends the build. Nobody should want
        // that, but a knob that cannot be turned off is a knob nobody can rule out.
        ZOTEUS_EMBED_MAX_RETRIES: z.coerce
          .number()
          .int()
          .nonnegative()
          .default(DEFAULT_EMBED_MAX_RETRIES),
        ZOTEUS_TRANSFORMERS_PATH: z.string().min(1).optional(),
        // Optical character recognition for PDFs with no text layer. `off` by default,
        // because the engine is an optional runtime dependency this package does not ship:
        // `auto` means "use it when it resolves, and say so clearly when it does not".
        ZOTEUS_OCR: z.enum(['off', 'auto']).default('off'),
        // Where to resolve the OCR engine from when the install cannot see it itself; the
        // same escape hatch ZOTEUS_TRANSFORMERS_PATH is for the embedding runtime.
        ZOTEUS_OCR_PATH: z.string().min(1).optional(),
        // Pages one OCR call may read. OCR is orders of magnitude slower than reading a
        // text layer, so an unbounded call would look like a hang to every MCP client.
        ZOTEUS_OCR_MAX_PAGES: z.coerce.number().int().positive().default(8),
        // Tesseract language codes, `+`-separated, e.g. "eng" or "eng+deu". Each one is a
        // separate trained-data file the engine has to have locally.
        ZOTEUS_OCR_LANGS: z.string().min(1).default('eng'),
        ZOTEUS_INDEX_FULLTEXT: bool(false),
        // On by default, unlike full text: the whole corpus is one paged crawl of text the
        // reader wrote by hand, orders of magnitude smaller than the attachment bodies it
        // sits beside, and it is the one part of a library nobody else wrote (#33).
        ZOTEUS_INDEX_OWN_WORDS: bool(true),
        ZOTEUS_INDEX_FULLTEXT_MAX_CHARS: z.coerce
          .number()
          .int()
          .nonnegative()
          .default(DEFAULT_FULLTEXT_MAX_CHARS),
        ZOTEUS_INDEX_FULLTEXT_CONCURRENCY: z.coerce.number().int().positive().optional(),
        // ZOTEUS_ALLOW_ELECTRON_FULLTEXT was here: the escape hatch from the refusal 1.12.0
        // put in front of the full-text pass under Electron. Both are gone, because the
        // crash it protected against is fixed at its source (#37, search/electron.ts). An
        // install that still sets it is simply not read; unknown variables are ignored.
        ZOTEUS_INDEX_MAX_ITEMS: z.coerce.number().int().positive().default(DEFAULT_INDEX_MAX_ITEMS),
        ZOTEUS_INDEX_BACKEND: z.enum(['auto', 'sqlite', 'memory']).default('auto'),
        // How many library indexes one context keeps open at once. Each open index costs a
        // SQLite handle and its cached pages, so a user who reaches many group libraries
        // should not accumulate one per group forever; the least recently used is closed.
        ZOTEUS_INDEX_MAX_OPEN: z.coerce.number().int().positive().default(4),
        // Query-side accent expansion: an unaccented keyword-search term also matches the
        // accented spellings that dominate the library's vocabulary. On by default — it
        // compensates the recall that keeping diacritics in the index removed for
        // unaccented queries; false opts into strict as-typed exactness. Query-time only:
        // flipping it never needs a rebuild.
        ZOTEUS_ACCENT_EXPANSION: bool(true),
        ZOTEUS_INDEX_ANN: bool(true),
        ZOTEUS_INDEX_ANN_OVERSAMPLE: z.coerce
          .number()
          .int()
          .positive()
          .default(DEFAULT_ANN_OVERSAMPLE),
        ZOTEUS_INDEX_ANN_MIN_CANDIDATES: z.coerce
          .number()
          .int()
          .positive()
          .default(DEFAULT_ANN_MIN_CANDIDATES),
        ZOTEUS_SCHOLAR_PROVIDERS: z.string().default('openalex'),
        // Whether open-access discovery may DOWNLOAD from the host it finds. Finding and
        // reporting an OA link is always allowed; fetching bytes from a URL a model chose
        // is egress to an arbitrary host, which an operator of a shared deployment may not
        // want. Discovery still reports the link when this is off, so nothing goes silent.
        ZOTEUS_OA_FETCH: bool(true),
        // Ceiling on entries accepted from one bibliographic file import, so a pasted
        // 5,000-entry .bib becomes a refusal that names the cap rather than a bulk write.
        ZOTEUS_IMPORT_MAX_ENTRIES: z.coerce.number().int().positive().default(200),
        ZOTEUS_DATA_DIR: z.string().min(1).optional(),
        ZOTERO_DATA_DIR: z.string().min(1).optional(),
        ZOTEUS_CONTACT_EMAIL: z.string().email().optional(),
        ZOTEUS_OPENALEX_API_KEY: z.string().min(1).optional(),
        ZOTEUS_ALLOW_DELETE: bool(false),
        ZOTEUS_READ_ONLY: bool(false),
        ZOTEUS_CONFIRM_BULK_WRITES: z.coerce.number().int().nonnegative().default(0),
        ZOTEUS_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
        ZOTEUS_LOG_FORMAT: z.enum(['text', 'json']).default('text'),
        ZOTEUS_LOG_FILE: z.string().min(1).optional(),
        ZOTEUS_UPDATE_CHECK: bool(false),
        ZOTEUS_DIST: z.string().min(1).optional(),
        ZOTEUS_ALLOW_INSECURE_HTTP: bool(false),
        ZOTEUS_METRICS_ENABLED: bool(false),
        ZOTEUS_METRICS_TOKEN: z.string().min(1).optional(),
        ZOTEUS_USAGE_LOG: bool(false),
        ZOTEUS_USAGE_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
        ZOTEUS_USAGE_IDENTIFY: z.enum(['user', 'hash', 'none']).default('user'),
        ZOTEUS_READYZ_CHECK_ZOTERO: bool(true),
        ZOTEUS_MCP_RATE_LIMIT_WINDOW_SEC: z.coerce.number().int().nonnegative().default(60),
        ZOTEUS_MCP_RATE_LIMIT_MAX: z.coerce.number().int().nonnegative().default(120),
        ZOTEUS_OAUTH_ENABLED: bool(false),
        ZOTEUS_PUBLIC_URL: z.string().url().optional(),
        ZOTEUS_OAUTH_PASSCODE: z.string().min(1).optional(),
        ZOTEUS_OAUTH_ACCESS_TTL: z.coerce.number().int().positive().default(3600),
        ZOTEUS_OAUTH_REFRESH_TTL: z.coerce.number().int().positive().default(2592000),
        ZOTEUS_ALLOWED_HOSTS: z.string().optional(),
        ZOTEUS_OAUTH_MODE: z.enum(['passcode', 'zotero']).default('passcode'),
        ZOTERO_OAUTH_CLIENT_KEY: z.string().min(1).optional(),
        ZOTERO_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
        ZOTEUS_OAUTH_STORE: z.enum(['memory', 'file']).default('memory'),
        ZOTEUS_OAUTH_TOKEN_SECRET: z.string().min(1).optional(),
        ZOTEUS_CIMD_ENABLED: bool(false),
        ZOTEUS_CIMD_CACHE_TTL_SEC: z.coerce.number().int().nonnegative().default(3600),
        ZOTEUS_CIMD_MAX_BYTES: z.coerce.number().int().positive().default(16384),
        ZOTEUS_CIMD_ALLOWED_REDIRECT_SCHEMES: z.string().default('https'),
        ZOTEUS_CIMD_ALLOWED_HOSTS: z.string().default(''),
      },
      { warnings, rejected },
    ),
  );

  const parsed = schema.parse(env);

  /**
   * The end of the knobs, and the start of the settings that are not knobs.
   *
   * A rejected value falls back everywhere above, because no tuning number is worth a
   * server that will not start. These are different: each one chooses a scope or a
   * security model, so falling back would quietly change who the server answers for
   * rather than how fast it runs. `ZOTEUS_OAUTH_MODE=Zotero` must not serve every client
   * from the operator's own key, and a library id the API cannot address must not resolve
   * to the personal library instead. None of them appears in `mcpb/manifest.json`, so a
   * desktop user, whose settings a host fills in and who has no stderr to read, cannot
   * reach any of these (#18). An operator setting them by hand can read the refusal.
   *
   * The message carries the warnings collected so far, because throwing here discards
   * them: without that, a rejected `ZOTEUS_PUBLIC_URL` reported only that the variable was
   * required, which is a lie when the operator has plainly set it.
   */
  const refuse = (key: string, why: string): never => {
    const detail = warnings.length ? ` (${warnings.join('; ')})` : '';
    throw new Error(`${key}=${JSON.stringify(env[key])} is not usable: ${why}${detail}`);
  };
  if (rejected.has('ZOTERO_LIBRARY_TYPE')) {
    refuse(
      'ZOTERO_LIBRARY_TYPE',
      'refusing to guess whether to read and write a personal or a group library',
    );
  }
  if (rejected.has('ZOTERO_LIBRARY_ID')) {
    refuse(
      'ZOTERO_LIBRARY_ID',
      'refusing to fall back to whichever library the API key belongs to',
    );
  }

  const oauthEnabled = parsed.ZOTEUS_OAUTH_ENABLED;
  const publicUrl = parsed.ZOTEUS_PUBLIC_URL?.replace(/\/+$/, '');
  const mode = parsed.ZOTEUS_OAUTH_MODE;
  const store = parsed.ZOTEUS_OAUTH_STORE;
  if (oauthEnabled) {
    if (rejected.has('ZOTEUS_OAUTH_MODE')) {
      refuse(
        'ZOTEUS_OAUTH_MODE',
        "refusing to fall back to shared-passcode auth, which would serve every client from the operator's own Zotero key",
      );
    }
    if (rejected.has('ZOTEUS_OAUTH_STORE')) {
      refuse(
        'ZOTEUS_OAUTH_STORE',
        'refusing to fall back to in-memory tokens, which would skip the encryption key that file storage requires',
      );
    }
    if (!publicUrl) {
      if (rejected.has('ZOTEUS_PUBLIC_URL')) {
        refuse('ZOTEUS_PUBLIC_URL', 'it must be an absolute URL, e.g. https://zoteus.example.com');
      }
      throw new Error('ZOTEUS_PUBLIC_URL is required when ZOTEUS_OAUTH_ENABLED=true');
    }
    if (mode === 'passcode') {
      if (!parsed.ZOTEUS_OAUTH_PASSCODE) {
        throw new Error(
          'ZOTEUS_OAUTH_PASSCODE is required when ZOTEUS_OAUTH_ENABLED=true (passcode mode)',
        );
      }
      if (parsed.ZOTEUS_OAUTH_PASSCODE.length < MIN_PASSCODE_LENGTH) {
        throw new Error(
          `ZOTEUS_OAUTH_PASSCODE must be at least ${MIN_PASSCODE_LENGTH} characters (generate one with: openssl rand -base64 24)`,
        );
      }
    } else {
      // zotero mode: per-user Zotero login replaces the shared passcode
      if (!parsed.ZOTERO_OAUTH_CLIENT_KEY || !parsed.ZOTERO_OAUTH_CLIENT_SECRET) {
        throw new Error(
          'ZOTERO_OAUTH_CLIENT_KEY and ZOTERO_OAUTH_CLIENT_SECRET are required when ZOTEUS_OAUTH_MODE=zotero (register an app at https://www.zotero.org/oauth/apps)',
        );
      }
    }
    if (store === 'file' && !parsed.ZOTEUS_OAUTH_TOKEN_SECRET) {
      throw new Error(
        'ZOTEUS_OAUTH_TOKEN_SECRET is required when ZOTEUS_OAUTH_STORE=file (used to encrypt stored Zotero keys at rest; generate one with: openssl rand -base64 32)',
      );
    }
  }
  // An empty CIMD host list means "any public host" (src/lib/cimd.ts), so a reference that
  // never expanded must not arrive here as empty: that turns a restriction the operator
  // wrote into no restriction at all. Blank stays legal, because blank is how it is spelled
  // deliberately.
  if (parsed.ZOTEUS_CIMD_ENABLED && looksUnexpanded(env.ZOTEUS_CIMD_ALLOWED_HOSTS)) {
    refuse(
      'ZOTEUS_CIMD_ALLOWED_HOSTS',
      'it looks like a reference that was never expanded, and an empty host list means no restriction at all',
    );
  }

  // #43 asked for a separate ZOTEUS_LOCAL_EMBEDDING_MODEL, and the answer was the knob that
  // already exists. Saying so is the point: a variable nothing reads is otherwise a setting
  // that appears to work and changes nothing.
  if (
    env.ZOTEUS_LOCAL_EMBEDDING_MODEL !== undefined &&
    !isUnset(env.ZOTEUS_LOCAL_EMBEDDING_MODEL)
  ) {
    warnings.push(
      'ZOTEUS_LOCAL_EMBEDDING_MODEL is not a Zoteus setting and is ignored; ZOTEUS_EMBEDDING_MODEL ' +
        'names the model of whichever ZOTEUS_EMBEDDINGS provider is active, local included',
    );
  }

  // A precision is a file the local pipeline downloads. An API provider returns vectors
  // computed on someone else's hardware at whatever precision they run, so the variable is
  // not merely unused there, it is a promise Zoteus cannot keep: say so rather than let it
  // read as an accepted setting.
  if (
    parsed.ZOTEUS_EMBEDDINGS !== 'local' &&
    env.ZOTEUS_EMBEDDING_DTYPE !== undefined &&
    !isUnset(env.ZOTEUS_EMBEDDING_DTYPE)
  ) {
    warnings.push(
      `ZOTEUS_EMBEDDING_DTYPE applies to on-device embeddings only and is ignored under ` +
        `ZOTEUS_EMBEDDINGS=${parsed.ZOTEUS_EMBEDDINGS}; precision is an argument to the local pipeline`,
    );
  }

  // The same fact as for the dtype: pooling is an argument to the local pipeline, and an
  // API provider pools on its own side.
  if (
    parsed.ZOTEUS_EMBEDDINGS !== 'local' &&
    env.ZOTEUS_EMBEDDING_POOLING !== undefined &&
    !isUnset(env.ZOTEUS_EMBEDDING_POOLING)
  ) {
    warnings.push(
      `ZOTEUS_EMBEDDING_POOLING applies to on-device embeddings only and is ignored under ` +
        `ZOTEUS_EMBEDDINGS=${parsed.ZOTEUS_EMBEDDINGS}; pooling is an argument to the local pipeline`,
    );
  }
  const allowedHosts = (parsed.ZOTEUS_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    apiKey: parsed.ZOTERO_API_KEY,
    localApiKey: parsed.ZOTEUS_LOCAL_API_KEY,
    libraryId: parsed.ZOTERO_LIBRARY_ID,
    libraryType: parsed.ZOTERO_LIBRARY_TYPE,
    local: parsed.ZOTEUS_LOCAL,
    localPort: parsed.ZOTERO_LOCAL_PORT,
    zoteroDeadlineMs: parsed.ZOTEUS_ZOTERO_DEADLINE_MS,
    translationServerUrl: parsed.ZOTEUS_TRANSLATION_SERVER_URL,
    embeddings: parsed.ZOTEUS_EMBEDDINGS,
    ollamaUrl: parsed.ZOTEUS_OLLAMA_URL,
    embeddingModel: parsed.ZOTEUS_EMBEDDING_MODEL?.trim() || undefined,
    embeddingPrefixes: parsed.ZOTEUS_EMBEDDING_PREFIXES,
    embeddingDtype: parsed.ZOTEUS_EMBEDDING_DTYPE,
    embeddingPooling: parsed.ZOTEUS_EMBEDDING_POOLING,
    embedBatchSize: parsed.ZOTEUS_EMBED_BATCH_SIZE,
    embedBatchDelayMs: parsed.ZOTEUS_EMBED_BATCH_DELAY_MS,
    embedMaxRetries: parsed.ZOTEUS_EMBED_MAX_RETRIES,
    transformersPath: parsed.ZOTEUS_TRANSFORMERS_PATH?.trim() || undefined,
    ocr: parsed.ZOTEUS_OCR,
    ocrPath: parsed.ZOTEUS_OCR_PATH?.trim() || undefined,
    ocrMaxPages: parsed.ZOTEUS_OCR_MAX_PAGES,
    ocrLangs: parsed.ZOTEUS_OCR_LANGS,
    indexFulltext: parsed.ZOTEUS_INDEX_FULLTEXT,
    indexOwnWords: parsed.ZOTEUS_INDEX_OWN_WORDS,
    indexFulltextMaxChars: parsed.ZOTEUS_INDEX_FULLTEXT_MAX_CHARS,
    indexFulltextConcurrency: parsed.ZOTEUS_INDEX_FULLTEXT_CONCURRENCY,
    indexMaxItems: parsed.ZOTEUS_INDEX_MAX_ITEMS,
    indexBackend: parsed.ZOTEUS_INDEX_BACKEND,
    indexMaxOpen: parsed.ZOTEUS_INDEX_MAX_OPEN,
    indexAnn: parsed.ZOTEUS_INDEX_ANN,
    accentExpansion: parsed.ZOTEUS_ACCENT_EXPANSION,
    indexAnnOversample: parsed.ZOTEUS_INDEX_ANN_OVERSAMPLE,
    indexAnnMinCandidates: parsed.ZOTEUS_INDEX_ANN_MIN_CANDIDATES,
    scholarProviders: parsed.ZOTEUS_SCHOLAR_PROVIDERS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    dataDir: parsed.ZOTEUS_DATA_DIR ?? defaultDataDir(env),
    zoteroDataDir: parsed.ZOTERO_DATA_DIR ?? defaultZoteroDataDir(env),
    contactEmail: parsed.ZOTEUS_CONTACT_EMAIL,
    openalexApiKey: parsed.ZOTEUS_OPENALEX_API_KEY,
    oaFetch: parsed.ZOTEUS_OA_FETCH,
    importMaxEntries: parsed.ZOTEUS_IMPORT_MAX_ENTRIES,
    allowDelete: parsed.ZOTEUS_ALLOW_DELETE,
    readOnly: parsed.ZOTEUS_READ_ONLY,
    confirmBulkWrites: parsed.ZOTEUS_CONFIRM_BULK_WRITES,
    logLevel: parsed.ZOTEUS_LOG_LEVEL,
    logFormat: parsed.ZOTEUS_LOG_FORMAT,
    logFile: parsed.ZOTEUS_LOG_FILE,
    updateCheck: parsed.ZOTEUS_UPDATE_CHECK,
    dist: parsed.ZOTEUS_DIST,
    allowInsecureHttp: parsed.ZOTEUS_ALLOW_INSECURE_HTTP,
    metricsEnabled: parsed.ZOTEUS_METRICS_ENABLED,
    metricsToken: parsed.ZOTEUS_METRICS_TOKEN,
    usage: {
      enabled: parsed.ZOTEUS_USAGE_LOG,
      retentionDays: parsed.ZOTEUS_USAGE_RETENTION_DAYS,
      identify: parsed.ZOTEUS_USAGE_IDENTIFY,
    },
    readyzCheckZotero: parsed.ZOTEUS_READYZ_CHECK_ZOTERO,
    mcpRateLimit: {
      windowMs: parsed.ZOTEUS_MCP_RATE_LIMIT_WINDOW_SEC * 1000,
      max: parsed.ZOTEUS_MCP_RATE_LIMIT_MAX,
    },
    oauth: {
      enabled: oauthEnabled,
      publicUrl,
      passcode: parsed.ZOTEUS_OAUTH_PASSCODE,
      accessTokenTtlSec: parsed.ZOTEUS_OAUTH_ACCESS_TTL,
      refreshTokenTtlSec: parsed.ZOTEUS_OAUTH_REFRESH_TTL,
      allowedHosts,
      mode,
      zoteroClientKey: parsed.ZOTERO_OAUTH_CLIENT_KEY,
      zoteroClientSecret: parsed.ZOTERO_OAUTH_CLIENT_SECRET,
      store,
      tokenSecret: parsed.ZOTEUS_OAUTH_TOKEN_SECRET,
    },
    cimd: {
      enabled: parsed.ZOTEUS_CIMD_ENABLED,
      cacheTtlSec: parsed.ZOTEUS_CIMD_CACHE_TTL_SEC,
      maxBytes: parsed.ZOTEUS_CIMD_MAX_BYTES,
      allowedRedirectSchemes: parsed.ZOTEUS_CIMD_ALLOWED_REDIRECT_SCHEMES.split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      allowedHosts: parsed.ZOTEUS_CIMD_ALLOWED_HOSTS.split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    },
    warnings,
  };
}
