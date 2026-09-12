import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { z } from 'zod';
import pkceChallenge from 'pkce-challenge';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Server } from 'node:http';
import { startHttp } from '../../src/transports/http.js';
import { buildOAuth } from '../../src/auth/router.js';
import { loadConfig } from '../../src/config.js';

let httpServer: Server | undefined;
afterEach(() => {
  httpServer?.close();
  httpServer = undefined;
});

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => resolve(typeof addr === 'object' && addr ? addr.port : 0));
    });
  });
}

function pingServer(): McpServer {
  const server = new McpServer({ name: 'zoteus-oauth-test', version: '0.0.0' }, { capabilities: { tools: {} } });
  server.registerTool('ping', { description: 'ping', inputSchema: { msg: z.string() } }, async ({ msg }) => ({
    content: [{ type: 'text', text: `pong:${msg}` }],
  }));
  return server;
}

const form = (o: Record<string, string>): URLSearchParams => new URLSearchParams(o);
/** `Response.json()` is `unknown`. These bodies are ad-hoc OAuth JSON, read field by field. */
const json = (res: Response): Promise<any> => res.json();
const authIdFrom = (html: string): string => /name="auth_id" value="([^"]+)"/.exec(html)![1];

describe('OAuth 2.1 auth-code + PKCE flow', () => {
  it('discovers metadata, registers, consents, exchanges, and serves /mcp with a bearer token', async () => {
    const port = await getFreePort();
    const base = `http://127.0.0.1:${port}`;
    const config = loadConfig({
      ZOTERO_API_KEY: 'k',
      ZOTEUS_OAUTH_ENABLED: 'true',
      ZOTEUS_PUBLIC_URL: base,
      ZOTEUS_OAUTH_PASSCODE: 'open-sesame-1234',
    } as unknown as NodeJS.ProcessEnv);
    const oauth = (await buildOAuth(config))!;
    // DNS-rebinding ON: allowedHosts=[127.0.0.1:<port>] matches the live Host (accept path).
    // Factory form (per-session) — the same path production/claude.ai uses.
    httpServer = await startHttp(() => pingServer(), {
      port,
      host: '127.0.0.1',
      oauth,
      enableDnsRebindingProtection: true,
      allowedHosts: oauth.allowedHosts,
    });

    // 1. AS metadata — and verify advertised endpoints are host-consistent with the public URL.
    const asMeta = await json(await fetch(`${base}/.well-known/oauth-authorization-server`));
    expect(asMeta.code_challenge_methods_supported).toContain('S256');
    expect(asMeta.response_types_supported).toContain('code');
    expect(asMeta.grant_types_supported).toEqual(expect.arrayContaining(['authorization_code', 'refresh_token']));
    expect(asMeta.token_endpoint_auth_methods_supported).toContain('none');
    expect(asMeta.authorization_endpoint).toBe(`${base}/authorize`);
    expect(asMeta.token_endpoint).toBe(`${base}/token`);
    expect(asMeta.registration_endpoint).toBe(`${base}/register`);

    // 2. Protected-resource metadata (path-specific per RFC 9728)
    const prm = await json(await fetch(`${base}/.well-known/oauth-protected-resource/mcp`));
    expect(prm.resource).toBe(`${base}/mcp`);
    expect(prm.authorization_servers).toEqual(expect.arrayContaining([asMeta.issuer]));

    // 3. Unauthenticated /mcp → 401 with WWW-Authenticate resource_metadata
    const unauth = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('www-authenticate')).toMatch(/resource_metadata=/);

    // 4. Dynamic Client Registration (public client) — at the advertised endpoint
    const redirectUri = 'http://localhost:45999/callback';
    const reg = await fetch(asMeta.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', client_name: 'Test' }),
    });
    expect(reg.status).toBe(201);
    const client = await json(reg);
    expect(client.client_id).toBeTruthy();

    // 5. PKCE
    const { code_verifier, code_challenge } = await pkceChallenge();

    // 6. Authorize (GET, at advertised endpoint) → consent HTML
    const authUrl = new URL(asMeta.authorization_endpoint);
    authUrl.search = form({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge,
      code_challenge_method: 'S256',
      state: 'state-123',
      scope: 'zoteus',
    }).toString();
    const consentHtml = await (await fetch(authUrl)).text();
    const authId = authIdFrom(consentHtml);
    expect(authId).toBeTruthy();

    // 7. Wrong passcode → no redirect
    const bad = await fetch(`${base}/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ auth_id: authId, passcode: 'nope' }),
      redirect: 'manual',
    });
    expect(bad.status).toBe(401);

    // 8. Correct passcode → 302 redirect with code + state (and no token in the URL)
    const ok = await fetch(`${base}/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ auth_id: authId, passcode: 'open-sesame-1234' }),
      redirect: 'manual',
    });
    expect(ok.status).toBe(302);
    const loc = new URL(ok.headers.get('location')!);
    expect(loc.searchParams.get('state')).toBe('state-123');
    expect(ok.headers.get('location')).not.toMatch(/access_token|token=/);
    const code = loc.searchParams.get('code')!;
    expect(code).toBeTruthy();

    // 9. Token exchange (at advertised endpoint)
    const tokRes = await fetch(asMeta.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'authorization_code',
        code,
        code_verifier,
        client_id: client.client_id,
        redirect_uri: redirectUri,
      }),
    });
    expect(tokRes.status).toBe(200);
    const tokens = await json(tokRes);
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.access_token).toBeTruthy();

    // 10. Authenticated MCP client works (Host matches allowedHosts → rebinding accept path)
    const client2 = new Client({ name: 'oauth-test-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
    });
    await client2.connect(transport);
    const { tools } = await client2.listTools();
    expect(tools.map((t) => t.name)).toContain('ping');
    const callRes = (await client2.callTool({ name: 'ping', arguments: { msg: 'hi' } })) as {
      content: { text: string }[];
    };
    expect(callRes.content[0].text).toBe('pong:hi');
    await client2.close();

    // 11. Wrong PKCE verifier rejected at the token endpoint
    const { code_challenge: cc2 } = await pkceChallenge();
    const authUrl2 = new URL(asMeta.authorization_endpoint);
    authUrl2.search = form({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: cc2,
      code_challenge_method: 'S256',
    }).toString();
    const authId2 = authIdFrom(await (await fetch(authUrl2)).text());
    const ok2 = await fetch(`${base}/consent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ auth_id: authId2, passcode: 'open-sesame-1234' }),
      redirect: 'manual',
    });
    const code2 = new URL(ok2.headers.get('location')!).searchParams.get('code')!;
    const badTok = await fetch(asMeta.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'authorization_code',
        code: code2,
        code_verifier: 'wrong-verifier-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        client_id: client.client_id,
        redirect_uri: redirectUri,
      }),
    });
    expect(badTok.status).toBe(400);

    // 12. claude.ai-shaped non-loopback https callback: exact match accepted, mismatch rejected
    const httpsCallback = 'https://claude.ai/api/mcp/auth_callback';
    const reg2 = await fetch(asMeta.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [httpsCallback], token_endpoint_auth_method: 'none', client_name: 'Web' }),
    });
    const webClient = await json(reg2);
    const exactUrl = new URL(asMeta.authorization_endpoint);
    exactUrl.search = form({
      response_type: 'code',
      client_id: webClient.client_id,
      redirect_uri: httpsCallback,
      code_challenge: cc2,
      code_challenge_method: 'S256',
    }).toString();
    expect((await fetch(exactUrl)).status).toBe(200);
    const mismatchUrl = new URL(asMeta.authorization_endpoint);
    mismatchUrl.search = form({
      response_type: 'code',
      client_id: webClient.client_id,
      redirect_uri: 'https://evil.example.com/cb',
      code_challenge: cc2,
      code_challenge_method: 'S256',
    }).toString();
    expect((await fetch(mismatchUrl)).status).toBe(400);
  }, 30_000);
});

describe('Dynamic Client Registration: confidential clients', () => {
  it('registers a confidential client (as ChatGPT does) with a usable secret, and a public client with none', async () => {
    const port = await getFreePort();
    const base = `http://127.0.0.1:${port}`;
    const config = loadConfig({
      ZOTERO_API_KEY: 'k',
      ZOTEUS_OAUTH_ENABLED: 'true',
      ZOTEUS_PUBLIC_URL: base,
      ZOTEUS_OAUTH_PASSCODE: 'open-sesame-1234',
    } as unknown as NodeJS.ProcessEnv);
    const oauth = (await buildOAuth(config))!;
    httpServer = await startHttp(() => pingServer(), {
      port,
      host: '127.0.0.1',
      oauth,
      enableDnsRebindingProtection: true,
      allowedHosts: oauth.allowedHosts,
    });

    // ChatGPT presents its client secret on every token refresh, so the secret has to outlive
    // the refresh token (see the clientRegistrationOptions comment in src/auth/router.ts).
    const confidential = await json(
      await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['https://chatgpt.com/connector/oauth/abc123'],
          token_endpoint_auth_method: 'client_secret_post',
          client_name: 'ChatGPT',
        }),
      }),
    );
    expect(confidential.client_secret).toBeTruthy();
    expect(confidential.client_secret_expires_at).toBe(0);

    // claude.ai registers a public client: no secret is issued at all.
    const publicClient = await json(
      await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
          token_endpoint_auth_method: 'none',
          client_name: 'Claude',
        }),
      }),
    );
    expect(publicClient.client_secret).toBeUndefined();
  }, 30_000);
});
