import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../../src/server.js';
import { loadConfig } from '../../src/config.js';
import type { ToolContext } from '../../src/registry/registry.js';
import { BIBTEX_FIXTURE } from '../fixtures/bibliographies/index.js';
import { doiTitlePagePdf, DOI_PDF_DOI } from '../fixtures/pdf-identifiers.js';
import { SCHEMA_SLICE } from '../fixtures/zotero-schema.js';

/** The only URL this file's server is allowed to ask for, and the answer it gets. */
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
 * It throws on every other URL rather than returning a canned 404: a request this file did
 * not intend then fails the test instead of quietly leaving the machine.
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

/**
 * The new actions driven over the wire rather than through the handler.
 *
 * This is what the direct-handler tests cannot prove: that `text`, `path`, `format`,
 * `attachment_key`, `scan_pages` and `confirm` survive the closed-argument valve
 * (src/registry/strict-args.ts), and that everything the handler puts in
 * `structuredContent` passes the SDK's validation against the advertised outputSchema.
 */
async function connect(env: Record<string, string> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'zoteus-import-file-server-'));
  const config = loadConfig({
    ZOTEUS_LOCAL: 'off',
    ZOTEUS_OAUTH_ENABLED: 'false',
    ZOTERO_API_KEY: 'TEST-KEY',
    ZOTEUS_DATA_DIR: dataDir,
    ...env,
  });
  const built = await buildServer(config);
  const ctx = built.ctx as ToolContext;
  (ctx as any).translation = { isUp: vi.fn(async () => false) };
  // The fixture schema rather than the live one: deterministic, and no network in a test.
  (ctx as any).schema = { getSchema: vi.fn(async () => SCHEMA_SLICE) };
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await built.server.connect(a);
  await client.connect(b);
  return { client, ctx, dataDir };
}

describe('the server these cases build', () => {
  it('answers its startup key probe from the fake, and asks for nothing else', async () => {
    await connect();
    // Exactly one URL, and it never left the process. An empty list here means the fake
    // transport is not installed and the probe went to api.zotero.org for real.
    expect(requested).toEqual([KEY_PROBE]);
  });
});

describe('zotero_import by_file over the wire', () => {
  it('accepts the new arguments and returns a result the SDK validates', async () => {
    const { client } = await connect();
    const res: any = await client.callTool({
      name: 'zotero_import',
      arguments: { action: 'by_file', text: BIBTEX_FIXTURE, format: 'bibtex' },
    });
    expect(res.isError).toBeFalsy();
    const content = JSON.parse(res.content[1]!.text);
    expect(content.format).toBe('bibtex');
    expect(content.parsed).toBe(4);
    expect(content.saved).toBe(false);
    expect(content.items).toHaveLength(4);
  });

  it('refuses an argument the tool does not declare, as it always has', async () => {
    const { client } = await connect();
    const res: any = await client.callTool({
      name: 'zotero_import',
      arguments: { action: 'by_file', bibtex: BIBTEX_FIXTURE },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/unknown argument `bibtex`/);
  });

  it('honours the configured entry cap end to end', async () => {
    const { client } = await connect({ ZOTEUS_IMPORT_MAX_ENTRIES: '2' });
    const many = Array.from({ length: 5 }, (_u, i) => `@article{k${i}, title = {P${i}}}`).join('\n');
    const res: any = await client.callTool({
      name: 'zotero_import',
      arguments: { action: 'by_file', text: many },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/cap of 2 \(ZOTEUS_IMPORT_MAX_ENTRIES\)/);
  });
});

describe('zotero_import by_pdf over the wire', () => {
  it('accepts path and scan_pages, and returns a result the SDK validates', async () => {
    const { client, ctx, dataDir } = await connect();
    const pdf = join(dataDir, 'paper.pdf');
    writeFileSync(pdf, doiTitlePagePdf());
    (ctx as any).scholar = {
      lookup: vi.fn(async () => ({ title: 'Resolved Title', authors: ['E. Schrodinger'], year: 1926, type: 'article' })),
    };
    const res: any = await client.callTool({
      name: 'zotero_import',
      arguments: { action: 'by_pdf', path: pdf, scan_pages: 1 },
    });
    expect(res.isError).toBeFalsy();
    const content = JSON.parse(res.content[1]!.text);
    expect(content.identifierFound).toMatchObject({ type: 'doi', value: DOI_PDF_DOI, page: 1 });
    expect(content.pagesScanned).toBe(1);
    expect(content.items[0]).toMatchObject({ title: 'Resolved Title' });
    expect(content.provenance.trust).toBe('untrusted');
  });
});
