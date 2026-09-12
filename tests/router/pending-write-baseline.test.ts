import { describe, expect, it, vi } from 'vitest';
import { LibraryRouter } from '../../src/router/library-router.js';
import { loadConfig } from '../../src/config.js';

const settle = () => new Promise((r) => setTimeout(r, 0));

function makeRouter() {
  const local = {
    objectVersion: vi.fn(async (): Promise<number | null> => 5),
    listItems: vi.fn(async () => ({ data: [{ key: 'LOCAL' }] })),
  };
  const router = new LibraryRouter({
    config: loadConfig({ ZOTEUS_LOCAL: 'on' } as any),
    capabilities: { cloud: { userID: 1 }, localApi: true, localGroupIds: [2] } as any,
    local: local as any,
    web: { listItems: async () => ({ data: [{ key: 'CLOUD' }] }) } as any,
  });
  return { router, local };
}

describe('reads before a cloud write baseline is known', () => {
  it.each(['user', 'group'] as const)('does not mistake a preexisting %s item for a synced update', async (type) => {
    const library = { type, id: type === 'user' ? 1 : 2 };
    const { router, local } = makeRouter();
    let release!: (value: number | null) => void;
    local.objectVersion.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    router.noteCloudWrite(library, 'items', ['EXISTING']);

    // The read can finish while the baseline query is still in flight. Presence alone
    // says nothing about whether the existing item's updated fields have reached Zotero.
    expect((await router.searchItems({ library })).data[0].key).toBe('CLOUD');
    release(5);
    await settle();
    expect((await router.searchItems({ library })).data[0].key).toBe('CLOUD');
    local.objectVersion.mockResolvedValue(6);
    expect((await router.searchItems({ library })).data[0].key).toBe('LOCAL');
  });

  it('does not treat a failed baseline as evidence that an existing item is current', async () => {
    const { router, local } = makeRouter();
    local.objectVersion.mockRejectedValueOnce(new Error('transient baseline failure'));
    router.noteCloudWrite({ type: 'user', id: 1 }, 'items', ['EXISTING']);
    await settle();
    // Later probes could succeed but have no baseline to compare against.
    expect((await router.searchItems()).data[0].key).toBe('CLOUD');
  });

  it('still releases a create after a known-absent baseline becomes present', async () => {
    const { router, local } = makeRouter();
    local.objectVersion.mockResolvedValueOnce(null);
    router.noteCloudWrite({ type: 'user', id: 1 }, 'items', ['NEW']);
    await settle();
    expect((await router.searchItems()).data[0].key).toBe('LOCAL');
  });

  it('still releases a deletion without requiring a baseline', async () => {
    const { router, local } = makeRouter();
    local.objectVersion.mockResolvedValue(null);
    router.noteCloudWrite({ type: 'user', id: 1 }, 'items', ['GONE'], true);
    expect((await router.searchItems()).data[0].key).toBe('LOCAL');
  });
});
