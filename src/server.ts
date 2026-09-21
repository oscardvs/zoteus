import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { ZoteusConfig } from './config.js';
import { createLogger, type Logger } from './lib/logger.js';
import type { Metrics } from './lib/metrics.js';
import type { UsageRecorder } from './lib/usage/event.js';
import { RateLimitedFetcher } from './api/http.js';
import { WebApiClient } from './api/web-client.js';
import { LocalApiClient } from './api/local-client.js';
import { LocalWriteClient } from './api/local-writes.js';
import { ConnectorWriteClient } from './api/connector-writes.js';
import { probeCapabilities } from './router/capabilities.js';
import { LocalApiStatus } from './router/local-status.js';
import { LibraryRouter } from './router/library-router.js';
import { SchemaService } from './schema/schema-service.js';
import { join } from 'node:path';
import { StyleResolver } from './features/citation/styles.js';
import { TranslationServerClient } from './features/citation/translation-server.js';
import { createSearchIndex } from './features/search/factory.js';
import { canonicalLibraryToken, describeLibraryToken, type SearchIndex } from './features/search/backend.js';
import { defaultIndexPath, SearchIndexRegistry } from './features/search/index-registry.js';
import { createEmbeddingProvider } from './features/search/embeddings.js';
import { ScholarGraph } from './features/scholar/graph.js';
import {
  registerAllTools,
  SESSION_RETIRED_MESSAGE,
  type ToolContext,
  type ToolContextSource,
  type AnyToolDefinition,
} from './registry/registry.js';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';
import { tools } from './tools/index.js';
import { UpdateChecker } from './lib/update-check.js';
import { VERSION as SERVER_VERSION } from './lib/version.js';

// Read from package.json so release bumps can't leave a stale hardcoded string
// (healthz/serverInfo reported 1.0.1 for several releases).
const VERSION: string = SERVER_VERSION;

export interface ContextOverrides {
  /** Per-user Zotero API key (multi-tenant); defaults to config.apiKey. */
  apiKey?: string;
  /** Per-user Zotero userID; scopes the search index file and is the cache key. */
  zoteroUserId?: number;
  /**
   * Process-wide observability handles, shared by every context rather than built per
   * user: one metrics registry so `/metrics` totals the whole server, and one usage
   * recorder so there is a single SQLite writer.
   */
  telemetry?: Telemetry;
}

/** The observability handles a context passes on to its tool calls. */
export interface Telemetry {
  metrics?: Metrics;
  usage?: UsageRecorder;
  /**
   * The process's one logger, the instance `main()` created with ZOTEUS_LOG_FILE attached.
   * Without it a context built its own from the level and format alone, and everything
   * that logs through the context (the embedder, every index build's progress and failure
   * line, the Zotero clients) went to stderr only, while the file received the HTTP request
   * lines and nothing else (#59).
   */
  logger?: Logger;
}

/**
 * Tools exposed for this config: read-only mode hides mutating tools (plus zotero_index,
 * which only touches local index files). Mirrors the M10 selection.
 */
function selectActiveTools(config: ZoteusConfig): AnyToolDefinition[] {
  return config.readOnly
    ? tools.filter((t) => t.annotations?.readOnlyHint === true || t.name === 'zotero_index')
    : tools;
}

/**
 * Build the (expensive) per-context state: Zotero clients, capability probe, router,
 * schema, search index, etc. With no overrides this is the operator/shared context
 * (identical to M10). With a per-user apiKey it is that tenant's context.
 */
