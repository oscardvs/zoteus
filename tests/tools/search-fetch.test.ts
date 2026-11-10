import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAllTools } from '../../src/registry/registry.js';
import { searchFetchTools, tools } from '../../src/tools/index.js';
import { loadConfig, withTransportDefaults } from '../../src/config.js';
import { selectActiveTools } from '../../src/server.js';
import {
  documentId,
  itemUrl,
  parseDocumentId,
} from '../../src/features/connector/search-fetch.js';

const ftMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/tools/get-fulltext.js', () => ({ default: { name: 'zotero_get_fulltext', handler: ftMock } }));
const fulltext = { handler: ftMock };

const semMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/tools/semantic-search.js', () => ({ default: { name: 'zotero_semantic_search', handler: semMock } }));
const semantic = { handler: semMock };

const search = searchFetchTools.find((t) => t.name === 'search')!;
const fetchTool = searchFetchTools.find((t) => t.name === 'fetch')!;

const USER = { type: 'user' as const, id: 19552201 };

function fakeCtx(opts: { indexEmpty?: boolean; lib?: { type: 'user' | 'group'; id: number }; item?: any } = {}) {
  const lib = opts.lib ?? USER;
  return {
    config: { local: 'off', libraryType: lib.type } as any,
    capabilities: { cloud: { userID: 19552201, username: 'someone' }, localApi: false, localGroupIds: [] },
    router: {
      defaultLibrary: () => lib,
      searchItems: vi.fn(async () => ({
        data: [
          { key: 'ABCD2345', data: { itemType: 'journalArticle', title: 'Deep Learning' } },
          { key: 'WXYZ6789', data: { itemType: 'book', title: '' } },
        ],
        totalResults: 2,
        lastModifiedVersion: 9,
      })),
      getItem: vi.fn(async () =>
        opts.item ?? {
          key: 'ABCD2345',
          links: { alternate: { href: 'https://www.zotero.org/users/19552201/items/ABCD2345' } },
          data: {
            itemType: 'journalArticle',
            title: 'Deep Learning',
            creators: [{ creatorType: 'author', firstName: 'Geoffrey', lastName: 'Hinton' }],
            date: '2015',
            publicationTitle: 'Nature',
            DOI: '10.1038/nature14539',
            abstractNote: 'An abstract.',
          },
        },
      ),
    },
    search: { isEmpty: opts.indexEmpty ?? true, syncFromStore: () => {} },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  } as any;
}

beforeEach(() => {
  fulltext.handler.mockReset();
  semantic.handler.mockReset();
});

describe('document ids and URLs', () => {
  it('uses the bare key in the personal library and group:<id>:<KEY> in a group', () => {
    expect(documentId(USER, 'ABCD2345')).toBe('ABCD2345');
    expect(documentId({ type: 'group', id: 42 }, 'ABCD2345')).toBe('group:42:ABCD2345');
    expect(parseDocumentId('ABCD2345')).toEqual({ key: 'ABCD2345' });
    expect(parseDocumentId('group:42:ABCD2345')).toEqual({ key: 'ABCD2345', library: { type: 'group', id: 42 } });
    expect(parseDocumentId('https://example.com')).toBeUndefined();
    expect(parseDocumentId('group:x:ABCD2345')).toBeUndefined();
  });

  it('points at the zotero.org web library, the form Zotero puts in links.alternate', () => {
    expect(itemUrl(USER, 'ABCD2345')).toBe('https://www.zotero.org/users/19552201/items/ABCD2345');
    expect(itemUrl({ type: 'user', id: 0 }, 'ABCD2345', 7)).toBe('https://www.zotero.org/users/7/items/ABCD2345');
    expect(itemUrl({ type: 'group', id: 42 }, 'ABCD2345')).toBe('https://www.zotero.org/groups/42/items/ABCD2345');
    // No user id anywhere (desktop only, no key): still a non-empty, openable URL.
    expect(itemUrl({ type: 'user', id: 0 }, 'ABCD2345')).toBe('zotero://select/library/items/ABCD2345');
  });
});

