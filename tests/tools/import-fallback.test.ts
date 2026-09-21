import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import type { WebApiClient } from '../../src/api/web-client.js';
import type { ToolContext } from '../../src/registry/registry.js';

/** The only URL these servers are allowed to ask for, and the answer they get. */
const KEY_PROBE = 'https://api.zotero.org/keys/current';
const KEY_INFO = { userID: 4242, username: 'tester', access: { user: { library: true, files: true } } };

/** Every URL the fake transport was handed, newest last. Reset before each test. */
let requested: string[] = [];

/**
 * The whole network, faked, installed before `buildServer` builds anything.
 *
 * `buildServer` probes the configured key against api.zotero.org before it returns
 * (src/router/capabilities.ts), so a live transport here put a fabricated API key on the
 * wire five times per `connect()` on every `npm test`: the suite depended on a third
 * party's availability and mood, and once Zotero's auth-failure throttle tripped each of
 * these tests spent about nine seconds in retry backoff. `RateLimitedFetcher` captures
 * `globalThis.fetch` in its constructor (src/api/http.ts), so the stub has to be in place
 * before the server is built, which `beforeEach` guarantees.
 *
 * It throws on every other URL rather than returning a canned 404: a request these cases
 * did not intend then fails the test instead of quietly leaving the machine.
 */
function fakeZoteroTransport(): void {
  requested = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown): Promise<Response> => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      requested.push(url);
      if (url === KEY_PROBE) {
        return new Response(JSON.stringify(KEY_INFO), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected outbound request from a test: ${url}`);
    }),
  );
}

beforeEach(fakeZoteroTransport);
afterEach(() => {
  vi.unstubAllGlobals();
});

async function connect(overrides: Partial<ToolContext> = {}) {
  const config = loadConfig({
    ZOTEUS_LOCAL: 'off',
    ZOTEUS_OAUTH_ENABLED: 'false',
    ZOTERO_API_KEY: 'TEST-KEY',
    // A real server opens (and creates) its index store: keep that out of the real data dir.
    ZOTEUS_DATA_DIR: mkdtempSync(join(tmpdir(), 'zoteus-import-fallback-')),
  });
  const built = await buildServer(config);
  const ctx = built.ctx;
  (ctx as any).translation = { isUp: vi.fn(async () => false) };
  Object.assign(ctx, overrides);
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await built.server.connect(a);
  await client.connect(b);
  return { client, ctx };
}

describe('the server these cases build', () => {
  it('answers its startup key probe from the fake, and asks for nothing else', async () => {
    await connect();
    // Exactly one URL, and it never left the process. An empty list here means the fake
    // transport is not installed and the probe went to api.zotero.org for real.
    expect(requested).toEqual([KEY_PROBE]);
  });
});

describe('zotero_import built-in fallback', () => {
  it('resolves an arXiv id via the built-in Atom parser when translation-server is down', async () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <id>http://arxiv.org/abs/2201.00001</id>
      <published>2022-01-01T00:00:00Z</published>
      <title>Fallback Paper</title>
      <summary>Abstract.</summary>
      <author><name>Ada Lovelace</name></author>
    </entry></feed>`;
    const { client, ctx } = await connect();
    (ctx as any).translation = { isUp: vi.fn(async () => false) };
    (ctx as any).fetcher = { fetch: vi.fn(async () => new Response(xml, { status: 200 })) };
    const res: any = await client.callTool({
      name: 'zotero_import',
      arguments: { action: 'by_identifier', identifier: '2201.00001' },
    });
    expect(res.isError).toBeFalsy();
    const content = JSON.parse(res.content[1]!.text);
    expect(content.source).toBe('arxiv');
    expect(content.items[0]).toMatchObject({ itemType: 'preprint', title: 'Fallback Paper' });
  });

  it('resolves a DOI via the scholar graph when translation-server is down', async () => {
    const { client, ctx } = await connect();
    (ctx as any).translation = { isUp: vi.fn(async () => false) };
    (ctx as any).scholar = {
      lookup: vi.fn(async () => ({
        title: 'A Scholarly Work',
        authors: ['Ada Lovelace'],
        year: 2024,
        venue: 'Nature',
      })),
    };
    const res: any = await client.callTool({
      name: 'zotero_import',
      arguments: { action: 'by_identifier', identifier: '10.1234/example' },
    });
    expect(res.isError).toBeFalsy();
    const content = JSON.parse(res.content[1]!.text);
    expect(content.source).toBe('scholar');
    expect(content.items[0]).toMatchObject({
      itemType: 'journalArticle',
      title: 'A Scholarly Work',
      publicationTitle: 'Nature',
    });
  });

  it('returns a clear error for ISBN/PMID/bibcode without translation-server', async () => {
    const { client } = await connect();
    const res: any = await client.callTool({
      name: 'zotero_import',
      arguments: { action: 'by_identifier', identifier: '9783161484100' },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/translation-server/);
  });

  it('returns a clear error for URL scraping without translation-server', async () => {
    const { client } = await connect();
    const res: any = await client.callTool({
      name: 'zotero_import',
      arguments: { action: 'by_url', url: 'https://example.com/paper' },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/translation-server/);
  });
});

// keep WebApiClient referenced for typing stability
void (0 as unknown as WebApiClient);
