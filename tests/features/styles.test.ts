import { describe, it, expect, vi } from 'vitest';
import { StyleResolver } from '../../src/features/citation/styles.js';

describe('StyleResolver', () => {
  it('resolves common aliases and passes through ids', () => {
    const r = new StyleResolver();
    expect(r.resolveId('APA 7th')).toBe('apa');
    expect(r.resolveId('IEEE')).toBe('ieee');
    // The id "chicago" used to name was renamed upstream for the 18th edition; the alias
    // follows the rename, so it keeps rendering what it always rendered (#58).
    expect(r.resolveId('Chicago')).toBe('chicago-shortened-notes-bibliography');
    expect(r.resolveId('Chicago notes')).toBe('chicago-notes-bibliography');
    expect(r.resolveId('chicago author-date')).toBe('chicago-author-date');
    expect(r.resolveId('some-custom-style')).toBe('some-custom-style');
  });

  it('follows the repository\'s rename record when an id has moved (#58)', async () => {
    // A raw file fetch does not get the redirect zotero.org applies, so an id copied from
    // Zotero's preferences, or one this project's own table carried, 404s over a rename.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/chicago-note-bibliography.csl')) return new Response('gone', { status: 404 });
      if (url.endsWith('/renamed-styles.json')) {
        return new Response(JSON.stringify({ 'chicago-note-bibliography': 'chicago-shortened-notes-bibliography' }), {
          status: 200,
        });
      }
      if (url.endsWith('/chicago-shortened-notes-bibliography.csl')) {
        return new Response('<style>SHORTENED</style>', { status: 200 });
      }
      return new Response('nope', { status: 404 });
    });
    const r = new StyleResolver({ fetchImpl: fetchImpl as any });
    expect(await r.fetchStyle('chicago-note-bibliography')).toContain('SHORTENED');
    // Cached under the old id too: the record is read once and the 404 is not repeated.
    expect(await r.fetchStyle('chicago-note-bibliography')).toContain('SHORTENED');
    expect(fetchImpl.mock.calls.filter(([u]) => u.endsWith('/renamed-styles.json'))).toHaveLength(1);
    expect(fetchImpl.mock.calls.filter(([u]) => u.endsWith('/chicago-note-bibliography.csl'))).toHaveLength(1);
    // An id the record does not know stays a plain 404.
    await expect(r.fetchStyle('no-such-style')).rejects.toThrow(/"no-such-style" not found \(HTTP 404\)/);
  });

  it('fetches and caches a style', async () => {
    const fetchImpl = vi.fn(async () => new Response('<style>real</style>', { status: 200 }));
    const r = new StyleResolver({ fetchImpl: fetchImpl as any });
    const a = await r.fetchStyle('apa');
    const b = await r.fetchStyle('apa');
    expect(a).toContain('real');
    expect(b).toBe(a);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('follows a dependent style to its independent parent', async () => {
    const dependent =
      '<style><info><link href="http://www.zotero.org/styles/nature" rel="independent-parent"/></info></style>';
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/nature-biotechnology.csl')) return new Response(dependent, { status: 200 });
      if (url.endsWith('/nature.csl')) return new Response('<style>PARENT</style>', { status: 200 });
      return new Response('nope', { status: 404 });
    });
    const r = new StyleResolver({ fetchImpl: fetchImpl as any });
    const xml = await r.fetchStyle('nature-biotechnology');
    expect(xml).toContain('PARENT');
  });

  it('falls back to en-US when a locale is missing', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('en-US') ? new Response('<locale>en</locale>', { status: 200 }) : new Response('x', { status: 404 }),
    );
    const r = new StyleResolver({ fetchImpl: fetchImpl as any });
    const xml = await r.fetchLocale('zz-ZZ');
    expect(xml).toContain('en');
  });
});
