import { describe, it, expect, vi } from 'vitest';
import { LibraryRouter, splitConjunction } from '../../src/router/library-router.js';
import { LocalApiUnsupportedError } from '../../src/api/local-client.js';
import { loadConfig } from '../../src/config.js';

const cloudInfo = { userID: 19552201, username: 'oscardvs', access: {} };
/** What the router resolves an omitted library to; localLibraryPrefix maps it to /users/0. */
const defaultUserLib = { type: 'user' as const, id: cloudInfo.userID };

function makeRouter(opts: {
  local: 'auto' | 'on' | 'off';
  localApi: boolean;
  /** Groups this desktop app holds. Empty = pre-Zotero-10, or a group it does not have. */
  localGroupIds?: number[];
  /** Build capabilities WITHOUT the field, the way an older caller's literal would. */
  omitLocalGroupIds?: boolean;
}) {
  const web = {
    listItems: vi.fn(async () => ({ data: [{ key: 'CLOUD' }], totalResults: 1, lastModifiedVersion: 1 })),
    getItem: vi.fn(async () => ({ key: 'CLOUD' })),
    getItemChildren: vi.fn(async () => ({ data: [{ key: 'CLOUDCHILD' }], totalResults: 1, lastModifiedVersion: 1 })),
    getFullText: vi.fn(async () => ({ content: 'CLOUD TEXT' })),
    fullTextSince: vi.fn(async () => ({ CLOUDATT: 9 })),
    itemVersions: vi.fn(async () => ({ versions: { CLOUD: 2114 }, totalResults: 1, lastModifiedVersion: 2114 })),
    exportItems: vi.fn(async () => '{"items":[]}'),
    getBibliography: vi.fn(async () => '<div>CLOUD BIB</div>'),
    listTags: vi.fn(async () => ({ data: [{ tag: 'CLOUDTAG' }], totalResults: 1, lastModifiedVersion: 1 })),
    versions: vi.fn(async () => ({ CLOUD: 2114 })),
    deleted: vi.fn(async () => ({ items: ['CLOUDGONE'] })),
  };
  const local = {
    listItems: vi.fn(async () => ({ data: [{ key: 'LOCAL' }], totalResults: 1, lastModifiedVersion: 1 })),
    getItem: vi.fn(async () => ({ key: 'LOCAL' })),
    getItemChildren: vi.fn(async () => ({ data: [{ key: 'LOCALCHILD' }], totalResults: 1, lastModifiedVersion: 1 })),
    getFullText: vi.fn(async () => ({ content: 'LOCAL TEXT' })),
    fullTextSince: vi.fn(async () => ({ LOCALATT: 4 })),
    itemVersions: vi.fn(async () => ({ versions: { LOCAL: 13 }, totalResults: 1, lastModifiedVersion: 13 })),
    exportItems: vi.fn(async () => '[]'),
    getBibliography: vi.fn(async () => '<div>LOCAL BIB</div>'),
    listTags: vi.fn(async () => ({ data: [{ tag: 'LOCALTAG' }], totalResults: 1, lastModifiedVersion: 1 })),
    objectVersions: vi.fn(async () => ({ LOCAL: 13 })),
    deleted: vi.fn(async () => {
      throw new LocalApiUnsupportedError('the deletion log', 'no /deleted endpoint');
    }),
  };
  const cfg = loadConfig({ ZOTEUS_LOCAL: opts.local } as any);
  const capabilities: any = { cloud: cloudInfo, localApi: opts.localApi };
  if (!opts.omitLocalGroupIds) capabilities.localGroupIds = opts.localGroupIds ?? [];
  const router = new LibraryRouter({
    config: cfg,
    capabilities,
    web: web as any,
    local: local as any,
  });
  return { router, web, local };
}

/**
 * zotero_search_items documents `&&` as AND, and neither Zotero API reads it: both take
 * "World Models && method · diffusion" as one tag name and answer 0, where the repeated
 * parameters answer 7 (measured 2026-10-01), and the cloud refuses an itemType written so
 * with HTTP 400. The router spells it the way both APIs understand.
 */
