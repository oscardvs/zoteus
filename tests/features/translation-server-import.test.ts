import { describe, it, expect, vi } from 'vitest';
import { TranslationServerClient } from '../../src/features/citation/translation-server.js';

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
