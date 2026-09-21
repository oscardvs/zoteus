/**
 * `zoteus index build|update|refresh|status`: an index job with no MCP client attached.
 *
 * Why this command exists at all, and it is the only justification there is: the docs
 * already tell users to build headlessly against the same ZOTEUS_DATA_DIR because the
 * build is slower inside Claude Desktop (docs/semantic-search.md, and zotero_index's own
 * description says it too), and until now the only way to do that was to launch the stdio
 * server and drive it by hand with an MCP inspector. Everything else a terminal could ask
 * a Zotero library is already one MCP call away, so nothing else is here.
 *
 * It calls `zotero_index`'s handler rather than `startIndexBuild`: the gates (paused
 * holds, the unreadable-store repair, the resume checkpoint), the notices and the
 * resume/refresh semantics all live in the handler, so the command and the model see the
 * same job with the same words. What the handler does NOT carry is what
 * `registerAllTools` wraps around it, and one half of that wrapper matters here:
 * `ctx.localStatus.ensure()`. The startup probe's answer is a function of launch order
 * (#22), so a build started while Zotero is still launching would otherwise route to the
 * slow, rate-limited Web API for its whole run. This calls it for exactly that reason.
 * The other halves are deliberately skipped: the closed-argument parse guards against a
 * model inventing an argument and this file constructs the arguments itself, and the
 * usage recorder counts client tool calls, which an operator command is not.
 */
import { loadConfig } from '../config.js';
import { progressLine } from '../features/search/build.js';
import { createLogger } from '../lib/logger.js';
import { ATTRIBUTION_LINE } from '../lib/notices.js';
import { buildContext } from '../server.js';
import indexTool from '../tools/index-tool.js';
import type { IndexBuildStatus } from '../features/search/backend.js';
import type { ToolContext, ToolHandlerResult } from '../registry/registry.js';
import type { CliIo } from './io.js';

/** Actions the command accepts. `stop`, `pause` and `resume` are deliberately absent: see below. */
const ACTIONS = ['build', 'update', 'refresh', 'status'] as const;
type IndexAction = (typeof ACTIONS)[number];

const isAction = (value: string | undefined): value is IndexAction =>
  value !== undefined && (ACTIONS as readonly string[]).includes(value);

/** Default gap between status polls. Long enough not to spin, short enough to feel live. */
export const DEFAULT_POLL_MS = 2000;

export interface IndexCommandDeps {
  /** Builds the context the handler runs against. Faked in tests; never faked in production. */
  makeContext(): Promise<ToolContext>;
  /** The tool handler. Defaults to zotero_index's, which is the entire point of the command. */
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolHandlerResult>;
  /** Gap between polls, in ms. Overridden by --poll-ms, and by the tests. */
  pollMs: number;
  /** What a second interrupt does. Separated out so the interrupt handler is testable. */
  quit(code: number): void;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** The summary line of a tool result: `ok()` puts it first and the JSON mirror second. */
function summaryOf(res: ToolHandlerResult): string {
  const first = res.content.find((c) => c.type === 'text');
  return first?.text ?? '';
}

function statusOf(res: ToolHandlerResult): IndexBuildStatus | undefined {
  return res.structuredContent as IndexBuildStatus | undefined;
}

export function indexUsage(): string {
  return `usage: zoteus index <build|update|refresh|status> [options]

  build      index the library, resuming an interrupted build from its checkpoint
  update     index only what changed since the last build (the cheap one)
  refresh    rebuild from scratch, re-embedding every passage (with an API embedding
             provider that means paying for all of them again)
  status     print what the index in ZOTEUS_DATA_DIR holds, and start nothing

options (build, update and refresh):
  --fulltext                 also index the body text Zotero extracted from attachments:
                             much slower, much larger, and what makes search match a
                             claim inside a PDF rather than only its title and abstract
  --fulltext-max-chars N     cap indexed body text per item (0 means no cap)
  --limit N                  stop after N items (it can only lower ZOTEUS_INDEX_MAX_ITEMS)
  --library-type user|group  which library to index (default: the configured one)
  --library-id N             its numeric id; required with --library-type group
  --no-own-words             skip child notes and PDF annotations, which are on by default
  --poll-ms N                ms between progress lines on stderr (default ${DEFAULT_POLL_MS})
  --json                     print the final status as one JSON object instead of prose

Progress goes to stderr and the final summary to stdout, so \`zoteus index build --json >
status.json\` keeps the progress on your terminal. Exit code 0 when the job finished, 1
when it failed or was refused, 2 when the command line was wrong.

This command is a separate process from any running server. It cannot stop, pause or
report on a build running inside one: Ctrl-C stops the build THIS command started (the
partial index is kept, and the next \`zoteus index build\` resumes from it), and nothing
here reaches into Claude Desktop. Quit a client that is serving the same ZOTEUS_DATA_DIR
before building here.
`;
}

interface ParsedIndexArgs {
  action: IndexAction;
  json: boolean;
  pollMs: number;
  /** Exactly the arguments zotero_index declares, and nothing else. */
  toolArgs: Record<string, unknown>;
}

type ParseResult = { ok: true; value: ParsedIndexArgs } | { ok: false; error: string };

/** Positive integer, or undefined when the token is not one. Rejects "3.5", "-1", "" and "abc". */
function intArg(raw: string | undefined, min: number): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min ? n : undefined;
}

