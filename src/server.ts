import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { ZoteusConfig } from './config.js';
import { createLogger, type Logger } from './lib/logger.js';
import { RateLimitedFetcher } from './api/http.js';
import { WebApiClient } from './api/web-client.js';
import { LocalApiClient } from './api/local-client.js';
import { LocalWriteClient } from './api/local-writes.js';
import { ConnectorWriteClient } from './api/connector-writes.js';
import { probeCapabilities } from './router/capabilities.js';
import { LibraryRouter } from './router/library-router.js';
import { SchemaService } from './schema/schema-service.js';
import { join } from 'node:path';
import { StyleResolver } from './features/citation/styles.js';
import { TranslationServerClient } from './features/citation/translation-server.js';
import { createSearchIndex } from './features/search/factory.js';
import { createEmbeddingProvider } from './features/search/embeddings.js';
import { ScholarGraph } from './features/scholar/graph.js';
import { registerAllTools, type ToolContext, type ToolContextSource, type ToolDefinition } from './registry/registry.js';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';
import { tools } from './tools/index.js';
import { UpdateChecker } from './lib/update-check.js';
import { createRequire } from 'node:module';

// Read from package.json so release bumps can't leave a stale hardcoded string
// (healthz/serverInfo reported 1.0.1 for several releases).
const VERSION: string = createRequire(import.meta.url)('../package.json').version;

export interface ContextOverrides {
  /** Per-user Zotero API key (multi-tenant); defaults to config.apiKey. */
  apiKey?: string;
  /** Per-user Zotero userID; scopes the search index file and is the cache key. */
  zoteroUserId?: number;
}

/**
 * Tools exposed for this config: read-only mode hides mutating tools (plus zotero_index,
 * which only touches local index files). Mirrors the M10 selection.
 */
function selectActiveTools(config: ZoteusConfig): ToolDefinition[] {
  return config.readOnly
    ? tools.filter((t) => t.annotations?.readOnlyHint === true || t.name === 'zotero_index')
    : tools;
}

/**
 * Build the (expensive) per-context state: Zotero clients, capability probe, router,
 * schema, search index, etc. With no overrides this is the operator/shared context
 * (identical to M10). With a per-user apiKey it is that tenant's context.
 */
