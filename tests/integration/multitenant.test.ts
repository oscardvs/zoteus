import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import pkceChallenge from 'pkce-challenge';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHttp } from '../../src/transports/http.js';
import { buildOAuth } from '../../src/auth/router.js';
import { buildServer, createServerFrom, ContextCache } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';

let httpServer: Server | undefined;
const realFetch = globalThis.fetch;
afterEach(() => {
  httpServer?.close();
  httpServer = undefined;
  vi.unstubAllGlobals();
});

// Two Zotero users, addressed by the request token issued in /oauth/request.
const USERS: Record<string, { key: string; userId: number; username: string }> = {
  REQTOK_A: { key: 'KEY_ALICE', userId: 111, username: 'alice' },
  REQTOK_B: { key: 'KEY_BOB', userId: 222, username: 'bob' },
};
const KEY_TO_USER: Record<string, { userId: number; username: string }> = {
  KEY_ALICE: { userId: 111, username: 'alice' },
  KEY_BOB: { userId: 222, username: 'bob' },
};

/**
 * Zotero's desktop local API. Nothing in this file may reach it: it is the developer's own
 * running Zotero, holding the developer's own library, and a hosted deployment (which is
 * what these cases model) has no desktop app at all.
 */
const DESKTOP_LOCAL_API_PORT = 23119;

/** Every URL the mock handed to the real network, so a case can prove where it did not go. */
let passedThrough: string[] = [];

