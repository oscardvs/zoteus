import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildContext, ContextCache, createServerFrom } from '../../src/server.js';
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
      userID: key?.startsWith('foreign') ? 222 : 111, username: 'fixture',
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

  it('keeps both clients of one account connected, each with its own key and permissions', async () => {
    // Claude and ChatGPT each run their own OAuth authorization, and Zotero mints a key for
    // each. Treating the second as a replacement of the first disconnected whichever client
    // connected first, and reconnecting it disconnected the other in turn.
    const { cache, config, probe } = await setup();
    const connect = async (key: string) => {
      const server = createServerFrom(config, () => cache.resolve(auth(key)));
      const client = new Client({ name: `client-${key}`, version: '1' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      return { client, server };
    };
    const claude = await connect('broad');
    expect((await claude.client.callTool({ name: 'zotero_whoami', arguments: {} })).isError).toBeFalsy();
    const chatgpt = await connect('limited');
    for (const { client } of [chatgpt, claude, chatgpt, claude]) {
      const result = await client.callTool({ name: 'zotero_whoami', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as { userID: number }).userID).toBe(111);
    }

    const first = await cache.resolve(auth('broad'));
    const second = await cache.resolve(auth('limited'));
    expect(second).not.toBe(first);
    expect(first.invalidated).toBeFalsy();
    // Neither acts with the other's grant.
    expect(first.capabilities.cloud?.access).toEqual({ user: { library: true, write: true } });
    expect(second.capabilities.cloud?.access).toEqual({ user: { library: true, write: false } });
    // One probe per key, and none again for as long as both stay cached.
    expect(probe).toHaveBeenCalledTimes(2);
    for (const { client, server } of [claude, chatgpt]) {
      await client.close();
      await server.close();
    }
    await cache.flushIndexes();
  });

  it("shares the account's search indexes across its keys instead of opening them twice", async () => {
    const { cache } = await setup();
    const first = await cache.resolve(auth('broad'));
    const closed = vi.spyOn(first.indexes!, 'closeAll');
    const second = await cache.resolve(auth('limited'));
    expect(second.indexes).toBe(first.indexes);
    expect(second.search).toBe(first.search);
    expect(second.searchIndexPath).toBe(first.searchIndexPath);
    expect(closed).not.toHaveBeenCalled();
    // A repair through one key's context is what the other key's context reads next, not
    // the handle the repair just closed.
    const fresh = await second.reopenSearchIndex();
    expect(first.search).toBe(fresh);
    await cache.flushIndexes();
  });

  it("closes an account's indexes when the account is evicted, and not while any of its keys is cached", async () => {
    const { cache } = await setup(1);
    const first = await cache.resolve(auth('broad'));
    const second = await cache.resolve(auth('limited'));
    const closed = vi.spyOn(first.indexes!, 'closeAll');
    // Both keys are one account, so a bound of one account holds them both.
    expect(first.invalidated).toBeFalsy();
    expect(closed).not.toHaveBeenCalled();
    await cache.resolve(auth('foreign', 222));
    expect(first.invalidated).toBe(true);
    expect(second.invalidated).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
    await cache.flushIndexes();
  });

  it('drops the least recently used key past the per-account bound, keeping the indexes open', async () => {
    const { cache } = await setup();
    const oldest = await cache.resolve(auth('key-0'));
    const closed = vi.spyOn(oldest.indexes!, 'closeAll');
    for (let i = 1; i <= 8; i++) await cache.resolve(auth(`key-${i}`));
    expect(oldest.invalidated).toBe(true);
    expect(closed).not.toHaveBeenCalled();
    // Dropped, not refused: its next call builds it a context again, on the same indexes.
    const rebuilt = await cache.resolve(auth('key-0'));
    expect(rebuilt).not.toBe(oldest);
    expect(rebuilt.invalidated).toBeFalsy();
    expect(rebuilt.indexes).toBe(oldest.indexes);
    await cache.flushIndexes();
  });

  it("never shares one account's indexes with a context of another", async () => {
    const { cache, config } = await setup();
    const mine = await cache.resolve(auth('broad'));
    await expect(
      buildContext(config, { apiKey: 'foreign', zoteroUserId: 222, telemetry: { logger }, indexesOf: mine }),
    ).rejects.toThrow('same account');
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
