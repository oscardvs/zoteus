import { describe, it, expect, vi, afterEach } from 'vitest';
import { OaFetchError, fetchOaPdf, setOaHostLookup } from '../../src/features/oa/fetch.js';

/*
 * The clock on an open-access download.
 *
 * `RateLimitedFetcher` clears its abort timer the instant a Response is in hand, so its
 * `deadlineMs` bounds time-to-headers and nothing else. A host that answered immediately and
 * then trickled the body therefore held zotero_attach_file open with no limit at all: the
 * 64 MB cap bounds size, not time, and at one byte every 50 ms it is roughly five weeks
 * away. The caller saw an opaque connector timeout instead of a sentence it could act on.
 *
 * Nothing here touches the network: the DNS seam is stubbed and the bodies are hand-built
 * streams. Every budget is passed in explicitly so the suite costs milliseconds.
 */

const PDF_BYTE = 0x25;

/** A body that never ends: one byte every `everyMs`, exactly like a throttling repository. */
function trickling(everyMs: number): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let timer: ReturnType<typeof setInterval> | undefined;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        try {
          controller.enqueue(new Uint8Array([PDF_BYTE]));
        } catch {
          clearInterval(timer);
        }
      }, everyMs);
      (timer as { unref?: () => void }).unref?.();
    },
    cancel() {
      cancelled = true;
      clearInterval(timer);
    },
  });
  return { stream, cancelled: () => cancelled };
}

/** A body that delivers something and then goes quiet without closing. */
function goesQuiet(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([PDF_BYTE]));
    },
  });
}

function ctxWith(fetchImpl: any) {
  return { fetcher: { fetch: vi.fn(fetchImpl) } } as any;
}

const PDF_HEADERS = { 'content-type': 'application/pdf' };

describe('fetchOaPdf bounds the body read, not only the time to headers', () => {
  afterEach(() => setOaHostLookup(null));

  it('abandons a trickling body when the download budget is spent', async () => {
    setOaHostLookup(async () => ['93.184.216.34']);
    const body = trickling(5);
    const ctx = ctxWith(async () => new Response(body.stream, { status: 200, headers: PDF_HEADERS }));
    const started = Date.now();
    const err = await fetchOaPdf(ctx, 'https://repo.example/x.pdf', { deadlineMs: 150, idleMs: 60_000 })
      .then(() => null)
      .catch((e) => e as Error);
    expect(err).toBeInstanceOf(OaFetchError);
    expect(err!.message).toMatch(/was still arriving after the \d+ s Zoteus allows/);
    // The sentence has to be usable, not just present.
    expect(err!.message).toMatch(/attach it with `path`/);
    // Without a clock on the body this read never returns at all.
    expect(Date.now() - started).toBeLessThan(3_000);
    // And the socket is let go rather than left draining bytes nobody will read.
    expect(body.cancelled()).toBe(true);
  });

  it('abandons a body that stopped arriving, and says that is what happened', async () => {
    setOaHostLookup(async () => ['93.184.216.34']);
    const ctx = ctxWith(async () => new Response(goesQuiet(), { status: 200, headers: PDF_HEADERS }));
    const err = await fetchOaPdf(ctx, 'https://repo.example/x.pdf', { deadlineMs: 60_000, idleMs: 80 })
      .then(() => null)
      .catch((e) => e as Error);
    expect(err).toBeInstanceOf(OaFetchError);
    expect(err!.message).toMatch(/stopped arriving/);
    expect(err!.message).not.toMatch(/larger than/);
  });

  it('spends ONE budget across the redirect chain, not a fresh one per hop', async () => {
    setOaHostLookup(async () => ['93.184.216.34']);
    const deadlines: Array<number | undefined> = [];
    const ctx = ctxWith(async (url: string, _init: RequestInit, opts: { deadlineMs?: number }) => {
      deadlines.push(opts?.deadlineMs);
      await new Promise((r) => setTimeout(r, 40));
      return url.includes('cdn')
        ? new Response(new Uint8Array([PDF_BYTE]), { status: 200, headers: PDF_HEADERS })
        : new Response(null, { status: 302, headers: { location: 'https://cdn.example/file.pdf' } });
    });
    const out = await fetchOaPdf(ctx, 'https://repo.example/x.pdf', { deadlineMs: 5_000 });
    expect(out.bytes.length).toBe(1);
    expect(deadlines).toHaveLength(2);
    expect(deadlines[0]!).toBeLessThanOrEqual(5_000);
    // The second hop inherits what the first one left, so six redirects cannot cost six
    // budgets and the documented total stays the truth.
    expect(deadlines[1]!).toBeLessThan(deadlines[0]!);
  });

  it('still reads an ordinary body straight through', async () => {
    setOaHostLookup(async () => ['93.184.216.34']);
    const bytes = new Uint8Array([PDF_BYTE, 0x50, 0x44, 0x46]);
    const ctx = ctxWith(async () => new Response(bytes, { status: 200, headers: PDF_HEADERS }));
    const out = await fetchOaPdf(ctx, 'https://repo.example/x.pdf', { deadlineMs: 5_000, idleMs: 1_000 });
    expect(Array.from(out.bytes)).toEqual(Array.from(bytes));
    expect(out.servedType).toBe('application/pdf');
  });
});


it('bounds DNS resolution by the same total download deadline', async () => {
  setOaHostLookup(() => new Promise(() => {}));
  const ctx = ctxWith(async () => new Response(null));
  try {
    await expect(fetchOaPdf(ctx, 'https://repo.example/x.pdf', { deadlineMs: 20 })).rejects.toThrow(/took longer/);
    expect(ctx.fetcher.fetch).not.toHaveBeenCalled();
  } finally {
    setOaHostLookup(null);
  }
});
