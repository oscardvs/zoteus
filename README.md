<div align="center">

# Zoteus

**Your whole Zotero library, inside Claude.**

An MCP server that gives Claude Desktop, claude.ai, Claude Code, Cursor and any other MCP client access to a [Zotero](https://www.zotero.org) library: search by keyword or by meaning, passages from your PDFs with page numbers, citations in any CSL style, adding items, and safe writes.

[![npm](https://img.shields.io/npm/v/@oscardvs/zoteus.svg?color=2ea44f)](https://www.npmjs.com/package/@oscardvs/zoteus)
[![npm downloads](https://img.shields.io/npm/dm/@oscardvs/zoteus.svg)](https://www.npmjs.com/package/@oscardvs/zoteus)
[![CI](https://github.com/oscardvs/zoteus/actions/workflows/ci.yml/badge.svg)](https://github.com/oscardvs/zoteus/actions/workflows/ci.yml)
[![Node](https://img.shields.io/node/v/@oscardvs/zoteus.svg?color=2ea44f)](https://www.npmjs.com/package/@oscardvs/zoteus)
[![License: MIT](https://img.shields.io/badge/License-MIT-2ea44f.svg)](./LICENSE)

</div>

<img alt="Claude in the browser answering a question from a Zotero library through Zoteus: the question is typed, the Zoteus tools run, and the answer arrives with a verbatim passage, its page number, and APA references." src="docs/assets/demo.gif" width="800">

<sub>A real session, 6 September 2026, against the maintainer's own library. Tool calls are shown as a time-lapse. The <a href="https://zoteus.com">full recording is on zoteus.com</a>.</sub>

## Install

For most clients there is nothing to download: the client fetches Zoteus with `npx` the first time it runs. New to MCP servers? Start with [`docs/getting-started.md`](./docs/getting-started.md).

| Client | How |
|---|---|
| **Claude Desktop** | Download `zoteus.mcpb` from the [latest release](https://github.com/oscardvs/zoteus/releases/latest) and double-click it. |
| **Claude Code** | `claude mcp add --transport stdio zoteus -- npx -y @oscardvs/zoteus` |
| **Cursor, VS Code, Zed, Codex, Gemini CLI, any MCP client** | `npx add-mcp @oscardvs/zoteus`, or add `npx -y @oscardvs/zoteus` as a stdio server by hand. |
| **claude.ai in the browser** | Add a custom connector pointing at a [hosted Zoteus](https://zoteus.com/pricing) or at [your own remote instance](./docs/remote-oauth.md). |

Then run the Zotero desktop app. Reads, and the personal-library writes that go through the app (adding items by identifier, attachments, annotations, trash and restore), need no cloud key. Add a Zotero API key for sync, group libraries, metadata edits, tags and collections, and for when the app is closed:

```bash
claude mcp add --transport stdio zoteus -e ZOTERO_API_KEY=xxxxx -- npx -y @oscardvs/zoteus
```

> Get a key at [zotero.org/settings/keys](https://www.zotero.org/settings/keys). In the desktop app, enable **Settings → Advanced → "Allow other applications on this computer to communicate with Zotero"**. Step-by-step for each client, with screenshots: [zoteus.com/docs/connect-claude-to-zotero](https://zoteus.com/docs/connect-claude-to-zotero/).

> **Updating a desktop-extension install.** A manually installed `.mcpb` (or older `.dxt`) does not auto-update. Turn on **Check for updates** in the extension settings (or set `ZOTEUS_UPDATE_CHECK=true`) and Zoteus asks GitHub once a day, then says so in-chat via `zotero_whoami` when a newer version exists; download the new `zoteus.mcpb` and reinstall. The check is off by default. `npx` installs always run the latest published version.

## What it does

Zoteus exposes 30 tools, namespaced `zotero_*`, that search the library by keyword or by meaning, return passages from your PDFs with page locators, format bibliographies with citeproc-js in any CSL style, add items by DOI or arXiv id, and create, edit, tag and organize items with versioned writes and a reversible trash. When the Zotero desktop app is running, reads and personal-library writes go to it directly and need no cloud API key; the Zotero Web API v3 is the fallback for sync, group libraries, and for when the app is closed. Zoteus is written in TypeScript, runs on your machine, and is MIT licensed.

## Features

- **Search your own library.** Hybrid keyword and semantic search over titles, abstracts, creators, and tags, plus full-text keyword search inside your PDFs and notes, with the matching passage returned together with its page number. Your own notes and PDF annotations are indexed under the item they belong to, so "where did I object to this?" is a question search can answer. Set `ZOTEUS_INDEX_FULLTEXT` (or pass `fulltext:true` to `zotero_index`) and semantic search also covers the body of every PDF, so a claim that never made it into an abstract is still findable.
- **Format citations.** Zoteus reads the citation data in your Zotero library and formats it with [citeproc-js](https://citeproc-js.readthedocs.io) in any [CSL](https://citationstyles.org) style from the CSL styles repository.
- **Add a paper by identifier.** Pass a DOI or arXiv id and Zoteus fetches the metadata and files the item. This works out of the box through built-in resolvers; a Zotero translation-server extends it to ISBN, PMID, and URLs (see [`docs/resolver.md`](./docs/resolver.md)).
- **Write back.** Create items, edit, tag, and organize. Writes are versioned with optimistic-locking retries, trash is reversible by default, and permanent deletion is opt-in and confirmation-gated.
- **Write straight to the desktop app.** Personal-library writes go to your running Zotero, with no cloud API key. On Zotero 10+ this uses the local API behind a key you grant once ("Always Allow"); on Zotero 9 and earlier, whose local API is read-only, it uses the connector protocol the browser extensions use. The cloud Web API is the fallback for group libraries and for when the app is not running.
- **Annotate PDFs and attach files.** `zotero_annotate` adds highlights, underlines, and notes, the same objects the Zotero PDF reader creates. Quote the passage and Zoteus locates it in the PDF and anchors the annotation to the lines it occupies, wrapping and hyphenation included, so no page coordinates are needed. `zotero_attach_file` stores a local file or a URL as an attachment under any item.
- **Ground claims in the PDF.** `zotero_get_fulltext` returns the relevant passage with character offsets, the nearest heading, and a page locator. When Zotero has not indexed the PDF or EPUB, it extracts the text on the fly, from the running desktop app or from Zotero's own storage folder, so a file added a minute ago is readable immediately. It also returns a PDF's table of contents (`outline:true`) and any page range on demand, so working through a 400-page book costs a few small calls rather than one that returns the whole book.
- **Follow the literature.** `zotero_scholar` looks up a paper's references, citing works, and related works through OpenAlex, with Crossref as a fallback, and can flag which of them are already in your library.
- **Agent support.** 30 tools with structured outputs, MCP Resources and Prompts, and a generated tool tree for the [code-execution-with-MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) pattern.

## How it works

1. **Install** with one `npx` command, or the one-click `.mcpb`.
2. **Connect** by running the desktop app for key-free local access, or by pasting your Zotero API key.
3. **Ask.** Your MCP client can now search, cite, add to, and organize your library.

Zoteus detects a running Zotero desktop app and talks to it directly: the key-free local API for reads (full PDFs, saved-search results, the semantic-search index build), and the app itself for personal-library writes (imports, annotations, attachments, trash). The cloud Web API v3 is the fallback, and it is still required for sync, group libraries, and writes when the app is not running. Details: [`docs/writing.md`](./docs/writing.md).

> **Semantic search setup.** The first `zotero_semantic_search` builds the library index in the background. On very large libraries you can also run `zotero_index` (action:"build") yourself, then poll action:"status" until it is done. The build pages your library through the same local-first path as every other read, so it needs no cloud API key while the desktop app is running. That covers your personal library and, on Zotero 10+, any group library the app holds; a key is needed when the app is closed, and for a group the app does not hold.

> **Embedding through an API on a large library.** A full-text build of a 10k-item library is tens of thousands of requests, and at the default pacing the rate rides at OpenAI's tokens-per-minute ceiling whatever your tier. A rate-limited request backs off and retries rather than failing the build, and a build that still ends short keeps everything it indexed: run `zotero_index action:"build"` again and it resumes, embedding only the passages that have no vector yet (`action:"refresh"` is the one that starts over). To pace it up front, set `ZOTEUS_EMBED_BATCH_SIZE=256` and `ZOTEUS_EMBED_BATCH_DELAY_MS=8000`. See [`docs/semantic-search.md`](./docs/semantic-search.md#when-a-build-gets-rate-limited).

> **Vector ranking is opt-in.** Keyword (BM25) search works out of the box everywhere. On-device vectors need `@huggingface/transformers`, which the desktop-extension bundle cannot ship (the resolved dependency tree, onnxruntime's native binaries included, is about 700 MB): install it into a directory of its own (`mkdir -p ~/.zoteus-deps && cd ~/.zoteus-deps && npm init -y && npm i @huggingface/transformers`) and set `ZOTEUS_TRANSFORMERS_PATH` to `~/.zoteus-deps/node_modules`. Not `npm i -g`: Claude Desktop runs the server on its own built-in Node, so a global install under a version manager sits next to a Node the extension never executes. When vectors are unavailable Zoteus says so in `zotero_index` status, `zotero_whoami`, and `zotero_semantic_search` rather than quietly returning nothing. See [`docs/semantic-search.md`](./docs/semantic-search.md).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ZOTERO_API_KEY` | none | Cloud auth (sync, groups, writes without the desktop app; optional otherwise) |
| `ZOTEUS_LOCAL` | `auto` | `auto\|on\|off`: use the Zotero desktop app (reads + personal-library writes) |
| `ZOTEUS_LOCAL_API_KEY` | none | Pre-provision the Zotero 10+ desktop write key (else granted once, in-app) |
| `ZOTEUS_EMBEDDINGS` | `local` | `local\|openai\|gemini\|off` for semantic search |
| `ZOTEUS_EMBEDDING_MODEL` | provider default | The model that provider embeds with, `local` included: `Xenova/multilingual-e5-small` for a German or otherwise multilingual library, `Xenova/all-MiniLM-L6-v2` by default |
| `ZOTEUS_EMBEDDING_DTYPE` | `fp32` | Weight precision of the on-device model: `q8` downloads `Xenova/multilingual-e5-small` at 129 MB instead of 465 MB. Above `fp32` it joins the embedder identity, so changing it needs one rebuild |
| `ZOTEUS_EMBED_BATCH_SIZE` | `32` | Passages per embedding call. Lower it if an API provider rejects a whole request (OpenAI answers `400` above 300K tokens per request) |
| `ZOTEUS_EMBED_BATCH_DELAY_MS` | `0` | Pause between embedding calls. Raise it if an API provider rate-limits a large build: `256` and `8000` together hold a full-text build near 400K tokens/min |
| `ZOTEUS_INDEX_OWN_WORDS` | `true` | Index your own child notes and PDF annotations as searchable passages |
| `ZOTEUS_INDEX_FULLTEXT` | `false` | Index PDF body text for semantic search (opt-in; costly) |
| `ZOTEUS_INDEX_BACKEND` | `auto` | `auto\|sqlite\|memory`: where the search index lives. `auto` uses SQLite (FTS5) on Node 22.13+, which is what a large library needs |
| `ZOTEUS_TRANSFORMERS_PATH` | none | Where to find `@huggingface/transformers` for `local` embeddings when the install can't see it (desktop extension) |
| `ZOTEUS_LOG_FILE` | none | Append every log line to this file, for a server that runs without a terminal |
| `ZOTEUS_ALLOW_DELETE` | `false` | Must be `true` to expose permanent deletion |

Full table in [`docs/configuration.md`](./docs/configuration.md). To run a shared or remote instance, see [`docs/remote-oauth.md`](./docs/remote-oauth.md) (self-host the OAuth remote on loopback or behind your own proxy).

## Documentation

**[zoteus.com/docs](https://zoteus.com/docs)** · [Connect Claude to Zotero](https://zoteus.com/docs/connect-claude-to-zotero/) · [Group libraries for review teams](https://zoteus.com/docs/group-libraries-for-review-teams/) · [Zoteus and zotero-mcp, side by side](https://zoteus.com/docs/zoteus-and-zotero-mcp/)

In this repository: [Getting started](./docs/getting-started.md) · [Configuration](./docs/configuration.md) · [Import & resolver](./docs/resolver.md) · [Architecture](./docs/architecture.md) · [Safe writes](./docs/writing.md) · [Citations](./docs/citations.md) · [Semantic search](./docs/semantic-search.md) · [Scholarly context](./docs/scholar.md) · [Code execution](./docs/code-execution.md) · [Deployment](./docs/deployment.md) · [Uninstall](./docs/uninstall.md)

Zoteus is listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.oscardvs/zoteus`.

## Uninstall

Zoteus writes everything it derives (the search index, the on-device model weights, the update-check cache, the granted local-API key) into one directory: `ZOTEUS_DATA_DIR` if you set it, otherwise your OS's default application-data path. Stop the server, remove it from your MCP client's configuration, then delete that directory; your Zotero library lives elsewhere and nothing here touches it. Full steps and platform paths: [`docs/uninstall.md`](./docs/uninstall.md).

## Privacy

Zoteus runs locally, collects nothing, and has no telemetry. Your library data flows only between your machine and the services you configure (Zotero, and optionally scholarly-graph or embedding providers), directly and under your own keys. Full policy: [`PRIVACY.md`](./PRIVACY.md).

## Contributing

Contributions are welcome; see [`CONTRIBUTING.md`](./CONTRIBUTING.md). Zoteus is MIT licensed.

## Acknowledgements

Built on the [Model Context Protocol](https://modelcontextprotocol.io), the [Zotero Web API](https://www.zotero.org/support/dev/web_api/v3/basics), [citeproc-js](https://citeproc-js.readthedocs.io), and the [Citation Style Language](https://citationstyles.org). Not affiliated with or endorsed by the Corporation for Digital Scholarship / Zotero.
