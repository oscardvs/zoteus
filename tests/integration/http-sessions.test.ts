import { describe, it, expect, afterEach } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Server } from 'node:http';
import { startHttp } from '../../src/transports/http.js';

let httpServer: Server | undefined;
afterEach(() => {
  httpServer?.close();
  httpServer = undefined;
});

function makePing(): McpServer {
  const s = new McpServer({ name: 'sess', version: '0.0.0' }, { capabilities: { tools: {} } });
  s.registerTool('ping', { description: 'ping', inputSchema: { msg: z.string() } }, async ({ msg }) => ({
    content: [{ type: 'text', text: `pong:${msg}` }],
  }));
  return s;
}

describe('per-session transports (factory mode)', () => {
  it('supports multiple concurrent sessions without "Server already initialized"', async () => {
    // Factory form: a fresh McpServer per MCP session (what claude.ai needs).
    httpServer = await startHttp(() => makePing(), { port: 0, host: '127.0.0.1' });
    const address = httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const url = (): URL => new URL(`http://127.0.0.1:${port}/mcp`);

    const c1 = new Client({ name: 'c1', version: '0.0.0' });
    const c2 = new Client({ name: 'c2', version: '0.0.0' });
    await c1.connect(new StreamableHTTPClientTransport(url()));
    await c2.connect(new StreamableHTTPClientTransport(url())); // 2nd initialize: would 400 on a shared transport

    const r1 = (await c1.callTool({ name: 'ping', arguments: { msg: 'a' } })) as { content: { text: string }[] };
    const r2 = (await c2.callTool({ name: 'ping', arguments: { msg: 'b' } })) as { content: { text: string }[] };
    expect(r1.content[0].text).toBe('pong:a');
    expect(r2.content[0].text).toBe('pong:b');

    await c1.close();
    await c2.close();
  }, 20_000);

  /**
   * Regression: a redeploy drops every in-memory session, and the client then presents a
   * session ID this process never issued. Answering 400 wedged the connector (every later
   * call failed, plain reads included, until the user reconnected by hand); 404 is the
   * spec's signal to re-initialize, so clients heal themselves.
   */
  it('answers an unknown session ID with 404 so the client re-initializes', async () => {
    httpServer = await startHttp(() => makePing(), { port: 0, host: '127.0.0.1' });
    const address = httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'a-session-from-a-previous-process',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32001);

    // A request with no session ID at all is still a plain bad request, not a dead session.
    const noSession = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(noSession.status).toBe(400);

    // ...and a fresh client still connects against the same server.
    const c = new Client({ name: 'fresh', version: '0.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const r = (await c.callTool({ name: 'ping', arguments: { msg: 'ok' } })) as { content: { text: string }[] };
    expect(r.content[0].text).toBe('pong:ok');
    await c.close();
  }, 20_000);
});

/**
 * Clients rarely end a session: the hosted server logged 648 sessions opened in 4.3 days
 * and 2 DELETEs, each session held a whole McpServer, and the heap grew until V8 aborted
 * the process. Idle sessions are now closed, and a closed one answers 404 like any other
 * unknown session, so the client re-initializes.
 */
describe('idle sessions are closed (factory mode)', () => {
  const HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

  function makeSlow(): McpServer {
    const s = makePing();
    s.registerTool('wait', { description: 'wait', inputSchema: { ms: z.number() } }, async ({ ms }) => {
      await new Promise((r) => setTimeout(r, ms));
      return { content: [{ type: 'text', text: 'done' }] };
    });
    return s;
  }

  async function start(opts: { sessionIdleMs: number; maxSessions?: number; sessionSweepMs: number }): Promise<string> {
    httpServer = await startHttp(() => makeSlow(), { port: 0, host: '127.0.0.1', ...opts });
    const address = httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return `http://127.0.0.1:${port}/mcp`;
  }

  async function open(url: string): Promise<string> {
    const res = await fetch(url, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }),
    });
    expect(res.status).toBe(200);
    const sid = res.headers.get('mcp-session-id')!;
    await fetch(url, {
      method: 'POST',
      headers: { ...HEADERS, 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    return sid;
  }

  function call(url: string, sid: string, name: string, args: Record<string, unknown>): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: { ...HEADERS, 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
    });
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('closes a session that has been idle past the limit, and it then answers 404', async () => {
    const url = await start({ sessionIdleMs: 150, sessionSweepMs: 25 });
    const sid = await open(url);
    expect((await call(url, sid, 'ping', { msg: 'a' })).status).toBe(200);
    await sleep(400);
    const res = await call(url, sid, 'ping', { msg: 'b' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32001);
    // A new session works as before.
    expect((await call(url, await open(url), 'ping', { msg: 'c' })).status).toBe(200);
  }, 20_000);

  it('keeps a session that is used more often than the limit', async () => {
    const url = await start({ sessionIdleMs: 300, sessionSweepMs: 25 });
    const sid = await open(url);
    for (let i = 0; i < 6; i++) {
      await sleep(100);
      expect((await call(url, sid, 'ping', { msg: String(i) })).status).toBe(200);
    }
  }, 20_000);

  it('never closes a session while a call is in flight, however long it runs', async () => {
    const url = await start({ sessionIdleMs: 50, sessionSweepMs: 20 });
    const sid = await open(url);
    const res = await call(url, sid, 'wait', { ms: 500 });
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain('done');
  }, 20_000);

  it('holds at most maxSessions, closing the longest idle first', async () => {
    const url = await start({ sessionIdleMs: 60_000, maxSessions: 2, sessionSweepMs: 60_000 });
    const first = await open(url);
    await sleep(20);
    const second = await open(url);
    await sleep(20);
    const third = await open(url);
    expect((await call(url, first, 'ping', { msg: '1' })).status).toBe(404);
    expect((await call(url, second, 'ping', { msg: '2' })).status).toBe(200);
    expect((await call(url, third, 'ping', { msg: '3' })).status).toBe(200);
  }, 20_000);
});