describe('splitConjunction', () => {
  it('turns && into repeated values and leaves everything else alone', () => {
    expect(splitConjunction('to-read && 2024')).toEqual(['to-read', '2024']);
    expect(splitConjunction('-attachment && -note')).toEqual(['-attachment', '-note']);
    expect(splitConjunction('a || b && c')).toEqual(['a || b', 'c']);
    expect(splitConjunction('journalArticle || book')).toBe('journalArticle || book');
    expect(splitConjunction('to-read')).toBe('to-read');
    expect(splitConjunction(['a && b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(splitConjunction(undefined)).toBeUndefined();
  });

  it('reaches both backends as repeated parameters', async () => {
    for (const localApi of [true, false]) {
      const { router, web, local } = makeRouter({ local: 'auto', localApi });
      await router.searchItems({ tag: 'World Models && method · diffusion', itemType: '-attachment && -note' });
      const sent: any = localApi ? (local.listItems.mock.calls[0] as any)[0] : (web.listItems.mock.calls[0] as any)[1];
      expect(sent.tag).toEqual(['World Models', 'method · diffusion']);
      expect(sent.itemType).toEqual(['-attachment', '-note']);
    }
  });
});

describe('LibraryRouter', () => {
  it('reads from the local API when available and not disabled', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: true });
    const r = await router.searchItems({ q: 'x' });
    expect(r.data[0].key).toBe('LOCAL');
    expect(local.listItems).toHaveBeenCalled();
    expect(web.listItems).not.toHaveBeenCalled();
  });

  it('falls back to the cloud when local is unavailable', async () => {
    const { router, web } = makeRouter({ local: 'auto', localApi: false });
    const r = await router.searchItems({ q: 'x' });
    expect(r.data[0].key).toBe('CLOUD');
    expect(web.listItems).toHaveBeenCalled();
  });

  it('searches the cloud for a group this desktop does not hold', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: true, localGroupIds: [] });
    await router.searchItems({ q: 'x', library: { type: 'group', id: 999 } });
    expect(web.listItems).toHaveBeenCalled();
    expect(local.listItems).not.toHaveBeenCalled();
  });

  it('searches the desktop for a group it does hold', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: true, localGroupIds: [999] });
    const lib = { type: 'group' as const, id: 999 };
    const r = await router.searchItems({ q: 'x', library: lib });
    expect(r.data[0].key).toBe('LOCAL');
    expect(local.listItems).toHaveBeenCalledWith({ q: 'x' }, lib);
    expect(web.listItems).not.toHaveBeenCalled();
  });

  it('never confuses user 999 with the held group 999', async () => {
    // localGroupIds holds bare numbers, so matching must be gated on the library TYPE:
    // an id-only comparison would serve a foreign user library from this desktop.
    const { router, web, local } = makeRouter({ local: 'auto', localApi: true, localGroupIds: [999] });
    await router.searchItems({ q: 'x', library: { type: 'user', id: 999 } });
    expect(web.listItems).toHaveBeenCalledWith({ type: 'user', id: 999 }, { q: 'x' });
    expect(local.listItems).not.toHaveBeenCalled();
  });

  it('routes a group to the cloud when capabilities carry no localGroupIds at all', async () => {
    // Capabilities is a published interface: a caller built before this field existed must
    // get cloud routing, not a crash on `undefined.includes`.
    const { router, web, local } = makeRouter({
      local: 'auto',
      localApi: true,
      omitLocalGroupIds: true,
    });
    const r = await router.searchItems({ q: 'x', library: { type: 'group', id: 999 } });
    expect(r.data[0].key).toBe('CLOUD');
    expect(local.listItems).not.toHaveBeenCalled();
    expect(web.listItems).toHaveBeenCalled();
  });

  it('gets children from the local /children endpoint, not a parentItem-filtered list', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: true });
    const r = await router.getItemChildren('ABCD1234', { limit: 25 });
    expect(r.data[0].key).toBe('LOCALCHILD');
    expect(local.getItemChildren).toHaveBeenCalledWith('ABCD1234', { limit: 25 }, defaultUserLib);
    // The desktop local API ignores ?parentItem= and would return the whole library.
    expect(local.listItems).not.toHaveBeenCalled();
    expect(web.getItemChildren).not.toHaveBeenCalled();
  });

  it('gets children from the cloud for a group this desktop does not hold', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: true, localGroupIds: [] });
    const r = await router.getItemChildren('ABCD1234', { library: { type: 'group', id: 999 } });
    expect(r.data[0].key).toBe('CLOUDCHILD');
    expect(web.getItemChildren).toHaveBeenCalledWith({ type: 'group', id: 999 }, 'ABCD1234', {});
    expect(local.getItemChildren).not.toHaveBeenCalled();
  });

  it('gets children from the desktop for a group it does hold', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: true, localGroupIds: [999] });
    const lib = { type: 'group' as const, id: 999 };
    const r = await router.getItemChildren('ABCD1234', { library: lib });
    expect(r.data[0].key).toBe('LOCALCHILD');
    expect(local.getItemChildren).toHaveBeenCalledWith('ABCD1234', {}, lib);
    expect(web.getItemChildren).not.toHaveBeenCalled();
  });

  it('reads full text from the desktop app when it is running (no cloud key needed)', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: true });
    expect((await router.getFullText('ATT01'))?.content).toBe('LOCAL TEXT');
    expect(local.getFullText).toHaveBeenCalledWith('ATT01', defaultUserLib);
    expect(web.getFullText).not.toHaveBeenCalled();

    expect(await router.fullTextSince(0)).toEqual({ LOCALATT: 4 });
    expect(local.fullTextSince).toHaveBeenCalledWith(0, defaultUserLib);
  });

  it('falls back to the cloud for full text when the desktop app is closed', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: false });
    expect((await router.getFullText('ATT01'))?.content).toBe('CLOUD TEXT');
    expect(web.getFullText).toHaveBeenCalledWith({ type: 'user', id: cloudInfo.userID }, 'ATT01');
    expect(local.getFullText).not.toHaveBeenCalled();
  });

  it('keeps group full text on the cloud when this desktop does not hold the group', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: true, localGroupIds: [] });
    const lib = { type: 'group' as const, id: 999 };
    await router.getFullText('ATT01', { library: lib });
    await router.fullTextSince(12, { library: lib });
    expect(web.getFullText).toHaveBeenCalledWith(lib, 'ATT01');
    expect(web.fullTextSince).toHaveBeenCalledWith(lib, 12);
    expect(local.getFullText).not.toHaveBeenCalled();
    expect(local.fullTextSince).not.toHaveBeenCalled();
  });

  it('reads group full text from the desktop when it does hold the group', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: true, localGroupIds: [999] });
    const lib = { type: 'group' as const, id: 999 };
    expect((await router.getFullText('ATT01', { library: lib }))?.content).toBe('LOCAL TEXT');
    expect(await router.fullTextSince(12, { library: lib })).toEqual({ LOCALATT: 4 });
    expect(local.getFullText).toHaveBeenCalledWith('ATT01', lib);
    expect(local.fullTextSince).toHaveBeenCalledWith(12, lib);
    expect(web.getFullText).not.toHaveBeenCalled();
  });

  it('defaultLibrary uses the resolved cloud userID', () => {
    const { router } = makeRouter({ local: 'auto', localApi: true });
    expect(router.defaultLibrary()).toEqual({ type: 'user', id: 19552201 });
  });

  it('routes the ?format=versions census like every other read', async () => {
    const up = makeRouter({ local: 'auto', localApi: true });
    expect((await up.router.itemVersions({ top: true })).versions).toEqual({ LOCAL: 13 });
    expect(up.local.itemVersions).toHaveBeenCalledWith({ top: true }, defaultUserLib);
    expect(up.web.itemVersions).not.toHaveBeenCalled();

    const down = makeRouter({ local: 'auto', localApi: false });
    expect((await down.router.itemVersions({ top: true, since: 5 })).versions).toEqual({ CLOUD: 2114 });
    expect(down.web.itemVersions).toHaveBeenCalledWith(defaultUserLib, { top: true, since: 5 });
  });

  it('reports which API serves a library, because their version sequences differ', () => {
    expect(makeRouter({ local: 'auto', localApi: true }).router.servesLocally()).toBe(true);
    expect(makeRouter({ local: 'auto', localApi: false }).router.servesLocally()).toBe(false);
    expect(makeRouter({ local: 'off', localApi: true }).router.servesLocally()).toBe(false);
    // A group the desktop does not hold is a cloud read even while the app is running.
    const held = makeRouter({ local: 'auto', localApi: true, localGroupIds: [999] });
    expect(held.router.servesLocally({ type: 'group', id: 999 })).toBe(true);
    expect(held.router.servesLocally({ type: 'group', id: 1000 })).toBe(false);
  });

  it('reads tags and the sync delta from the desktop app it serves from', async () => {
    // The three tools these back went to api.zotero.org unconditionally, so on the majority
    // setup (desktop app, no cloud key) every one of them asked the cloud about users/0 and
    // came back "Invalid user ID".
    const { router, web, local } = makeRouter({ local: 'auto', localApi: true });
    expect((await router.listTags({ q: 'ml', limit: 10 })).data[0].tag).toBe('LOCALTAG');
    expect(local.listTags).toHaveBeenCalledWith({ q: 'ml', limit: 10 }, defaultUserLib);
    expect(await router.versions('items', 7)).toEqual({ LOCAL: 13 });
    expect(local.objectVersions).toHaveBeenCalledWith('items', 7, defaultUserLib);
    expect(web.listTags).not.toHaveBeenCalled();
    expect(web.versions).not.toHaveBeenCalled();
  });

  it('surfaces what the desktop app cannot serve rather than falling back mid-delta', async () => {
    // A cloud deletion log spliced into a local delta would be reported under one `since`
    // that belongs to neither sequence, so the gap is raised, not filled.
    const { router, web } = makeRouter({ local: 'auto', localApi: true });
    await expect(router.deleted(0)).rejects.toBeInstanceOf(LocalApiUnsupportedError);
    expect(web.deleted).not.toHaveBeenCalled();
  });

  it('reads tags and the sync delta from the cloud when the desktop app is closed', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: false });
    expect((await router.listTags({ limit: 5 })).data[0].tag).toBe('CLOUDTAG');
    expect(web.listTags).toHaveBeenCalledWith(defaultUserLib, { limit: 5 });
    expect(await router.versions('tags', 3)).toEqual({ CLOUD: 2114 });
    expect(web.versions).toHaveBeenCalledWith(defaultUserLib, 'tags', 3);
    expect(await router.deleted(3)).toEqual({ items: ['CLOUDGONE'] });
    expect(web.deleted).toHaveBeenCalledWith(defaultUserLib, 3);
    expect(local.listTags).not.toHaveBeenCalled();
  });

  it('keeps tags and the sync delta on the cloud for a group the desktop lacks', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: true, localGroupIds: [] });
    const lib = { type: 'group' as const, id: 999 };
    expect((await router.listTags({ library: lib })).data[0].tag).toBe('CLOUDTAG');
    expect(await router.versions('items', 0, { library: lib })).toEqual({ CLOUD: 2114 });
    expect(await router.deleted(0, { library: lib })).toEqual({ items: ['CLOUDGONE'] });
    expect(local.listTags).not.toHaveBeenCalled();
    expect(local.objectVersions).not.toHaveBeenCalled();
    expect(web.listTags).toHaveBeenCalledWith(lib, {});
  });

  it('reads a held group tags and delta from the desktop, and honours a pinned backend', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: true, localGroupIds: [999] });
    const lib = { type: 'group' as const, id: 999 };
    expect((await router.listTags({ library: lib })).data[0].tag).toBe('LOCALTAG');
    expect(local.listTags).toHaveBeenCalledWith({}, lib);
    // A pinned read repeats a decision already made, so it goes to the cloud even here.
    expect(await router.versions('items', 0, { library: lib, backend: 'cloud' })).toEqual({
      CLOUD: 2114,
    });
    expect(web.versions).toHaveBeenCalledWith(lib, 'items', 0);
  });

  it('renders bibliographies and exports through the desktop app it serves from (#64)', async () => {
    const held = makeRouter({ local: 'auto', localApi: true, localGroupIds: [999] });
    const { router, web, local } = held;
    const opts = { style: 'apa', locale: 'fr-FR', linkwrap: true };
    expect(await router.getBibliography(['K1'], opts)).toBe('<div>LOCAL BIB</div>');
    expect(local.getBibliography).toHaveBeenCalledWith(['K1'], opts, defaultUserLib);
    const lib = { type: 'group' as const, id: 999 };
    const query = { format: 'csljson', itemKey: ['K1'], limit: 100 };
    expect(await router.exportItems({ ...query, library: lib })).toBe('[]');
    expect(local.exportItems).toHaveBeenCalledWith(query, lib);
    expect(web.getBibliography).not.toHaveBeenCalled();
    expect(web.exportItems).not.toHaveBeenCalled();
  });

  it('keeps bibliographies and exports on the cloud for a group the desktop lacks', async () => {
    const { router, web, local } = makeRouter({ local: 'auto', localApi: true, localGroupIds: [] });
    const lib = { type: 'group' as const, id: 999 };
    const bib = await router.getBibliography(['K1'], { library: lib, style: 'apa' });
    expect(bib).toBe('<div>CLOUD BIB</div>');
    expect(web.getBibliography).toHaveBeenCalledWith(lib, ['K1'], { style: 'apa' });
    expect(await router.exportItems({ format: 'bibtex', library: lib })).toBe('{"items":[]}');
    expect(web.exportItems).toHaveBeenCalledWith(lib, { format: 'bibtex' });
    expect(local.getBibliography).not.toHaveBeenCalled();
    expect(local.exportItems).not.toHaveBeenCalled();
  });
});