export async function buildContext(
  config: ZoteusConfig,
  overrides: ContextOverrides = {},
): Promise<ToolContext> {
  const { metrics, usage } = overrides.telemetry ?? {};
  // The caller's logger when it has one, so a context logs where the server logs. The
  // fallback carries the file too: a context built without the server's logger (a test, an
  // embedding) must still leave the record ZOTEUS_LOG_FILE promises.
  const logger =
    overrides.telemetry?.logger ?? createLogger(config.logLevel, config.logFormat, { file: config.logFile });
  const apiKey = overrides.apiKey ?? config.apiKey;
  const perUser = overrides.apiKey !== undefined;
  const fetcher = new RateLimitedFetcher({ maxConcurrency: 4, logger });
  const web = new WebApiClient({ apiKey, fetcher, contactEmail: config.contactEmail, logger });
  // Per-user (hosted) contexts never touch the operator's desktop local API.
  const local =
    !perUser && config.local !== 'off'
      ? new LocalApiClient({ port: config.localPort, fetcher, deadlineMs: config.zoteroDeadlineMs })
      : undefined;

  const capabilities = await probeCapabilities(config, { web, local, logger });
  if (perUser && (!capabilities.cloud || capabilities.cloud.userID !== overrides.zoteroUserId)) {
    // Refused rather than built degraded: a per-user context exists only to reach one
    // account's library through the cloud, and one whose key the cloud did not confirm
    // has nothing to serve. The next call tries again, so a zotero.org outage costs a
    // retry, not a reconnect.
    throw new Error(
      'Zotero did not confirm this key for this account (zotero.org unreachable, or the key revoked or reassigned). ' +
        'Retry; if it persists, reconnect Zotero.',
    );
  }
  // The startup probe is the first answer, not the only one: Zotero may be launched after
  // this server, and used to stay invisible for the life of the process when it was (#18,
  // #22). This keeps `capabilities` live, re-asking lazily on the way in to a tool call.
  const localStatus = new LocalApiStatus({ config, client: local, capabilities, logger });
  const router = new LibraryRouter({ config, capabilities, web, local });
  // Every cloud write tells the router, so reads of that library stop being answered by a
  // desktop app that has not synced it yet. Wired at the client rather than in each write
  // tool: writes reach api.zotero.org through exactly this object, and a tool cannot forget
  // to report one.
  web.onWrite = (lib, type, keys, removed) => router.noteCloudWrite(lib, type, keys, removed);
  // Zotero 10+ accepts local-API writes behind a user-granted key. Only the operator
  // context (never per-user tenants) talks to the desktop app. The client is created
  // eagerly but authorizes lazily, on first write.
  //
  // Deliberately NOT gated on the startup probe. Gating it there made a desktop app that
  // started after this server permanently unwritable: `ensureLocalApi` would flip the
  // capability to true and every write path would still fall through to the cloud, because
  // the client object it needed had never been constructed (#22). Constructing it costs a
  // base URL and no I/O, and every call site still gates the write itself on the live
  // capability, so nothing here can reach a Zotero that is not running.
  const localWrites =
    !perUser && config.local !== 'off'
      ? new LocalWriteClient({
          port: config.localPort,
          fetcher,
          logger,
          key: config.localApiKey,
          keyStorePath: join(config.dataDir, 'local-api-key.json'),
        })
      : undefined;
  // The connector protocol works on all recent Zotero versions while the app runs,
  // including Zotero 9 and earlier, whose local API is read-only (no grant dialog).
  const connectorWrites =
    !perUser && config.local !== 'off'
      ? new ConnectorWriteClient({ port: config.localPort, fetcher, logger })
      : undefined;
  const schema = new SchemaService({ web });
  const styles = new StyleResolver();
  const translation = new TranslationServerClient(config.translationServerUrl, fetcher);
  // Preflighted at startup so a configured-but-unrunnable embedder (the classic case: a
  // desktop bundle that cannot carry @huggingface/transformers) is reported as inactive
  // from the first status call, rather than discovered as a silently empty vector set.
  const embedding = createEmbeddingProvider(config, logger);
  // The path this data directory has always used. Unchanged on purpose: it is what an
  // index built by an earlier version lives at, and a second library gets a SIBLING file
  // rather than a rename, so nothing has to be migrated. `zoteroUserId` stays part of it
  // in multi-tenant mode, and no library token may ever replace or collapse that segment:
  // two tenants who both belong to group 4523 still index through different Zotero keys.
  const searchIndexPath = defaultIndexPath(config.dataDir, overrides.zoteroUserId);
  // Hoisted rather than passed inline, because a repair has to be able to build the same
  // index again later and the embedder triple is not reachable from the context (#21).
  // Split from the path so the registry can apply the same options to a second library.
  const searchIndexOpts = {
    embedder: embedding.provider,
    configured: embedding.configured,
    unavailable: embedding.unavailable,
    logger,
    backend: config.indexBackend,
    annEnabled: config.indexAnn,
    accentExpansion: config.accentExpansion,
    annOversample: config.indexAnnOversample,
    annMinCandidates: config.indexAnnMinCandidates,
  };
  // Opens the store (and, on the SQLite backend's first run, imports a legacy JSON index).
  // ZOTEUS_INDEX_BACKEND=sqlite on a runtime without node:sqlite throws here, at startup.
  const search = await createSearchIndex({ ...searchIndexOpts, jsonPath: searchIndexPath });
  // Vectors from a previous embedding model are dropped on load; say so at startup too,
  // not only in tool output, because the remedy is a rebuild the user has to start.
  const stale = search.buildStatus().vectorsStaleReason;
  if (stale) logger.warn(stale);
  logger.debug(`search index backend: ${search.storage} (${searchIndexPath})`);
  const scholar = new ScholarGraph({
    fetcher,
    mailto: config.contactEmail,
    openalexApiKey: config.openalexApiKey,
  });

  /**
   * Which library the file at `searchIndexPath` answers for.
   *
   * Its OWN stamp wins over the configured default, and that is what keeps a
   * ZOTERO_LIBRARY_TYPE=group install working: that install has been writing its group's
   * rows into this very file all along, so keying the file by the configured default and
   * handing the group a new sibling would orphan a complete index and silently start over.
   * An unstamped or empty index has nothing to say about whose rows it holds, so it takes
   * the configured default, which is exactly what the next build is about to stamp it.
   */
  const primaryLibrary = search.buildStatus().library ?? canonicalLibraryToken(router.defaultLibrary());
  /**
   * Every library's index, with the one above as the entry that is never closed to make
   * room. One store holds one library's rows (see index-registry.ts), so a second library
   * is a second file beside this one, and ZOTEUS_INDEX_MAX_OPEN bounds how many are held
   * open at once.
   */
  const indexes = new SearchIndexRegistry({
    create: searchIndexOpts,
    primaryPath: searchIndexPath,
    primary: search,
    primaryLibrary,
    maxOpen: config.indexMaxOpen,
    logger,
  });
  /**
   * The one state where the stamp-first rule above costs something, said out loud at
   * startup because nothing else in the product can see it.
   *
   * When this file's stamp disagrees with the configured default library, the default
   * library's index is a SIBLING of this one: `zotero_index` with no library argument
   * builds and reports that sibling while this file goes on holding rows of its own. Two
   * installs land here, and they are indistinguishable once written: one whose index
   * really was built for another library, and a group-default install indexed by a Zoteus
   * older than the stamp, whose file holds the GROUP's rows under the personal library's
   * token. Both want to know, and the remedy (delete the primary and rebuild, or address
   * libraries explicitly) is the same.
   */
  const configuredDefault = canonicalLibraryToken(router.defaultLibrary());
  if (primaryLibrary !== configuredDefault && search.buildStatus().documents > 0) {
    logger.warn(
      `The search index at ${searchIndexPath} is stamped ${describeLibraryToken(primaryLibrary)}, but this server's ` +
        `default library is ${describeLibraryToken(configuredDefault)}. A call that names no library therefore ` +
        `addresses ${indexes.pathFor(configuredDefault)} instead, and this file answers only calls that name ` +
        `${describeLibraryToken(primaryLibrary)}. If this index was in fact built for ` +
        `${describeLibraryToken(configuredDefault)} by a Zoteus older than the library stamp, delete it and run ` +
        'zotero_index action:"build" again to restamp it; otherwise nothing is wrong and both libraries can have ' +
        'an index of their own here (zotero_index action:"libraries" lists them).',
    );
  }

  /**
   * Replace the held search index with a freshly opened one.
   *
   * Three properties, each load-bearing, and all three now live in the registry's
   * `reopen` so that every library gets them rather than only the default one:
   *  - single-flight, so two concurrent repairs cannot both open the same database (they
   *    interleave across awaits on one event loop, and the second would orphan the first);
   *  - the old handle is released before the new one is opened, because a repair deletes
   *    files and on Windows an open handle refuses the unlink, so a server holding them
   *    would block the recovery it is prescribing;
   *  - `ctx.search` is only ever assigned an index that opened successfully, so a failed
   *    reopen leaves the faulted one in place rather than leaving the field undefined.
   *
   * Still the default library's index and nothing else, because that is the one `ctx.search`
   * holds. A second library's index is repaired through the registry, under its own token.
   */
  const reopenSearchIndex = async (): Promise<SearchIndex> => {
    const fresh = await indexes.reopen(primaryLibrary);
    ctx.search = fresh;
    return fresh;
  };

  const ctx: ToolContext = {
    config,
    capabilities,
    router,
    schema,
    web,
    local,
    localWrites,
    connectorWrites,
    styles,
    translation,
    search,
    scholar,
    fetcher,
    logger,
    remoteCaller: perUser || config.oauth.enabled,
    zoteroUserId: overrides.zoteroUserId,
    metrics,
    usage,
    searchIndexPath,
    indexes,
    localStatus,
    reopenSearchIndex,
  };
  // Manual installs (notably the .dxt) have no auto-update channel; check GitHub
  // releases once a day and let zotero_whoami surface a newer version. Operator
  // context only: per-user (hosted) tenants share the operator's install.
  if (!perUser) {
    ctx.updates = new UpdateChecker({
      currentVersion: VERSION,
      dataDir: config.dataDir,
      logger,
      enabled: config.updateCheck,
    });
    void ctx.updates.start();
  }
  ctx.toolCatalog = selectActiveTools(config).map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    deferLoading: t.deferLoading,
  }));
  return ctx;
}

