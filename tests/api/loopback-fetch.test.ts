import { createServer, STATUS_CODES, type IncomingMessage, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loopbackFetch, undiciParserAssertionAdvisory } from '../../src/api/loopback-fetch.js';
import { RateLimitedFetcher } from '../../src/api/http.js';
import { LocalApiClient } from '../../src/api/local-client.js';
import { LocalWriteClient } from '../../src/api/local-writes.js';
import { ConnectorWriteClient } from '../../src/api/connector-writes.js';
import { BbtClient } from '../../src/api/bbt-client.js';
import { ZoteroApiError } from '../../src/api/errors.js';
import { connectFailureCode } from '../../src/features/search/embeddings.js';
import { loadConfig } from '../../src/config.js';
import { buildContext } from '../../src/server.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** One request as the fake desktop app saw it. */
interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

type Handler = (seen: Seen, raw: IncomingMessage) => void | Promise<void>;

let server: Server;
let port: number;
let base: string;
let seen: Seen[] = [];
let handler: Handler = () => {};

/**
 * Answer the way the Zotero desktop app does: status line, headers and body in ONE write on
 * the socket, `Connection: close`, and the socket ended at once. Deliberately not through
 * node's ServerResponse, which would spread the same bytes over more than one write and hold
 * the socket a moment longer; the shape that tripped undici's parser is the one to test.
 */
