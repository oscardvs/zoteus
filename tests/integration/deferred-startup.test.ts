import { describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDeferredServer } from '../../src/server.js';
import type { ToolContext } from '../../src/registry/registry.js';
import { tools } from '../../src/tools/index.js';

const config = { local: 'off', libraryType: 'user', readOnly: false } as any;

function fakeCtx(): ToolContext {
  const cloud = { userID: 42, username: 'oscardvs', access: { user: { write: true } } };
  return {
    config,
    capabilities: { cloud: cloud as any, localApi: false, localGroupIds: [] },
    router: { whoami: () => cloud, defaultLibrary: () => ({ type: 'user', id: 42 }) } as any,
    schema: {} as any,
    web: {} as any,
    styles: {} as any,
    translation: { isUp: async () => false } as any,
    search: { isEmpty: true, embedderName: 'none', storage: 'memory', buildStatus: () => ({}), status: () => ({}) } as any,
    scholar: {} as any,
    fetcher: {} as any,
    searchIndexPath: '',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

async function connect(build: () => Promise<ToolContext>) {
  const deferred = createDeferredServer(config, build);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([deferred.server.connect(serverT), client.connect(clientT)]);
  return { client, deferred };
}

/**
 * The handshake must not wait on buildContext. A host that gives `initialize` well under a
 * second (Claude Desktop's shared Cowork/Code pool) killed the server outright while the
 * context probed the desktop app and the cloud key for ~2s (#18).
 */
describe('deferred startup', () => {
  it('completes the handshake and lists tools while the context is still building', async () => {
    // Never resolves: the handshake must not be waiting on it.
    const build = vi.fn(() => new Promise<ToolContext>(() => {}));
    const { client } = await connect(build);

    // Connected, and the full tool list is served from the config alone.
    const { tools: listed } = await client.listTools();
    expect(listed).toHaveLength(tools.length);
    expect(client.getServerVersion()?.name).toBe('zoteus');
    // Nothing has demanded the context yet.
    expect(build).not.toHaveBeenCalled();
  });

  it('makes a tool call wait for the context rather than run without one', async () => {
    let release!: (ctx: ToolContext) => void;
    const ctx = fakeCtx();
    const { client } = await connect(() => new Promise<ToolContext>((r) => (release = r)));

    let settled = false;
    const call = client.callTool({ name: 'zotero_whoami', arguments: {} }).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    release(ctx);
    const result = (await call) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('oscardvs');
  });

  it('builds once and shares the result across calls', async () => {
    const build = vi.fn(async () => fakeCtx());
    const { deferred } = await connect(build);
    const [a, b] = await Promise.all([deferred.context(), deferred.context()]);
    expect(build).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  /**
   * The build used to run before the transport, so any failure in it (a locked search
   * index, a network blip on the key probe) took the process down. Now it surfaces as a
   * tool error on a server that is still up — and the next call gets a fresh attempt.
   */
  it('reports a failed build as a tool error, and retries it on the next call', async () => {
    const build = vi
      .fn<[], Promise<ToolContext>>()
      .mockRejectedValueOnce(new Error('database is locked'))
      .mockImplementation(async () => fakeCtx());
    const { client } = await connect(build);

    const failed = (await client.callTool({ name: 'zotero_whoami', arguments: {} })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toContain('database is locked');

    const recovered = (await client.callTool({ name: 'zotero_whoami', arguments: {} })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(recovered.isError).toBeFalsy();
    expect(build).toHaveBeenCalledTimes(2);
  });
});