/** The McpServer shell: identity, capabilities and instructions, with nothing registered yet. */
function newMcpServer(): McpServer {
  return new McpServer(
    { name: 'zoteus', version: VERSION },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true },
      },
      instructions:
        'Zoteus exposes your Zotero library. Call zotero_whoami first to resolve identity. Prefer zotero_search_items for discovery and zotero_get_item for full records. Use zotero_schema before constructing items. Library search tools: zotero_search_items (keyword/field/tag), zotero_semantic_search (by meaning; run zotero_index action:"build" first), zotero_get_item (full record). IMPORTANT: zotero_scholar searches the EXTERNAL scholarly web (OpenAlex/Crossref) — it does NOT search or read your library; never use it to find items in the library. Call tools sequentially rather than in large parallel batches — Zotero rate-limits, and parallel or very long calls can time out.',
    },
  );
}

/** Wire a server's tools, resources and prompts to a context (built, or still building). */
function registerAll(
  server: McpServer,
  config: ZoteusConfig,
  source: ToolContextSource,
): McpServer {
  registerAllTools(server, selectActiveTools(config), source);
  registerResources(server, source);
  registerPrompts(server);
  return server;
}

/** Create a fresh McpServer bound to a (possibly per-user) ToolContext. */
export function createServer(ctx: ToolContext): McpServer {
  return registerAll(newMcpServer(), ctx.config, ctx);
}

