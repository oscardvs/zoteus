import { describe, it, expect, vi } from 'vitest';
import { TranslationServerClient, TranslationServerError } from '../../src/features/citation/translation-server.js';

/** A fetcher stub shaped like RateLimitedFetcher, recording exactly what was requested. */
function fetcherFor(response: Response) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => response);
  return { fetcher: { fetch } as any, fetch };
}

const PAYLOAD = '@article{k, title = {A Title}, year = {2020}}';

describe('TranslationServerClient.import', () => {
  it('posts the payload verbatim as text/plain to /import', async () => {
    const { fetcher, fetch } = fetcherFor(
      new Response(JSON.stringify([{ itemType: 'journalArticle', title: 'A Title' }]), { status: 200 }),
    );
    const client = new TranslationServerClient('http://127.0.0.1:1969', fetcher);
    const items = await client.import(PAYLOAD);

    expect(items).toEqual([{ itemType: 'journalArticle', title: 'A Title' }]);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:1969/import');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('text/plain');
    expect(init.body).toBe(PAYLOAD);
  });

  it('throws the "no translator" error on 400 and on 501, which is what the fallback keys on', async () => {
    for (const status of [400, 501]) {
      const { fetcher } = fetcherFor(new Response('', { status }));
      const client = new TranslationServerClient('http://127.0.0.1:1969', fetcher);
      await expect(client.import(PAYLOAD)).rejects.toThrow(/No translator/);
    }
  });

  it('names the status on any other failure', async () => {
    const { fetcher } = fetcherFor(new Response('', { status: 500 }));
    const client = new TranslationServerClient('http://127.0.0.1:1969', fetcher);
    await expect(client.import(PAYLOAD)).rejects.toThrow(/\/import returned 500/);
  });

  it('answers with an empty list when the server returns something that is not one', async () => {
    const { fetcher } = fetcherFor(new Response(JSON.stringify({ not: 'an array' }), { status: 200 }));
    const client = new TranslationServerClient('http://127.0.0.1:1969', fetcher);
    expect(await client.import(PAYLOAD)).toEqual([]);
  });
});

describe('TranslationServerClient.web', () => {
  const PAGE = 'https://example.com/paper';

  it('returns a 300 as the choices it offers, not as a failure', async () => {
    const choices = { url: PAGE, session: 's1', items: { a: 'Choice A', b: 'Choice B' } };
    const { fetcher, fetch } = fetcherFor(new Response(JSON.stringify(choices), { status: 300 }));
    const client = new TranslationServerClient('http://127.0.0.1:1969', fetcher);
    expect(await client.web(PAGE)).toEqual({ multiple: choices });
    expect(fetch.mock.calls[0]![0]).toBe('http://127.0.0.1:1969/web');
  });

  it('keeps the status and the reason the server sends as its body', async () => {
    // The translation-server answers a failure with one plain-text line. Only the status used
    // to be kept, so nothing could say why the page failed.
    for (const [status, body] of [
      [501, 'No translators available\n'],
      [500, 'An error occurred retrieving the document\n'],
    ] as const) {
      const { fetcher } = fetcherFor(new Response(body, { status }));
      const client = new TranslationServerClient('http://127.0.0.1:1969', fetcher);
      const failure = await client.web(PAGE).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(TranslationServerError);
      expect(failure).toMatchObject({ status, reason: body.trim() });
      expect((failure as Error).message).toBe(`translation-server /web returned ${status} (${body.trim()}).`);
    }
  });

  it('quotes the first line of an HTML error page without its tags, and nothing for an empty body', async () => {
    const html =
      '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body><center>nginx</center></body></html>';
    const { fetcher } = fetcherFor(new Response(html, { status: 502 }));
    const failure = await new TranslationServerClient('http://127.0.0.1:1969', fetcher)
      .web(PAGE)
      .catch((e: unknown) => e);
    expect(failure).toMatchObject({ status: 502, reason: '502 Bad Gateway' });

    const empty = fetcherFor(new Response('', { status: 500 }));
    const bare = await new TranslationServerClient('http://127.0.0.1:1969', empty.fetcher)
      .web(PAGE)
      .catch((e: unknown) => e);
    expect(bare).toMatchObject({ status: 500, reason: undefined });
    expect((bare as Error).message).toBe('translation-server /web returned 500.');
  });
});
