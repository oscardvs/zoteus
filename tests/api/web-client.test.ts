import { describe, it, expect, vi } from 'vitest';
import { WebApiClient } from '../../src/api/web-client.js';
import { RateLimitedFetcher } from '../../src/api/http.js';

function makeClient(fetchImpl: any) {
  const fetcher = new RateLimitedFetcher({ fetchImpl, maxConcurrency: 4 });
  return new WebApiClient({ apiKey: 'KEY', fetcher });
}

describe('WebApiClient', () => {
  it('sends version + auth headers and resolves keysCurrent', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.zotero.org/keys/current');
      expect((init.headers as Record<string, string>)['Zotero-API-Key']).toBe('KEY');
      expect((init.headers as Record<string, string>)['Zotero-API-Version']).toBe('3');
      return new Response(
        JSON.stringify({ userID: 19552201, username: 'oscardvs', access: {} }),
        { status: 200 },
      );
    });
    const info = await makeClient(fetchImpl).keysCurrent();
    expect(info.userID).toBe(19552201);
    expect(info.username).toBe('oscardvs');
  });

  it('lists items and parses Total-Results + Last-Modified-Version', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/users/19552201/items');
      expect(url).toContain('limit=2');
      expect(url).toContain('q=ai');
      return new Response(JSON.stringify([{ key: 'A' }, { key: 'B' }]), {
        status: 200,
        headers: { 'Total-Results': '138', 'Last-Modified-Version': '2114' },
      });
    });
    const r = await makeClient(fetchImpl).listItems({ type: 'user', id: 19552201 }, { q: 'ai', limit: 2 });
    expect(r.data).toHaveLength(2);
    expect(r.totalResults).toBe(138);
    expect(r.lastModifiedVersion).toBe(2114);
  });

  it('scopes listItems by collection via the path segment, not a query param', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/users/19552201/collections/ABC/items');
      expect(url).not.toContain('collectionKey=');
      return new Response(JSON.stringify([{ key: 'A' }]), {
        status: 200,
        headers: { 'Total-Results': '1', 'Last-Modified-Version': '5' },
      });
    });
    const r = await makeClient(fetchImpl).listItems(
      { type: 'user', id: 19552201 },
      { collectionKey: 'ABC' },
    );
    expect(r.data).toHaveLength(1);
  });

  it('scopes listItems by collection and top via the path segment', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/users/19552201/collections/ABC/items/top');
      expect(url).not.toContain('collectionKey=');
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Total-Results': '0' } });
    });
    await makeClient(fetchImpl).listItems(
      { type: 'user', id: 19552201 },
      { collectionKey: 'ABC', top: true },
    );
  });

  it('throws ZoteroApiError with an actionable message on failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }));
    await expect(makeClient(fetchImpl).getItem({ type: 'user', id: 1 }, 'XYZ')).rejects.toThrow(
      /not found/i,
    );
  });

  it('reads the item key census from /items/top?format=versions', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/users/19552201/items/top');
      expect(url).toContain('format=versions');
      expect(url).toContain('limit=5000');
      expect(url).not.toContain('top=');
      return new Response(JSON.stringify({ AAAA: 12, BBBB: 2114 }), {
        status: 200,
        headers: { 'Total-Results': '2', 'Last-Modified-Version': '2114' },
      });
    });
    const r = await makeClient(fetchImpl).itemVersions({ type: 'user', id: 19552201 }, { top: true, limit: 5000 });
    expect(r.versions).toEqual({ AAAA: 12, BBBB: 2114 });
    expect(r.totalResults).toBe(2);
    expect(r.lastModifiedVersion).toBe(2114);
  });

  it('fetches the global schema without auth', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.zotero.org/schema');
      return new Response(JSON.stringify({ version: 39, itemTypes: [] }), { status: 200 });
    });
    const schema = await makeClient(fetchImpl).getSchema();
    expect(schema.version).toBe(39);
  });

  // #79, the cloud half: same key sets, same guarantee.
  describe('listItemKeys', () => {
    it('reads /items with format=keys and splits the plain-text body', async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        expect(url).toContain('/users/19552201/items?');
        expect(url).not.toContain('/items/top');
        expect(url).toContain('format=keys');
        expect(url).toContain('itemType=attachment');
        return new Response('AAAAAAAA\nBBBBBBBB', {
          status: 200,
          headers: { 'Total-Results': '2', 'Last-Modified-Version': '3476' },
        });
      });
      const res = await makeClient(fetchImpl).listItemKeys(
        { type: 'user', id: 19552201 },
        { itemType: 'attachment' },
      );
      expect(res.keys).toEqual(['AAAAAAAA', 'BBBBBBBB']);
      expect(res.totalResults).toBe(2);
      expect(res.lastModifiedVersion).toBe(3476);
    });

    it('reads /items/top for the top-level key set', async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        expect(url).toContain('/users/19552201/items/top?');
        expect(url).toContain('format=keys');
        return new Response('AAAAAAAA', { status: 200, headers: { 'Total-Results': '1' } });
      });
      const res = await makeClient(fetchImpl).listItemKeys({ type: 'user', id: 19552201 }, { top: true });
      expect(res.keys).toEqual(['AAAAAAAA']);
    });
  });
});