/**
 * A fresh McpServer whose context is resolved through `source` on every call.
 *
 * The form the HTTP transport uses with a `ContextCache`: the session's server never holds
 * a context object of its own, so an eviction or a rebuild between two calls is invisible
 * to it, and a credential change is answered by the cache rather than by a stale binding.
 */
export function createServerFrom(config: ZoteusConfig, source: ToolContextSource): McpServer {
  return registerAll(newMcpServer(), config, source);
}

export interface DeferredServer {
  server: McpServer;
  /** The context, built on first call. A failed build is retried by the next call. */
  context: () => Promise<ToolContext>;
}

/**
 * A server that can be connected before its context exists.
 *
 * buildContext probes the desktop app (retrying for ~2s while Zotero starts), the cloud
 * key and the search index, so building it first leaves `initialize` unanswered for
 * seconds. Hosts do not wait that long — Claude Desktop's shared Cowork/Code pool gives
 * the handshake well under a second and then tears the server down (#18) — so the
 * handshake, which needs only the config-derived tool list, goes first and the build runs
 * behind it. Tool calls await the build, so none of them ever sees a half-built context.
 */
export function createDeferredServer(
  config: ZoteusConfig,
  build: () => Promise<ToolContext> = () => buildContext(config),
): DeferredServer {
  let pending: Promise<ToolContext> | undefined;
  const context = (): Promise<ToolContext> => {
    // A rejection is not cached: the usual causes are transient (a second Zoteus process
    // still holding the search index, a network blip on the key probe), and a permanent
    // one simply fails the same way again on the next call.
    pending ??= build().catch((err) => {
      pending = undefined;
      throw err;
    });
    return pending;
  };
  return { server: registerAll(newMcpServer(), config, context), context };
}

export interface BuiltServer {
  server: McpServer;
  ctx: ToolContext;
  /**
   * Create a fresh McpServer sharing the same (expensive) ToolContext. Used by the
   * HTTP transport to give each MCP session its own server/transport pair — a single
   * McpServer/transport cannot be reused across sessions (it rejects a second
   * `initialize` with "Server already initialized").
   */
  createServer: () => McpServer;
}