/**
 * Parse the arguments after `index`. Exported so the refusals are testable without
 * building a context: every one of them is a case where doing the build would be wrong.
 */
export function parseIndexArgs(argv: readonly string[]): ParseResult {
  const [action, ...rest] = argv;
  if (!isAction(action)) {
    return { ok: false, error: `not an index action: ${action ?? '(none)'}` };
  }
  const toolArgs: Record<string, unknown> = {};
  let json = false;
  let pollMs = DEFAULT_POLL_MS;
  let libraryType: 'user' | 'group' | undefined;
  let libraryId: number | undefined;

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] as string;
    const value = rest[i + 1];
    switch (token) {
      case '--json':
        json = true;
        break;
      case '--fulltext':
        toolArgs.fulltext = true;
        break;
      case '--no-own-words':
        toolArgs.own_words = false;
        break;
      case '--limit': {
        const n = intArg(value, 1);
        if (n === undefined) return { ok: false, error: `--limit needs a whole number of items (got ${value ?? '(nothing)'})` };
        toolArgs.limit = n;
        i++;
        break;
      }
      case '--fulltext-max-chars': {
        const n = intArg(value, 0);
        if (n === undefined) {
          return { ok: false, error: `--fulltext-max-chars needs a whole number, 0 for no cap (got ${value ?? '(nothing)'})` };
        }
        toolArgs.fulltext_max_chars = n;
        i++;
        break;
      }
      case '--poll-ms': {
        const n = intArg(value, 10);
        if (n === undefined) return { ok: false, error: `--poll-ms needs a whole number of milliseconds, at least 10 (got ${value ?? '(nothing)'})` };
        pollMs = n;
        i++;
        break;
      }
      case '--library-type': {
        if (value !== 'user' && value !== 'group') {
          return { ok: false, error: `--library-type is "user" or "group" (got ${value ?? '(nothing)'})` };
        }
        libraryType = value;
        i++;
        break;
      }
      case '--library-id': {
        const n = intArg(value, 1);
        if (n === undefined) return { ok: false, error: `--library-id needs a numeric library id (got ${value ?? '(nothing)'})` };
        libraryId = n;
        i++;
        break;
      }
      default:
        // Strict here, unlike the top-level dispatcher: the caller has already named a
        // subcommand, so there is no server to fall through to and a mistyped flag that
        // was silently ignored would start the wrong job (a --fulltex build that quietly
        // indexed no body text is the failure this refuses).
        return { ok: false, error: `unknown option: ${token}` };
    }
  }

  // The tool takes library_type + a numeric library_id, and refuses "group" without an id
  // rather than serving the personal library instead (#74). Said here, before a context is
  // built, in the command line's own words.
  if (libraryType === 'group' && libraryId === undefined) {
    return { ok: false, error: '--library-type group needs --library-id (zotero_groups lists the ids)' };
  }
  // Refused BEFORE the library pair is added: one data directory now holds one index per
  // library, so "which library's index?" is a question status has to be able to answer.
  // Everything else still starts work, and status starts nothing.
  if (action === 'status' && Object.keys(toolArgs).length > 0) {
    return {
      ok: false,
      error: 'status takes no build options: it reports the index on disk and starts nothing (--library-type/--library-id are allowed, to pick which library\'s index)',
    };
  }
  if (libraryType !== undefined) toolArgs.library_type = libraryType;
  if (libraryId !== undefined) toolArgs.library_id = libraryId;
  return { ok: true, value: { action, json, pollMs, toolArgs } };
}

