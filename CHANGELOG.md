# Changelog

All notable changes to Zoteus are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.7.1] - 2026-08-26

### Fixed
- **The desktop extension no longer crashes on startup in recent Claude Desktop versions**
  (#18, thanks @StianOby). The shared Cowork/Code server pool expects `initialize` to be
  answered promptly and tears the server down when it is not, and zoteus was taking two
  seconds or more to reply: it built its whole context first, which retries the desktop
  local API while Zotero starts, checks the cloud key, and opens the search index. The
  stdio transport now connects before that build rather than after it, so the handshake
  and the tool list (both of which need only the configuration) are answered in
  milliseconds while the context builds behind them. Tool calls still wait for it, so
  none of them ever sees a half-built context.
- **A second zoteus process no longer kills the first** (#18). SQLite fails a contended
  lock instantly by default, so two servers sharing a data dir — which is what a host
  does when it probes by spawning a disposable server alongside the real one — could both
  abort at startup with `database is locked`. The index now waits for the lock, and
  tolerates a journal-mode switch another connection is already holding.
- A failed startup no longer takes the stdio server down with it. The failure is logged,
  reported as the error on any tool call that needs the context, and retried by the next
  one, instead of exiting the process and leaving the host to report a bare disconnect.

## [1.7.0] - 2026-08-25

### Added
- **Group libraries are served from the desktop app when it holds them** (#12, #14, thanks
  @MinhHaDuong). Zotero 10 serves `/groups/<id>` on the local API, so zoteus now probes
  which groups the desktop holds at startup (and again if Zotero starts later), routes
  those reads locally with no cloud key, and still sends groups the app does not hold to
  the Web API. One server and one index cover the personal library plus groups.
- **The index item cap is configurable** (#11, #13, thanks @MinhHaDuong).
  `ZOTEUS_INDEX_MAX_ITEMS` (default 5000) replaces the hardcoded cap. A build that
  truncates now says so, naming the real library size next to what was indexed, in the
  build status, in `zotero_semantic_search` results, and after a restart.
- **SQLite full-text index backend** (#10). On Node 22.13+ the search index lives in
  SQLite with FTS5 (built-in `node:sqlite`, no new dependency), removing the 512 MB
  persistence ceiling and the multi-gigabyte memory residency of the JSON index: builds
  are faster, reloads are instant, and keyword search never materializes the corpus in
  memory. `ZOTEUS_INDEX_BACKEND` selects `auto` | `sqlite` | `memory`; the JSON backend
  remains the fallback on older Node. Small existing JSON indexes are imported
  automatically, oversized ones get an explicit rebuild notice.
- **Incremental index updates** (#16). `zotero_index action:"update"` fetches only items
  changed since the last stamped library version, re-embeds only their passages, and
  reconciles deletions with a cheap key census. It falls back to a full rebuild, saying
  why, whenever the stamp, serving backend, or embedding model cannot be trusted.
- **Configurable embeddings** (#15). `ZOTEUS_EMBEDDING_MODEL`, `ZOTEUS_EMBED_BATCH_SIZE`
  and `ZOTEUS_EMBED_BATCH_DELAY_MS` tune the OpenAI/Gemini embedding calls for large
  builds and per-tier rate limits. The model is stamped into the index; switching models
  drops the stale vectors with a visible notice instead of mixing vector spaces.
- **Desktop settings** (#9): the extension settings screen now exposes full-text
  characters per item (0 = no cap), the item cap, and the embedding model, batch size
  and delay.

### Fixed
- A blank environment variable (an empty field in the desktop settings screen, or a bare
  `KEY=` line in `.env`) no longer crashes boot or, for `ZOTEUS_DATA_DIR`, silently
  relocates the data directory: blank now means unset everywhere.
- Index persist failures are recorded on the build status (`persistError`) and surfaced
  wherever status is read, instead of vanishing into a log warning while the build
  reports done (#10).

## [1.6.0] - 2026-08-20

### Added
- **Semantic search can now cover the full text of your PDFs, not just metadata and
  abstracts** (#8). The index has always been built from title, abstract, creators and
  tags, so a claim that appears only on page 9 of a paper was unfindable by meaning. Full
  text is now an opt-in extra pass over the same build:
  - `zotero_index action:"build" fulltext:true` (or `ZOTEUS_INDEX_FULLTEXT=true` as the
    default for every build) indexes the body text Zotero extracted from each item's
    attachments as additional passages. `fulltext_max_chars` /
    `ZOTEUS_INDEX_FULLTEXT_MAX_CHARS` caps how much of each item is indexed (default
    40000 characters, about 13 pages; `0` = no cap).
  - Body passages carry their **parent item's** key and title, so a hit lands on the paper
    rather than the attachment, and one paper cannot flood the results. Hits whose snippet
    came from a PDF body are marked `source: "fulltext"` so the passage can be quoted and
    located with `zotero_get_fulltext`.
  - **Key-free, local-first.** Zotero 7+ serves the `/fulltext` endpoints from the desktop
    app, so this works with no cloud API key, like every other read. Group libraries (and
    everything when the app is closed) go to the cloud Web API.
  - The resolution costs two library-wide reads instead of per-item probing: one
    `/fulltext?since=0` call names the attachments that have extracted text, and paging
    `itemType=attachment` maps them to their parents. Only that intersection is fetched.
  - Off by default because it is genuinely expensive: measured on a 212-item library with
    151 extracted PDFs, roughly 9x the passages (687 -> 6246) and 20x the index file
    (0.4 MB -> 7.9 MB), with the embedding stage growing by the same factor.
  - `zotero_index action:"status"` reports `fulltextEnabled`, `fulltextItems` and
    `fulltextPassages`; when full text was requested but produced nothing (no extracted
    attachments, unreachable endpoints) the build still completes as a metadata index and
    `fulltextReason` says why, rather than looking complete.

### Fixed
- **A redeploy no longer wedges a connected client.** A session id this process never
  issued (any restart drops the in-memory transports, and sessions are also reaped) was
  answered with `400`, which clients treat as a plain bad request: every later call kept
  failing, plain reads included, until the user reconnected the connector by hand. The
  Streamable HTTP spec makes `404` the signal a client MUST answer by re-initializing, so
  it is now a `404` and clients heal themselves. A request with no session id at all is
  still a `400`.
- **Full-text reads no longer require a cloud API key.** `zotero_get_fulltext` and
  `zotero_fulltext` (`get`/`since`) went to `api.zotero.org` unconditionally, so in
  local-only mode (no key, personal library addressed as `users/0`) they failed outright
  even though the running desktop app serves the very same endpoints. Both now route like
  every other read: desktop app first, cloud when it is closed or the library is a group.
  `zotero_fulltext action:"set"` is a write and stays on the cloud Web API.

## [1.5.0] - 2026-08-20

### Fixed
- **File attachments now work without the Zotero desktop app.** Every write path that
  stores a file was gated on desktop access, so on a remote or hosted Zoteus (a claude.ai
  custom connector, or any server not on the user's machine) attaching a PDF was
  impossible: `zotero_attach_file` refused with "storing files needs Zotero desktop write
  access", and `zotero_import` saved the metadata but reported `attach_url is only
  supported for desktop-app saves; the file was not attached`. Both suggested granting
  Zotero write access, which cannot help: the desktop local API listens on the *user's*
  `127.0.0.1:23119`, and a server elsewhere has no route to it. The cloud Web API does
  support file uploads, and Zoteus already implemented that protocol for
  `zotero_attachment action:"upload"`, but only from a file on the server's own disk.
  Now the bytes can come from a URL and the upload runs from memory:
  - `zotero_attach_file` uses the desktop app when it is reachable and the cloud Web
    API's File Storage protocol when it is not, so `url` works on every deployment. It
    also takes `library_type`/`library_id` for attaching in a group library.
  - `zotero_import`'s `attach_url` is no longer desktop-only; on a cloud save it uploads
    the file into Zotero storage. As on the desktop paths, a failure degrades to a
    `warning` rather than failing an import that already saved.
  - `zotero_attachment action:"upload"` accepts `url` alongside `file_path`, which on a
    remote server refers to a disk the caller cannot write to.
  - A file fetched from the web is stored as `imported_url` keeping its source URL (what
    Zotero itself records for a downloaded PDF), and an extension is appended from the
    served content type, since arXiv-style PDF URLs carry none.
  - On Zotero 9 and earlier (read-only local API) the desktop attempt fails before
    anything is created, so the call now retries on the cloud instead of dead-ending. A
    failure *after* the attachment item exists is reported rather than retried, so a
    partial write cannot silently produce a duplicate.

## [1.4.2] - 2026-08-19

### Fixed
- **Semantic search no longer fails silently when the embedder cannot run** (#7). With
  `ZOTEUS_EMBEDDINGS=local` and `@huggingface/transformers` absent, Zoteus fell back to
  keyword-only search but kept reporting `embedder: "local"`, and `mode:"semantic"`
  returned `{"hits": []}`, indistinguishable from a library with no matches. The only
  signal was one stderr line, which desktop clients discard. Now:
  - `zotero_index action:"status"` reports the **effective** embedder plus
    `embedderConfigured`, `embedderActive` and an actionable `embedderReason`, so
    `embedder` reads `none (local requested; @huggingface/transformers is not installed)`.
  - `zotero_semantic_search mode:"semantic"` returns an explicit error naming the cause
    when the index holds 0 vectors; `auto` still answers from BM25 and says vector
    ranking is off.
  - `zotero_whoami` reports embedding health alongside identity.
  - The provider is preflighted at startup (resolve-only, nothing executed), so the
    degradation is known before a build silently produces an empty vector set, and a
    failure recorded mid-build survives into every later status call instead of living
    in one build's local scope.

### Added
- **`ZOTEUS_TRANSFORMERS_PATH`**: resolve `@huggingface/transformers` from outside the
  install. Desktop-extension bundles resolve modules only from inside themselves and
  cannot ship the package (`onnxruntime-node` is statically imported and its prebuilt
  native binaries total ~384 MB across platforms), which left `.mcpb` users with no
  route to on-device vectors at all. Install it anywhere (`npm i -g
  @huggingface/transformers`) and point this at the directory `npm root -g` prints; it
  accepts that path, the package directory, or an npm prefix, and it survives extension
  updates. Exposed in the bundle as the **"Local embeddings path"** setting.

## [1.4.1] - 2026-08-19

### Changed
- **Desktop extension migrated from `.dxt` to MCP Bundles (`.mcpb`)** for official
  directory submission (#6). The manifest is now `manifest_version` 0.3, packed with
  `@anthropic-ai/mcpb` (validated in CI before packing), and declares the new
  `PRIVACY.md` via `privacy_policies`. Releases now attach `zoteus.mcpb` instead of
  `zoteus.dxt`; the update notice names the new bundle.

### Added
- `PRIVACY.md` privacy policy and a README privacy section: Zoteus collects nothing,
  has no telemetry, and only contacts the services you configure, directly from your
  machine.

## [1.4.0] - 2026-08-19

### Added
- **Update notices for manually installed builds** (#6). Claude only auto-updates
  desktop extensions installed from the official directory, so a hand-installed
  `zoteus.dxt` never learns about new versions. Zoteus now checks the latest GitHub
  release once a day (cached on disk, a single unauthenticated GET, no user data sent)
  and surfaces a notice through `zotero_whoami` and the stderr log. On `.dxt` installs
  (the manifest now sets `ZOTEUS_DIST=dxt`) the notice includes download-and-reinstall
  instructions. Opt out with `ZOTEUS_UPDATE_CHECK=false`.

### Fixed
- The README install table pointed at a `zoteus.mcpb` release asset that releases do
  not ship; the actual asset is `zoteus.dxt`.

## [1.3.1] — 2026-08-18

### Fixed
- **Semantic-search indexing no longer requires a cloud key while Zotero runs** (#5).
  The index build fetched items through the cloud Web API unconditionally; it now pages
  through the same local-first router as every other read, so a running desktop app
  serves the build key-free (group libraries and app-closed builds still use the cloud).
  Also fixes a local-API pagination bug where a missing `Total-Results` header was read
  as `0`, silently truncating a local build after the first page. README and docs now
  state the actual key rule.
- **`zotero_import` attaches `attach_url` on both desktop write paths.** The connector
  protocol (Zotero 9 and earlier) streamed the file into its save session, but the
  Zotero 10 local-API save path ignored `attach_url` entirely and left the imported item
  with no attachment. That path now downloads the file and stores it as an
  `imported_file` child of the saved item through the local API's 3-phase upload — the
  same flow `zotero_attach_file` uses — honouring `attach_title` and deriving a bare
  file name (with the extension the content type implies) from the URL. A failed
  download or upload degrades to a `warning` on an otherwise-successful import instead
  of failing the save, since the items are already in the library.

## [1.3.0] — 2026-08-18

### Fixed
- **Zotero 10 local-API writes.** Local-API write support shipped in Zotero 10 (Zotero 9
  and earlier expose a read-only, GET-only local API), and the shipped protocol differs
  from what the write client was built against. Verified against `zotero/zotero @ 10.0.0`,
  `chrome/content/zotero/xpcom/server/server_localAPI.js`:
  - `POST /api/local/authorize` is itself a write method and does not opt out of the
    server-ID precondition, so the grant request must carry `Zotero-Server-ID`. Zoteus
    sent it on writes but not on the grant, which made every first-time grant fail with
    `428 Precondition Required`. The server ID is now probed before authorizing, and a
    stale one (412) is re-probed once.
  - Multi-object `DELETE` *requires* `If-Unmodified-Since-Version`, and key-based writes
    require it or a per-object `version` (428 otherwise). The client now tracks the
    library version alongside the server ID and refreshes both on 412/428.
  - There is no `/items/deleted` write endpoint; permanent deletes go to
    `DELETE …/items?itemKey=…`, chunked to the local API's 50-object batch limit.
- **Trash no longer erases on the desktop path.** `zotero_trash_items` and
  `zotero_annotate` (`action:"delete"`) previously issued the local API's `DELETE`,
  which — exactly like the Web API's — purges items outright rather than trashing them.
  They now write `deleted: 1` (and `deleted: 0` to restore), which is what "trash" means
  and what the tool descriptions promise.
- `isLocalWritesUnavailable()` now also recognises 501 `Endpoint does not support method`
  and the "no `Zotero-Server-ID` header" signal, so a Zotero 9 desktop correctly falls
  back to the connector protocol instead of surfacing a hard tool error.
- `zotero_attach_file` strips any path separators from the requested file name, which
  Zotero rejects outright.

### Added
- `zotero_delete_items` routes permanent deletes for the personal library through the
  running Zotero desktop app when it accepts local-API writes, falling back to the cloud
  Web API otherwise.

### Changed
- Docs and tool descriptions now say **Zotero 10+** for desktop local-API writes (they
  said "Zotero 9+", written against pre-release behaviour) and "Zotero 9 and earlier"
  for the read-only local API that falls back to the connector protocol.

## [1.2.0] — 2026-08-18

### Added
- **PDF annotation tools.** New `zotero_annotate` adds and deletes Zotero PDF
  annotations — highlights, underlines, and notes — the same objects the PDF reader
  creates (`annotationType`, `annotationText`, `annotationComment`, `annotationColor`,
  `annotationPosition` as `{"pageIndex":N,"rects":[[x1,y1,x2,y2],...]}` in native PDF
  points (bottom-left origin), and a reader-compatible `annotationSortIndex`). It
  resolves the PDF attachment from any parent item, or accepts an attachment key
  directly. New `zotero_attach_file` stores a local file or URL as an `imported_file`
  attachment under an item where the desktop app supports local-API writes.
- **Desktop writes, two paths.** `zotero_annotate`, `zotero_attach_file`,
  `zotero_trash_items` and `zotero_import` (save) now write straight to the running
  Zotero desktop app for the personal library — no cloud key required:
  - On Zotero builds with local-API write support, writes use the user-granted local
    key (`POST /api/local/authorize`; cached under the data dir as
    `local-api-key.json`, pre-provisionable via `ZOTEUS_LOCAL_API_KEY`), carrying the
    required `Zotero-Server-ID` header and transparently re-authorizing on 401 /
    re-probing on 412/428.
  - On Zotero versions whose local API is still read-only (≤ 9.0), writes fall back to
    the desktop connector protocol (`saveItems`/`saveAttachment`/`updateSession`) — no
    grant dialog; created keys are recovered by polling the local API. `zotero_import`
    gained `attach_url`/`attach_title` to stream a file (e.g. an arXiv PDF) into the
    same save session, and `collection_key` targeting for desktop saves.
  - The cloud Web API remains the fallback when the desktop app is not running or a
    group/other library is targeted.
- **PDF full-text fallback.** `zotero_get_fulltext` now serves text even when Zotero
  has not indexed a PDF: it downloads the attachment and extracts text on the fly
  (optional pdfjs-dist), with exact page locators (`fulltextSource:"pdf"`). Opt out
  with `fallback:false`. OOM size guard shared with `precise_pages`.
- **Semantic-search first-use UX.** `zotero_semantic_search` auto-starts the index
  build on first use (`auto_build`, default true) and reports progress instead of
  failing silently; `zotero_index` builds now run as a background job (poll
  `action:"status"`, cancel with `action:"stop"`), persisting partial progress
  atomically.

### Fixed
- Child-item listing on the desktop read path returned the **entire library**: the
  local API silently ignores the `parentItem` query param, so `zotero_get_item`
  (`include_children`) and `zotero_annotate`'s PDF-attachment resolution scored every
  item in the library. Children are now fetched via `/items/<key>/children`.
- Import save errors now surface as actionable results instead of unhandled
  rejections (`await maybeSave`); pdfjs no longer detaches caller buffers.

## [1.1.0] — 2026-08-14

### Added
- `zotero_import` no longer dies when the translation-server is unreachable: DOI and arXiv
  ids now resolve through a built-in server-side fallback (OpenAlex/Crossref for DOIs, the
  export.arxiv.org Atom feed for arXiv ids), with a `source` field on results for
  provenance. ISBN/PMID/bibcode and URL scraping still require a translation-server and say
  so explicitly. See `docs/resolver.md`. arXiv calls are paced (~1 per 3s, per arXiv API
  etiquette) and back off on HTTP 429/503; a persistently throttled id now raises a
  rate-limit error instead of being misreported as "no record".
- Tool descriptions/examples for `zotero_create_items` and `zotero_update_item` now embed a
  complete, correct payload example, and validation errors for a missing/wrong `itemType`
  show exactly what was sent (e.g. "got a wrapper object {itemType: \"report\"}") so
  clients can self-correct instead of re-sampling the same bad shape.

### Fixed
- `zotero_create_items` / `zotero_update_item`: item-data payloads sent with nested
  "wedding-cake" field wrappers (`{"itemType": {"itemType": "report"}, "title":
  {"title": "…"}}`) are now repaired server-side into the flat shape Zotero expects, turning
  a confusing "Missing required itemType" into a successful write. This is the same class
  of degraded-encoding repair added for array fields in 1.0.3, applied to scalar fields.
  Repair also covers corrupted field NAMES observed in the same transcripts:
  `Quote`-suffixed keys (`creatorsQuote`, `collectionsQuote`, `collectionQuote`) and
  singular spellings (`collection`, `creator`, `tag`) are normalized to the real Zotero
  field names instead of failing the whole batch with "Invalid property".

## [1.0.4] — 2026-07-20

### Fixed
- `/healthz` and MCP `serverInfo` now report the real package version. Two hardcoded
  `VERSION` constants were missed by every release bump since 1.0.1, so deployed servers
  self-reported a stale version and made deploys look outdated. The version is now read
  from `package.json` at runtime.

## [1.0.3] — 2026-07-20

### Fixed
- `zotero_update_item` / `zotero_create_items`: writing array-valued fields (`creators`,
  `tags`, `collections`) no longer fails with Zotero's "property must be an array" when the
  client sends them in a degraded shape (a JSON-encoded string, a single un-wrapped object,
  a numeric-keyed object, or a wrapper object around the real array). The structured fields
  are now explicitly typed in the advertised tool schema so clients know the expected shape
  up front, and the common degradations are repaired at the tool boundary before the write
  reaches Zotero. Reported in
  [#1](https://github.com/oscardvs/zoteus/issues/1).

## [1.0.2] — 2026-06-01

### Fixed
- `zotero_bibliography` and `zotero_export` now mirror their rendered output into
  `structuredContent`, not only `content`. MCP clients that read the structured channel
  (e.g. the claude.ai connector) were surfacing just a summary (`{style, itemCount}` /
  `{format, length}`) and dropping the actual bibliography/export text.
  `zotero_format_bibliography` also returns the joined `bibliography` string alongside
  `entries` for consistency.
- Zotero fetcher: a slow single request that exceeds the time budget is no longer reported
  as rate-limiting. The 408 now distinguishes genuine throttling (a 429/503/`Backoff` was
  observed → back off and retry sequentially) from an expensive query that was simply slow
  (e.g. a full-text `qmode=everything` scan over a large library → narrow the query or lower
  the limit), so the guidance matches the real cause.
- OAuth (`MODE=zotero`): removed `identity=1` from the Zotero authorize URL, which forced
  identity-only mode and prevented a real API key from being issued.

## [1.0.1] — 2026-06-01

### Changed
- `zotero_search_items`: a quick search (`q`) with no pinned `qmode` that returns nothing now
  auto-retries once in `everything` mode (notes + attachment full text) before reporting
  absence, so "is X in my library?" checks no longer false-negative on terms that appear only
  inside PDF text. Empty `everything` results are reported as strong-but-not-conclusive
  (un-indexed/scanned/un-synced PDFs aren't full-text searchable). The response gains `qmode`
  (effective) and `broadened`; only previously-empty searches change behavior.
- `zotero_fulltext`: description now states it is not a search and points to
  `zotero_search_items` (qmode=everything) for finding which items contain a term.
- Zotero fetcher: bounded per-request time budget (~25s, overridable) with an `AbortController`,
  so a rate-limited (429/503) retry loop or a stalled connection fails fast with an actionable
  408 ("retry sequentially, avoid parallel batches, keep responses concise") instead of hanging
  until the MCP connector's own per-call timeout fires. The budget is per request (not per
  operation), so multi-request batch flows are unaffected. 429/503 messages and the server
  `instructions` now also steer the model toward sequential calls.

## [1.0.0] — 2026-05-31

First public release: published to npm as a scoped public package, listed in the MCP
registry, and shipped as a Claude Desktop DXT.

### Added
- Published `@oscardvs/zoteus` to npm (`npx -y @oscardvs/zoteus`), scoped public with `publishConfig.access=public`.
- MCP registry listing via `server.json` (npm package + hosted remote endpoint).
- Refreshed Claude Desktop DXT one-click package (local-API toggle, icon, self-contained bundle).
- **CIMD (Client ID Metadata Document)** support: resolve a URL `client_id` to a registered
  client without DCR, advertised via `client_id_metadata_document_supported`. Prerequisite for
  the claude.ai connector directory (single shared app instead of per-connection DCR).
- `CHANGELOG.md` and a maintainer distribution runbook (`docs/distribution.md`).
- README launch polish: npm badge, connect matrix, directory/CIMD note.

## [0.12.0] — 2026-05-30 (M13)
### Added
- Production hardening: `/healthz` `/readyz` `/metrics`, secret-redacting logger (text/JSON),
  `/mcp` rate limiting, graceful shutdown (drain → flush store + indexes → close).
- Deploy IaC: docker-compose + Caddy, systemd + Fly alternatives, backups, GHCR release workflow,
  `docs/deployment.md` runbook.

## [0.11.0] — (M12)
### Added
- `zotero_get_fulltext` (passage retrieval with page locators), `zotero_tag_audit`,
  `zotero_list_tags`, `zotero_list_collections`, `zotero_export format:"better-biblatex"`,
  `zotero_update_item dry_run` diff, query-centred search snippets.

## [0.10.0] — (M11)
### Added
- Multi-tenant per-user Zotero login (OAuth `zotero` mode); per-user encrypted token store.

## [0.9.0] — (M10)
### Added
- OAuth 2.1 + PKCE authorization server in front of `/mcp`; passcode-gated consent;
  HTTP transport + DXT + initial MCP registry entry; turn-key claude.ai custom connector.