/** The startup line describing a trimmed tool set, or undefined when every tool is exposed. */
export function toolSelectionNotice(config: ZoteusConfig): string | undefined {
  return config.readOnly
    ? `Read-only mode: exposing ${selectActiveTools(config).length}/${tools.length} tools.`
    : undefined;
}

/** Operator/shared server (stdio + the no-auth HTTP path). Preserves the M10 signature. */
export async function buildServer(
  config: ZoteusConfig,
  telemetry?: Telemetry,
): Promise<BuiltServer> {
  const ctx = await buildContext(config, { telemetry });
  const notice = toolSelectionNotice(config);
  if (notice) ctx.logger.info(notice);
  return { server: createServer(ctx), ctx, createServer: () => createServer(ctx) };
}

/** How many replaced keys an account keeps on record, so a rotation storm stays bounded. */
const RETIRED_KEYS_PER_ACCOUNT = 8;

/** The per-user credential an access token carries, if it carries one. */
function credentials(authInfo?: AuthInfo): { zoteroKey?: string; zoteroUserId?: number } {
  const extra = authInfo?.extra as { zoteroKey?: string; zoteroUserId?: number } | undefined;
  return { zoteroKey: extra?.zoteroKey, zoteroUserId: extra?.zoteroUserId };
}

/**
 * Resolves a ToolContext per authenticated user (keyed by zoteroUserId), caching the
 * expensive build. Sessions without a per-user Zotero key (passcode/stdio/no-auth) fall
 * back to the operator context. Eviction drops the cache entry AND closes that context's
 * search indexes.
 *
 * Resolved on EVERY tool call, not once per session (`createServerFrom` with a thunk in
 * src/index.ts). A session that bound its context at `initialize` kept the object an LRU
 * eviction had closed and retired, so the 51st distinct account to connect cost the least
 * recently CONNECTED tenant its session: "Reconnect to start a new session" on every later
 * call, with no 404 to make the client do so on its own, and an in-flight search ending in
 * "The SQLite search index is not open". Resolved per call, an eviction is what it should
 * be: the evicted context is closed, and the next call from that account builds a fresh
 * one at the cost of one key probe. It also makes `lastUsed` mean used.
 *
 * A context IS still retired, and its sessions told to reconnect, when the account's key
 * changes: that is a credential change, and a session carrying the old key must not keep
 * a context built from it. The replaced key is remembered so that a session still
 * presenting it is refused rather than rebuilding the old context and retiring the new one
 * on every call, which two live sessions of one account would otherwise do to each other.
 */
export class ContextCache {
  private readonly entries = new Map<number, { ctx: ToolContext; lastUsed: number; zoteroKey: string }>();
  /** Keys each account has replaced, most recent last. */
  private readonly retired = new Map<number, Set<string>>();
  // Serialize cache MISSES so simultaneous initializations cannot open competing index
  // handles or replace a credential while its predecessor is still opening. Hits do not
  // queue here: with a resolve per tool call, waiting behind another tenant's build would
  // be paid on every call.
  private resolveTail: Promise<unknown> = Promise.resolve();
  private order = 0;

  constructor(
    private readonly config: ZoteusConfig,
    private readonly operatorCtx: ToolContext,
    private readonly maxEntries = 50,
    private readonly telemetry?: Telemetry,
  ) {}

  resolve(authInfo?: AuthInfo): Promise<ToolContext> {
    const { zoteroKey, zoteroUserId } = credentials(authInfo);
    if (!zoteroKey || zoteroUserId === undefined) return Promise.resolve(this.operatorCtx);
    const hit = this.entries.get(zoteroUserId);
    if (hit && hit.zoteroKey === zoteroKey) {
      hit.lastUsed = ++this.order;
      return Promise.resolve(hit.ctx);
    }
    const result = this.resolveTail.then(() => this.resolveMiss(zoteroKey, zoteroUserId));
    this.resolveTail = result.catch(() => {});
    return result;
  }

