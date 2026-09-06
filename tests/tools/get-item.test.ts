import { describe, it, expect, vi } from 'vitest';
import getItem from '../../src/tools/get-item.js';

function ctx(getImpl: any, childrenImpl?: any) {
  return {
    router: {
      getItem: getImpl,
      getItemChildren:
        childrenImpl ?? vi.fn(async () => ({ data: [], totalResults: 0, lastModifiedVersion: 0 })),
      defaultLibrary: () => ({ type: 'user', id: 19552201 }),
    },
    styles: { resolveId: (name: string) => (name === 'Chicago' ? 'chicago-shortened-notes-bibliography' : name) },
  } as any;
}

describe('zotero_get_item', () => {
  it('returns the full item record', async () => {
    const getImpl = vi.fn(async () => ({ key: 'ABCD', version: 5, data: { itemType: 'book', title: 'T' } }));
    const res = await getItem.handler({ item_key: 'ABCD' }, ctx(getImpl));
    expect(getImpl).toHaveBeenCalledWith('ABCD', expect.any(Object));
    expect((res.structuredContent?.item as any).data.title).toBe('T');
  });

  it('forwards style and locale with the rendered output they apply to (#58)', async () => {
    // Both arguments were accepted and neither reached the API, so "apa" and "chicago"
    // rendered the same bibliography entry: Zotero's default, every time.
    const getImpl = vi.fn(async () => ({ key: 'ABCD', bib: '<div/>', data: { itemType: 'book' } }));
    await getItem.handler({ item_key: 'ABCD', include: 'bib', style: 'Chicago', locale: 'en-GB' }, ctx(getImpl));
    expect(getImpl).toHaveBeenCalledWith('ABCD', {
      include: 'bib',
      style: 'chicago-shortened-notes-bibliography',
      locale: 'en-GB',
      library: undefined,
    });
    // A bare CSL id or a URL is passed through as it is.
    await getItem.handler({ item_key: 'ABCD', include: 'citation', style: 'chicago-author-date' }, ctx(getImpl));
    expect(getImpl).toHaveBeenLastCalledWith('ABCD', expect.objectContaining({ style: 'chicago-author-date' }));
  });

  it('includes children when requested', async () => {
    const getImpl = vi.fn(async () => ({ key: 'ABCD', data: { itemType: 'book' } }));
    const childrenImpl = vi.fn(async () => ({
      data: [{ key: 'NOTE1', data: { itemType: 'note' } }],
      totalResults: 1,
      lastModifiedVersion: 5,
    }));
    const res = await getItem.handler({ item_key: 'ABCD', include_children: true }, ctx(getImpl, childrenImpl));
    expect(childrenImpl).toHaveBeenCalled();
    expect((res.structuredContent?.children as any[])[0].key).toBe('NOTE1');
  });
});