export async function buildContext(config: ZoteusConfig, overrides: ContextOverrides = {}): Promise<ToolContext> {
  const logger = createLogger(config.logLevel, config.logFormat);
  const apiKey = overrides.apiKey ?? config.apiKey;
  const perUser = overrides.apiKey !== undefined;
  const fetcher = new RateLimitedFetcher({ maxConcurrency: 4, logger });
  const web = new WebApiClient({ apiKey, fetcher, contactEmail: config.contactEmail, logger });
  // Per-user (hosted) contexts never touch the operator's desktop local API.
  const local = !perUser && config.local !== 'off' ? new LocalApiClient({ port: config.localPort, fetcher }) : undefined;

  const capabilities = await probeCapabilities(config, { web, local, logger });
  const router = new LibraryRouter({ config, capabilities, web, local });
  // Zotero 10+ accepts local-API writes behind a user-granted key. Only the operator
  // context (never per-user tenants) talks to the desktop app. The client is created
  // eagerly but authorizes lazily, on first write.
  const localWrites =
    !perUser && capabilities.localApi
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
    !perUser && capabilities.localApi
      ? new ConnectorWriteClient({ port: config.localPort, fetcher, logger })
      : undefined;
  const schema = new SchemaService({ web });
  const styles = new StyleResolver();
  const translation = new TranslationServerClient(config.translationServerUrl, fetcher);
  // Preflighted at startup so a configured-but-unrunnable embedder (the classic case: a
  // desktop bundle that cannot carry @huggingface/transformers) is reported as inactive
  // from the first status call, rather than discovered as a silently empty vector set.
  const embedding = createEmbeddingProvider(config, logger);
  const searchIndexPath = join(
    config.dataDir,
    overrides.zoteroUserId !== undefined ? `search-index-${overrides.zoteroUserId}.json` : 'search-index.json',
  );
  // Opens the store (and, on the SQLite backend's first run, imports a legacy JSON index).
  // ZOTEUS_INDEX_BACKEND=sqlite on a runtime without node:sqlite throws here, at startup.
  const search = await createSearchIndex({
    embedder: embedding.provider,
    configured: embedding.configured,
    unavailable: embedding.unavailable,
    logger,
    backend: config.indexBackend,
    jsonPath: searchIndexPath,
  });
  // Vectors from a previous embedding model are dropped on load; say so at startup too,
  // not only in tool output, because the remedy is a rebuild the user has to start.
  const stale = search.buildStatus().vectorsStaleReason;
  if (stale) logger.warn(stale);
  logger.debug(`search index backend: ${search.storage} (${searchIndexPath})`);
  const scholar = new ScholarGraph({ fetcher, mailto: config.contactEmail });

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
    searchIndexPath,
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
function registerAll(server: McpServer, config: ZoteusConfig, source: ToolContextSource): McpServer {
  registerAllTools(server, selectActiveTools(config), source);
  registerResources(server, source);
  registerPrompts(server);
  return server;
}

/** Create a fresh McpServer bound to a (possibly per-user) ToolContext. */
export function createServer(ctx: ToolContext): McpServer {
  return registerAll(newMcpServer(), ctx.config, ctx);
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
export async function buildServer(config: ZoteusConfig): Promise<BuiltServer> {
  const ctx = await buildContext(config);
  const notice = toolSelectionNotice(config);
  if (notice) ctx.logger.info(notice);
  return { server: createServer(ctx), ctx, createServer: () => createServer(ctx) };
}

/**
 * Resolves a ToolContext per authenticated user (keyed by zoteroUserId), caching the
 * expensive build. Sessions without a per-user Zotero key (passcode/stdio/no-auth) fall
 * back to the operator context. Eviction only drops the cache entry; live sessions keep
 * the ctx they already closed over.
 */
export class ContextCache {
  private readonly entries = new Map<number, { ctx: ToolContext; lastUsed: number }>();
  private order = 0;

  constructor(
    private readonly config: ZoteusConfig,
    private readonly operatorCtx: ToolContext,
    private readonly maxEntries = 50,
  ) {}

  async resolve(authInfo?: AuthInfo): Promise<ToolContext> {
    const extra = authInfo?.extra as { zoteroKey?: string; zoteroUserId?: number; username?: string } | undefined;
    const zoteroKey = extra?.zoteroKey;
    const zoteroUserId = extra?.zoteroUserId;
    if (!zoteroKey || zoteroUserId === undefined) return this.operatorCtx;

    const hit = this.entries.get(zoteroUserId);
    if (hit) {
      hit.lastUsed = ++this.order;
      return hit.ctx;
    }
    const ctx = await buildContext(this.config, { apiKey: zoteroKey, zoteroUserId });
    this.entries.set(zoteroUserId, { ctx, lastUsed: ++this.order });
    this.evictIfNeeded();
    return ctx;
  }

  /**
   * Persist every live context's search index (operator + per-user) and release its store.
   * Best-effort, and terminal: this runs from the shutdown handler, where closing is what
   * checkpoints SQLite's write-ahead log instead of leaving it for the next startup.
   */
  async flushIndexes(): Promise<void> {
    const ctxs = [this.operatorCtx, ...[...this.entries.values()].map((e) => e.ctx)];
    await Promise.allSettled(ctxs.map(async (c) => {
      await c.search.save();
      await c.search.close();
    }));
  }

  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      let oldestKey: number | undefined;
      let oldest = Infinity;
      for (const [k, v] of this.entries) {
        if (v.lastUsed < oldest) {
          oldest = v.lastUsed;
          oldestKey = k;
        }
      }
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }
}

export type { Logger };
