import { describe, expect, it, vi } from 'vitest';
import { LibraryRouter } from '../../src/router/library-router.js';
import { loadConfig } from '../../src/config.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function makeRouter() {
  const local = {
    objectVersion: vi.fn(async (_type: string, _key: string): Promise<number | null> => null),
    listItems: vi.fn(async () => ({ data: [{ key: 'LOCAL' }] })),
  };
  const web = { listItems: vi.fn(async () => ({ data: [{ key: 'CLOUD' }] })) };
  const router = new LibraryRouter({
    config: loadConfig({ ZOTEUS_LOCAL: 'on' } as any),
    capabilities: { cloud: { userID: 1 }, localApi: true, localGroupIds: [2] } as any,
    local: local as any,
    web: web as any,
  });
  return { router, local };
}

describe('pending writes across overlapping reads and writes', () => {
  it.each(['user', 'group'] as const)('does not clear a newer %s write when an older read finishes', async (type) => {
    const library = { type, id: type === 'user' ? 1 : 2 };
    const { router, local } = makeRouter();
    const check = deferred<number | null>();
    local.objectVersion.mockResolvedValueOnce(null).mockImplementationOnce(() => check.promise);
    router.noteCloudWrite(library, 'items', ['FIRST']);
    await settle();
    const olderRead = router.searchItems({ library });

    router.noteCloudWrite(library, 'items', ['SECOND']);
    await settle();
    check.resolve(7);
    expect((await olderRead).data[0].key).toBe('CLOUD');
    // SECOND is still absent. The stale check must not remove its marker.
    expect((await router.searchItems({ library })).data[0].key).toBe('CLOUD');
    local.objectVersion.mockResolvedValue(8);
    expect((await router.searchItems({ library })).data[0].key).toBe('LOCAL');
  });

  it('does not let an older baseline initialize a newer write to the same key', async () => {
    const library = { type: 'user' as const, id: 1 };
    const { router, local } = makeRouter();
    const first = deferred<number | null>();
    const second = deferred<number | null>();
    local.objectVersion.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    router.noteCloudWrite(library, 'items', ['SAME']);
    router.noteCloudWrite(library, 'items', ['SAME']);
    first.resolve(4);
    await settle();
    second.resolve(5);
    await settle();

    // Version 5 predates the second write; only its own baseline is meaningful.
    local.objectVersion.mockResolvedValue(5);
    expect((await router.searchItems()).data[0].key).toBe('CLOUD');
    local.objectVersion.mockResolvedValue(6);
    expect((await router.searchItems()).data[0].key).toBe('LOCAL');
  });
});
