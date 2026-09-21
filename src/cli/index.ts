/**
 * The `zoteus` command line.
 *
 * This binary's job is, and stays, "start an MCP server": every installed config in the
 * field (README's `claude mcp add ... -- npx -y @oscardvs/zoteus`, mcp.json, the Claude
 * Desktop bundle's manifest, the Dockerfile's `--http --port 3939`) launches it with no
 * arguments or with the three transport flags. So the command line is strictly additive
 * and deliberately tiny:
 *
 *  - `--version` / `--help` print and exit, because today they start a server and print
 *    nothing at all, which is a plain defect;
 *  - `zoteus index ...` runs an index build with no MCP client attached, which is the one
 *    thing the MCP surface genuinely cannot do (docs/semantic-search.md has told users to
 *    build headlessly against the same ZOTEUS_DATA_DIR since before any command existed).
 *
 * THE DISPATCH RULE IS THE WHOLE COMPATIBILITY STORY. `cliCommand()` recognises exactly
 * three first arguments: `--version`, `--help`, and the literal subcommand `index` (plus
 * the `-V`/`-h` short forms). Everything else, including an unrecognised flag, an
 * unrecognised positional, and anything after the first argument, returns undefined and
 * takes the server path exactly as it does today. An allowlist rather than "any token
 * that does not start with a dash" because the cost of being wrong is asymmetric: a
 * client that passes an argument we did not anticipate must still get its server, and a
 * user who mistypes a subcommand gets a server rather than an error only until they read
 * `--help`.
 *
 * Nothing here loads config, opens the usage database or builds a context: `src/index.ts`
 * dispatches before any of that, so `zoteus --version` touches no disk.
 */
import { indexCommand, indexUsage, type IndexCommandDeps } from './index-command.js';
import type { CliIo } from './io.js';

/** Subcommands the dispatcher claims. Everything not in here belongs to the server. */
const SUBCOMMANDS = ['index'] as const;

export type CliInvocation = 'version' | 'help' | (typeof SUBCOMMANDS)[number];

/**
 * Which command this argv asks for, or undefined when it is not a CLI invocation at all
 * and must be handed to the server unchanged.
 *
 * Only argv[0] is examined. `zoteus --http --version` is a server launch: the flag is not
 * in first position, so nothing here claims it.
 */
export function cliCommand(argv: readonly string[]): CliInvocation | undefined {
  const first = argv[0];
  if (first === undefined) return undefined;
  if (first === '--version' || first === '-V') return 'version';
  if (first === '--help' || first === '-h') return 'help';
  return (SUBCOMMANDS as readonly string[]).includes(first)
    ? (first as CliInvocation)
    : undefined;
}

export interface CliOptions {
  /** The version `--version` prints. Passed in so this module never re-reads package.json. */
  version: string;
  /** Injection seam for the tests; production passes nothing and gets the real context. */
  deps?: Partial<IndexCommandDeps>;
}

/** The top-level help. Honest about what the CLI does and does not replace. */
export function usage(version: string): string {
  return `zoteus ${version}: an MCP server for a Zotero library, plus a small command line.

With no arguments zoteus starts an MCP server on stdio. That is how MCP clients launch
it and it is unchanged: only the three commands below are handled here, and only when
they are the FIRST argument, so a client passing flags of its own always gets a server.

Server (unchanged):
  zoteus                          start the MCP server on stdio
  zoteus --http [--port N] [--host H]
                                  start the MCP server over HTTP (default port 3939)

Commands:
  zoteus index build [options]    build the search index with no MCP client attached
  zoteus index update [options]   index only what changed since the last build
  zoteus index refresh [options]  rebuild from scratch, re-embedding every passage
  zoteus index status             report what the index in ZOTEUS_DATA_DIR holds
  zoteus --version, -V            print ${version} and exit
  zoteus --help, -h               print this and exit

Run \`zoteus index --help\` for the build options.

The index commands read the same ZOTEUS_* environment as the server and write the same
index in the same ZOTEUS_DATA_DIR, so a build run here is one Claude Desktop does not
have to run. They do not talk to a running server: see docs/cli.md.
`;
}

/**
 * Run a CLI invocation and return the process exit code.
 *
 * 0 succeeded, 1 the command ran and failed, 2 the command line was wrong. Returns rather
 * than exiting so that the tests can call it directly; `src/index.ts` owns the exit.
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
  opts: CliOptions,
): Promise<number> {
  switch (cliCommand(argv)) {
    case 'version':
      io.out(`${opts.version}\n`);
      return 0;
    case 'help':
      io.out(usage(opts.version));
      return 0;
    case 'index':
      return indexCommand(argv.slice(1), io, opts.deps);
    default:
      // Unreachable from src/index.ts, which only calls this once cliCommand() has named a
      // command, and which sends everything else to the server. Reported rather than
      // thrown so a future caller that skips the check gets a usable message.
      io.err(`zoteus: not a command: ${argv[0] ?? ''}\n\n${usage(opts.version)}`);
      return 2;
  }
}

export { indexUsage };
export type { CliIo, IndexCommandDeps };