function answer(raw: IncomingMessage, status: number, headers: [string, string][] = [], body: Buffer | string = ''): void {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const bodiless = status === 204 || status === 205 || status === 304;
  const lines = [
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}`,
    'Connection: close',
    ...headers.map(([name, value]) => `${name}: ${value}`),
  ];
  if (!bodiless) lines.push(`Content-Length: ${payload.length}`);
  const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
  raw.socket.on('error', () => {});
  raw.socket.end(raw.method === 'HEAD' || bodiless ? head : Buffer.concat([head, payload]));
}

function json(raw: IncomingMessage, status: number, value: unknown, headers: [string, string][] = []): void {
  answer(raw, status, [['Content-Type', 'application/json'], ...headers], JSON.stringify(value));
}

/**
 * Resolves when the server's side of a connection closes, however it closes. Not
 * `events.once(socket, 'close')`: that rejects on an 'error' first, and a client that drops
 * a socket with unread data on it makes the kernel answer with a reset, which the server
 * side sees as `read ECONNRESET` before 'close'. That reset IS the socket being destroyed.
 */
function closeOf(socket: IncomingMessage['socket']): Promise<void> {
  return new Promise((resolve) => socket.once('close', () => resolve()));
}

/** A port nothing listens on: taken for a moment, then released. */
async function closedPort(): Promise<number> {
  const probe = createTcpServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const free = (probe.address() as AddressInfo).port;
  probe.close();
  await once(probe, 'close');
  return free;
}

beforeAll(async () => {
  server = createServer(async (req) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const record: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) };
    seen.push(record);
    await handler(record, req);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
});

beforeEach(() => {
  seen = [];
  handler = () => {};
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loopbackFetch against a server that answers in one write and closes at once', () => {
  it('GET: a JSON body and the headers that came with it, over a Connection: close request', async () => {
    handler = (_s, raw) =>
      json(raw, 200, [{ key: 'ABCD1234' }], [
        ['Total-Results', '1'],
        ['Last-Modified-Version', '42'],
      ]);
    const res = await loopbackFetch(`${base}/api/users/0/items?limit=1`, {
      method: 'GET',
      headers: { 'Zotero-API-Version': '3' },
    });
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.headers.get('total-results')).toBe('1');
    expect(res.headers.get('last-modified-version')).toBe('42');
    expect(await res.json()).toEqual([{ key: 'ABCD1234' }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/api/users/0/items?limit=1' });
    expect(seen[0]!.headers['zotero-api-version']).toBe('3');
    expect(seen[0]!.headers.connection).toBe('close');
  });

  it('POST: a JSON string body and custom headers reach the server, in each header shape', async () => {
    handler = (s, raw) => json(raw, 200, { method: s.method, headers: s.headers, body: s.body.toString('utf8') });
    const body = JSON.stringify({ appName: 'Zoteus MCP' });
    const shapes: Record<string, RequestInit['headers']> = {
      record: { 'Content-Type': 'application/json', 'Zotero-Server-ID': 'srv-1', 'X-Custom': 'yes' },
      Headers: new Headers({ 'Content-Type': 'application/json', 'Zotero-Server-ID': 'srv-1', 'X-Custom': 'yes' }),
      array: [
        ['Content-Type', 'application/json'],
        ['Zotero-Server-ID', 'srv-1'],
        ['X-Custom', 'yes'],
      ],
    };
    for (const [shape, headers] of Object.entries(shapes)) {
      const res = await loopbackFetch(`${base}/api/local/authorize`, { method: 'POST', headers, body });
      const echo = (await res.json()) as { method: string; headers: Record<string, string>; body: string };
      expect(echo.method, shape).toBe('POST');
      expect(echo.body, shape).toBe(body);
      expect(echo.headers['content-type'], shape).toBe('application/json');
      expect(echo.headers['zotero-server-id'], shape).toBe('srv-1');
      expect(echo.headers['x-custom'], shape).toBe('yes');
      expect(echo.headers['content-length'], shape).toBe(String(Buffer.byteLength(body)));
    }
  });

  it('a string body defaults to text/plain and a URLSearchParams body to a form, as fetch does', async () => {
    handler = (s, raw) => json(raw, 200, { type: s.headers['content-type'], body: s.body.toString('utf8') });
    const text = await (await loopbackFetch(`${base}/x`, { method: 'POST', body: 'hello' })).json();
    expect(text).toEqual({ type: 'text/plain;charset=UTF-8', body: 'hello' });
    const form = await (
      await loopbackFetch(`${base}/x`, {
        method: 'POST',
        body: new URLSearchParams({ md5: 'abc', filename: 'paper.pdf' }),
      })
    ).json();
    expect(form).toEqual({ type: 'application/x-www-form-urlencoded;charset=UTF-8', body: 'md5=abc&filename=paper.pdf' });
  });

  it('binary bodies round-trip byte for byte: a Uint8Array, an offset Buffer view, an ArrayBuffer', async () => {
    const bytes = randomBytes(200_000);
    handler = (s, raw) => answer(raw, 200, [['Content-Type', 'application/octet-stream']], s.body);
    const offsetView = Buffer.concat([Buffer.alloc(7, 0xff), bytes]).subarray(7);
    expect(offsetView.byteOffset).not.toBe(0);
    const shapes: Record<string, RequestInit['body']> = {
      Uint8Array: new Uint8Array(bytes),
      'offset Buffer view': offsetView,
      ArrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
    for (const [shape, body] of Object.entries(shapes)) {
      seen = [];
      const res = await loopbackFetch(`${base}/api/local/uploads/k`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
      });
      expect(seen[0]!.body.equals(bytes), `${shape}: what the server received`).toBe(true);
      expect(seen[0]!.headers['content-length'], shape).toBe(String(bytes.length));
      expect(Buffer.from(await res.arrayBuffer()).equals(bytes), `${shape}: what came back`).toBe(true);
    }
  });

  it('refuses a body shape the desktop clients never send, naming it', async () => {
    await expect(loopbackFetch(`${base}/x`, { method: 'POST', body: new Blob(['x']) })).rejects.toThrow(
      /Blob request body is not supported/,
    );
    expect(seen).toHaveLength(0);
  });

  it('204: a null body, with the headers kept', async () => {
    handler = (_s, raw) => answer(raw, 204, [['Last-Modified-Version', '7']]);
    const res = await loopbackFetch(`${base}/api/users/0/items/K1`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    expect(res.headers.get('last-modified-version')).toBe('7');
    expect(await res.text()).toBe('');
  });

  it('HEAD: a null body even when Content-Length says otherwise', async () => {
    handler = (_s, raw) => answer(raw, 200, [['Content-Type', 'application/json']], '[1,2]');
    const res = await loopbackFetch(`${base}/api/users/0/items`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers.get('content-length')).toBe('5');
  });

  it('repeated response headers survive the copy', async () => {
    handler = (_s, raw) =>
      answer(
        raw,
        200,
        [
          ['X-Multi', 'a'],
          ['X-Multi', 'b'],
          ['Set-Cookie', 'a=1'],
          ['Set-Cookie', 'b=2'],
        ],
        'ok',
      );
    const res = await loopbackFetch(`${base}/x`);
    expect(res.headers.get('x-multi')).toBe('a, b');
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect(await res.text()).toBe('ok');
  });

  it('an already-aborted signal rejects before anything is sent', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(loopbackFetch(`${base}/x`, { signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(ac.signal.aborted).toBe(true);
    expect(seen).toHaveLength(0);
  });

  it('an abort while waiting for the answer rejects and drops the socket', async () => {
    let closed: Promise<void> = Promise.resolve();
    handler = (_s, raw) => {
      // Never answers; the client has to give up on its own.
      closed = closeOf(raw.socket);
    };
    const ac = new AbortController();
    const pending = loopbackFetch(`${base}/slow`, { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(ac.signal.aborted).toBe(true);
    await closed;
  });

  it('an abort while the body is being read errors the body, not the process', async () => {
    handler = (_s, raw) => {
      raw.socket.on('error', () => {});
      // Headers now, the promised ten bytes never.
      raw.socket.write(Buffer.from('HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: 10\r\n\r\n', 'latin1'));
    };
    const ac = new AbortController();
    const res = await loopbackFetch(`${base}/stalled-body`, { signal: ac.signal });
    expect(res.status).toBe(200);
    const reading = res.text();
    ac.abort();
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
  });

  it("the RateLimitedFetcher's budget turns the abort into its own timeout error", async () => {
    handler = () => {};
    const fetcher = new RateLimitedFetcher({ fetchImpl: loopbackFetch, maxConcurrency: 2 });
    const err = await fetcher.fetch(`${base}/slow`, { method: 'GET' }, { maxRetries: 0, deadlineMs: 50 }).catch((e) => e);
    expect(err).toBeInstanceOf(ZoteroApiError);
    expect((err as ZoteroApiError).status).toBe(408);
    expect(String((err as Error).message)).toMatch(/Zotero took longer than the 1s budget/);
  });

  it('ECONNREFUSED rejects as TypeError("fetch failed") with the code in cause, as undici reports it', async () => {
    const free = await closedPort();
    const err: unknown = await loopbackFetch(`http://127.0.0.1:${free}/api/users/0/items?limit=1`).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toBe('fetch failed');
    expect(((err as Error).cause as { code?: string }).code).toBe('ECONNREFUSED');
    expect(connectFailureCode(err)).toBe('ECONNREFUSED');
  });

  it('a 302 comes back as a 302 and is not followed', async () => {
    handler = (_s, raw) => answer(raw, 302, [['Location', 'file:///home/me/Zotero/storage/ABCD1234/paper.pdf']]);
    const res = await loopbackFetch(`${base}/api/users/0/items/ABCD1234/file`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('file:///home/me/Zotero/storage/ABCD1234/paper.pdf');
    expect(seen).toHaveLength(1);
    await res.body?.cancel();
  });

  it('body.cancel() resolves and destroys the socket', async () => {
    let closed: Promise<void> = Promise.resolve();
    handler = (_s, raw) => {
      closed = closeOf(raw.socket);
      answer(raw, 200, [['Content-Type', 'application/octet-stream']], Buffer.alloc(4 * 1024 * 1024, 1));
    };
    const res = await loopbackFetch(`${base}/big`);
    expect(res.status).toBe(200);
    await expect(res.body!.cancel()).resolves.toBeUndefined();
    await closed;
  });

  it('a URL that is not http: is not the desktop app and goes to the platform fetch', async () => {
    const res = await loopbackFetch('data:text/plain,not%20loopback');
    expect(await res.text()).toBe('not loopback');
    expect(seen).toHaveLength(0);
  });
});

