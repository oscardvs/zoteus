# The `zoteus` command line

Zoteus is an MCP server. The `zoteus` binary's job is to start one, and that has not
changed: with no arguments it serves MCP over stdio, and `--http` serves it over HTTP.
Every installed configuration in the field launches it that way.

On top of that there is a small command line, and it is deliberately small. It exists for
two things only.

## 1. `--version` and `--help`

Before this, `zoteus --version` started an MCP server and printed no version, because every
argument the server did not recognise fell through to the stdio transport. Now:

```console
$ zoteus --version
1.20.1
$ zoteus --help
zoteus 1.20.1: an MCP server for a Zotero library, plus a small command line.
...
```

Both print to stdout and exit 0 without opening a transport.

## 2. `zoteus index`: a build with no MCP client attached

This is the one thing the MCP surface genuinely cannot do, and the reason there is a
command line at all. Building the search index inside Claude Desktop works and produces
exactly the same index, but it is slower there, so the documentation has long told people
to build once in a terminal against the same `ZOTEUS_DATA_DIR` and let the app read the
result. Until now the only way to do that was to launch the stdio server and drive it by
hand with an MCP inspector: start the process, send `initialize`, send
`notifications/initialized`, call `tools/call` for `zotero_index`, keep stdin open, and
poll. One command replaces all of it.

```bash
# The same environment the server reads. On Linux the default data directory is
# ~/.local/share/zoteus; on macOS, ~/Library/Application Support/zoteus.
ZOTEUS_DATA_DIR=~/.local/share/zoteus npx -y @oscardvs/zoteus index build --fulltext

# Or, with the package installed globally:
ZOTEUS_DATA_DIR=~/.local/share/zoteus zoteus index build --fulltext
```

```
zoteus index build      index the library, resuming an interrupted build from its checkpoint
zoteus index update     index only what changed since the last build (the cheap one)
zoteus index refresh    rebuild from scratch, re-embedding every passage
zoteus index status     report what the index in ZOTEUS_DATA_DIR holds, and start nothing
```

Options for `build`, `update` and `refresh`:

| Option | What it does |
| --- | --- |
| `--fulltext` | also index the body text Zotero extracted from attachments |
| `--fulltext-max-chars N` | cap indexed body text per item (`0` means no cap) |
| `--limit N` | stop after N items (it can only lower `ZOTEUS_INDEX_MAX_ITEMS`) |
| `--library-type user\|group` | which library to index |
| `--library-id N` | its numeric id, required with `--library-type group` |
| `--no-own-words` | skip child notes and PDF annotations, which are indexed by default |
| `--poll-ms N` | milliseconds between progress lines (default 2000) |
| `--json` | print the final status as one JSON object instead of prose |

Progress goes to **stderr**, the final summary to **stdout**, so
`zoteus index build --json > status.json` leaves the progress on your terminal. Exit codes:
`0` the job finished, `1` it failed or was refused, `2` the command line was wrong.

The command calls `zotero_index`'s own handler rather than reimplementing the build, so the
gates, the notices, the resume checkpoint and the refresh semantics are the same ones the
model gets, described in the same words. See
[Semantic search](semantic-search.md) for what those actions mean.

### What it will not do

- **It cannot stop, pause or report on a build running inside another process.** A running
  Claude Desktop holds its own index in its own memory; nothing here reaches into it.
  `Ctrl-C` stops the build *this command* started: the partial index stays searchable and
  the next `zoteus index build` resumes from the checkpoint. A second `Ctrl-C` quits at
  once, without that checkpoint.
- **There is no cross-process lock.** Quit a client that is serving the same
  `ZOTEUS_DATA_DIR` before building here. Two processes indexing one library duplicate the
  crawl, with an API embedding provider they duplicate the bill, and only one of them can
  save the result (the index refuses to write its older state over a file another process
  replaced, and logs that it did so).
- **It is not a way to search, cite or edit a library from a terminal.** Those are all one
  MCP call away already, and duplicating them here would be a second surface to keep
  correct for an audience that, by design, does not open a terminal.

## Compatibility: what is and is not treated as a command

Only the **first** argument is examined, and only three values are claimed: `--version`
(`-V`), `--help` (`-h`), and the literal subcommand `index`. Everything else takes the
server path exactly as before:

| Invocation | What happens |
| --- | --- |
| `zoteus` | stdio MCP server |
| `zoteus --http --port 3939 --host 0.0.0.0` | HTTP MCP server |
| `zoteus --not-a-real-flag` | stdio MCP server (an unknown flag is not an error) |
| `zoteus --http --version` | HTTP MCP server (the flag is not first) |
| `zoteus serve` | stdio MCP server (not a known subcommand) |

An allowlist rather than "any argument that does not start with a dash", because the cost
of being wrong is asymmetric: a client that passes an argument nobody anticipated must
still get its server, and it would fail inside a host that shows no logs. Every row above is
pinned by `tests/cli/dispatch.test.ts`, and `tests/cli/entry.test.ts` spawns the real binary
for the bare, `--http` and unknown-flag cases and waits for the server to announce itself.

The command line path loads config and builds a context of its own, and it does **not**
open the usage database: usage counts client tool calls, and an operator command is not
one.

## On benchmarking

The audit asked for a benchmark before building this. A meaningful one is not possible in
the development environment: it needs a real library of a realistic size, a real embedding
provider, and a Claude Desktop install to compare against, and the number it produced would
describe that one machine's disk and CPU. No such benchmark was run, and none is quoted
here.

What can be stated exactly is the capability difference, which is what justified the
command in the first place: **the CLI runs an index build with no MCP client attached.**
Everything else `zoteus index` does, an MCP client can already do by calling `zotero_index`.
The speed claim ("slower inside the desktop app") is the existing one from
[Semantic search](semantic-search.md) and belongs to the Electron allocator workaround
documented there, not to this command.
