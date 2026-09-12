import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import { join } from 'node:path';
import {
  mcpAuthRouter,
  getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { ZoteusConfig } from '../config.js';
import { ZoteusOAuthProvider, type AuthEvent } from './provider.js';
import { MemoryStore, FileStore, type OAuthStore } from './store.js';

export interface BuiltOAuth {
  provider: ZoteusOAuthProvider;
  store: OAuthStore;
  issuerUrl: URL;
  resourceServerUrl: URL;
  resourceMetadataUrl: string;
  /** Hosts accepted by DNS-rebinding protection (issuer host + any operator overrides). */
  allowedHosts: string[];
  mount(app: Express): void;
}

/** Build the OAuth subsystem from config, or undefined when OAuth is disabled. */
export async function buildOAuth(
  config: ZoteusConfig,
  hooks: { onEvent?: (e: AuthEvent) => void } = {},
): Promise<BuiltOAuth | undefined> {
  if (!config.oauth.enabled) return undefined;
  if (!config.oauth.publicUrl) {
    throw new Error('OAuth enabled but ZOTEUS_PUBLIC_URL missing');
  }

  const issuerUrl = new URL(config.oauth.publicUrl);
  const resourceServerUrl = new URL('/mcp', issuerUrl);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceServerUrl);
  const allowedHosts = [...new Set([issuerUrl.host, ...config.oauth.allowedHosts])];

  let store: OAuthStore;
  if (config.oauth.store === 'file') {
    if (!config.oauth.tokenSecret) throw new Error('store=file requires ZOTEUS_OAUTH_TOKEN_SECRET');
    store = await FileStore.open(
      join(config.dataDir, 'oauth-store.json'),
      config.oauth.tokenSecret,
    );
  } else {
    store = new MemoryStore();
  }

  const provider = new ZoteusOAuthProvider({
    mode: config.oauth.mode,
    passcode: config.oauth.passcode,
    accessTokenTtlSec: config.oauth.accessTokenTtlSec,
    refreshTokenTtlSec: config.oauth.refreshTokenTtlSec,
    store,
    onEvent: hooks.onEvent,
    cimd: config.cimd.enabled
      ? {
          enabled: true,
          cacheTtlSec: config.cimd.cacheTtlSec,
          maxBytes: config.cimd.maxBytes,
          allowedRedirectSchemes: config.cimd.allowedRedirectSchemes,
          allowedHosts: config.cimd.allowedHosts,
        }
      : undefined,
    zotero:
      config.oauth.mode === 'zotero'
        ? {
            clientKey: config.oauth.zoteroClientKey!,
            clientSecret: config.oauth.zoteroClientSecret!,
            callbackUrl: new URL('/oauth/zotero/callback', issuerUrl).href,
            readOnly: config.readOnly,
          }
        : undefined,
  });

  // Throttle the custom consent/callback endpoints (the SDK rate-limits its own routes,
  // but /consent and /oauth/zotero/callback are ours). Combined with the per-auth_id
  // attempt cap in the provider this resists passcode brute force.
  const consentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    // Behind a TLS proxy/tunnel the server sets `trust proxy`; silence express-rate-limit's
    // X-Forwarded-For / trust-proxy advisories so they don't spam logs on every request.
    validate: { trustProxy: false, xForwardedForHeader: false },
    message: {
      error: 'too_many_requests',
      error_description: 'Too many consent attempts. Try again later.',
    },
  });

  return {
    provider,
    store,
    issuerUrl,
    resourceServerUrl,
    resourceMetadataUrl,
    allowedHosts,
    mount(app: Express): void {
      // Register the custom consent endpoints before the SDK router. The SDK
      // sub-routers only bind their own mount paths (/authorize, /token, ...)
      // and fall through otherwise, so these are not shadowed. No CORS here —
      // both are same-origin/top-level browser navigations, not cross-origin APIs.
      app.post('/consent', consentLimiter, express.urlencoded({ extended: false }), (req, res) => {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const authId = typeof body.auth_id === 'string' ? body.auth_id : '';
        const passcode = typeof body.passcode === 'string' ? body.passcode : '';
        void provider.completeConsent(authId, passcode, res);
      });
      // Zotero OAuth 1.0a callback (zotero mode). A top-level browser redirect from zotero.org.
      if (config.oauth.mode === 'zotero') {
        app.get('/oauth/zotero/callback', consentLimiter, (req, res) => {
          const oauthToken = typeof req.query.oauth_token === 'string' ? req.query.oauth_token : '';
          const verifier =
            typeof req.query.oauth_verifier === 'string' ? req.query.oauth_verifier : '';
          void provider.completeZoteroCallback(oauthToken, verifier, res);
        });
      }
      // Advertise CIMD support (RFC: client_id_metadata_document_supported) by augmenting the
      // SDK's authorization-server metadata. The SDK serves the document on GET; we intercept,
      // let it produce the body, then merge the flag in. Only active when CIMD is enabled.
      if (config.cimd.enabled) {
        app.get('/.well-known/oauth-authorization-server', (_req, res, next) => {
          const orig = res.json.bind(res);
          res.json = ((body: Record<string, unknown>) =>
            orig({ ...body, client_id_metadata_document_supported: true })) as typeof res.json;
          next();
        });
      }
      app.use(
        mcpAuthRouter({
          provider,
          issuerUrl,
          resourceServerUrl,
          scopesSupported: ['zoteus'],
          resourceName: 'Zoteus Zotero MCP server',
          // Dynamically registered client secrets never expire. The SDK default is 30 days,
          // which is fine for a public client (claude.ai registers with auth method `none`)
          // but a confidential client such as ChatGPT authenticates every token refresh with
          // its secret, so an expiring secret would force every ChatGPT user through the
          // subscription-key and Zotero sign-in again on day 31. Client records are still
          // capped and swept by the store (MAX_CLIENTS, FIFO).
          clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
        }),
      );
    },
  };
}