function installMockZotero(nextReqToken: () => string): void {
  passedThrough = [];
  const form = (s: string): Response =>
    new Response(s, { status: 200, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  const stub = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('www.zotero.org/oauth/request')) {
      const tok = nextReqToken();
      return form(`oauth_token=${tok}&oauth_token_secret=SEC_${tok}&oauth_callback_confirmed=true`);
    }
    if (url.includes('www.zotero.org/oauth/access')) {
      // Identify the user from the oauth_token in the Authorization header.
      const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
      const m = /oauth_token="([^"]+)"/.exec(auth);
      const u = USERS[m?.[1] ?? ''];
      if (!u) return new Response('unknown token', { status: 401 });
      return form(`oauth_token=AT&oauth_token_secret=${u.key}&userID=${u.userId}&username=${u.username}`);
    }
    if (url.includes('api.zotero.org/keys/current')) {
      const key = String((init?.headers as Record<string, string>)?.['Zotero-API-Key'] ?? '');
      const u = KEY_TO_USER[key];
      if (!u) return new Response('forbidden', { status: 403 });
      return new Response(JSON.stringify({ userID: u.userId, username: u.username, access: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // Everything else (the local /mcp server + MCP client) goes to the real fetch.
    passedThrough.push(url);
    return realFetch(input as Parameters<typeof fetch>[0], init);
  }) as typeof fetch;
  vi.stubGlobal('fetch', stub);
}

async function authorizeUser(base: string, reqTokenForThisUser: string): Promise<string> {
  // DCR
  const reg = await realFetch(`${base}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['http://localhost:45999/cb'], token_endpoint_auth_method: 'none', client_name: 'Test' }),
  });
  const client = (await reg.json()) as { client_id: string };
  const { code_verifier, code_challenge } = await pkceChallenge();

  // /authorize → provider calls /oauth/request (mock returns reqTokenForThisUser) → 302 to zotero.org
  const authUrl = new URL(`${base}/authorize`);
  authUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.client_id,
    redirect_uri: 'http://localhost:45999/cb',
    code_challenge,
    code_challenge_method: 'S256',
    state: `st-${reqTokenForThisUser}`,
    scope: 'zoteus',
  }).toString();
  const authRes = await realFetch(authUrl, { redirect: 'manual' });
  expect(authRes.status).toBe(302);
  const zoteroLoc = new URL(authRes.headers.get('location')!);
  expect(zoteroLoc.searchParams.get('oauth_token')).toBe(reqTokenForThisUser);

  // Simulate the user approving on zotero.org → browser hits our callback.
  const cbRes = await realFetch(`${base}/oauth/zotero/callback?oauth_token=${reqTokenForThisUser}&oauth_verifier=VERIF`, {
    redirect: 'manual',
  });
  expect(cbRes.status).toBe(302);
  const back = new URL(cbRes.headers.get('location')!);
  const code = back.searchParams.get('code')!;
  expect(back.searchParams.get('state')).toBe(`st-${reqTokenForThisUser}`);

  // Token exchange
  const tokRes = await realFetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier,
      client_id: client.client_id,
      redirect_uri: 'http://localhost:45999/cb',
    }),
  });
  const tokens = (await tokRes.json()) as { access_token: string };
  expect(tokens.access_token).toBeTruthy();
  return tokens.access_token as string;
}

async function whoamiUserId(base: string, accessToken: string): Promise<number> {
  const c = new Client({ name: 'mt-client', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  await c.connect(transport);
  const res = (await c.callTool({ name: 'zotero_whoami', arguments: {} })) as {
    structuredContent?: { userID?: number };
  };
  await c.close();
  return res.structuredContent?.userID ?? -1;
}

describe('multi-tenant: two Zotero users resolve to different libraries', () => {
  let reqTokens: string[];
  beforeEach(() => {
    reqTokens = ['REQTOK_A', 'REQTOK_B'];
  });

  it('each bearer token reports its own Zotero identity', async () => {
    installMockZotero(() => reqTokens.shift()!);

    const config = loadConfig({
      ZOTEUS_OAUTH_ENABLED: 'true',
      ZOTEUS_OAUTH_MODE: 'zotero',
      ZOTEUS_PUBLIC_URL: 'http://127.0.0.1',
      ZOTERO_OAUTH_CLIENT_KEY: 'ck',
      ZOTERO_OAUTH_CLIENT_SECRET: 'cs',
      ZOTEUS_READ_ONLY: 'true',
      // Keep the test hermetic: no release lookup, no cache write outside the sandbox.
      ZOTEUS_UPDATE_CHECK: 'false',
      // And no desktop app. Left at the default the operator context built below probes
      // 127.0.0.1:23119 on startup, which on a developer machine is a real running Zotero
      // answering out of a real library. A hosted server never has one anyway.
      ZOTEUS_LOCAL: 'off',
      // Each resolved tenant opens its own index store, so keep those files out of the
      // real data dir.
      ZOTEUS_DATA_DIR: mkdtempSync(join(tmpdir(), 'zoteus-multitenant-')),
    } as unknown as NodeJS.ProcessEnv);

    const oauth = await buildOAuth(config);
    const { ctx } = await buildServer(config);
    const cache = new ContextCache(config, ctx);
    httpServer = await startHttp(async (authInfo) => createServerFrom(config, () => cache.resolve(authInfo)), {
      port: 0,
      host: '127.0.0.1',
      oauth,
    });
    const address = httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;

    const tokenA = await authorizeUser(base, 'REQTOK_A');
    const tokenB = await authorizeUser(base, 'REQTOK_B');
    expect(tokenA).not.toBe(tokenB);

    const idA = await whoamiUserId(base, tokenA);
    const idB = await whoamiUserId(base, tokenB);
    expect(idA).toBe(111);
    expect(idB).toBe(222);
    expect(idA).not.toBe(idB);

    // A valid token for Bob must never reuse Alice's initialized MCP session.
    const alice = new Client({ name: 'session-owner', version: '0.0.0' });
    const aliceTransport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokenA}` } },
    });
    await alice.connect(aliceTransport);
    for (const method of ['POST', 'GET', 'DELETE']) {
      const stolen = await realFetch(`${base}/mcp`, {
        method,
        headers: {
          Authorization: `Bearer ${tokenB}`,
          'mcp-session-id': aliceTransport.sessionId!,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        ...(method === 'POST' ? { body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }) } : {}),
      });
      expect(stolen.status).toBe(404);
    }
    const owned = await alice.callTool({ name: 'zotero_whoami', arguments: {} });
    expect((owned.structuredContent as { userID: number }).userID).toBe(111);
    await alice.close();
    await cache.flushIndexes();

    // Nothing here went near the developer's own Zotero. Every request the mock let
    // through was to this test's own HTTP server on 127.0.0.1; the startup capability
    // probe used to add two more to the desktop app's port.
    expect(passedThrough.filter((u) => u.includes(`:${DESKTOP_LOCAL_API_PORT}`))).toEqual([]);
  }, 30_000);
});
