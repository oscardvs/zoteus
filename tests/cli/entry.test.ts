/**
 * The entry point as a process, which is the only place the compatibility contract is
 * real: `src/index.ts` is what npx, the Claude Desktop bundle, the Dockerfile and every
 * `claude mcp add` line actually execute.
 *
 * Four claims are pinned here, and the last three are the ones that break every install in
 * the field if they ever stop holding:
 *   1. `--version` and `--help` print and exit 0 without starting a transport.
 *   2. a bare invocation still starts the stdio MCP server;
 *   3. `--http` (with `--port`/`--host`) still starts the HTTP server;
 *   4. an unrecognised flag still falls through to the stdio server rather than erroring.
 *
 * Each server case is killed as soon as it has announced itself, so nothing is left
 * running. No process here is given a Zotero to reach: ZOTEUS_LOCAL=off, no API key, and a
 * throwaway ZOTEUS_DATA_DIR, so a real library is never touched.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * How to run the entry point.
 *
 * `dist/index.js` when the whole of `src/` has been compiled into it: that is the file
 * package.json's `bin` points at, and CI runs `npm run build` before `npm test`, so CI
 * tests the real binary. Otherwise tsx over the TypeScript, because `npm test` does not
 * build and a test that silently exercised a stale `dist/` would report on code nobody is
 * shipping. The comparison is against every source file, not only the four this feature
 * touches, since these cases start the whole server.
 */
function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
}

function entry(): { cmd: string; args: string[]; via: string } {
  const dist = join(repo, 'dist', 'index.js');
  if (existsSync(dist) && statSync(dist).mtimeMs >= newestMtime(join(repo, 'src'))) {
    return { cmd: process.execPath, args: [dist], via: 'dist/index.js' };
  }
  return { cmd: process.execPath, args: ['--import', 'tsx', join(repo, 'src', 'index.ts')], via: 'tsx src/index.ts' };
}

/** A clean environment: no inherited ZOTEUS_/ZOTERO_ settings, nothing that reaches a library. */
function env(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('ZOTEUS_') && !k.startsWith('ZOTERO_')) base[k] = v;
  }
  return {
    ...base,
    ZOTEUS_DATA_DIR: mkdtempSync(join(tmpdir(), 'zoteus-cli-spawn-')),
    ZOTEUS_LOCAL: 'off',
    ZOTEUS_EMBEDDINGS: 'off',
    ZOTEUS_USAGE_LOG: 'false',
  };
}

const running = new Set<ChildProcess>();

afterEach(() => {
  for (const child of running) child.kill('SIGKILL');
  running.clear();
});

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run to completion. Used only for the paths that must exit by themselves. */
function runToExit(args: string[], timeoutMs = 30_000): Promise<Run> {
  const { cmd, args: base } = entry();
  const child = spawn(cmd, [...base, ...args], { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  running.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d) => (stdout += String(d)));
  child.stderr?.on('data', (d) => (stderr += String(d)));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`did not exit within ${timeoutMs}ms; stderr so far: ${stderr}`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      running.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Start it, wait until stderr says the server is up, then kill it. Resolving on the
 * announcement rather than on exit is the point: these invocations are supposed NOT to
 * exit, and a version of this binary that started printing and exiting for them would
 * leave every MCP client with a server that dies on launch.
 */
function runUntilAnnounced(args: string[], announcement: RegExp, timeoutMs = 30_000): Promise<Run> {
  const { cmd, args: base } = entry();
  // stdin is a pipe and stays open: the stdio transport ends the process on EOF.
  const child = spawn(cmd, [...base, ...args], { env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
  running.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d) => (stdout += String(d)));
  return new Promise((resolve, reject) => {
    const finish = (): void => {
      clearTimeout(timer);
      running.delete(child);
      child.kill('SIGKILL');
      resolve({ code: null, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`no ${announcement} within ${timeoutMs}ms; stderr: ${stderr}`));
    }, timeoutMs);
    child.stderr?.on('data', (d) => {
      stderr += String(d);
      if (announcement.test(stderr)) finish();
    });
    child.on('exit', () => {
      clearTimeout(timer);
      running.delete(child);
      resolve({ code: null, stdout, stderr });
    });
  });
}

const version = (JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string }).version;

describe(`the zoteus entry point (${entry().via})`, () => {
  it('prints the version on stdout and exits 0, with no transport', async () => {
    const { code, stdout, stderr } = await runToExit(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toBe(version);
    // No server, so no startup line, no attribution line, no capability probe.
    expect(stderr).not.toMatch(/started on stdio|listening on http/);
  });

  it('prints help on stdout and exits 0, with no transport', async () => {
    const { code, stdout, stderr } = await runToExit(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('zoteus index build');
    expect(stderr).not.toMatch(/started on stdio|listening on http/);
  });

  it('exits 2 on a command line it cannot use, after the dispatch has already claimed it', async () => {
    const { code, stdout, stderr } = await runToExit(['index', 'rebuild']);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('not an index action');
  });

  it('still starts the stdio server on a bare invocation', async () => {
    const { stderr } = await runUntilAnnounced([], /Zoteus MCP server started on stdio\./);
    expect(stderr).toContain('Zoteus MCP server started on stdio.');
  });

  it('still starts the stdio server for an unrecognised flag', async () => {
    // The dispatcher must never turn an argument it does not know into an error: a host
    // that passes one would get a server that refuses to launch, with no log to say why.
    const { stderr } = await runUntilAnnounced(['--not-a-real-flag'], /Zoteus MCP server started on stdio\./);
    expect(stderr).toContain('Zoteus MCP server started on stdio.');
  });

  it('still starts the HTTP server for --http --port --host', async () => {
    const { stderr } = await runUntilAnnounced(
      ['--http', '--port', '0', '--host', '127.0.0.1'],
      /Zoteus MCP server listening on http:\/\//,
    );
    expect(stderr).toMatch(/listening on http:\/\/127\.0\.0\.1:\d+/);
  });
});
