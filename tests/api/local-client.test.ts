import { describe, it, expect, vi } from 'vitest';
import { LocalApiClient } from '../../src/api/local-client.js';
import { RateLimitedFetcher } from '../../src/api/http.js';

function makeLocal(fetchImpl: any, port = 23119) {
  return new LocalApiClient({ port, fetcher: new RateLimitedFetcher({ fetchImpl, maxConcurrency: 4 }) });
}

describe('LocalApiClient', () => {
  it('ping returns true when the local API responds', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('http://127.0.0.1:23119/api/users/0/items');
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Total-Results': '0' } });
    });
    expect(await makeLocal(fetchImpl).ping()).toBe(true);
  });

  it('ping returns false on connection error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await makeLocal(fetchImpl).ping()).toBe(false);
  });

  // The desktop app gets its own per-read budget (ZOTEUS_ZOTERO_DEADLINE_MS), so a machine
  // whose local API answers a listing in 40 s can be given room to finish an index build's
  // attachment map without letting every cloud call hang that long too (#78).
  it('spends its configured budget on an ordinary read', async () => {
    const hang = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    const local = new LocalApiClient({
      port: 23119,
      fetcher: new RateLimitedFetcher({ fetchImpl: hang, maxConcurrency: 4 }),
      deadlineMs: 80,
    });
    await expect(local.listItems({ limit: 5 })).rejects.toThrow(/budget/);
    expect(hang).toHaveBeenCalledTimes(1);
  }, 1500);

  // The probe is the one read that must not inherit it: it answers now or not at all, and a
  // raised budget would turn every tool call's liveness check into a wait that long.
  it('leaves the liveness probe its own budget', async () => {
    const hang = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    const local = new LocalApiClient({
      port: 23119,
      fetcher: new RateLimitedFetcher({ fetchImpl: hang, maxConcurrency: 4 }),
      probeFetcher: new RateLimitedFetcher({ fetchImpl: hang, maxConcurrency: 2 }),
      deadlineMs: 60_000,
    });
    const started = Date.now();
    expect(await local.probe(200)).toEqual({ up: false, timedOut: true });
    expect(Date.now() - started).toBeLessThan(1000);
  }, 1500);

  it('lists items against users/0', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/api/users/0/items');
      expect(url).toContain('limit=5');
      return new Response(JSON.stringify([{ key: 'A' }]), {
        status: 200,
        headers: { 'Total-Results': '1', 'Last-Modified-Version': '10' },
      });
    });
    const r = await makeLocal(fetchImpl).listItems({ limit: 5 });
    expect(r.data).toHaveLength(1);
    expect(r.totalResults).toBe(1);
  });

  it('requests top-level items from /items/top for index builds', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/api/users/0/items/top');
      expect(url).toContain('limit=100');
      expect(url).toContain('start=100');
      return new Response(JSON.stringify([{ key: 'A' }]), {
        status: 200,
        headers: { 'Total-Results': '250', 'Last-Modified-Version': '13' },
      });
    });
    const r = await makeLocal(fetchImpl).listItems({ top: true, limit: 100, start: 100 });
    expect(r.totalResults).toBe(250); // pagers need the library-wide total, not the page size
  });

  it('falls back to the page length when Total-Results is missing (never 0)', async () => {
    // Number(null) is 0 and finite — a naive parse would report totalResults: 0 and stop
    // a paging caller (the search-index build) dead after its first page.
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([{ key: 'A' }, { key: 'B' }]), { status: 200 }));
    const r = await makeLocal(fetchImpl).listItems({ limit: 2 });
    expect(r.totalResults).toBe(2);
    expect(r.lastModifiedVersion).toBe(0);
  });

  it('scopes listItems by collection via the path segment, not a query param', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/api/users/0/collections/ABC/items');
      expect(url).not.toContain('collectionKey=');
      return new Response(JSON.stringify([{ key: 'A' }]), {
        status: 200,
        headers: { 'Total-Results': '1', 'Last-Modified-Version': '10' },
      });
    });
    const r = await makeLocal(fetchImpl).listItems({ collectionKey: 'ABC' });
    expect(r.data).toHaveLength(1);
  });

  it('fetches children via /items/<key>/children, never a parentItem filter', async () => {
    // The desktop local API ignores ?parentItem= and answers with the whole library.
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/api/users/0/items/ABCD1234/children');
      expect(url).not.toContain('parentItem');
      return new Response(JSON.stringify([{ key: 'CHILD' }]), {
        status: 200,
        headers: { 'Total-Results': '1', 'Last-Modified-Version': '7' },
      });
    });
    const r = await makeLocal(fetchImpl).getItemChildren('ABCD1234');
    expect(r.data).toEqual([{ key: 'CHILD' }]);
    expect(r.totalResults).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('passes item filters through to the children endpoint', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/api/users/0/items/ABCD1234/children');
      expect(url).toContain('itemType=annotation');
      expect(url).toContain('limit=100');
      return new Response(JSON.stringify([]), { status: 200, headers: { 'Total-Results': '0' } });
    });
    await makeLocal(fetchImpl).getItemChildren('ABCD1234', { itemType: 'annotation', limit: 100 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reads an attachment full text from the local /fulltext endpoint', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('http://127.0.0.1:23119/api/users/0/items/ATT01/fulltext');
      return new Response(JSON.stringify({ content: 'body text', indexedPages: 7, totalPages: 7 }), { status: 200 });
    });
    const ft = await makeLocal(fetchImpl).getFullText('ATT01');
    expect(ft.content).toBe('body text');
    expect(ft.totalPages).toBe(7);
  });

  it('returns null (not an error) for an attachment the app has no text for', async () => {
    const fetchImpl = vi.fn(async () => new Response('Not found', { status: 404 }));
    expect(await makeLocal(fetchImpl).getFullText('ATT01')).toBeNull();
  });

  it('still throws when the local API is unreachable, so a build reports it', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(makeLocal(fetchImpl).getFullText('ATT01')).rejects.toThrow(/500/);
  });

  it('lists full-text changes since a version', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/api/users/0/fulltext');
      expect(url).toContain('since=0');
      return new Response(JSON.stringify({ ATT01: 676, ATT02: 705 }), { status: 200 });
    });
    expect(await makeLocal(fetchImpl).fullTextSince(0)).toEqual({ ATT01: 676, ATT02: 705 });
  });

  it('reads a group library from /groups/<id>, never users/0', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/api/groups/4321/items');
      expect(url).not.toContain('/users/0');
      expect(url).toContain('limit=5');
      return new Response(JSON.stringify([{ key: 'G1' }]), {
        status: 200,
        headers: { 'Total-Results': '1', 'Last-Modified-Version': '3' },
      });
    });
    const r = await makeLocal(fetchImpl).listItems({ limit: 5 }, { type: 'group', id: 4321 });
    expect(r.data).toEqual([{ key: 'G1' }]);
  });

  it('addresses every other group read under the same /groups/<id> prefix', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url);
      const body = url.includes('/items/ATT01/fulltext') ? { content: 'group text' } : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Total-Results': '0' } });
    });
    const c = makeLocal(fetchImpl);
    const lib = { type: 'group' as const, id: 4321 };
    await c.getItemChildren('ABCD1234', {}, lib);
    const ft = await c.getFullText('ATT01', lib);
    await c.fullTextSince(7, lib);
    await c.listCollections({}, lib);
    expect(ft.content).toBe('group text');
    expect(seen).toEqual([
      'http://127.0.0.1:23119/api/groups/4321/items/ABCD1234/children',
      'http://127.0.0.1:23119/api/groups/4321/items/ATT01/fulltext',
      'http://127.0.0.1:23119/api/groups/4321/fulltext?since=7',
      'http://127.0.0.1:23119/api/groups/4321/collections',
    ]);
  });
});