describe('search', () => {
  it('falls back to keyword search when the index is empty, without touching the index', async () => {
    const ctx = fakeCtx();
    const res = await search.handler({ query: 'deep learning' }, ctx);
    expect(semantic.handler).not.toHaveBeenCalled();
    expect(ctx.router.searchItems).toHaveBeenCalledWith(expect.objectContaining({ q: 'deep learning', top: true }));
    expect(res.structuredContent).toEqual({
      results: [
        { id: 'ABCD2345', title: 'Deep Learning', url: 'https://www.zotero.org/users/19552201/items/ABCD2345' },
        { id: 'WXYZ6789', title: '(untitled)', url: 'https://www.zotero.org/users/19552201/items/WXYZ6789' },
      ],
    });
    // One text item carrying the same object as JSON, as OpenAI's page specifies.
    expect(res.content).toHaveLength(1);
    expect(JSON.parse((res.content[0] as any).text)).toEqual(res.structuredContent);
  });

  it('ranks with the hybrid index when it has rows, one result per item', async () => {
    semantic.handler.mockResolvedValue({
      content: [],
      structuredContent: {
        hits: [
          { itemKey: 'ABCD2345', title: 'Deep Learning', snippet: 'a', score: 2 },
          { itemKey: 'ABCD2345', title: 'Deep Learning', snippet: 'b', score: 1 },
        ],
      },
    });
    const ctx = fakeCtx({ indexEmpty: false, lib: { type: 'group', id: 42 } });
    const res = await search.handler({ query: 'neural nets' }, ctx);
    expect(ctx.router.searchItems).not.toHaveBeenCalled();
    expect(res.structuredContent).toEqual({
      results: [{ id: 'group:42:ABCD2345', title: 'Deep Learning', url: 'https://www.zotero.org/groups/42/items/ABCD2345' }],
    });
  });

  it('falls back to keyword search when the index answers nothing', async () => {
    semantic.handler.mockResolvedValue({ content: [], structuredContent: { hits: [] }, isError: true });
    const ctx = fakeCtx({ indexEmpty: false });
    const res = await search.handler({ query: 'x' }, ctx);
    expect(ctx.router.searchItems).toHaveBeenCalled();
    expect((res.structuredContent!.results as unknown[]).length).toBe(2);
  });

  it('learns the user id from a desktop record when there is no cloud key', async () => {
    // Measured against Zotero 10's local API: every record carries library.id and a
    // links.alternate of https://www.zotero.org/users/<id>/items/<KEY>.
    const ctx = fakeCtx({
      lib: { type: 'user', id: 0 },
      item: { key: 'ABCD2345', library: { type: 'user', id: 555 }, data: { itemType: 'book', title: 'T' } },
    });
    ctx.capabilities.cloud = null;
    const res = await search.handler({ query: 'x' }, ctx);
    const urls = (res.structuredContent!.results as Array<{ url: string }>).map((r) => r.url);
    expect(urls).toEqual([
      'https://www.zotero.org/users/555/items/ABCD2345',
      'https://www.zotero.org/users/555/items/WXYZ6789',
    ]);
    expect(ctx.router.getItem).toHaveBeenCalledTimes(1);
  });
});

