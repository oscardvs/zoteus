/**
 * `zoteus index`: what it starts, where it writes, what it refuses, and what it does on
 * the way out.
 *
 * The context here is the fake from tests/tools/search-tools.test.ts (a vi.fn() web client
 * over two canned items, a MemorySearchIndex, a tmpdir data directory), because the point
 * of the command is that it calls zotero_index's real handler: no Zotero and no embedding
 * bill are needed to prove that, and a real library must never be touched by a test.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexCommand, makeInterruptHandler, parseIndexArgs } from '../../src/cli/index-command.js';
import { captureIo } from '../../src/cli/io.js';
import { loadConfig } from '../../src/config.js';
import { FakeEmbeddingProvider } from '../../src/features/search/embeddings.js';
import { MemorySearchIndex, type SearchIndex } from '../../src/features/search/index-manager.js';
import { LibraryRouter } from '../../src/router/library-router.js';

const sampleItems = [
  { key: 'A', data: { itemType: 'journalArticle', title: 'Neural networks', abstractNote: 'deep learning' } },
  { key: 'B', data: { itemType: 'book', title: 'Gardening', abstractNote: 'tomatoes' } },
];

function makeCtx(search: SearchIndex, listItems?: () => Promise<unknown>): any {
  const web = {
    listItems: vi.fn(listItems ?? (async () => ({ data: sampleItems, totalResults: 2, lastModifiedVersion: 1 }))),
  };
  // No desktop app in reach here, so the router pages the cloud Web API.
  const config = loadConfig({ ZOTEUS_LOCAL: 'off' } as any);
  const capabilities = {
    cloud: { userID: 19552201, username: 'oscardvs', access: {} } as any,
    localApi: false,
    localGroupIds: [],
  };
  const dataDir = mkdtempSync(join(tmpdir(), 'zoteus-cli-'));
  return {
    config: { ...config, dataDir },
    capabilities,
    router: new LibraryRouter({ config, capabilities, web: web as any }),
    web,
    search,
    searchIndexPath: join(dataDir, 'search-index.json'),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    localStatus: { ensure: vi.fn(async () => true) },
  };
}

/** A command run whose context is the given fake, with polling fast enough for a test. */
function run(argv: string[], ctx: any, extra: Record<string, unknown> = {}) {
  const io = captureIo();
  return indexCommand(argv, io, { makeContext: async () => ctx, pollMs: 5, ...extra }).then((code) => ({
    code,
    ...io,
  }));
}