describe('the test seam', () => {
  it('a replaced global fetch receives the loopback call; the platform fetch restored, node:http is back', async () => {
    const stub = vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', stub);
    const init = { method: 'GET', headers: { 'Zotero-API-Version': '3' } };
    const res = await loopbackFetch(`${base}/api/users/0/items?limit=1`, init);
    expect(await res.json()).toEqual([]);
    expect(stub).toHaveBeenCalledTimes(1);
    expect(stub).toHaveBeenCalledWith(`${base}/api/users/0/items?limit=1`, init);
    expect(seen).toHaveLength(0);

    vi.unstubAllGlobals();
    handler = (_s, raw) => json(raw, 200, [{ key: 'K1' }]);
    expect(await (await loopbackFetch(`${base}/api/users/0/items?limit=1`, init)).json()).toEqual([{ key: 'K1' }]);
    expect(seen).toHaveLength(1);
    expect(stub).toHaveBeenCalledTimes(1);
  });
});

describe('the desktop clients built the way src/server.ts builds them', () => {
  it('route every request through the loopback transport, never through the shared fetcher\'s own fetch', async () => {
    const never = vi.fn(async (url: string) => {
      throw new Error(`the fetcher's own fetch was used for ${url}`);
    });
    const fetcher = new RateLimitedFetcher({ fetchImpl: never, maxConcurrency: 4 });
    handler = (s, raw) => {
      if (s.url.startsWith('/api/users/0/items')) {
        return json(raw, 200, [{ key: 'K1' }], [
          ['Zotero-Server-ID', 'srv-1'],
          ['Last-Modified-Version', '9'],
          ['Total-Results', '1'],
        ]);
      }
      if (s.url === '/connector/ping') return answer(raw, 200, [['Content-Type', 'text/html']], '<p>Zotero is running</p>');
      if (s.url === '/better-bibtex/json-rpc') return json(raw, 200, { jsonrpc: '2.0', result: [], id: 0 });
      return answer(raw, 404, [], 'nope');
    };

    const local = new LocalApiClient({
      port,
      fetcher,
      probeFetcher: new RateLimitedFetcher({ fetchImpl: never, maxConcurrency: 2 }),
      fetchImpl: loopbackFetch,
    });
    expect(await local.probe(2_000)).toEqual({ up: true, timedOut: false });
    expect((await local.listItems({ limit: 1 })).data).toEqual([{ key: 'K1' }]);

    const writes = new LocalWriteClient({ port, fetcher, key: 'k', fetchImpl: loopbackFetch });
    expect(await writes.getServerId()).toBe('srv-1');

    const connector = new ConnectorWriteClient({ port, fetcher, fetchImpl: loopbackFetch });
    expect(await connector.ping()).toBe(true);

    const bbt = new BbtClient({ port, fetchImpl: loopbackFetch });
    expect(await bbt.ping()).toBe(true);

    expect(never).not.toHaveBeenCalled();
    expect(seen.map((s) => s.url)).toEqual([
      '/api/users/0/items?limit=1',
      '/api/users/0/items?limit=1',
      '/api/users/0/items?limit=1',
      '/connector/ping',
      '/better-bibtex/json-rpc',
    ]);
    expect(seen.every((s) => s.headers.connection === 'close')).toBe(true);
  });

  it('and buildContext itself: the startup probe and the write clients reach the desktop app over node:http', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-loopback-'));
    handler = (s, raw) => {
      if (s.url.startsWith('/api/users/0/items')) {
        return json(raw, 200, [{ key: 'K1' }], [
          ['Zotero-Server-ID', 'srv-1'],
          ['Last-Modified-Version', '9'],
          ['Total-Results', '1'],
        ]);
      }
      if (s.url === '/connector/ping') return answer(raw, 200, [['Content-Type', 'text/html']], '<p>Zotero is running</p>');
      // Groups, and whatever else startup asks for: an empty list.
      return json(raw, 200, [], [['Total-Results', '0']]);
    };
    try {
      const config = loadConfig({
        ZOTEUS_LOCAL: 'on',
        ZOTERO_LOCAL_PORT: String(port),
        ZOTEUS_DATA_DIR: dir,
        ZOTEUS_EMBEDDINGS: 'off',
        ZOTEUS_INDEX_BACKEND: 'memory',
        ZOTEUS_UPDATE_CHECK: 'false',
      } as any);
      const ctx = await buildContext(config, { telemetry: { logger: silentLogger as any } });
      expect(ctx.capabilities.localApi).toBe(true);
      expect(await ctx.localWrites!.getServerId()).toBe('srv-1');
      expect(await ctx.connectorWrites!.ping()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(seen.length).toBeGreaterThanOrEqual(3);
    for (const s of seen) {
      // node:http's request, not undici's: the platform fetch sends `connection:
      // keep-alive`, `sec-fetch-mode: cors` and `user-agent: node`; this transport none.
      expect(s.headers.connection, s.url).toBe('close');
      expect(s.headers['sec-fetch-mode'], s.url).toBeUndefined();
      expect(s.headers['user-agent'], s.url).toBeUndefined();
    }
  });
});

describe('undiciParserAssertionAdvisory', () => {
  it('names the affected build, what is routed around it, and the Node to move to', () => {
    const line = undiciParserAssertionAdvisory({ node: '24.20.0', undici: '7.29.0' });
    expect(line).toContain('Node 24.20.0 bundles undici 7.29.0');
    expect(line).toContain('nodejs/undici#5360');
    expect(line).toContain('node:http');
    expect(line).toContain('api.zotero.org');
    expect(line).toContain('Node 24.21.0 or newer');
  });

  it('is silent on the fixed build, on older lines, and when nothing is known', () => {
    expect(undiciParserAssertionAdvisory({ node: '24.21.0', undici: '7.29.1' })).toBeUndefined();
    expect(undiciParserAssertionAdvisory({ node: '22.23.2', undici: '6.28.0' })).toBeUndefined();
    expect(undiciParserAssertionAdvisory({ node: '24.20.0' })).toBeUndefined();
    expect(undiciParserAssertionAdvisory({})).toBeUndefined();
  });
});