describe('LocalApiClient.listLocalGroupIds', () => {
  it('parses the flat group shape', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('/api/users/0/groups');
      expect(url).toContain('limit=100');
      return new Response(JSON.stringify([{ id: 4321 }, { id: 8765 }]), {
        status: 200,
        headers: { 'Total-Results': '2' },
      });
    });
    const ids = await makeLocal(fetchImpl).listLocalGroupIds();
    expect(ids).toEqual([4321, 8765]);
    expect(ids.every((n) => typeof n === 'number')).toBe(true);
  });

  it('parses the data-wrapped group shape, whose ids would otherwise all be NaN', async () => {
    // Zotero group JSON is commonly `{ data: { id } }`; reading only `g.id` there yields
    // NaN for every group, so nothing is ever recognised as locally held.
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify([{ data: { id: 4321, name: 'Lab' } }, { data: { id: 8765 } }]), {
          status: 200,
          headers: { 'Total-Results': '2' },
        }),
    );
    expect(await makeLocal(fetchImpl).listLocalGroupIds()).toEqual([4321, 8765]);
  });

  it('coerces ids to numbers and drops entries that carry none', async () => {
    // The router compares against LibraryRef.id, a number, so '4321' must not stay a string.
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify([{ id: '4321' }, { data: { id: '8765' } }, { name: 'no id' }]), {
          status: 200,
          headers: { 'Total-Results': '3' },
        }),
    );
    const ids = await makeLocal(fetchImpl).listLocalGroupIds();
    expect(ids).toEqual([4321, 8765]);
    expect(ids.every((n) => typeof n === 'number')).toBe(true);
  });

  it('returns [] when the app is unreachable, so group reads stay on the cloud', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await makeLocal(fetchImpl).listLocalGroupIds()).toEqual([]);
  });

  it('returns [] when the endpoint is absent (pre-Zotero-10)', async () => {
    const fetchImpl = vi.fn(async () => new Response('No endpoint found', { status: 404 }));
    expect(await makeLocal(fetchImpl).listLocalGroupIds()).toEqual([]);
  });

  it('pages past the first 100 groups instead of truncating', async () => {
    const all = Array.from({ length: 150 }, (_, i) => ({ data: { id: 1000 + i } }));
    const starts: number[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      const start = Number(new URL(url).searchParams.get('start'));
      starts.push(start);
      return new Response(JSON.stringify(all.slice(start, start + 100)), {
        status: 200,
        headers: { 'Total-Results': '150' },
      });
    });
    const ids = await makeLocal(fetchImpl).listLocalGroupIds();
    expect(starts).toEqual([0, 100]);
    expect(ids).toHaveLength(150);
    expect(ids[149]).toBe(1149);
  });

  it('keeps the metadata the desktop serves for each group, and only that', async () => {
    // The shape below is what Zotero 10.0.1 really answers with: read off
    // Zotero.Group.prototype.toResponseJSON({ includeGroupDetails: true }) in the
    // installed omni.ja, whose meta carries numItems and nothing else, and whose data
    // carries no `type` and no `libraryEditing` (the desktop does not store them).
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              id: 4321,
              version: 12,
              links: { self: { href: 'http://localhost:23119/api/groups/4321' } },
              meta: { numItems: 512 },
              data: { id: 4321, version: 12, name: 'Lab', description: 'Reading group' },
            },
          ]),
          { status: 200, headers: { 'Total-Results': '1' } },
        ),
    );
    const [g] = await makeLocal(fetchImpl).listLocalGroups();
    expect(g).toEqual({ id: 4321, name: 'Lab', description: 'Reading group', numItems: 512, version: 12 });
  });

  it('drops fields the response does not carry rather than inventing them', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify([{ id: 4321, data: { id: 4321, name: 'Lab' } }]), {
          status: 200,
          headers: { 'Total-Results': '1' },
        }),
    );
    const [g] = await makeLocal(fetchImpl).listLocalGroups();
    expect(g).toEqual({ id: 4321, name: 'Lab' });
    expect('numItems' in g).toBe(false);
  });

  it('returns [] when the app is unreachable, so nothing is reported as locally held', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await makeLocal(fetchImpl).listLocalGroups()).toEqual([]);
  });

  it('reads the item key census from the desktop app, per library', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain('http://127.0.0.1:23119/api/groups/999/items/top');
      expect(url).toContain('format=versions');
      expect(url).toContain('since=13');
      return new Response(JSON.stringify({ AAAA: 13 }), {
        status: 200,
        headers: { 'Total-Results': '1', 'Last-Modified-Version': '14' },
      });
    });
    const r = await makeLocal(fetchImpl).itemVersions({ top: true, since: 13 }, { type: 'group', id: 999 });
    expect(r.versions).toEqual({ AAAA: 13 });
    // The desktop keeps its own sequence, far behind the cloud's; nothing here compares them.
    expect(r.lastModifiedVersion).toBe(14);
  });

  it('keeps the pages it already read when a later one fails', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('start=100')) throw new Error('ECONNRESET');
      return new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i }))), {
        status: 200,
        headers: { 'Total-Results': '150' },
      });
    });
    expect(await makeLocal(fetchImpl).listLocalGroupIds()).toHaveLength(100);
  });
});

