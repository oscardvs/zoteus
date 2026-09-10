import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import tagAudit from '../../src/tools/tag-audit.js';

function ctx(over: Record<string, unknown> = {}) {
  return {
    // A stdio-shaped caller: the operator owns the machine, so vocabulary_path is not
    // confined to the data directory. See tests/lib/caller-path.test.ts for the confined case.
    config: { dataDir: tmpdir() },
    remoteCaller: false,
    ...over,
    router: {
      defaultLibrary: () => ({ type: 'user', id: 19552201 }),
      // Tags come through the router like the items do, so a desktop-only install can run
      // the audit at all; reading them off ctx.web asked api.zotero.org about users/0.
      listTags: vi.fn(async () => ({
        data: [
          { tag: 'ml', meta: { type: 0, numItems: 10 } },
          { tag: 'legacy', meta: { type: 0, numItems: 2 } }, // manual ⇒ off-taxonomy (not auto-bucketed)
        ],
        totalResults: 2,
        lastModifiedVersion: 1,
      })),
      searchItems: vi.fn(async () => ({
        data: [
          { key: 'I1', data: { title: 'A', tags: [{ tag: 'ml' }] } },
          { key: 'I2', data: { title: 'B', tags: [{ tag: 'legacy' }] } },
        ],
        totalResults: 2,
        lastModifiedVersion: 1,
      })),
    },
  } as any;
}

const vocabulary = {
  tags: [{ name: 'ml', tier: 'topic' }],
  tiers: [{ name: 'topic', required: true }],
};

