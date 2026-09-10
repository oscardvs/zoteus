import { describe, it, expect, vi } from 'vitest';
import listTags from '../../src/tools/list-tags.js';
import tagAudit from '../../src/tools/tag-audit.js';
import sync from '../../src/tools/sync.js';
import savedSearches from '../../src/tools/saved-searches.js';
import { LibraryRouter } from '../../src/router/library-router.js';
import { WebApiClient } from '../../src/api/web-client.js';
import { LocalApiClient } from '../../src/api/local-client.js';
import { RateLimitedFetcher } from '../../src/api/http.js';
import { loadConfig } from '../../src/config.js';

/**
 * The three tools that read tags and the sync delta used to call the Web API client
 * directly. On the majority setup (Zotero desktop app running, no cloud API key) that is a
 * request to api.zotero.org for users/0, which the cloud answers 400 "Invalid user ID", so
 * zotero_list_tags, zotero_tag_audit and zotero_sync were all unreachable while the desktop
 * app next door was serving the same data. Same cause as #64, #26 and #67.
 *
 * These drive the real handlers over the real router and the real clients, with both
 * transports' fetchers replaced by stubs that record every URL, so what is under test is
 * which API is asked and what happens where the desktop app has no answer.
 */

const cloudInfo = { userID: 19552201, username: 'oscardvs', access: {} };
const GROUP = 6666644;

/** Two tags, in the shape Zotero 10.0.1 serves them locally. */
const TAGS = [
  { tag: 'MPCC', meta: { type: 0, numItems: 1 } },
  { tag: 'Accuracy', meta: { type: 1, numItems: 1 } },
];
/** One saved-search definition, in the shape Zotero 10.0.1 serves it locally. */
const SEARCHES = [
  {
    key: 'S1',
    version: 42,
    data: {
      key: 'S1',
      version: 42,
      name: 'Unread 2024',
      conditions: [{ condition: 'tag', operator: 'is', value: 'to-read' }],
    },
  },
];
const ITEMS = [
  { key: 'I1', data: { key: 'I1', itemType: 'journalArticle', title: 'A', tags: [{ tag: 'MPCC' }] } },
  { key: 'I2', data: { key: 'I2', itemType: 'journalArticle', title: 'B', tags: [] } },
];

function json(body: unknown, total: number, version = 666): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Total-Results': String(total), 'Last-Modified-Version': String(version) },
  });
}

/**
 * The desktop app as measured against Zotero 10.0.1: it serves tags, items and collections,
 * answers /tags?format=versions with an empty map while counting every tag in the same
 * response, and has no /deleted endpoint at all.
 */
function localAnswer(url: string): Response {
  const u = new URL(url);
  const path = u.pathname.replace(/^\/api\/(users\/0|groups\/\d+)/, '');
  const versions = u.searchParams.get('format') === 'versions';
  if (path === '/deleted') return new Response('No endpoint found', { status: 404 });
  if (path === '/tags') return versions ? json({}, TAGS.length) : json(TAGS, TAGS.length);
  if (path === '/items') return versions ? json({ I1: 623, I2: 624 }, 2) : json(ITEMS, ITEMS.length);
  if (path === '/items/top') return json(ITEMS, ITEMS.length);
  if (path === '/collections') return versions ? json({ C1: 508 }, 1) : json([], 0);
  if (path === '/searches') return versions ? json({}, 0) : json(SEARCHES, SEARCHES.length);
  return new Response('No endpoint found', { status: 404 });
}

function harness(opts: { key?: string; localApi?: boolean; localGroupIds?: number[] } = {}) {
  const webUrls: string[] = [];
  const localUrls: string[] = [];
  const webFetch = vi.fn(async (url: string) => {
    webUrls.push(url);
    // What api.zotero.org really says to users/0; any other library answers normally.
    if (url.includes('/users/0/')) return new Response('Invalid user ID', { status: 400 });
    const u = new URL(url);
    if (u.pathname.endsWith('/deleted')) return json({ items: ['CLOUDGONE'] }, 1);
    if (u.searchParams.get('format') === 'versions') return json({ CLOUD1: 2114 }, 1);
    if (u.pathname.endsWith('/tags')) return json(TAGS, TAGS.length);
    return json(ITEMS, ITEMS.length);
  });
  const localFetch = vi.fn(async (url: string) => {
    localUrls.push(url);
    return localAnswer(url);
  });
  const web = new WebApiClient({
    apiKey: opts.key,
    fetcher: new RateLimitedFetcher({ fetchImpl: webFetch, maxConcurrency: 4 }),
  });
  const local = new LocalApiClient({
    fetcher: new RateLimitedFetcher({ fetchImpl: localFetch, maxConcurrency: 4 }),
  });
  const config = loadConfig({ ZOTEUS_LOCAL: 'on', ZOTERO_API_KEY: opts.key } as any);
  const capabilities = {
    cloud: opts.key ? cloudInfo : null,
    localApi: opts.localApi ?? true,
    localGroupIds: opts.localGroupIds ?? [],
  };
  const router = new LibraryRouter({ config, capabilities, web, local });
  const ctx = { config, capabilities, router, web, local, remoteCaller: false } as any;
  return { ctx, webUrls, localUrls };
}

const textOf = (res: any) => (res.content ?? []).map((c: { text: string }) => c.text).join('\n');