describe('LocalApiClient bibliography and export reads', () => {
  it('renders a desktop bibliography with style, locale and linkwrap (#64)', async () => {
    // Probed against Zotero 10.0.1: format=bib honours all three, exactly as the cloud does.
    const fetchImpl = vi.fn(async (url: string) => {
      const u = new URL(url);
      expect(u.origin + u.pathname).toBe('http://127.0.0.1:23119/api/users/0/items');
      expect(u.searchParams.get('itemKey')).toBe('AAAA,BBBB');
      expect(u.searchParams.get('format')).toBe('bib');
      expect(u.searchParams.get('style')).toBe('apa');
      expect(u.searchParams.get('locale')).toBe('fr-FR');
      expect(u.searchParams.get('linkwrap')).toBe('1');
      return new Response('<div class="csl-bib-body"/>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      });
    });
    const text = await makeLocal(fetchImpl).getBibliography(['AAAA', 'BBBB'], {
      style: 'apa',
      locale: 'fr-FR',
      linkwrap: true,
    });
    expect(text).toBe('<div class="csl-bib-body"/>');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('exports named items from /items/top, since the desktop adds their children on /items', async () => {
    // Probed on Zotero 10.0.1: /items?itemKey=PARENT answers with the parent AND its
    // attachment, and csljson then carries a `document` entry for the PDF; /items/top with
    // the same key answers with the parent alone, which is what the cloud means by itemKey.
    const fetchImpl = vi.fn(async (url: string) => {
      const u = new URL(url);
      expect(u.pathname).toBe('/api/groups/999/items/top');
      expect(u.searchParams.get('format')).toBe('csljson');
      expect(u.searchParams.get('itemKey')).toBe('AAAA');
      expect(u.searchParams.get('limit')).toBe('100');
      return new Response('[{"id":"a"}]', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    });
    const text = await makeLocal(fetchImpl).exportItems(
      { format: 'csljson', itemKey: ['AAAA'], limit: 100 },
      { type: 'group', id: 999 },
    );
    expect(text).toBe('[{"id":"a"}]');
  });

  it('exports a collection or a search from /items, children included, as the cloud does', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(new URL(url).pathname);
      return new Response('@misc{a}', { status: 200 });
    });
    const local = makeLocal(fetchImpl);
    await local.exportItems({ format: 'bibtex', collectionKey: 'ABC' });
    await local.exportItems({ format: 'bibtex', q: 'robots' });
    expect(seen).toEqual(['/api/users/0/collections/ABC/items', '/api/users/0/items']);
  });

  // The desktop app answers /collections/<unknown>/items with the WHOLE library, so the
  // collection itself is the only place it admits a key is unknown.
  it('reports a collection as existing on 200 and as absent on 404', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      seen.push(path);
      return path.endsWith('/ZZZZZZZZ')
        ? new Response('Not found', { status: 404 })
        : new Response(JSON.stringify({ key: 'DDMMTKDW' }), { status: 200 });
    });
    const local = makeLocal(fetchImpl);
    expect(await local.collectionExists('DDMMTKDW')).toBe(true);
    expect(await local.collectionExists('ZZZZZZZZ')).toBe(false);
    expect(seen).toEqual([
      '/api/users/0/collections/DDMMTKDW',
      '/api/users/0/collections/ZZZZZZZZ',
    ]);
  });

  it('asks the group prefix for a group collection, and rethrows anything but a 404', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(new URL(url).pathname);
      return new Response('boom', { status: 500 });
    });
    const local = makeLocal(fetchImpl);
    await expect(local.collectionExists('ABCD1234', { type: 'group', id: 42 })).rejects.toMatchObject({
      name: 'LocalApiError',
      status: 500,
    });
    expect(seen).toEqual(['/api/groups/42/collections/ABCD1234']);
  });

  it('carries the body of a failed render, which is where Zotero names the bad style', async () => {
    const fetchImpl = vi.fn(async () => new Response('Invalid style: nope', { status: 400 }));
    const render = makeLocal(fetchImpl).getBibliography(['AAAA'], { style: 'nope' });
    await expect(render).rejects.toMatchObject({
      name: 'LocalApiError',
      status: 400,
      message: expect.stringContaining('Invalid style: nope'),
    });
  });
});