describe('zotero_tag_audit', () => {
  it('is read-only', () => {
    expect(tagAudit.annotations?.readOnlyHint).toBe(true);
  });

  it('reports off-taxonomy tags and items missing a required tier', async () => {
    const res = await tagAudit.handler({ vocabulary }, ctx());
    const sc = res.structuredContent as any;
    expect(sc.offTaxonomy.map((t: any) => t.name)).toContain('legacy');
    expect(sc.missingByTier[0].tier).toBe('topic');
    expect(sc.missingByTier[0].items.map((i: any) => i.key)).toEqual(['I2']);
    const text = (res.content ?? []).map((c: { text: string }) => c.text).join('\n');
    expect(text).toContain('legacy');
  });

  it('errors when neither vocabulary nor vocabulary_path is given', async () => {
    const res = await tagAudit.handler({}, ctx());
    expect(res.isError).toBe(true);
  });

  it('refuses a vocabulary_path outside the data directory when the caller is remote', async () => {
    const res = await tagAudit.handler(
      { vocabulary_path: '/etc/passwd' },
      ctx({ config: { dataDir: join(tmpdir(), 'zoteus-data') }, remoteCaller: true }),
    );
    expect(res.isError).toBe(true);
    const text = (res.content ?? []).map((c: { text: string }) => c.text).join('\n');
    expect(text).toContain('vocabulary_path');
  });

  it('returns a friendly error when vocabulary_path is malformed JSON', async () => {
    const path = join(tmpdir(), `zoteus-vocab-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(path, '{ this is not: valid json,, }', 'utf8');
    try {
      const res = await tagAudit.handler({ vocabulary_path: path }, ctx());
      expect(res.isError).toBe(true);
      const text = (res.content ?? []).map((c: { text: string }) => c.text).join('\n');
      expect(text).toContain('not valid JSON');
    } finally {
      await unlink(path).catch(() => {});
    }
  });

  it('audits each collection in scope.collection_keys as well as the whole library', async () => {
    const c = ctx();
    c.router.searchItems = vi.fn(async ({ collectionKey }: { collectionKey?: string }) => ({
      data: collectionKey === 'C1' ? [{ key: 'I2', data: { title: 'B', tags: [{ tag: 'legacy' }] } }] : [
        { key: 'I1', data: { title: 'A', tags: [{ tag: 'ml' }] } },
        { key: 'I2', data: { title: 'B', tags: [{ tag: 'legacy' }] } },
      ],
      totalResults: collectionKey === 'C1' ? 1 : 2,
      lastModifiedVersion: 1,
    }));
    const res = await tagAudit.handler({ vocabulary, scope: { collection_keys: ['C1'] } }, c);
    const sc = res.structuredContent as any;
    expect(sc.itemsScanned).toBe(2);
    expect(sc.collections).toEqual([
      { collectionKey: 'C1', missingByTier: [{ tier: 'topic', itemCount: 1, items: [{ key: 'I2', title: 'B' }], omitted: 0 }] },
    ]);
  });
});

/**
 * `z.object` strips what it does not recognise, and every member of `scope` and of the
 * vocabulary objects is optional, so `scope: {"collections": [...]}` arrived as `{}` and the
 * audit ran over the whole library and called it a success. Measured against the real
 * library before this was fixed: the same call reported "Audited 211 tag(s) over 285
 * item(s)" whether the scope key was spelled right or wrong, with no per-collection
 * coverage in the second and nothing to say it had been asked for.
 */
describe('zotero_tag_audit refuses a collection key the library does not have', () => {
  /**
   * The desktop app answers `/collections/<unknown>/items` with the WHOLE library, so an
   * audit scoped to a mistyped key reported every item in the library as that collection's
   * coverage. Measured before this guard: `itemCount: 285` for a key that does not exist,
   * against the 6 the real collection holds, with nothing in the answer to say which
   * question had been answered. In an audit that is the worst possible wrong answer,
   * because a mistyped key reports compliance nobody has. zotero_search_items and
   * zotero_export already refuse the same key for the same reason.
   */
  function scopedCtx(known: string[]) {
    const c = ctx();
    c.local = { collectionExists: vi.fn(async (k: string) => known.includes(k)) };
    c.router.servesLocally = () => true;
    return c;
  }

  it('names the unknown key and audits nothing at all', async () => {
    const c = scopedCtx(['REAL1234']);
    const res = await tagAudit.handler({ vocabulary, scope: { collection_keys: ['ZZZZZZZZ'] } }, c);
    expect(res.isError).toBe(true);
    const text = (res.content ?? []).map((x: any) => x.text).join('\n');
    expect(text).toContain('ZZZZZZZZ');
    expect(text).toContain('zotero_list_collections');
    // Refused before any listing work, so no partial audit is reported alongside.
    expect(res.structuredContent).toBeUndefined();
    expect(c.router.listTags).not.toHaveBeenCalled();
    expect(c.router.searchItems).not.toHaveBeenCalled();
  });

  it('still audits a key the library really has', async () => {
    const c = scopedCtx(['REAL1234']);
    const res = await tagAudit.handler({ vocabulary, scope: { collection_keys: ['REAL1234'] } }, c);
    expect(res.isError).toBeUndefined();
    expect((res.structuredContent as any).collections[0].collectionKey).toBe('REAL1234');
  });
});

describe('zotero_tag_audit refuses keys it does not know', () => {
  const parse = (args: Record<string, unknown>) => z.object(tagAudit.inputSchema).safeParse(args);
  const messagesOf = (res: z.SafeParseReturnType<unknown, unknown>) =>
    res.success ? '' : res.error.issues.map((i) => i.message).join('\n');

  it('names the scope key it was given and the one this tool spells', () => {
    const res = parse({ vocabulary, scope: { collections: ['DDMMTKDW'] } });
    expect(res.success).toBe(false);
    expect(messagesOf(res)).toContain('unknown key `collections` in `scope`: this tool spells it `collection_keys`');
    // Dropping it changed the question, not just the arguments, so say what did not happen.
    expect(messagesOf(res)).toContain('Nothing was audited');
    expect((res as z.SafeParseError<unknown>).error.issues[0]!.path).toEqual(['scope']);
  });

  it('pairs a near miss with its twin however it was spelled', () => {
    expect(messagesOf(parse({ vocabulary, scope: { collection_key: 'A' } }))).toContain('spells it `collection_keys`');
    expect(messagesOf(parse({ vocabulary, scope: { collectionKeys: ['A'] } }))).toContain('spells it `collection_keys`');
    expect(messagesOf(parse({ vocabulary, scope: { keys: ['A'] } }))).toContain('spells it `collection_keys`');
  });

  it('refuses a vocabulary tag whose tier was going to be dropped', () => {
    const res = parse({ vocabulary: { tags: [{ name: 'ml' }, { name: 'legacy', Tier: 'topic' }] } });
    expect(messagesOf(res)).toContain('unknown key `Tier` in a `vocabulary.tags` entry: this tool spells it `tier`');
    // The path is what tells a caller WHICH entry of the list was wrong.
    expect((res as z.SafeParseError<unknown>).error.issues[0]!.path).toEqual(['vocabulary', 'tags', 1]);
  });

  it('refuses a tier whose `required` was going to be dropped, which reports no gaps at all', () => {
    const res = parse({ vocabulary: { tags: [{ name: 'ml', tier: 'topic' }], tiers: [{ name: 'topic', require: true }] } });
    expect(messagesOf(res)).toContain('unknown key `require` in a `vocabulary.tiers` entry: this tool spells it `required`');
  });

  it('refuses a vocabulary whose whole tier list was going to be dropped', () => {
    const res = parse({ vocabulary: { tags: [{ name: 'ml', tier: 'topic' }], tier: [{ name: 'topic', required: true }] } });
    expect(messagesOf(res)).toContain('unknown key `tier` in `vocabulary`: this tool spells it `tiers`');
  });

  it('lists the keys when the offending one resembles none of them', () => {
    expect(messagesOf(parse({ vocabulary, scope: { folder: 'x' } }))).toContain(
      'unknown key `folder` in `scope`. The keys are: collection_keys.',
    );
    expect(messagesOf(parse({ vocabulary: { tags: [{ name: 'ml', priority: 1 }] } }))).toContain(
      'unknown key `priority` in a `vocabulary.tags` entry. The keys are: name, tier.',
    );
  });

  it('still accepts every key it documents', () => {
    expect(
      parse({
        vocabulary: { tags: [{ name: 'ml', tier: 'topic' }], tiers: [{ name: 'topic', required: true }] },
        scope: { collection_keys: ['C1'] },
        include_auto: true,
        limit: 10,
        library_type: 'group',
        library_id: 6666644,
      }).success,
    ).toBe(true);
    // An absent optional is not an unknown key.
    expect(parse({ vocabulary: { tags: [{ name: 'ml' }] }, scope: {} }).success).toBe(true);
  });
});

describe('zotero_tag_audit reads a vocabulary file through the same schema', () => {
  it('names the file, the key and its twin instead of dumping Zod issues', async () => {
    const path = join(tmpdir(), `zoteus-vocab-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(path, JSON.stringify({ tags: [{ name: 'ml', Tier: 'topic' }], tier: [{ name: 'topic' }] }), 'utf8');
    try {
      const res = await tagAudit.handler({ vocabulary_path: path }, ctx());
      expect(res.isError).toBe(true);
      const text = (res.content ?? []).map((c: { text: string }) => c.text).join('\n');
      expect(text).toContain(path);
      expect(text).toContain('unknown key `tier` in `vocabulary`: this tool spells it `tiers`');
      expect(text).toContain('tags.0: unknown key `Tier` in a `vocabulary.tags` entry');
    } finally {
      await unlink(path).catch(() => {});
    }
  });

  it('still reads a well-spelled file', async () => {
    const path = join(tmpdir(), `zoteus-vocab-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(path, JSON.stringify(vocabulary), 'utf8');
    try {
      const res = await tagAudit.handler({ vocabulary_path: path }, ctx());
      expect(res.isError).toBeFalsy();
      expect((res.structuredContent as any).missingByTier[0].tier).toBe('topic');
    } finally {
      await unlink(path).catch(() => {});
    }
  });
});
