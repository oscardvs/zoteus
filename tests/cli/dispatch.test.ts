/**
 * The dispatch rule, which is the whole compatibility story of the command line.
 *
 * Every installed Zoteus in the field launches this binary with no arguments or with the
 * transport flags, and none of them shows the operator a log. So the rule that decides
 * "command line" from "server" is pinned here, argument list by argument list, including
 * the exact launch lines shipped in the Dockerfile, the Claude Desktop manifest, mcp.json
 * and the README. A change that starts claiming one of these breaks installs silently.
 */
import { describe, it, expect, vi } from 'vitest';
import { cliCommand, runCli, usage } from '../../src/cli/index.js';
import { captureIo } from '../../src/cli/io.js';

/** argv (already sliced past node and the script) that must reach the server untouched. */
const SERVER_ARGV: [string, string[]][] = [
  ['a bare invocation, which is how every stdio client launches it', []],
  ['the HTTP flag alone', ['--http']],
  ['the HTTP flags as the Dockerfile passes them', ['--http', '--port', '3939', '--host', '0.0.0.0']],
  ['--port without --http', ['--port', '3939']],
  ['an unrecognised flag', ['--not-a-real-flag']],
  ['a near miss on --version', ['--versions']],
  ['an unrecognised short flag', ['-x']],
  ['an unrecognised positional', ['serve']],
  ['a path, as a wrapper might pass one', ['/opt/zoteus/dist/index.js']],
  ['--version after another flag', ['--http', '--version']],
  ['--help after another flag', ['--http', '--help']],
  ['a subcommand that is not first', ['--http', 'index']],
  ['an empty first argument', ['']],
];

/** argv the command line claims. */
const CLI_ARGV: [string[], string][] = [
  [['--version'], 'version'],
  [['-V'], 'version'],
  [['--help'], 'help'],
  [['-h'], 'help'],
  [['index'], 'index'],
  [['index', 'build', '--fulltext'], 'index'],
  [['index', '--help'], 'index'],
];

describe('cliCommand', () => {
  for (const [label, argv] of SERVER_ARGV) {
    it(`leaves the server path alone: ${label}`, () => {
      expect(cliCommand(argv)).toBeUndefined();
    });
  }

  for (const [argv, expected] of CLI_ARGV) {
    it(`claims ${JSON.stringify(argv)} as ${expected}`, () => {
      expect(cliCommand(argv)).toBe(expected);
    });
  }
});

describe('runCli', () => {
  it('prints exactly the version and nothing else, without building a context', async () => {
    const io = captureIo();
    const makeContext = vi.fn();
    const code = await runCli(['--version'], io, { version: '9.9.9', deps: { makeContext } });
    expect(code).toBe(0);
    expect(io.stdout).toBe('9.9.9\n');
    expect(io.stderr).toBe('');
    expect(makeContext).not.toHaveBeenCalled();
  });

  it('prints help on stdout, naming both the server default and the index command', async () => {
    const io = captureIo();
    const makeContext = vi.fn();
    const code = await runCli(['--help'], io, { version: '9.9.9', deps: { makeContext } });
    expect(code).toBe(0);
    expect(io.stderr).toBe('');
    expect(io.stdout).toContain('start the MCP server on stdio');
    expect(io.stdout).toContain('zoteus index build');
    expect(io.stdout).toContain('9.9.9');
    expect(makeContext).not.toHaveBeenCalled();
  });

  it('refuses rather than guessing when called directly with a non-command', async () => {
    const io = captureIo();
    const code = await runCli(['--not-a-real-flag'], io, { version: '9.9.9' });
    expect(code).toBe(2);
    expect(io.stdout).toBe('');
    expect(io.stderr).toContain('not a command');
  });

  it('never claims to be anything but an MCP server in its first sentence', () => {
    // The help is the one place the product describes itself to someone at a terminal, and
    // the audience for this binary is MCP clients. If that sentence ever stops being true
    // the CLI has grown past what was justified.
    expect(usage('1.0.0').split('\n')[0]).toContain('MCP server');
  });
});