describe('LocalApiClient tag and sync-delta reads', () => {
  it('pages tags straight through when there is nothing to filter', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const u = new URL(url);
      expect(u.origin + u.pathname).toBe('http://127.0.0.1:23119/api/groups/999/tags');
      expect(u.searchParams.get('limit')).toBe('10');
      expect(u.searchParams.get('start')).toBe('20');
      expect(u.searchParams.has('q')).toBe(false);
      return new Response(JSON.stringify([{ tag: 'ml', meta: { type: 1, numItems: 4 } }]), {
        status: 200,
        headers: { 'Total-Results': '211', 'Last-Modified-Version': '666' },
      });
    });
    const r = await makeLocal(fetchImpl).listTags({ limit: 10, start: 20 }, { type: 'group', id: 999 });
    expect(r.data[0]).toEqual({ tag: 'ml', meta: { type: 1, numItems: 4 } });
    expect(r.totalResults).toBe(211);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // Measured against Zotero 10.0.1: /tags?q=zzzznotag answers with every tag in the library
  // and a Total-Results counting all of them, so a `q` passed through would read as a
  // filter that matched everything.
  it('applies q itself, over the whole list, because the desktop app ignores it', async () => {
    const page = (tags: string[], total: number) =>
      new Response(JSON.stringify(tags.map((tag) => ({ tag, meta: { numItems: 1 } }))), {
        status: 200,
        headers: { 'Total-Results': String(total), 'Last-Modified-Version': '666' },
      });
    const fetchImpl = vi.fn(async (url: string) => {
      const start = Number(new URL(url).searchParams.get('start'));
      return start === 0 ? page(['Accuracy', 'MPCC'], 3) : page(['nonlinear MPC'], 3);
    });
    const r = await makeLocal(fetchImpl).listTags({ q: 'mpc' });
    expect(r.data.map((t: any) => t.tag)).toEqual(['MPCC', 'nonlinear MPC']);
    // The total counts the MATCHES, as it does on the cloud, not the library's tags.
    expect(r.totalResults).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reads a version census for a type the desktop app really serves', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const u = new URL(url);
      expect(u.origin + u.pathname).toBe('http://127.0.0.1:23119/api/users/0/collections');
      expect(u.searchParams.get('format')).toBe('versions');
      expect(u.searchParams.get('since')).toBe('510');
      return new Response(JSON.stringify({ SBHCJT8T: 512, RANF9BFV: 511 }), {
        status: 200,
        headers: { 'Total-Results': '2', 'Last-Modified-Version': '666' },
      });
    });
    expect(await makeLocal(fetchImpl).objectVersions('collections', 510)).toEqual({
      SBHCJT8T: 512,
      RANF9BFV: 511,
    });
  });

  // Zotero 10.0.1 answers /users/0/tags?format=versions with {} while the same response
  // counts 211 tags. Passing that on as "no tag changed" is the failure this project fears
  // most: a success that did nothing.
  it('refuses to pass off a short version map as an answer', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{}', {
          status: 200,
          headers: { 'Total-Results': '211', 'Last-Modified-Version': '666' },
        }),
    );
    await expect(makeLocal(fetchImpl).objectVersions('tags', 0)).rejects.toMatchObject({
      name: 'LocalApiUnsupportedError',
      what: 'tags',
      message: expect.stringContaining('0 of the 211 tags'),
    });
  });

  it('accepts an empty version map the response itself calls empty', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{}', { status: 200, headers: { 'Total-Results': '0' } }),
    );
    expect(await makeLocal(fetchImpl).objectVersions('searches', 0)).toEqual({});
  });

  // The desktop app answers /deleted with 404 "No endpoint found", for users/0 and for a
  // group it holds. It is asked anyway, so a later Zotero that serves it just works.
  it('names the deletion log as unavailable instead of reporting no deletions', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(new URL(url).pathname).toBe('/api/users/0/deleted');
      return new Response('No endpoint found', { status: 404 });
    });
    await expect(makeLocal(fetchImpl).deleted(0)).rejects.toMatchObject({
      name: 'LocalApiUnsupportedError',
      what: 'the deletion log',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns a deletion log if the app ever serves one', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ items: ['GONE1'], tags: [] }), { status: 200 }),
    );
    expect(await makeLocal(fetchImpl).deleted(12)).toEqual({ items: ['GONE1'], tags: [] });
  });

  it('objectVersion answers with the app own version, and null for what it does not hold', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/api/groups/6666644/items/SXD9FX9K') {
        return new Response(JSON.stringify({ key: 'SXD9FX9K', version: 7, data: { version: 7 } }), { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    });
    const local = makeLocal(fetchImpl);
    const group = { type: 'group' as const, id: 6666644 };
    expect(await local.objectVersion('items', 'SXD9FX9K', group)).toBe(7);
    expect(await local.objectVersion('items', 'ZZZZZZZZ', group)).toBeNull();
  });

  it('objectVersion asks by key so a trashed object still counts as present', async () => {
    // The local API leaves trashed items out of an ?itemKey= listing even with
    // includeTrashed, while GET /items/<key> answers 200 with deleted:true. Anyone asking
    // whether the app has caught up with a write has to see the trash as present, or a
    // trashed item would hold every read of the library on the cloud forever.
    const fetchImpl = vi.fn(async (url: string) => {
      expect(new URL(url).pathname).toBe('/api/users/0/items/WMAESDCV');
      return new Response(JSON.stringify({ key: 'WMAESDCV', version: 687, data: { deleted: true } }), {
        status: 200,
      });
    });
    expect(await makeLocal(fetchImpl).objectVersion('items', 'WMAESDCV')).toBe(687);
  });

  it('objectVersion lets a real failure through rather than reporting absence', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    await expect(makeLocal(fetchImpl).objectVersion('collections', 'COLL1234')).rejects.toMatchObject({
      name: 'LocalApiError',
      status: 500,
    });
  });

  // #79: `top` on an itemType-filtered search is resolved from key sets rather than by
  // trusting `/items/top`, so the keys read is the request that has to be exactly right.
  describe('listItemKeys', () => {
    it('reads /items with format=keys and splits the plain-text body', async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        expect(url).toContain('/users/0/items?');
        expect(url).not.toContain('/items/top');
        expect(url).toContain('format=keys');
        expect(url).toContain('itemType=attachment');
        return new Response('AAAAAAAA\nBBBBBBBB\nCCCCCCCC', {
          status: 200,
          headers: { 'Total-Results': '3', 'Last-Modified-Version': '681' },
        });
      });
      const res = await makeLocal(fetchImpl).listItemKeys({ itemType: 'attachment' });
      expect(res.keys).toEqual(['AAAAAAAA', 'BBBBBBBB', 'CCCCCCCC']);
      expect(res.totalResults).toBe(3);
      expect(res.lastModifiedVersion).toBe(681);
    });

    it('reads /items/top for the top-level key set', async () => {
      const fetchImpl = vi.fn(async (url: string) => {
        expect(url).toContain('/users/0/items/top?');
        expect(url).toContain('format=keys');
        return new Response('AAAAAAAA\n', { status: 200, headers: { 'Total-Results': '1' } });
      });
      const res = await makeLocal(fetchImpl).listItemKeys({ top: true });
      expect(res.keys).toEqual(['AAAAAAAA']);
    });

    it('reads an empty key set as no keys rather than one blank one', async () => {
      const fetchImpl = vi.fn(async () => new Response('', { status: 200, headers: { 'Total-Results': '0' } }));
      expect((await makeLocal(fetchImpl).listItemKeys({ itemType: 'book' })).keys).toEqual([]);
    });
  });
});