describe('tag and sync reads follow the library route', () => {
  it('lists tags from the desktop app with no cloud key, and never asks the cloud', async () => {
    const { ctx, webUrls, localUrls } = harness();
    const res = await listTags.handler({ limit: 10 }, ctx);
    expect(res.isError).toBeUndefined();
    expect((res.structuredContent?.tags as any[])[0]).toEqual({
      name: 'MPCC',
      numItems: 1,
      auto: false,
    });
    expect(webUrls).toEqual([]);
    expect(new URL(localUrls[0]).pathname).toBe('/api/users/0/tags');
  });

  it('audits a keyless library end to end, tags included', async () => {
    const { ctx, webUrls } = harness();
    const res = await tagAudit.handler({ vocabulary: { tags: [{ name: 'ml' }] } }, ctx);
    expect(res.isError).toBeUndefined();
    // Both library tags came back: MPCC is off the vocabulary, Accuracy is Zotero's own.
    expect(res.structuredContent?.offTaxonomy).toEqual([{ name: 'MPCC', numItems: 1 }]);
    expect(res.structuredContent?.autoTags).toEqual([{ name: 'Accuracy', numItems: 1 }]);
    expect(res.structuredContent?.itemsScanned).toBe(2);
    expect(webUrls).toEqual([]);
  });

  it('lists saved searches from the desktop app with no cloud key, and never asks the cloud', async () => {
    // The last read still calling ctx.web directly. On the majority setup (desktop app
    // running, no cloud key) that is api.zotero.org for users/0, which answers 400
    // "Invalid user ID", and the tool then dressed it up as advice about field names and
    // itemType, on a call that has no fields. Zotero 7+ serves /searches locally, so the
    // answer was next door the whole time.
    const { ctx, webUrls, localUrls } = harness();
    const res = await savedSearches.handler({ action: 'list' }, ctx);
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent?.searches).toEqual([
      { key: 'S1', name: 'Unread 2024', conditions: [{ condition: 'tag', operator: 'is', value: 'to-read' }] },
    ]);
    expect(webUrls).toEqual([]);
    expect(localUrls.some((u) => new URL(u).pathname === '/api/users/0/searches')).toBe(true);
    expect(textOf(res)).not.toMatch(/Invalid user ID|zotero_schema/);
  });

  it('serves the sync delta from the desktop app and names what it cannot answer', async () => {
    const { ctx, webUrls } = harness();
    const res = await sync.handler({ since: 0 }, ctx);
    expect(res.isError).toBeUndefined();
    expect(webUrls).toEqual([]);
    const s = res.structuredContent as any;
    expect(s.backend).toBe('local');
    expect(s.changed.items).toEqual({ count: 2, keys: ['I1', 'I2'] });
    // The two the desktop app has no answer for are named, not reported as empty: an
    // absent map and an empty one are the same JSON, and "0 tags changed" for a library
    // full of tags is a success that did nothing.
    expect(s.changed.tags).toBeUndefined();
    expect(s.deleted).toBeUndefined();
    expect(s.unavailable.map((u: any) => u.what)).toEqual(['tags', 'the deletion log']);
    expect(textOf(res)).toContain('ZOTERO_API_KEY');
    expect(textOf(res)).toMatch(/0 of the 2 tags/);
  });

  it('errors when every part of the delta asked for is one the desktop app lacks', async () => {
    const { ctx } = harness();
    const res = await sync.handler({ types: ['tags'], include_deleted: false }, ctx);
    expect(res.isError).toBe(true);
    // Never the schema advice the cloud's 400 used to produce, which was about neither the
    // caller's fields nor anything they could act on.
    expect(textOf(res)).not.toMatch(/Invalid user ID|zotero_schema/);
    expect(textOf(res)).toContain('tags');
    expect(textOf(res)).toContain('ZOTERO_API_KEY');
  });

  it('tells a keyed user where the missing pieces are, without splicing the two sequences', async () => {
    // Both APIs are usable here, and the delta still comes wholly from one: their version
    // sequences are independent, so a cloud deletion log under a local `since` is nonsense.
    const { ctx, webUrls } = harness({ key: 'k', localGroupIds: [] });
    const res = await sync.handler({ since: 0 }, ctx);
    expect((res.structuredContent as any).backend).toBe('local');
    expect(webUrls).toEqual([]);
    expect(textOf(res)).toContain('ZOTEUS_LOCAL=off');
  });

  it('reads a group the desktop holds from the desktop', async () => {
    const { ctx, webUrls, localUrls } = harness({ key: 'k', localGroupIds: [GROUP] });
    const res = await listTags.handler({ library_type: 'group', library_id: GROUP }, ctx);
    expect(res.isError).toBeUndefined();
    expect(new URL(localUrls[0]).pathname).toBe(`/api/groups/${GROUP}/tags`);
    expect(webUrls).toEqual([]);
  });

  it('reads a group the desktop does not hold from the cloud', async () => {
    const { ctx, webUrls, localUrls } = harness({ key: 'k', localGroupIds: [] });
    const res = await sync.handler({ since: 0, library_type: 'group', library_id: GROUP }, ctx);
    expect(res.isError).toBeUndefined();
    const s = res.structuredContent as any;
    expect(s.backend).toBe('cloud');
    expect(s.changed.tags.keys).toEqual(['CLOUD1']);
    expect(s.deleted).toEqual({ items: ['CLOUDGONE'] });
    expect(s.unavailable).toBeUndefined();
    expect(localUrls).toEqual([]);
    expect(webUrls.every((u) => u.startsWith(`https://api.zotero.org/groups/${GROUP}/`))).toBe(true);
  });

  it('falls back to the cloud when the desktop app is closed', async () => {
    const { ctx, webUrls, localUrls } = harness({ key: 'k', localApi: false });
    const res = await listTags.handler({}, ctx);
    expect(res.isError).toBeUndefined();
    expect(localUrls).toEqual([]);
    expect(new URL(webUrls[0]).pathname).toBe(`/users/${cloudInfo.userID}/tags`);
  });
});
