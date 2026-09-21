import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildContext, ContextCache, createServer, createServerFrom } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';

const logger = { info() {}, debug() {}, warn() {}, error() {} };
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function auth(key: string, user = 111): any {
  return { extra: { zoteroUserId: user, zoteroKey: key } };
}

async function setup(maxEntries = 50) {
  const dir = mkdtempSync(join(tmpdir(), 'zoteus-credentials-'));
  dirs.push(dir);
  const config = loadConfig({
    ZOTEUS_LOCAL: 'off', ZOTEUS_DATA_DIR: dir, ZOTEUS_EMBEDDINGS: 'off',
    ZOTEUS_INDEX_BACKEND: 'memory', ZOTEUS_UPDATE_CHECK: 'false',
  } as any);
  const operator = await buildContext(config, { telemetry: { logger } });
  const probe = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const key = (init?.headers as Record<string, string>)?.['Zotero-API-Key'];
    return new Response(JSON.stringify({
      userID: key === 'foreign' ? 222 : 111, username: 'fixture',
      access: { user: { library: true, write: key === 'broad' } },
    }), { headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', probe);
  return { cache: new ContextCache(config, operator, maxEntries, { logger }), config, probe };
}

describe('context credential isolation', () => {
  it('builds one context for concurrent initializations using the same credential', async () => {
    const { cache, probe } = await setup();
    const contexts = await Promise.all(Array.from({ length: 8 }, () => cache.resolve(auth('broad'))));
    expect(new Set(contexts).size).toBe(1);
    expect(probe).toHaveBeenCalledTimes(1);
    await cache.flushIndexes();
  });

  it('replaces a changed key and rejects tool calls on its retired session', async () => {
    const { cache } = await setup();
    const first = await cache.resolve(auth('broad'));
    const server = createServer(first);
    const client = new Client({ name: 'credential-regression', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const closed = vi.spyOn(first.indexes!, 'closeAll');
    const second = await cache.resolve(auth('limited'));
    expect(second).not.toBe(first);
    expect(second.capabilities.cloud?.access).toEqual({ user: { library: true, write: false } });
    expect(closed).toHaveBeenCalledTimes(1);
    const retired = await client.callTool({ name: 'zotero_whoami', arguments: {} });
    expect(retired.isError).toBe(true);
    await expect(client.readResource({ uri: 'zotero://collections' })).rejects.toThrow('authorization changed');
    expect(JSON.stringify(retired.content)).toContain('authorization changed');
    await client.close();
    await server.close();
    await cache.flushIndexes();
  });

  it('refuses a key the account has already replaced instead of rebuilding its context', async () => {
    const { cache, probe } = await setup();
    const first = await cache.resolve(auth('broad'));
    const second = await cache.resolve(auth('limited'));
    expect(second).not.toBe(first);
    // The session still carrying the old key is told to reconnect. Rebuilding for it would
    // retire the new context, and two live sessions of one account would then retire each
    // other's context on every call.
    await expect(cache.resolve(auth('broad'))).rejects.toThrow('authorization changed');
    expect(await cache.resolve(auth('limited'))).toBe(second);
    expect(probe).toHaveBeenCalledTimes(2);
    await cache.flushIndexes();
  });

  it('rebuilds an evicted context for a session that resolves it per call, without a reconnect', async () => {
    const { cache, config } = await setup(1);
    // The shape src/index.ts gives the HTTP transport: no context object bound to the session.
    const server = createServerFrom(config, () => cache.resolve(auth('broad', 111)));
    const client = new Client({ name: 'evicted-session', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const before = await client.callTool({ name: 'zotero_whoami', arguments: {} });
    expect(before.isError).toBeFalsy();
    const first = await cache.resolve(auth('broad', 111));

    // Another account's first call evicts this one (maxEntries 1): indexes closed, object retired.
    const other = await cache.resolve(auth('foreign', 222));
    expect(other.capabilities.cloud?.userID).toBe(222);
    expect(first.invalidated).toBe(true);

    // The idle session neither notices nor reconnects: its next call builds a fresh context.
    const after = await client.callTool({ name: 'zotero_whoami', arguments: {} });
    expect(after.isError).toBeFalsy();
    expect((after.structuredContent as { userID: number }).userID).toBe(111);
    expect(await cache.resolve(auth('broad', 111))).not.toBe(first);
    await client.close();
    await server.close();
    await cache.flushIndexes();
  });

  it('never opens an account context when its key belongs to another user', async () => {
    const { cache } = await setup();
    await expect(cache.resolve(auth('foreign'))).rejects.toThrow('did not confirm this key');
    const valid = await cache.resolve(auth('broad'));
    expect(valid.capabilities.cloud?.userID).toBe(111);
    await cache.flushIndexes();
  });
});