describe('fetch', () => {
  it('returns metadata followed by the full text, with the web library URL', async () => {
    fulltext.handler.mockResolvedValue({
      content: [],
      structuredContent: { mode: 'document', text: 'Body of the paper.', fulltextSource: 'zotero' },
    });
    const ctx = fakeCtx();
    const res = await fetchTool.handler({ id: 'ABCD2345' }, ctx);
    expect(fulltext.handler).toHaveBeenCalledWith(expect.objectContaining({ item_key: 'ABCD2345', max_chars: 100000 }), ctx);
    const sc = res.structuredContent as any;
    expect(sc.id).toBe('ABCD2345');
    expect(sc.title).toBe('Deep Learning');
    expect(sc.url).toBe('https://www.zotero.org/users/19552201/items/ABCD2345');
    expect(sc.text).toContain('Creators: Geoffrey Hinton');
    expect(sc.text).toContain('Abstract: An abstract.');
    expect(sc.text.endsWith('Body of the paper.')).toBe(true);
    expect(sc.metadata).toMatchObject({ itemType: 'journalArticle', DOI: '10.1038/nature14539', fulltext: 'zotero' });
    expect(res.content).toHaveLength(1);
    expect(JSON.parse((res.content[0] as any).text)).toEqual(sc);
  });

  it('still answers with the metadata when there is no full text', async () => {
    fulltext.handler.mockResolvedValue({ content: [{ type: 'text', text: 'no attachment' }], isError: true });
    const res = await fetchTool.handler({ id: 'ABCD2345' }, fakeCtx());
    const sc = res.structuredContent as any;
    expect(res.isError).toBeFalsy();
    expect(sc.text).toContain('Title: Deep Learning');
    expect(sc.metadata.fulltext).toBe('none');
  });

  it('reads a group item from its group and builds its URL', async () => {
    fulltext.handler.mockResolvedValue({ content: [], isError: true });
    const ctx = fakeCtx({ item: { key: 'ABCD2345', data: { itemType: 'book', title: 'G' } } });
    const res = await fetchTool.handler({ id: 'group:42:ABCD2345' }, ctx);
    expect(ctx.router.getItem).toHaveBeenCalledWith('ABCD2345', { library: { type: 'group', id: 42 } });
    expect(fulltext.handler).toHaveBeenCalledWith(
      expect.objectContaining({ library_type: 'group', library_id: 42 }),
      ctx,
    );
    expect((res.structuredContent as any).url).toBe('https://www.zotero.org/groups/42/items/ABCD2345');
    expect((res.structuredContent as any).id).toBe('group:42:ABCD2345');
  });

  it('refuses an id that is not one search hands out', async () => {
    const res = await fetchTool.handler({ id: 'not a key' }, fakeCtx());
    expect(res.isError).toBe(true);
  });
});

describe('registration', () => {
  it('is off for stdio and on for HTTP unless ZOTEUS_SEARCH_FETCH_TOOLS says otherwise', () => {
    const unset = loadConfig({ ZOTERO_API_KEY: 'k' } as any);
    expect(unset.searchFetchTools).toBeUndefined();
    expect(withTransportDefaults(unset, 'stdio').searchFetchTools).toBe(false);
    expect(withTransportDefaults(unset, 'http').searchFetchTools).toBe(true);
    const off = loadConfig({ ZOTERO_API_KEY: 'k', ZOTEUS_SEARCH_FETCH_TOOLS: 'false' } as any);
    expect(withTransportDefaults(off, 'http').searchFetchTools).toBe(false);
    const on = loadConfig({ ZOTERO_API_KEY: 'k', ZOTEUS_SEARCH_FETCH_TOOLS: 'true' } as any);
    expect(withTransportDefaults(on, 'stdio').searchFetchTools).toBe(true);
  });

  it('adds the pair only when the switch is on, read-only mode included, and never to `tools`', () => {
    const base = loadConfig({ ZOTERO_API_KEY: 'k' } as any);
    const names = (c: any) => selectActiveTools(c).map((t) => t.name);
    expect(names({ ...base, searchFetchTools: false })).not.toContain('search');
    expect(names({ ...base, searchFetchTools: true })).toEqual(expect.arrayContaining(['search', 'fetch']));
    expect(names({ ...base, readOnly: true, searchFetchTools: true })).toEqual(
      expect.arrayContaining(['search', 'fetch']),
    );
    expect(tools.map((t) => t.name)).not.toContain('search');
  });

  it('advertises read-only hints and schemas with no $schema key, and validates over MCP', async () => {
    const server = new McpServer({ name: 't', version: '0' }, { capabilities: { tools: {} } });
    fulltext.handler.mockResolvedValue({ content: [], structuredContent: { text: 'Body.' } });
    registerAllTools(server, searchFetchTools, fakeCtx());
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0' });
    await Promise.all([server.connect(b), client.connect(a)]);
    const { tools: listed } = await client.listTools();
    expect(listed.map((t) => t.name).sort()).toEqual(['fetch', 'search']);
    for (const t of listed) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(JSON.stringify(t.inputSchema)).not.toContain('$schema');
      expect(JSON.stringify(t.outputSchema)).not.toContain('$schema');
    }
    const s = await client.callTool({ name: 'search', arguments: { query: 'deep' } });
    expect(s.isError).toBeFalsy();
    const f = await client.callTool({ name: 'fetch', arguments: { id: 'ABCD2345' } });
    expect(f.isError).toBeFalsy();
    expect((f.structuredContent as any).text).toContain('Body.');
  });
});