  private async resolveMiss(zoteroKey: string, zoteroUserId: number): Promise<ToolContext> {
    // Re-read under the lock: an identical miss queued behind this one must not build twice.
    const hit = this.entries.get(zoteroUserId);
    if (hit && hit.zoteroKey === zoteroKey) {
      hit.lastUsed = ++this.order;
      return hit.ctx;
    }
    if (this.retired.get(zoteroUserId)?.has(zoteroKey)) throw new Error(SESSION_RETIRED_MESSAGE);
    if (hit) {
      hit.ctx.invalidated = true;
      this.entries.delete(zoteroUserId);
      this.retire(zoteroUserId, hit.zoteroKey);
      await releaseIndexes(hit.ctx);
    }
    const ctx = await buildContext(this.config, {
      apiKey: zoteroKey,
      zoteroUserId,
      telemetry: this.telemetry,
    });
    this.entries.set(zoteroUserId, { ctx, lastUsed: ++this.order, zoteroKey });
    await this.evictIfNeeded(zoteroUserId);
    return ctx;
  }

  private retire(zoteroUserId: number, key: string): void {
    const keys = this.retired.get(zoteroUserId) ?? new Set<string>();
    keys.add(key);
    while (keys.size > RETIRED_KEYS_PER_ACCOUNT) keys.delete(keys.values().next().value!);
    this.retired.set(zoteroUserId, keys);
  }

  /**
   * Persist every live context's search indexes (operator + per-user) and release their
   * stores. Best-effort, and terminal: this runs from the shutdown handler, where closing
   * is what checkpoints SQLite's write-ahead log instead of leaving it for the next startup.
   *
   * EVERY index of every context, not one each. A context now holds one index per library
   * it has addressed, and flushing only `ctx.search` would leave every other library's
   * handle open and its write-ahead log uncheckpointed on every shutdown.
   */
  async flushIndexes(): Promise<void> {
    await this.resolveTail;
    const ctxs = [this.operatorCtx, ...[...this.entries.values()].map((e) => e.ctx)];
    await Promise.allSettled(ctxs.map((c) => releaseIndexes(c)));
  }

  /**
   * Drop the least recently used contexts, closing their indexes as they go.
   *
   * Closing is the point. Dropping the cache entry alone left the evicted context's
   * SQLite handle open and its write-ahead log uncheckpointed for the life of the process,
   * once per eviction, and a context now holds one index per library it has addressed, so
   * the leak multiplies.
   *
   * Evicted contexts are marked invalidated so that nothing which still holds the object
   * (there should be nothing: sessions resolve per call) can use it after its indexes
   * closed. Contexts with a build running, a search holding an index open, and the
   * just-resolved context are not evicted; the loop takes the next candidate instead.
   *
   * "Any index", not `ctx.search`, and the difference was a real failure: a build on a
   * group runs inside that group's own index (zotero_index hands the registry's store to
   * startIndexBuild), so `ctx.search.isBuilding` is false throughout it. Asking only the
   * primary let another tenant's first request evict that context, close the group's store
   * mid-build through `closeAll`, and end an hours-long, possibly paid-embedding build at
   * "The SQLite search index is not open."
   */
  private async evictIfNeeded(justAdded?: number): Promise<void> {
    while (this.entries.size > this.maxEntries) {
      let oldestKey: number | undefined;
      let oldest = Infinity;
      for (const [k, v] of this.entries) {
        if (k === justAdded || v.ctx.search.isBuilding || v.ctx.indexes?.anyBuilding() || v.ctx.indexes?.anyLeased()) {
          continue;
        }
        if (v.lastUsed < oldest) {
          oldest = v.lastUsed;
          oldestKey = k;
        }
      }
      if (oldestKey === undefined) break;
      const evicted = this.entries.get(oldestKey)!;
      evicted.ctx.invalidated = true;
      this.entries.delete(oldestKey);
      await releaseIndexes(evicted.ctx);
    }
  }
}

/**
 * Persist and release every search index a context holds.
 *
 * Two independent attempts per index. `save()` refuses on a store that could not be read,
 * and close() is what checkpoints the write-ahead log and releases the file handle, so
 * chaining them would let one faulted index leak a handle and an uncheckpointed WAL,
 * silently, since the callers swallow the rejection.
 *
 * Falls back to `ctx.search` alone where there is no registry, which is every hand-built
 * test context.
 */
async function releaseIndexes(c: ToolContext): Promise<void> {
  if (c.indexes) {
    await c.indexes.closeAll();
    return;
  }
  await c.search.save().catch((e) => {
    c.logger.debug(`Flushing the search index on shutdown: ${e instanceof Error ? e.message : String(e)}`);
  });
  await c.search.close().catch((e) => {
    c.logger.debug(`Closing the search index on shutdown: ${e instanceof Error ? e.message : String(e)}`);
  });
}

export type { Logger };