/**
 * Ctrl-C while a build is running.
 *
 * The first one asks the build to stop the way `zotero_index action:"stop"` does: it halts
 * after the current page or batch, keeps everything already indexed and leaves a
 * checkpoint the next build resumes from. The second gives up on that and quits, which is
 * what a plain SIGINT would have done anyway. Separated from the command so both halves
 * can be tested without signalling the test runner.
 */
export function makeInterruptHandler(
  ctx: Pick<ToolContext, 'search' | 'indexes'>,
  io: CliIo,
  quit: (code: number) => void,
): () => void {
  let asked = false;
  return () => {
    if (asked) {
      io.err('Quitting now. The index was not checkpointed; the next `zoteus index build` re-does the work since the last save.\n');
      quit(130);
      return;
    }
    asked = true;
    // Not `ctx.search.requestStop()`: a `--library-id` build runs in that group's own index,
    // which is a different object, so stopping the default one would report "no job is
    // running" while the real job carried on to the next page.
    const stopping = ctx.indexes ? ctx.indexes.requestStopAll() : ctx.search.requestStop();
    io.err(
      stopping
        ? '\nStopping after the current page or batch. What is indexed so far is kept, and the next `zoteus index build` resumes from it. Press Ctrl-C again to quit immediately.\n'
        : '\nNo job is running here. Press Ctrl-C again to quit immediately.\n',
    );
  };
}

/** Build the real context: same config, same logger destination (stderr), no usage recorder. */
async function defaultContext(): Promise<ToolContext> {
  const config = loadConfig(process.env);
  const logger = createLogger(config.logLevel, config.logFormat, { file: config.logFile });
  for (const warning of config.warnings) logger.warn(`Configuration: ${warning}`);
  // citeproc-js is redistributed under the CPAL, whose Exhibit B asks for this line when a
  // session begins (#70). A command is a session too, and this one builds the same context.
  logger.info(ATTRIBUTION_LINE);
  // No usage recorder: it counts client tool calls, and an operator command is not one. It
  // would also take a write handle on usage.sqlite in a data directory a running server may
  // be using.
  return buildContext(config, { telemetry: { logger } });
}

/**
 * Flush and close, always, on every exit path including a failure.
 *
 * This is the same pair the stdio server runs on shutdown, for the same reason: `save()`
 * can legitimately refuse (a store that never opened, or one another process has replaced
 * since this handle read it), and `close()` is what checkpoints the write-ahead log, so it
 * runs either way. A command that exited without them would leave the WAL for the next
 * process to find.
 */
async function flushIndex(ctx: ToolContext): Promise<void> {
  // Every index this command opened, not just the default library's: a `--library-id` build
  // writes into that group's own store, and closing only `ctx.search` would leave the
  // group's write-ahead log uncheckpointed for the next process to find. The registry runs
  // the same save-then-close pair per index, and it holds `ctx.search` too.
  if (ctx.indexes) {
    await ctx.indexes.saveAll().catch((e: unknown) => ctx.logger.debug(`Index save on exit: ${message(e)}`));
    await ctx.indexes.closeAll().catch((e: unknown) => ctx.logger.debug(`Index close on exit: ${message(e)}`));
    return;
  }
  await ctx.search.save().catch((e: unknown) => ctx.logger.debug(`Index save on exit: ${message(e)}`));
  await ctx.search.close().catch((e: unknown) => ctx.logger.debug(`Index close on exit: ${message(e)}`));
}

