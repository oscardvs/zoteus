import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import attachment from '../../src/tools/attachment.js';
import attachFile from '../../src/tools/attach-file.js';
import importTool from '../../src/tools/import.js';
import tagAudit from '../../src/tools/tag-audit.js';

/**
 * The guard itself is unit-tested in tests/lib/caller-path.test.ts. These check that the
 * tools are actually WIRED to it, which is the part a refactor would silently drop, and
 * that a stdio caller keeps the behaviour the tools exist for.
 */
function ctx(over: Record<string, unknown> = {}) {
  return {
    config: { dataDir: join(tmpdir(), 'zoteus-data-does-not-exist') },
    remoteCaller: true,
    router: { defaultLibrary: () => ({ type: 'user', id: 1 }) },
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    ...over,
  } as never;
}

const text = (res: { content?: { text: string }[] }) =>
  (res.content ?? []).map((c) => c.text).join('\n');

describe('caller-supplied paths on a shared deployment', () => {
  /**
   * The data directory is ONE directory shared by every tenant of a hosted deployment, so
   * confining a path to it says nothing about the other tenants in it. `action:"upload"`
   * reads the file it is handed, which made a known path into another tenant's bytes.
   */
  it('zotero_attachment refuses one tenant the path of another tenant\'s file', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'zoteus-tenants-'));
    try {
      const victimDir = join(dataDir, 'tenants', '111', 'documents');
      const victim = join(victimDir, 'private.docx');
      await mkdtemp(join(tmpdir(), 'unused-'));
      const { mkdir } = await import('node:fs/promises');
      await mkdir(victimDir, { recursive: true });
      await writeFile(victim, 'another tenant\'s prose');

      // Tenant 222 naming tenant 111's file. It is inside the data directory, so the old
      // data-directory-wide confinement allowed it.
      const res = await attachment.handler(
        { action: 'upload', file_path: victim },
        ctx({ config: { dataDir }, zoteroUserId: 222 }),
      );
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('file_path');

      // And the owner still reaches their own file: the guard is isolation, not a blanket ban.
      // The call gets past the path check and fails later for want of a cloud key, which is
      // the proof that the path itself was accepted.
      const owner = await attachment.handler(
        { action: 'upload', file_path: victim },
        ctx({ config: { dataDir }, zoteroUserId: 111 }),
      ).catch((e: unknown) => ({ content: [{ text: e instanceof Error ? e.message : String(e) }], isError: true }));
      expect(text(owner)).not.toContain('file_path');
      expect(text(owner)).toMatch(/cloud|API key/i);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it.each(['attach', 'bibliography', 'pdf'])(
    '%s refuses other tenants and shared operator files before reading or uploading',
    async (action) => {
      const dataDir = await mkdtemp(join(tmpdir(), 'zoteus-read-tenants-'));
      try {
        const victimDir = join(dataDir, 'tenants', '111');
        await mkdir(victimDir, { recursive: true });
        for (const target of [join(victimDir, 'private.bib'), join(dataDir, 'operator.json')]) {
          await writeFile(target, '@article{secret, title={Private research}}');
          const context = ctx({ config: { dataDir }, zoteroUserId: 222 });
          const res = action === 'attach'
            ? await attachFile.handler({ parent: 'ABCD1234', path: target }, context)
            : await importTool.handler({ action: action === 'pdf' ? 'by_pdf' : 'by_file', path: target }, context);
          expect(res.isError).toBe(true);
          expect(text(res)).toContain('`path`');
          expect(text(res)).toContain('data directory');
        }
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );

  it('zotero_tag_audit refuses other tenants and shared operator files as a vocabulary', async () => {
    // The read side of the same rule: three distinct answers ("could not read", "not valid
    // JSON", a per-key issue list) over the whole data directory were an existence oracle
    // on every other tenant's files and a reflection of the OAuth store's key names.
    const dataDir = await mkdtemp(join(tmpdir(), 'zoteus-vocab-tenants-'));
    try {
      const victimDir = join(dataDir, 'tenants', '111');
      await mkdir(victimDir, { recursive: true });
      for (const target of [join(victimDir, 'vocabulary.json'), join(dataDir, 'oauth-store.json')]) {
        await writeFile(target, JSON.stringify({ allowed: ['secret'] }));
        const res = await tagAudit.handler({ vocabulary_path: target }, ctx({ config: { dataDir }, zoteroUserId: 222 }));
        expect(res.isError).toBe(true);
        expect(text(res)).toContain('`vocabulary_path`');
        expect(text(res)).not.toContain('secret');
      }
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('zotero_attachment refuses a save_path outside the data directory', async () => {
    const res = await attachment.handler(
      { action: 'download', item_key: 'ABCD1234', save_path: '/app/dist/index.js' },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('save_path');
  });

  it('zotero_attachment refuses a file_path outside the data directory', async () => {
    const res = await attachment.handler(
      { action: 'upload', file_path: '/proc/self/environ' },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('file_path');
  });

  it('zotero_attach_file refuses a path outside the data directory', async () => {
    const res = await attachFile.handler({ parent: 'ABCD1234', path: '/etc/passwd' }, ctx());
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('`path`');
  });

  it('points the caller at `url`, which works on every setup', async () => {
    const res = await attachFile.handler({ parent: 'ABCD1234', path: '/etc/passwd' }, ctx());
    expect(text(res)).toContain('url');
  });

  it('refuses to replace an existing file even inside the caller\'s own subtree', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'zoteus-attach-'));
    // The default fixture is a remote caller with no identity of its own, whose subtree is
    // tenants/shared: inside it, the no-clobber rule is the one that answers.
    const target = join(dataDir, 'tenants', 'shared', 'already-here.pdf');
    await mkdir(join(dataDir, 'tenants', 'shared'), { recursive: true });
    await writeFile(target, 'original');
    try {
      const res = await attachment.handler(
        { action: 'download', item_key: 'ABCD1234', save_path: target },
        ctx({ config: { dataDir } }),
      );
      expect(res.isError).toBe(true);
      expect(text(res)).toContain('overwrite');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('a stdio caller is not confined: the tool exists to write where you ask', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'zoteus-attach-'));
    try {
      // remoteCaller false, so the guard passes the path through and the handler proceeds
      // to the download itself, which fails on the stub web client rather than on the path.
      const res = await attachment.handler(
        { action: 'download', item_key: 'ABCD1234', save_path: '/tmp/zoteus-anywhere.pdf' },
        ctx({
          config: { dataDir },
          remoteCaller: false,
          capabilities: { cloud: { userID: 1 } },
          web: {
            downloadFileBytes: async () => {
              throw new Error('stub: reached the download, not blocked by the path guard');
            },
          },
        }),
      ).catch((e: Error) => ({ content: [{ text: e.message }], isError: true }));
      expect(text(res)).not.toContain('data directory');
      expect(text(res)).toContain('stub: reached the download');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