describe('zoteus index build', () => {
  it('builds through the tool handler, progress on stderr and the summary on stdout', async () => {
    const ctx = makeCtx(new MemorySearchIndex({ embedder: new FakeEmbeddingProvider() }));
    const { code, stdout, stderr } = await run(['build'], ctx);
    expect(code).toBe(0);
    expect(ctx.web.listItems).toHaveBeenCalled();
    // The result: the tool's own finished-job summary, on stdout, where no transport is.
    expect(stdout).toContain('2 items');
    expect(stdout.trim().split('\n')).toHaveLength(1);
    // Progress and notices: stderr, so `zoteus index build > out` keeps them on screen.
    expect(stderr).toContain('Index build started in the background');
    expect(stderr).toContain('items indexed');
    expect(stderr).toContain(ctx.config.dataDir);
    expect(stderr).toContain('Ctrl-C');
    expect(ctx.search.buildStatus().items).toBe(2);
  });

  it('asks the desktop-app probe for a current answer before the build starts', async () => {
    // registerAllTools does this for every MCP tool call, and a build that skipped it while
    // Zotero was still launching would route to the Web API for its whole run (#22).
    const ctx = makeCtx(new MemorySearchIndex({ embedder: null }));
    const order: string[] = [];
    ctx.localStatus.ensure = vi.fn(async () => {
      order.push('ensure');
      return true;
    });
    const handler = vi.fn(async (args: Record<string, unknown>) => {
      order.push(`handler:${String(args.action)}`);
      return { content: [{ type: 'text' as const, text: 'ok' }], structuredContent: { state: 'done' } };
    });
    const { code } = await run(['build'], ctx, { handler });
    expect(code).toBe(0);
    expect(order[0]).toBe('ensure');
    expect(order[1]).toBe('handler:build');
  });

  it('passes the options through to the tool rather than reimplementing them', async () => {
    const ctx = makeCtx(new MemorySearchIndex({ embedder: null }));
    const handler = vi.fn(async (_args: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: 'ok' }],
      structuredContent: { state: 'done' },
    }));
    await run(
      ['build', '--fulltext', '--limit', '7', '--no-own-words', '--fulltext-max-chars', '0', '--library-type', 'group', '--library-id', '5234875'],
      ctx,
      { handler },
    );
    expect(handler.mock.calls[0]?.[0]).toEqual({
      action: 'build',
      fulltext: true,
      limit: 7,
      own_words: false,
      fulltext_max_chars: 0,
      library_type: 'group',
      library_id: 5234875,
    });
  });

  it('prints one JSON object and nothing else with --json', async () => {
    const ctx = makeCtx(new MemorySearchIndex({ embedder: new FakeEmbeddingProvider() }));
    const { code, stdout } = await run(['build', '--json'], ctx);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.state).toBe('done');
    expect(parsed.items).toBe(2);
  });

  it('exits 1 and keeps stdout clean when the build fails', async () => {
    const ctx = makeCtx(
      new MemorySearchIndex({ embedder: null }),
      async () => {
        throw new Error('Zotero said no');
      },
    );
    const { code, stdout, stderr } = await run(['build'], ctx);
    expect(code).toBe(1);
    expect(stdout).toContain('failed');
    expect(stderr).toContain('Index build started');
    expect(ctx.search.buildStatus().state).toBe('error');
  });

  it('exits 1 and writes nothing to stdout when the tool refuses the job', async () => {
    const search = new MemorySearchIndex({ embedder: null });
    await search.setPaused(true);
    const ctx = makeCtx(search);
    const { code, stdout, stderr } = await run(['build'], ctx);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/paused/i);
    expect(ctx.web.listItems).not.toHaveBeenCalled();
  });

  it('exits 1 rather than throwing when the context cannot be built', async () => {
    const io = captureIo();
    const code = await indexCommand(['build'], io, {
      makeContext: async () => {
        throw new Error('ZOTEUS_INDEX_BACKEND=sqlite needs node:sqlite');
      },
    });
    expect(code).toBe(1);
    expect(io.stdout).toBe('');
    expect(io.stderr).toContain('node:sqlite');
  });

  it('flushes and closes the index on every path, including a thrown handler', async () => {
    const ctx = makeCtx(new MemorySearchIndex({ embedder: null }));
    const save = vi.spyOn(ctx.search, 'save');
    const close = vi.spyOn(ctx.search, 'close');
    const { code, stderr } = await run(['build'], ctx, {
      handler: async () => {
        throw new Error('boom');
      },
    });
    expect(code).toBe(1);
    expect(stderr).toContain('boom');
    // The pair the stdio server runs on shutdown: close() checkpoints the write-ahead log
    // and must run even when save() had nothing to write.
    expect(save).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(close.mock.invocationCallOrder[0]).toBeGreaterThan(save.mock.invocationCallOrder[0] as number);
  });
});

describe('zoteus index status', () => {
  it('reports the index on disk and starts nothing', async () => {
    const ctx = makeCtx(new MemorySearchIndex({ embedder: null }));
    const { code, stdout, stderr } = await run(['status'], ctx);
    expect(code).toBe(0);
    expect(stdout).toContain('0 passages');
    expect(ctx.web.listItems).not.toHaveBeenCalled();
    // No "quit your client first" warning: nothing is being written.
    expect(stderr).toBe('');
  });

  it('exits 1 when the index on disk is unreadable', async () => {
    const ctx = makeCtx(new MemorySearchIndex({ embedder: null }));
    const { code, stdout } = await run(['status'], ctx, {
      handler: async () => ({
        content: [{ type: 'text' as const, text: 'Index build failed: the store cannot be read.' }],
        structuredContent: { state: 'error' },
      }),
    });
    expect(code).toBe(1);
    expect(stdout).toContain('cannot be read');
  });
});

describe('zoteus index against a library that is not the default one', () => {
  /**
   * One data directory now holds one index per library, so every status call the command
   * makes has to name the same library the build named. A poll that omitted it reported on
   * the DEFAULT library's index while the group's build ran: "idle" forever, then exit 0
   * having watched the wrong file.
   */
  it('names the same library on every status poll it makes', async () => {
    const io = captureIo();
    const seen: Record<string, unknown>[] = [];
    let polls = 0;
    const handler = async (args: Record<string, unknown>) => {
      seen.push(args);
      // Building, then building once more, then done: two polls, so a poll that dropped the
      // library pair cannot hide behind a single call.
      const state = args.action === 'status' && ++polls > 1 ? 'done' : 'building';
      return { content: [{ type: 'text' as const, text: 'ok' }], structuredContent: { state, documents: 1 } };
    };
    const code = await indexCommand(
      ['build', '--library-type', 'group', '--library-id', '4523'],
      io,
      { makeContext: async () => makeCtx(new MemorySearchIndex({ embedder: null })) as never, pollMs: 1, handler: handler as never },
    );
    expect(code).toBe(0);
    const statuses = seen.filter((a) => a.action === 'status');
    expect(statuses.length).toBeGreaterThan(0);
    for (const call of [...statuses, seen[0]!]) {
      expect(call.library_type).toBe('group');
      expect(call.library_id).toBe(4523);
    }
  });

  it('stops a job running in a library other than the default one', () => {
    const io = captureIo();
    const defaultIndex = { requestStop: vi.fn(() => false) };
    // The registry is what knows about the group's index; ctx.search is the default one and
    // has no job, which is exactly why asking it alone reported "no job is running".
    const ctx = { search: defaultIndex, indexes: { requestStopAll: vi.fn(() => true) } } as never;
    makeInterruptHandler(ctx, io, () => {})();
    expect(io.stderr).toContain('Stopping after the current page or batch');
    expect(defaultIndex.requestStop).not.toHaveBeenCalled();
  });
});

