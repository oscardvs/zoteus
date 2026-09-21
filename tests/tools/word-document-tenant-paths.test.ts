import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import wordDocument from '../../src/tools/word-document.js';
import { AUTHOR_DATE_STYLE, LOCALE, PLAIN_ITEM } from '../fixtures/docx-csl.js';

/**
 * One hosted deployment, one data directory, two customers.
 *
 * `ctx.config` is built once and shared by every per-user context (src/server.ts), so
 * `config.dataDir` is the same string for every tenant. The search index already keys its
 * own file by `zoteroUserId` for that reason; a document does not get to be the exception,
 * because the thing in it is the researcher's own prose and their own library's citations.
 *
 * What these assert is the write side, which is what this tool owns: where a document lands,
 * and that a caller cannot write into, overwrite inside, or probe for files in another
 * tenant's subtree. The read side (zotero_attachment action:"upload" reading a path back out)
 * is confined to `ctx.config.dataDir` in src/tools/attachment.ts and is reported separately.
 */

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'zoteus-docx-tenant-'));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** A per-user context of the shape PerUserContexts hands to a tool on a hosted server. */
function tenant(zoteroUserId: number | undefined, over: Record<string, unknown> = {}) {
  return {
    config: { dataDir },
    remoteCaller: true,
    zoteroUserId,
    capabilities: {},
    router: {
      defaultLibrary: () => ({ type: 'user', id: 19552201 }),
      exportItems: vi.fn(async () => JSON.stringify([PLAIN_ITEM])),
      getItem: vi.fn(async () => ({ library: { type: 'user', id: 19552201 } })),
    },
    styles: {
      resolveId: (s: string) => s.trim().toLowerCase(),
      fetchStyle: vi.fn(async () => AUTHOR_DATE_STYLE),
      fetchLocale: vi.fn(async () => LOCALE),
    },
    web: { exportItems: vi.fn() },
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    ...over,
  } as never;
}

async function write(
  zoteroUserId: number | undefined,
  args: Record<string, unknown> = {},
  over: Record<string, unknown> = {},
) {
  const res = (await wordDocument.handler({ body: ['[[cite:ABCD1234]]'], ...args }, tenant(zoteroUserId, over))) as {
    isError?: boolean;
    content?: { text: string }[];
    structuredContent?: Record<string, unknown>;
  };
  return {
    isError: res.isError,
    text: (res.content ?? []).map((c) => c.text).join('\n'),
    savedTo: res.structuredContent?.savedTo as string | undefined,
    warnings: ((res.structuredContent?.warnings as string[] | undefined) ?? []).join(' '),
  };
}

describe('zotero_word_document tenant-scoped save paths', () => {
  it('writes each tenant into a directory of their own, not into one they share', async () => {
    const a = await write(111, { title: 'Literature Review', save_path: '/etc/zoteus-owned.docx' });
    const b = await write(222, { title: 'Literature Review' });

    const rootA = join(dataDir, 'tenants', '111') + sep;
    const rootB = join(dataDir, 'tenants', '222') + sep;
    expect(a.savedTo!.startsWith(rootA)).toBe(true);
    expect(b.savedTo!.startsWith(rootB)).toBe(true);
    expect(a.savedTo!.startsWith(rootB)).toBe(false);
    expect(b.savedTo!.startsWith(rootA)).toBe(false);
    expect(existsSync('/etc/zoteus-owned.docx')).toBe(false);
    // The fallback still tells the caller where the file went, and the path it names is now
    // one only that caller can read back.
    expect(a.warnings).toContain(a.savedTo!);
  });

  it('keeps the operator on the bare data directory, because there is only one of them', async () => {
    const res = await write(undefined, { title: 'Literature Review' }, { remoteCaller: false });
    expect(res.savedTo!.startsWith(join(dataDir, 'documents') + sep)).toBe(true);
  });

  it('gives a remote caller with no identity of its own a shared subtree, not the bare data directory', async () => {
    // A passcode-mode caller shares the operator's context but not the operator's disk: the
    // bare data directory holds the OAuth token store and every tenant's subtree.
    const res = await write(undefined, { title: 'Literature Review' });
    expect(res.savedTo!.startsWith(join(dataDir, 'tenants', 'shared', 'documents') + sep)).toBe(true);
  });

  it('does not let one tenant write over, or beside, another tenant\'s document', async () => {
    const a = await write(111, { title: 'Literature Review' });
    const before = readFileSync(a.savedTo!);

    // B asks for A's exact path, with overwrite, which is the strongest form of the attempt.
    const b = await write(222, { title: 'Literature Review', save_path: a.savedTo!, overwrite: true });
    expect(b.isError).toBeUndefined();
    expect(b.savedTo).not.toBe(a.savedTo);
    expect(b.savedTo!.startsWith(join(dataDir, 'tenants', '222') + sep)).toBe(true);
    expect(readFileSync(a.savedTo!).equals(before)).toBe(true);
    expect(b.warnings).toContain('`save_path` was not used');
  });

  it('does not answer whether another tenant has a file at a path', async () => {
    const theirs = join(dataDir, 'tenants', '111', 'documents', 'literature-review-20260914-192732-0a1b2c.docx');
    const a = await write(111, { title: 'Literature Review', save_path: theirs });
    expect(a.savedTo).toBe(theirs);

    // The old shared root made this an existence oracle: a path another tenant had used came
    // back as "already exists", a path they had not came back written. Both must now look the
    // same to B, and neither may say anything about A.
    const hit = await write(222, { save_path: theirs });
    const miss = await write(222, { save_path: join(dataDir, 'tenants', '111', 'documents', 'no-such-file.docx') });
    expect(hit.isError).toBeUndefined();
    expect(miss.isError).toBeUndefined();
    expect(hit.text).not.toContain('already exists');
    expect(miss.text).not.toContain('already exists');
    // Identical once each caller's own filename is taken out: the refusal carries nothing
    // about the path that was asked for.
    expect(hit.warnings.split(hit.savedTo!).join('')).toBe(miss.warnings.split(miss.savedTo!).join(''));
    expect(readFileSync(theirs, 'utf8').slice(0, 2)).toBe('PK');
  });

  it('still refuses to clobber a file inside the caller\'s own subtree', async () => {
    const mine = join(dataDir, 'tenants', '111', 'thesis.docx');
    const first = await write(111, { save_path: mine });
    expect(first.savedTo).toBe(mine);
    writeFileSync(mine, 'six months of work');

    const second = await write(111, { save_path: mine });
    expect(second.isError).toBe(true);
    expect(second.text).toContain('already exists');
    expect(readFileSync(mine, 'utf8')).toBe('six months of work');
  });

  it('gives the default filename bytes nobody can derive from the title and the clock', async () => {
    const first = await write(111, { title: 'Literature Review' });
    const second = await write(111, { title: 'Literature Review' });
    // Same tenant, same title, very likely the same wall-clock second: the names still differ,
    // because the stem is not a function of anything the caller published.
    expect(first.savedTo).not.toBe(second.savedTo);
    expect(basename(first.savedTo!)).toMatch(/^literature-review-\d{8}-\d{6}-[0-9a-f]{6}\.docx$/);
    expect(basename(second.savedTo!)).toMatch(/^literature-review-\d{8}-\d{6}-[0-9a-f]{6}\.docx$/);
  });
});
