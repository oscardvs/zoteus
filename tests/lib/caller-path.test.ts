import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveCallerPath, CallerPathError } from '../../src/lib/caller-path.js';

/**
 * The threat these guard against: on a shared deployment a tool argument like
 * `save_path` or `file_path` reaches the OPERATOR's disk, not the caller's. Reading
 * /proc/self/environ hands out the OAuth token secret; writing /app/dist/index.js is
 * code execution on the next restart.
 */
describe('resolveCallerPath', () => {
  let root: string;
  let dataDir: string;
  let outside: string;

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'zoteus-callerpath-')));
    dataDir = join(root, 'data');
    outside = join(root, 'elsewhere');
    await mkdir(join(dataDir, 'nested'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(dataDir, 'inside.json'), '{}');
    await writeFile(join(outside, 'secret.env'), 'TOKEN=hunter2');
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const opts = (over: Partial<Parameters<typeof resolveCallerPath>[1]> = {}) => ({
    dataDir,
    confined: true,
    mode: 'read' as const,
    argName: 'path',
    alternative: 'Use `url` instead.',
    ...over,
  });

  it('lets an unconfined caller reach anything: on stdio they own the machine', async () => {
    const target = join(outside, 'secret.env');
    await expect(resolveCallerPath(target, opts({ confined: false }))).resolves.toBe(target);
  });

  it('expands a leading ~ for an unconfined caller, as the documented examples assume', async () => {
    // A tool argument is not passed through a shell, so nothing else expands it, and
    // path.resolve would have made it `<cwd>/~/Downloads/x.bib`.
    await expect(resolveCallerPath('~/Downloads/x.bib', opts({ confined: false }))).resolves.toBe(
      join(homedir(), 'Downloads', 'x.bib'),
    );
    await expect(resolveCallerPath('~', opts({ confined: false }))).resolves.toBe(homedir());
    // Only a leading `~/` is a home reference; `~user` and a `~` inside the path are literal.
    await expect(resolveCallerPath('~other/x', opts({ confined: false }))).resolves.toBe(resolve('~other/x'));
    await expect(resolveCallerPath(join(outside, '~', 'x'), opts({ confined: false }))).resolves.toBe(
      join(outside, '~', 'x'),
    );
  });

  it('never expands ~ for a confined caller, whose ~ would be the operator\'s home', async () => {
    await expect(resolveCallerPath('~/x', opts())).rejects.toBeInstanceOf(CallerPathError);
    await expect(resolveCallerPath('~/x', opts({ mode: 'write' }))).rejects.toBeInstanceOf(CallerPathError);
  });

  it('allows a confined read inside the data directory', async () => {
    await expect(resolveCallerPath(join(dataDir, 'inside.json'), opts())).resolves.toBe(
      join(dataDir, 'inside.json'),
    );
  });

  it('refuses a confined read outside the data directory', async () => {
    await expect(resolveCallerPath(join(outside, 'secret.env'), opts())).rejects.toBeInstanceOf(
      CallerPathError,
    );
  });

  it('refuses traversal out of the data directory', async () => {
    await expect(
      resolveCallerPath(join(dataDir, '..', 'elsewhere', 'secret.env'), opts()),
    ).rejects.toBeInstanceOf(CallerPathError);
  });

  it('refuses absolute paths to the process environment and the served code', async () => {
    for (const p of ['/proc/self/environ', '/app/dist/index.js', '/etc/passwd']) {
      await expect(resolveCallerPath(p, opts())).rejects.toBeInstanceOf(CallerPathError);
    }
  });

  it('refuses a symlink inside the data directory that points outside it', async () => {
    const link = join(dataDir, 'escape');
    await symlink(join(outside, 'secret.env'), link);
    await expect(resolveCallerPath(link, opts())).rejects.toBeInstanceOf(CallerPathError);
  });

  it('refuses a write whose parent escapes, even though the file does not exist yet', async () => {
    await expect(
      resolveCallerPath(join(outside, 'new-file.bin'), opts({ mode: 'write' })),
    ).rejects.toBeInstanceOf(CallerPathError);
  });

  it('allows a write to a not-yet-existing file inside the data directory', async () => {
    const target = join(dataDir, 'nested', 'new-file.bin');
    await expect(resolveCallerPath(target, opts({ mode: 'write' }))).resolves.toBe(target);
  });

  it('names the argument and the alternative, so the caller can act on the refusal', async () => {
    await expect(
      resolveCallerPath('/etc/passwd', opts({ argName: 'save_path', alternative: 'Omit it.' })),
    ).rejects.toThrow(/save_path.*Omit it\./s);
  });

  it('accepts the data directory itself', async () => {
    await expect(resolveCallerPath(dataDir, opts())).resolves.toBe(dataDir);
  });

  it('does not accept a sibling directory sharing the data directory prefix', async () => {
    const sibling = `${dataDir}-evil`;
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, 'x'), 'x');
    await expect(resolveCallerPath(join(sibling, 'x'), opts())).rejects.toBeInstanceOf(
      CallerPathError,
    );
  });
});