describe('zoteus index argument handling', () => {
  const bad: [string, string[], RegExp][] = [
    ['no action at all', [], /not an index action/],
    ['an unknown action', ['rebuild'], /not an index action/],
    ['a mistyped flag', ['build', '--fulltex'], /unknown option: --fulltex/],
    ['--limit with no number', ['build', '--limit'], /--limit needs a whole number/],
    ['--limit with a word', ['build', '--limit', 'lots'], /--limit needs a whole number/],
    ['--limit with a fraction', ['build', '--limit', '2.5'], /--limit needs a whole number/],
    ['--poll-ms below the floor', ['build', '--poll-ms', '1'], /--poll-ms needs a whole number/],
    ['--library-type with a bad value', ['build', '--library-type', 'shared'], /"user" or "group"/],
    ['--library-id with a word', ['build', '--library-id', 'mine'], /numeric library id/],
    ['a group with no id, which the tool refuses too', ['build', '--library-type', 'group'], /needs --library-id/],
    ['build options on status, which starts nothing', ['status', '--fulltext'], /status takes no build options/],
    ['build options on status even alongside a library', ['status', '--limit', '10'], /status takes no build options/],
  ];

  for (const [label, argv, expected] of bad) {
    it(`exits 2 without building a context: ${label}`, async () => {
      const io = captureIo();
      const makeContext = vi.fn();
      const code = await indexCommand(argv, io, { makeContext: makeContext as never });
      expect(code).toBe(2);
      expect(io.stdout).toBe('');
      expect(io.stderr).toMatch(expected);
      expect(io.stderr).toContain('usage: zoteus index');
      expect(makeContext).not.toHaveBeenCalled();
    });
  }

  it('prints the index help on stdout and exits 0', async () => {
    const io = captureIo();
    const code = await indexCommand(['--help'], io, { makeContext: vi.fn() as never });
    expect(code).toBe(0);
    expect(io.stdout).toContain('usage: zoteus index');
    // Honest about the thing a user will otherwise assume works.
    expect(io.stdout).toContain('It cannot stop, pause or');
  });

  it('prints the same help, and exits 0, when --help or -h follows the action', async () => {
    // `zoteus index status --help` used to exit 2 with "unknown option: --help": the strict
    // option parser saw it before the help check did.
    for (const argv of [
      ['status', '--help'],
      ['build', '-h'],
      ['build', '--limit', '3', '--help'],
    ]) {
      const io = captureIo();
      const makeContext = vi.fn();
      const code = await indexCommand(argv, io, { makeContext: makeContext as never });
      expect(code, argv.join(' ')).toBe(0);
      expect(io.stdout).toContain('usage: zoteus index');
      expect(io.stderr).toBe('');
      expect(makeContext).not.toHaveBeenCalled();
    }
  });

  it('lets status name a library, now that one data directory holds several indexes', () => {
    const parsed = parseIndexArgs(['status', '--library-type', 'group', '--library-id', '4523']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.action).toBe('status');
      expect(parsed.value.toolArgs).toEqual({ library_type: 'group', library_id: 4523 });
    }
  });

  it('keeps --json and --poll-ms out of the tool arguments', () => {
    const parsed = parseIndexArgs(['build', '--json', '--poll-ms', '250']);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.json).toBe(true);
      expect(parsed.value.pollMs).toBe(250);
      // zotero_index refuses an argument it does not declare, so anything that is the
      // command line's own business must never be forwarded.
      expect(parsed.value.toolArgs).toEqual({});
    }
  });
});

describe('interrupting a build', () => {
  it('asks the build to stop on the first Ctrl-C and quits on the second', () => {
    const io = captureIo();
    const quit = vi.fn();
    const search = { requestStop: vi.fn(() => true) };
    const handler = makeInterruptHandler({ search } as never, io, quit);

    handler();
    expect(search.requestStop).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    expect(io.stderr).toContain('resumes from it');

    handler();
    expect(quit).toHaveBeenCalledWith(130);
    expect(io.stderr).toContain('not checkpointed');
  });

  it('says so instead of claiming a stop when nothing is running', () => {
    const io = captureIo();
    const search = { requestStop: vi.fn(() => false) };
    makeInterruptHandler({ search } as never, io, vi.fn())();
    expect(io.stderr).toContain('No job is running here');
  });
});
