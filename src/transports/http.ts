import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Logger } from '../lib/logger.js';
import { requestLogger } from '../lib/request-logger.js';
import { liveness, type Readiness } from '../lib/health.js';
import type { Metrics } from '../lib/metrics.js';
import type { UsageRecorder } from '../lib/usage/event.js';
import type { DailyRow } from '../lib/usage/rollup.js';
import type { BuiltOAuth } from '../auth/router.js';

/**
 * A factory that produces a fresh McpServer per MCP session. Receives the session's
 * {@link AuthInfo} (from the bearer middleware) so the server can be bound to a per-user
 * ToolContext; `undefined` on the no-auth path → the operator/shared context.
 */
export type McpServerFactory = (authInfo?: AuthInfo) => McpServer | Promise<McpServer>;

export interface HttpOptions {
  port?: number;
  host?: string;
  path?: string;
  logger?: Logger;
  /** When provided, OAuth endpoints are mounted and /mcp requires a bearer token. */
  oauth?: BuiltOAuth;
  enableDnsRebindingProtection?: boolean;
  allowedHosts?: string[];
  /** Permit binding a non-loopback host without OAuth (escape hatch; default false). */
  allowInsecureBind?: boolean;
  metrics?: Metrics;
  /** Persistent usage log; when absent, requests and tool calls are only logged. */
  usage?: UsageRecorder;
  /** Read side of the same log, which is what `/usage.json` serves. */
  usageRollups?: (fromDay?: string) => DailyRow[];
  /**
   * Bearer token required by `/metrics` and `/usage.json`. Unset leaves both open, which
   * is the historical behaviour and is only safe behind a proxy that blocks them.
   */
  metricsToken?: string;
  readiness?: () => Promise<Readiness>;
  version?: string;
  rateLimit?: { windowMs: number; max: number };
  /** Receives a drain handle for graceful shutdown (factory + single modes). */
  registerLifecycle?: (h: {
    drainSessions: (timeoutMs: number) => Promise<void>;
    activeSessions: () => number;
  }) => void;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Constant-time comparison of two secrets of any length.
 *
 * Hashed first because `timingSafeEqual` throws on a length mismatch, and throwing is
 * itself the leak: it would tell an attacker the token's length in one request.
 */
function secretEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** True if a parsed JSON-RPC body is (or contains) an MCP `initialize` request. */
function isInitialize(body: unknown): boolean {
  const one = (m: unknown): boolean =>
    typeof m === 'object' && m !== null && (m as { method?: unknown }).method === 'initialize';
  return Array.isArray(body) ? body.some(one) : one(body);
}

/**
 * Start the MCP server on a Streamable HTTP transport via Express.
 *
 * Pass a {@link McpServerFactory} to get **per-session** transports (a fresh server +
 * transport per `Mcp-Session-Id`) — required for remote/multi-client use such as a
 * claude.ai connector, where each connection sends its own `initialize`. Passing a
 * single {@link McpServer} keeps the legacy single-shared-transport behaviour (fine for
 * one client / local use).
 *
 * When `oauth` is provided the OAuth 2.1 metadata/DCR/token/authorize endpoints are
 * mounted and `/mcp` is protected by bearer-token auth; otherwise `/mcp` is
 * unauthenticated and must stay on loopback. Resolves with the underlying http.Server.
 */
export async function startHttp(
  serverOrFactory: McpServer | McpServerFactory,
  opts: HttpOptions = {},
): Promise<http.Server> {
  const host = opts.host ?? '127.0.0.1';
  const path = opts.path ?? '/mcp';

  // Safety: never expose an unauthenticated MCP endpoint on a non-loopback interface.
  if (!opts.oauth && !opts.allowInsecureBind && !LOOPBACK.has(host)) {
    throw new Error(
      `Refusing to bind ${host} without OAuth: an unauthenticated MCP endpoint must stay on loopback. ` +
        `Enable OAuth (ZOTEUS_OAUTH_ENABLED=true) or set ZOTEUS_ALLOW_INSECURE_HTTP=true to override.`,
    );
  }

  const makeTransport = (
    onsessioninitialized?: (sessionId: string) => void,
  ): StreamableHTTPServerTransport =>
    new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      enableDnsRebindingProtection: opts.enableDnsRebindingProtection ?? false,
      allowedHosts: opts.allowedHosts,
      onsessioninitialized,
    });

  // Build the request router: either a single shared transport (legacy) or a
  // per-session map keyed by Mcp-Session-Id (factory mode).
  let route: (req: express.Request, res: express.Response) => Promise<void>;

  if (typeof serverOrFactory !== 'function') {
    const transport = makeTransport();
    await serverOrFactory.connect(transport);
    route = (req, res) =>
      transport.handleRequest(req, res, req.method === 'POST' ? req.body : undefined);
    opts.registerLifecycle?.({
      activeSessions: () => 1,
      drainSessions: async () => {
        await transport.close();
      },
    });
  } else {
    const factory = serverOrFactory;
    const transports = new Map<string, StreamableHTTPServerTransport>();
    const owners = new Map<string, string>();
    // Bind sessions to the authenticated account, client, and Zotero credential.
    // Access-token refresh can retain a session; a different library key cannot.
    const ownerOf = (auth?: AuthInfo): string => {
      if (!auth) return 'operator';
      const extra = auth.extra as { zoteroUserId?: number; zoteroKey?: string } | undefined;
      return createHash('sha256').update(JSON.stringify([
        auth.clientId, extra?.zoteroUserId, extra?.zoteroKey,
        extra?.zoteroKey ? undefined : auth.token,
      ])).digest('hex');
    };
    route = async (req, res) => {
      const body = req.method === 'POST' ? req.body : undefined;
      const header = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(header) ? header[0] : header;

      const auth = (req as express.Request & { auth?: AuthInfo }).auth;
      const owner = ownerOf(auth);
      let transport: StreamableHTTPServerTransport | undefined;
      if (sessionId && transports.has(sessionId) && owners.get(sessionId) === owner) {
        transport = transports.get(sessionId);
      } else if (!sessionId && req.method === 'POST' && isInitialize(body)) {
        transport = makeTransport((sid) => {
          transports.set(sid, transport!);
          owners.set(sid, owner);
        });
        transport.onclose = () => {
          const sid = transport!.sessionId;
          if (sid) {
            transports.delete(sid);
            owners.delete(sid);
          }
        };
        const server = await factory(auth);
        await server.connect(transport);
      } else if (sessionId) {
        // A session ID this process does not know: it restarted (any redeploy) or the
        // session was reaped. The Streamable HTTP spec makes 404 the signal a client MUST
        // answer by re-initializing, so clients recover on their own. Answering 400 here
        // instead left every later call failing, plain reads included, until the user
        // manually reconnected the connector.
        res.status(404).json({
          jsonrpc: '2.0',
          error: {
            code: -32001,
            message: 'Session not found: reinitialize to start a new session.',
          },
          id: null,
        });
        return;
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Bad Request: No valid session ID' },
          id: null,
        });
        return;
      }
      await transport!.handleRequest(req, res, body);
    };
    opts.registerLifecycle?.({
      activeSessions: () => transports.size,
      drainSessions: async (timeoutMs) => {
        const all = [...transports.values()];
        await Promise.race([
          Promise.allSettled(all.map((t) => t.close())),
          new Promise<void>((r) => setTimeout(r, timeoutMs).unref?.()),
        ]);
      },
    });
  }

  const app = express();
  app.disable('x-powered-by');
  // Behind a TLS proxy/tunnel (OAuth deployments) so express-rate-limit keys on the
  // forwarded client IP instead of throwing on the X-Forwarded-For header. Set trust
  // proxy first so the request logger / rate limiter see the real client IP.
  if (opts.oauth) app.set('trust proxy', 1);
  if (opts.logger)
    app.use(
      requestLogger(opts.logger, { metrics: opts.metrics, usage: opts.usage, mcpPath: path }),
    );

  if (opts.oauth) opts.oauth.mount(app);

  const guards = opts.oauth
    ? [
        requireBearerAuth({
          verifier: opts.oauth.provider,
          resourceMetadataUrl: opts.oauth.resourceMetadataUrl,
        }),
      ]
    : [];

  const wrap = (req: express.Request, res: express.Response): void => {
    route(req, res).catch((err) => {
      opts.metrics?.inc('http_errors_total');
      opts.logger?.error('HTTP request failed:', err instanceof Error ? err.message : String(err));
      if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    });
  };

  // No-auth ops endpoints, mounted before the MCP path routes and the 404 catch-all.
  const startedAt = Date.now();
  app.get('/healthz', (_req, res) => res.json(liveness(opts.version ?? 'dev', startedAt)));
  app.get('/readyz', async (_req, res) => {
    if (!opts.readiness) return res.json({ ok: true, checks: {} });
    const r = await opts.readiness();
    res.status(r.ok ? 200 : 503).json(r);
  });
  // Ops endpoints that say something about traffic, rather than merely that the process is
  // alive, sit behind a token when one is configured. `/metrics` shipped open and stayed
  // open on a public deployment, where it published exactly how much the service is used
  // to anyone who asked for it.
  const opsGuard = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ): void => {
    if (!opts.metricsToken) return next();
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!secretEquals(presented, opts.metricsToken)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };
  if (opts.metrics) {
    app.get('/metrics', opsGuard, (_req, res) =>
      res.type('text/plain').send(opts.metrics!.render()),
    );
  }
  if (opts.usageRollups) {
    app.get('/usage.json', opsGuard, (req, res) => {
      const days = Math.min(3650, Math.max(1, Number(req.query.days) || 30));
      const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
      res.json({ from, days, rows: opts.usageRollups!(from) });
    });
  }

  const limiter =
    opts.rateLimit && opts.rateLimit.max > 0
      ? [
          rateLimit({
            windowMs: opts.rateLimit.windowMs,
            max: opts.rateLimit.max,
            standardHeaders: true,
            legacyHeaders: false,
            validate: { trustProxy: false, xForwardedForHeader: false },
            message: {
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Too many requests' },
              id: null,
            },
          }),
        ]
      : [];

  // CORS for web-based MCP clients + OPTIONS preflight (before bearer auth so
  // preflight is not rejected). The SDK already CORS-enables its own routes.
  app.use(path, cors());
  app.post(path, ...limiter, ...guards, express.json({ limit: '8mb' }), wrap);
  app.get(path, ...limiter, ...guards, wrap);
  app.delete(path, ...limiter, ...guards, wrap);
  app.use((_req, res) => res.status(404).json({ error: `Not found. MCP endpoint is ${path}.` }));

  const httpServer = await new Promise<http.Server>((resolve) => {
    const s = app.listen(opts.port ?? 0, host, () => resolve(s));
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : opts.port;
  opts.logger?.info(
    `Zoteus MCP server listening on http://${host}:${port}${path}${opts.oauth ? ' (OAuth 2.1 enabled)' : ''}`,
  );
  return httpServer;
}
