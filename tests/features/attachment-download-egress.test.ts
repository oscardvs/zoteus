import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import { AttachmentDownloadError, downloadAttachment } from '../../src/features/attachments/store.js';
import { setOaHostLookup } from '../../src/features/oa/fetch.js';
import type { ToolContext } from '../../src/registry/registry.js';

/*
 * The `url` argument of zotero_attach_file and zotero_import's attach_url, as seen from a
 * hosted deployment.
 *
 * There the caller is a tenant and the request leaves the operator's box, so `url` has to
 * be held to what an open-access download is held to: https, public hosts, every redirect
 * hop re-checked, a byte cap, a clock. Without that, `http://169.254.169.254/...` or
 * `http://127.0.0.1:<port>/...` read the operator's metadata service or a loopback service
 * into the tenant's library. A stdio caller is the person running the process on their own
 * machine and keeps fetching from wherever they like.
 *
 * Nothing here touches the network: the DNS seam is stubbed and the fetcher is a spy whose
 * arguments say which transport was chosen.
 */

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
const PDF_HEADERS = { 'content-type': 'application/pdf' };

type FetchSpy = Mock<(url: string, init: RequestInit, opts: { fetchImpl?: unknown; deadlineMs?: number }) => Promise<Response>>;
type Ctx = Pick<ToolContext, 'fetcher' | 'remoteCaller'> & { fetcher: { fetch: FetchSpy } };

function ctxWith(remoteCaller: boolean, impl: (url: string, init: RequestInit, opts: { fetchImpl?: unknown; deadlineMs?: number }) => Promise<Response>): Ctx {
  return { fetcher: { fetch: vi.fn(impl) }, remoteCaller } as unknown as Ctx;
}

const servesPdf = async () => new Response(PDF, { status: 200, headers: PDF_HEADERS });
const hosted = (impl = servesPdf) => ctxWith(true, impl);
const local = (impl = servesPdf) => ctxWith(false, impl);
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as AttachmentDownloadError);

afterEach(() => setOaHostLookup(null));

describe('downloadAttachment for a hosted (remote) caller', () => {
  it('refuses a private address before any request goes out, and says so in the caller\'s terms', async () => {
    const lookup = vi.fn(async () => ['93.184.216.34']);
    setOaHostLookup(lookup);
    const ctx = hosted();
    for (const url of ['https://169.254.169.254/latest/meta-data/', 'https://127.0.0.1:8080/x.pdf', 'https://[::1]/x.pdf']) {
      const err = await failure(downloadAttachment(ctx, url));
      expect(err).toBeInstanceOf(AttachmentDownloadError);
      expect(err!.status).toBe(0);
      expect(err!.message).toMatch(/non-public address/);
      expect(err!.message).toMatch(/hosted Zoteus fetches only from public hosts/);
      // The wrong subject and the wrong remedy for a link the caller typed on a hosted box.
      expect(err!.message).not.toMatch(/open-access|repository|`path`/);
    }
    expect(ctx.fetcher.fetch).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('refuses http, the scheme the metadata service actually speaks, before any request', async () => {
    const ctx = hosted();
    const err = await failure(downloadAttachment(ctx, 'http://169.254.169.254/latest/meta-data/'));
    expect(err).toBeInstanceOf(AttachmentDownloadError);
    expect(err!.message).toMatch(/served over http rather than https/);
    expect(ctx.fetcher.fetch).not.toHaveBeenCalled();
  });

  it('refuses a public name that resolves into the deployment', async () => {
    setOaHostLookup(async () => ['10.0.0.7']);
    const ctx = hosted();
    await expect(downloadAttachment(ctx, 'https://internal.example/x.pdf')).rejects.toThrow(/resolves to a non-public address/);
    expect(ctx.fetcher.fetch).not.toHaveBeenCalled();
  });

  it('fetches a public https host through the pinned transport, redirects by hand, with the cap on', async () => {
    setOaHostLookup(async () => ['93.184.216.34']);
    const ctx = hosted();
    const out = await downloadAttachment(ctx, 'https://arxiv.org/pdf/2501.12345v1');
    expect(Array.from(out.bytes)).toEqual(Array.from(PDF));
    expect(out.contentType).toBe('application/pdf');
    expect(out.filename).toBe('2501.12345v1');
    expect(ctx.fetcher.fetch).toHaveBeenCalledTimes(1);
    const [url, init, opts] = ctx.fetcher.fetch.mock.calls[0]!;
    expect(url).toBe('https://arxiv.org/pdf/2501.12345v1');
    // Redirects are followed by hand so each hop is re-checked, and the connection is the
    // pinned one rather than whatever the fetcher would have used.
    expect(init.redirect).toBe('manual');
    expect(typeof opts.fetchImpl).toBe('function');
    expect(opts.deadlineMs).toBeLessThanOrEqual(300_000);
  });

  it('applies the byte cap to a hosted url', async () => {
    setOaHostLookup(async () => ['93.184.216.34']);
    const ctx = hosted(async () => new Response(PDF, { status: 200, headers: { ...PDF_HEADERS, 'content-length': String(65 * 1024 * 1024) } }));
    const err = await failure(downloadAttachment(ctx, 'https://repo.example/huge.pdf'));
    expect(err).toBeInstanceOf(AttachmentDownloadError);
    expect(err!.message).toMatch(/larger than the 64 MB a hosted Zoteus downloads/);
  });

  it('re-checks every redirect hop, so a public host cannot bounce the request into loopback', async () => {
    setOaHostLookup(async (host: string) => (host === 'repo.example' ? ['93.184.216.34'] : ['127.0.0.1']));
    const ctx = hosted(async () => new Response(null, { status: 302, headers: { location: 'https://internal.example/x.pdf' } }));
    await expect(downloadAttachment(ctx, 'https://repo.example/x.pdf')).rejects.toThrow(/resolves to a non-public address/);
    expect(ctx.fetcher.fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the HTTP status on a non-2xx answer, in the sentence the tools already show', async () => {
    setOaHostLookup(async () => ['93.184.216.34']);
    const ctx = hosted(async () => new Response('nope', { status: 404 }));
    const err = await failure(downloadAttachment(ctx, 'https://repo.example/gone.pdf'));
    expect(err).toBeInstanceOf(AttachmentDownloadError);
    expect(err!.status).toBe(404);
    expect(err!.message).toBe('Download failed (404) for https://repo.example/gone.pdf');
  });
});

describe('downloadAttachment for a local (stdio) caller', () => {
  it('fetches from wherever the user points it, http and loopback included, with no pinning', async () => {
    const lookup = vi.fn(async () => ['93.184.216.34']);
    setOaHostLookup(lookup);
    const ctx = local();
    const out = await downloadAttachment(ctx, 'http://127.0.0.1:8080/local.pdf');
    expect(Array.from(out.bytes)).toEqual(Array.from(PDF));
    expect(out.filename).toBe('local.pdf');
    const [url, init, opts] = ctx.fetcher.fetch.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:8080/local.pdf');
    expect(init.redirect).toBeUndefined();
    expect(opts.fetchImpl).toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('still reports a non-2xx answer by its status', async () => {
    const ctx = local(async () => new Response('nope', { status: 403 }));
    const err = await failure(downloadAttachment(ctx, 'https://repo.example/x.pdf'));
    expect(err).toBeInstanceOf(AttachmentDownloadError);
    expect(err!.status).toBe(403);
  });
});