export async function indexCommand(
  argv: readonly string[],
  io: CliIo,
  deps: Partial<IndexCommandDeps> = {},
): Promise<number> {
  // Anywhere on the line, not only first: `zoteus index status --help` is how someone asks
  // what status takes, and answering it with "unknown option: --help" and exit 2 is wrong
  // twice over. Help wins over everything else on the line, as it does at the top level.
  if (argv.some((token) => token === '--help' || token === '-h')) {
    io.out(indexUsage());
    return 0;
  }
  const parsed = parseIndexArgs(argv);
  if (!parsed.ok) {
    io.err(`zoteus index: ${parsed.error}\n\n${indexUsage()}`);
    return 2;
  }
  const { action, json, toolArgs } = parsed.value;
  // The library pair alone, because every status call in this command has to name the same
  // library the build named: a poll that omitted it would report on the DEFAULT library's
  // index while a group's build ran, i.e. "idle" forever, and then exit 0 having watched
  // the wrong file.
  const libraryArgs: Record<string, unknown> = {};
  if (toolArgs.library_type !== undefined) libraryArgs.library_type = toolArgs.library_type;
  if (toolArgs.library_id !== undefined) libraryArgs.library_id = toolArgs.library_id;
  const pollMs = deps.pollMs ?? parsed.value.pollMs;
  const handler = deps.handler ?? ((args, ctx) => indexTool.handler(args, ctx) as Promise<ToolHandlerResult>);
  const makeContext = deps.makeContext ?? defaultContext;
  const quit = deps.quit ?? ((code: number) => process.exit(code));

  let ctx: ToolContext;
  try {
    ctx = await makeContext();
  } catch (e) {
    io.err(`zoteus index: could not start (${message(e)})\n`);
    return 1;
  }

  const onInterrupt = makeInterruptHandler(ctx, io, quit);
  process.on('SIGINT', onInterrupt);
  try {
    // The one half of registerAllTools this command cannot skip: see the file comment.
    await ctx.localStatus?.ensure();

    if (action !== 'status') {
      // Said before the job starts, because there is no cross-process lock and the index
      // save() refuses rather than overwriting a file another process replaced: a user who
      // leaves Claude Desktop running gets two crawls and one of them is thrown away.
      io.err(
        `Indexing into ${ctx.config.dataDir}. If an MCP client is serving a Zoteus server ` +
          'against that directory, quit it first: two processes indexing one library duplicate the ' +
          'work, and with an API embedding provider they duplicate the bill.\n',
      );
    }

    const started = await handler({ action, ...toolArgs }, ctx);
    if (started.isError) {
      io.err(`${summaryOf(started)}\n`);
      return 1;
    }
    if (action !== 'status') {
      // The tool's own summary ends by naming action:"stop", which is an MCP call nothing
      // in a terminal can make. Say what the cancel actually is here.
      io.err(`${summaryOf(started)}\n`);
      io.err('Press Ctrl-C to stop this job: what is indexed stays searchable and the next `zoteus index build` resumes from the checkpoint.\n');
    }

    let snapshot = statusOf(started);
    let lastLine = '';
    while (snapshot && snapshot.state === 'building') {
      const line = progressLine(snapshot);
      if (line !== lastLine) {
        io.err(`${line}\n`);
        lastLine = line;
      }
      await sleep(pollMs);
      const polled = await handler({ action: 'status', ...libraryArgs }, ctx);
      if (polled.isError) {
        io.err(`${summaryOf(polled)}\n`);
        return 1;
      }
      snapshot = statusOf(polled);
    }

    // Always ends on a fresh status call, so the summary on stdout is the tool's own
    // finished-job wording (statusSummary, with every notice folded in) rather than the
    // start message, whichever way the loop above went.
    const final = await handler({ action: 'status', ...libraryArgs }, ctx);
    if (final.isError) {
      io.err(`${summaryOf(final)}\n`);
      return 1;
    }
    const state = statusOf(final)?.state;
    io.out(json ? `${JSON.stringify(final.structuredContent ?? {}, null, 2)}\n` : `${summaryOf(final)}\n`);
    return state === 'error' ? 1 : 0;
  } catch (e) {
    io.err(`zoteus index: ${message(e)}\n`);
    return 1;
  } finally {
    process.off('SIGINT', onInterrupt);
    await flushIndex(ctx);
  }
}
