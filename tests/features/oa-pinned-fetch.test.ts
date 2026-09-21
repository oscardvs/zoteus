import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { request } from 'node:https';
import type { RequestOptions } from 'node:https';
import { RateLimitedFetcher } from '../../src/api/http.js';
import { fetchOaPdf, setOaHostLookup } from '../../src/features/oa/fetch.js';

vi.mock('node:https', () => ({ request: vi.fn() }));

const PDF = Buffer.from('%PDF-1.7\nfixture');

function transport(replies: Array<{ status?: number; headers?: string[]; body?: Buffer; stall?: boolean }>) {
  const calls: RequestOptions[] = [];
  vi.mocked(request).mockImplementation(((opts: RequestOptions, callback: (res: unknown) => void) => {
    calls.push(opts);
    const reply = replies[calls.length - 1]!;
    const res = Object.assign(new PassThrough(), {
      statusCode: reply.status ?? 200,
      rawHeaders: reply.headers ?? ['content-type', 'application/pdf'],
    });
    const req = Object.assign(new EventEmitter(), {
      end: () => {
        callback(res);
        if (!reply.stall) res.end(reply.body ?? PDF);
      },
      // Cancelling the web stream that `Readable.toWeb` builds over a client response does
      // not destroy the response. Node's stream destroyer recognises `res.req` as the request
      // (anything with `setHeader` and `abort`) and aborts that instead, and
      // ClientRequest.destroy() then dumps the response: every 'data' listener is removed
      // before the buffered body drains. A PassThrough with no `req` is destroyed in its
      // place, which removes nothing, so the resume the adapter had already scheduled still
      // delivered the buffered body to its listener, and enqueue on the cancelled controller
      // threw "Controller is already closed" on a nextTick outside any test.
      setHeader: () => {},
      abort: () => {
        res.removeAllListeners('data');
        res.resume();
      },
    });
    Object.assign(res, { req });
    return req;
  }) as any);
  const defaultFetch = vi.fn(async () => { throw new Error('Unpinned fetch must never be used'); });
  return { calls, defaultFetch, ctx: { fetcher: new RateLimitedFetcher({ fetchImpl: defaultFetch }) } };
}

afterEach(() => {
  setOaHostLookup(null);
  vi.clearAllMocks();
});

describe('OA connections pin validated addresses', () => {
  it('connects to the vetted IP after a DNS change and retains hostname authentication', async () => {
    const lookup = vi.fn().mockResolvedValueOnce(['93.184.216.34']).mockResolvedValue(['127.0.0.1']);
    setOaHostLookup(lookup);
    const { ctx, calls, defaultFetch } = transport([{}]);
    const result = await fetchOaPdf(ctx, 'https://repo.example:8443/paper.pdf?download=1');
    expect(Buffer.from(result.bytes)).toEqual(PDF);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(defaultFetch).not.toHaveBeenCalled();
    expect(calls[0]).toMatchObject({
      hostname: '93.184.216.34', port: '8443', servername: 'repo.example',
      path: '/paper.pdf?download=1', rejectUnauthorized: true, agent: false,
      headers: { host: 'repo.example:8443', 'accept-encoding': 'identity' },
    });
    const verify = calls[0]!.checkServerIdentity!;
    expect(verify('93.184.216.34', { subjectaltname: 'DNS:repo.example' } as any)).toBeUndefined();
    expect(verify('93.184.216.34', { subjectaltname: 'DNS:attacker.example' } as any)).toBeInstanceOf(Error);
  });

  it('validates and pins each redirected hostname separately', async () => {
    const lookup = vi.fn(async (host: string) => host === 'repo.example' ? ['93.184.216.34'] : ['93.184.216.35']);
    setOaHostLookup(lookup);
    const { ctx, calls } = transport([
      { status: 302, headers: ['location', 'https://cdn.example/paper.pdf'] },
      {},
    ]);
    const result = await fetchOaPdf(ctx, 'https://repo.example/paper.pdf');
    expect(result.url).toBe('https://cdn.example/paper.pdf');
    expect(calls.map((call) => [call.hostname, call.servername])).toEqual([
      ['93.184.216.34', 'repo.example'], ['93.184.216.35', 'cdn.example'],
    ]);
  });

  it('retains the streaming byte ceiling with the pinned transport', async () => {
    setOaHostLookup(async () => ['93.184.216.34']);
    const { ctx } = transport([{}]);
    await expect(fetchOaPdf(ctx, 'https://repo.example/paper.pdf', { maxBytes: 3 })).rejects.toThrow(/larger than/);
  });

  it('retains the body idle timeout with the pinned transport', async () => {
    setOaHostLookup(async () => ['93.184.216.34']);
    const { ctx } = transport([{ stall: true }]);
    await expect(fetchOaPdf(ctx, 'https://repo.example/paper.pdf', { deadlineMs: 500, idleMs: 20 })).rejects.toThrow(/stopped arriving/);
  });
});
