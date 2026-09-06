# Configuration

Zoteus is configured via environment variables (see [`.env.example`](../.env.example)).

A variable left blank counts as **unset**: a bare `KEY=` line in a `.env` file, or a desktop-extension setting the user cleared, falls back to the default in the table below rather than failing to boot.

| Variable | Default | Purpose |
|---|---|---|
| `ZOTERO_API_KEY` | — | Cloud auth (sync, group libraries, and writes when the desktop app is unavailable; optional otherwise). Create one at https://www.zotero.org/settings/keys |
| `ZOTEUS_LOCAL_API_KEY` | — | Optional pre-provisioned Zotero 10+ desktop local-API key for writes against the running app. When unset, Zoteus requests one via Zotero’s grant dialog on the first write (choose “Always Allow”). |
| `ZOTERO_LIBRARY_ID` / `ZOTERO_LIBRARY_TYPE` | auto | Pin a library; otherwise resolved automatically from the key. |
| `ZOTEUS_LOCAL` | `auto` | `auto\|on\|off` — use the Zotero desktop app (reads, and personal-library writes). `off` forces everything through the cloud. |
| `ZOTERO_LOCAL_PORT` | `23119` | Desktop local server port. |
| `ZOTERO_DATA_DIR` | `~/Zotero` | The **Zotero desktop app's** data directory, whose `storage/<attachment key>/` folders hold the attachment files. Zoteus reads them there when it shares the machine with Zotero but the app is not running, which is what lets an unindexed PDF be extracted with no cloud key and no desktop app (see [`grounding.md`](./grounding.md#where-the-file-bytes-come-from)). Set it only if you moved Zotero's data directory; a directory that is not there is skipped. Not to be confused with `ZOTEUS_DATA_DIR`, which is Zoteus's own. |
| `ZOTEUS_TRANSLATION_SERVER_URL` | `http://127.0.0.1:1969` | Optional Zotero translation-server for `zotero_import`. Without it, DOI and arXiv ids still resolve via built-in fallbacks; ISBN/PMID/bibcode and URLs need the server. See [`resolver.md`](./resolver.md). |
| `ZOTEUS_EMBEDDINGS` | `local` | Semantic-search embeddings provider (`local` model, `openai`, `gemini`, or `off`). |
| `ZOTEUS_EMBEDDING_MODEL` | provider default | Embedding model for whichever provider `ZOTEUS_EMBEDDINGS` selected, **`local` included**: `Xenova/all-MiniLM-L6-v2` for `local`, `text-embedding-3-small` for `openai`, `text-embedding-004` for `gemini`. Under `local` it names any transformers.js feature-extraction model, which is how a non-English library gets an embedder trained for it (`Xenova/multilingual-e5-small` is the multilingual pick, same 384 dimensions, 465 MB downloaded once into `<ZOTEUS_DATA_DIR>/models`, or 129 MB with `ZOTEUS_EMBEDDING_DTYPE=q8` below). Vectors from two models are not comparable, so an index built with one is dropped, with a notice, when the server starts embedding with another: rebuild after changing it. See [`semantic-search.md`](./semantic-search.md#choosing-a-local-model). |
| `ZOTEUS_EMBEDDING_PREFIXES` | `auto` | Whether local embedding inputs carry the E5 family's markers, `query: ` in front of a query and `passage: ` in front of an indexed passage. `auto` applies them when the model id has `e5` as a segment (`Xenova/multilingual-e5-small`, `intfloat/e5-base-v2`) and not otherwise; `off` never applies them; `e5` applies them to any model, for a mirrored checkpoint whose name does not say what it is. E5 models lose a good deal of retrieval quality without them. |
| `ZOTEUS_EMBEDDING_POOLING` | `auto` | How the **on-device** model's token outputs are pooled into one vector, `mean` or `cls`. `auto` takes the answer from a curated per-model table: `mean` for `Xenova/all-MiniLM-L6-v2` and the E5 family, `cls` for the granite, gte, arctic-embed, bge and mxbai models, and `mean` for any model the table does not list, which is what every model got before the table existed. The table exists because the value cannot be detected: it is published in `1_Pooling/config.json` on a model's source repository, and the ONNX mirrors the pipeline loads (`Xenova/*`, `onnx-community/*`) do not republish it. `mean` or `cls` here overrides the table for every model, for a mirrored or renamed checkpoint whose id the table does not know. A pooling that is not the default joins the embedder identity (`local:<model>#cls`), as a precision above `fp32` does, so setting it is not free: it makes a different vector space, and the vectors already stored are dropped with a notice rather than queried as if they matched. Every model the table pools the default way keeps the identity it had. Getting the value wrong is otherwise silent in the way a missing E5 prefix is, so leave it unset unless you have read the model's own `1_Pooling/config.json`. Ignored under `openai`/`gemini`. See [`semantic-search.md`](./semantic-search.md#choosing-a-local-model). |
| `ZOTEUS_EMBEDDING_DTYPE` | `fp32` | Weight precision the **on-device** model loads at, naming a file the repository publishes rather than a conversion Zoteus performs: `q8` fetches `model_quantized.onnx`, which puts `Xenova/multilingual-e5-small` at 129 MB on disk instead of 465 MB. `fp16`, `int8`, `uint8`, `q4`, `q4f16`, `q2`, `q2f16`, `q1`, `q1f16` and `bnb4` are also accepted. The `Xenova/` mirrors publish the full set; a model's own repository often publishes fp32 alone, and asking it for a variant it never uploaded fails at load rather than falling back. Above `fp32` the precision joins the embedder identity (`local:<model>@q8`), so changing it drops the vectors with a notice and costs one rebuild, exactly as changing the model does. Ignored under `openai`/`gemini`, which embed at their own precision. See [`semantic-search.md`](./semantic-search.md#choosing-a-precision). |
| `ZOTEUS_EMBED_BATCH_SIZE` | `32` | Passages per embedding call: one API request, or one local pipeline call. Lower it when a provider rejects a batch outright (OpenAI answers `400` above 300K tokens per request, a ceiling full-text passages reach far sooner than metadata ones). |
| `ZOTEUS_EMBED_BATCH_DELAY_MS` | `0` | Pause between those calls. `0` only yields to the event loop (unchanged behaviour); a positive value sleeps, which is how a large build stays under a provider's tokens-per-minute limit. At `0` the rate is set entirely by how fast the provider answers, which on a large full-text build lands at roughly its ceiling whatever your tier: `ZOTEUS_EMBED_BATCH_SIZE=256` with `ZOTEUS_EMBED_BATCH_DELAY_MS=8000` holds a 10k-item library near 400K tokens/min. `zotero_index action:"status"` reports the rate it is actually sustaining as `embedRate`. See [`semantic-search.md`](./semantic-search.md#when-a-build-gets-rate-limited). |
| `ZOTEUS_EMBED_MAX_RETRIES` | `5` | Retries a rate-limited (`429`), timed-out or `5xx` embedding request gets before the build gives up: exponential backoff from 1 s with jitter, honouring `Retry-After`, capped at 60 s per wait and about three minutes per request. A `400` is never retried, since an oversized batch is oversized on every attempt. `0` restores the pre-1.13 behaviour, where one transient failure ended the whole build. |
| `ZOTEUS_TRANSFORMERS_PATH` | — | Where to resolve `@huggingface/transformers` from when the install cannot see it itself (notably a `.mcpb` bundle). Point it at a `node_modules` directory holding the package, at the package directory itself, or at an npm prefix whose modules live under `lib/node_modules`. Give the package a directory of its own rather than installing it globally: Claude Desktop runs the server on its own built-in Node, so `npm i -g` under a version manager resolves against a Node the extension never executes. See [`semantic-search.md`](./semantic-search.md#why-it-is-not-bundled). |
| `ZOTEUS_INDEX_OWN_WORDS` | `true` | Index the words *you* wrote: every child note, and every PDF annotation (its highlighted passage and its comment), as passages carrying the parent item's key. On by default, unlike full text — the whole corpus is one paged crawl of hand-written text, orders of magnitude smaller than attachment bodies, and it is the only text in a library nobody else wrote. Can be set per build with `zotero_index own_words:false`. See [`semantic-search.md`](./semantic-search.md#your-own-notes-and-annotations). |
| `ZOTEUS_INDEX_FULLTEXT` | `false` | Also index the body text of item attachments (what Zotero extracted from each PDF), so semantic search matches claims inside a paper and not only its title and abstract. Opt-in because it is expensive: roughly 9× the passages, index size, and embedding time. Can be set per build with `zotero_index fulltext:true`. See [`semantic-search.md`](./semantic-search.md#full-text-indexing-opt-in). |
| `ZOTEUS_INDEX_FULLTEXT_MAX_CHARS` | `40000` | Cap on indexed full-text characters per item (~13 pages of dense text); `0` means no cap. The main dial for the cost above. |
| `ZOTEUS_INDEX_FULLTEXT_CONCURRENCY` | `2` local / `4` cloud | Concurrent attachment full-text fetches during an index build. The default depends on which Zotero API is serving the crawl, because the two tolerate load in opposite ways: the cloud Web API is a fleet that answers a burst with a `429` and a `Backoff` header, while the desktop local API is a *single process*, sharing itself with Zotero's UI, sync and PDF indexer, with no rate limiter at all. Four continuous body reads were enough to stop Zotero 10 answering on port 23119 within 60 to 90 seconds, which drops every read and write in the session onto the Web API. Setting this overrides both defaults. Independently of it, a crawl that does saturate the desktop app backs off to one read at a time for the rest of the job and reports `localApiDegradedAt` on `zotero_index action:"status"`. |
| `ZOTEUS_INDEX_MAX_ITEMS` | `5000` | Max top-level items a single index build will crawl. Raise it for a library that outgrows the default; a build that stops here says how many items were left unindexed, and `zotero_semantic_search` repeats the warning. `zotero_index limit:` can lower it per build but never raise it. |
| `ZOTEUS_INDEX_BACKEND` | `auto` | Where the search index is stored. `auto` uses SQLite (FTS5, via Node's built-in `node:sqlite`) when the runtime has it, Node 22.13+, and the legacy JSON file otherwise. `sqlite` requires it and fails at startup without it. `memory` forces the JSON file, which cannot hold more than roughly 250k passages: a single `JSON.stringify` cannot exceed ~512 MB and a file near it needs about ten times its size in heap to read back. An existing `search-index.json` is imported on the first SQLite open and left in place. See [`semantic-search.md`](./semantic-search.md#storage-backends). |
| `ZOTEUS_ACCENT_EXPANSION` | `true` | Query-side accent expansion in keyword search: an unaccented term also matches the accented spellings that dominate the library's vocabulary (`theorie` finds `théorie`). Expansion compensates the recall that keeping diacritics in the index removed for unaccented queries; `false` opts into strict as-typed exactness. Query-time only — flipping it never needs a rebuild. See [`semantic-search.md`](./semantic-search.md). |
| `ZOTEUS_INDEX_ANN` | `true` | Two-stage vector search on the SQLite backend: a binary code per vector (one sign bit per dimension, mean-centred) is scanned by Hamming distance for a candidate pool, then those candidates' real vectors are rescored with the exact cosine. Every score returned is still exact; what an approximation can cost is recall, and the pool below is the dial for it. `false` is the escape hatch: every semantic query scans every stored vector, as it did before, and no codes are written. See [`semantic-search.md`](./semantic-search.md#two-stage-vector-search). |
| `ZOTEUS_INDEX_ANN_OVERSAMPLE` | `16` | Candidates that first pass hands the exact rescore, per vector hit asked for. Higher is more accurate and slower: measured against the exact ranking on real embeddings, recall was 0.884 at a 4× pool, 0.953 at 8× and 0.986 at 16×. |
| `ZOTEUS_INDEX_ANN_MIN_CANDIDATES` | `500` | Floor on that pool, so a small `limit` still rescores a real neighbourhood. It doubles as the size below which an index is simply scanned exactly and carries no codes at all. |
| `ZOTEUS_SCHOLAR_PROVIDERS` | `openalex` | Comma list of scholarly-graph providers (`openalex`, `crossref`, `semanticscholar`). |
| `ZOTEUS_DATA_DIR` | OS data dir | Index + caches location. |
| `ZOTEUS_CONTACT_EMAIL` | — | Polite-pool contact for external scholarly APIs. |
| `ZOTEUS_ALLOW_DELETE` | `false` | Must be `true` to expose `zotero_delete_items` (permanent delete). Trash is always available. |
| `ZOTEUS_READ_ONLY` | `false` | Expose only non-mutating tools. Recommended for public/remote endpoints. |
| `ZOTEUS_LOG_LEVEL` | `info` | `debug\|info\|warn\|error` (stderr only — stdout carries the JSON-RPC stream). |
| `ZOTEUS_LOG_FILE` | — | A file every log line is appended to as well as stderr, in the same format. For a server nobody's terminal is attached to (a Windows scheduled task, a service manager that discards stderr), it is the only record of what the process was doing. A file that cannot be written is reported once on stderr and never stops the server from starting. |
| `ZOTEUS_UPDATE_CHECK` | `false` | Set `true` for a daily check of GitHub releases for a newer version; when one exists, `zotero_whoami` (and the stderr log) says so. Worth turning on for manual installs such as the Claude desktop `.mcpb`, which have no auto-update channel. The check is a single unauthenticated GET to the GitHub API, sends no user data, and caches the result for 24 h. It is **off by default** because it is the only request Zoteus makes that you did not ask for, and a local-first tool should not reach the network on its own initiative. |
| `ZOTEUS_DIST` | — | Distribution-channel marker. The packaged desktop-extension manifest sets `mcpb` (older bundles set `dxt`) so the update notice tells users to download and reinstall the new bundle. Not usually set by hand. |

## Desktop extension settings (`.mcpb`)

The Claude Desktop bundle has no `.env` file to read, so the installed extension's own
settings screen (**Settings → Extensions → Zoteus**) is where these variables get set. Every
field is optional and maps to one variable from the table above; leave a field **empty** to
keep the server's default, and restart Claude Desktop after a change (the server reads its
environment once, at startup).

| Setting | Variable |
|---|---|
| Zotero API Key | `ZOTERO_API_KEY` |
| Zotero local API | `ZOTEUS_LOCAL` |
| Semantic-search embeddings | `ZOTEUS_EMBEDDINGS` |
| Embedding model | `ZOTEUS_EMBEDDING_MODEL` (applies to the local model too) |
| Embedding batch size | `ZOTEUS_EMBED_BATCH_SIZE` |
| Pause between embedding calls (ms) | `ZOTEUS_EMBED_BATCH_DELAY_MS` |
| Index your notes and annotations | `ZOTEUS_INDEX_OWN_WORDS` |
| Index PDF full text | `ZOTEUS_INDEX_FULLTEXT` |
| Full-text characters per item | `ZOTEUS_INDEX_FULLTEXT_MAX_CHARS` (set `0` for no cap, i.e. index whole documents; see the note below) |
| Max items per index build | `ZOTEUS_INDEX_MAX_ITEMS` |
| Local embeddings path | `ZOTEUS_TRANSFORMERS_PATH` |

**A `0` you type into "Full-text characters per item" looks like it was rejected, and was
not.** Claude Desktop's number input will not render or retain a displayed `0`, so the box
goes blank again the moment you leave it. The value is saved and does reach the server,
which reads it as "no cap" exactly as documented. If reading back the value you set matters
more than the round number, type a very large one instead (`10000000` caps nothing in
practice). Blank keeps meaning *the default*, 40000, whether or not full-text indexing is
on: it has to, or every install that turned full text on and never touched this dial would
silently start crawling whole books.

Any variable *not* in that list is out of reach of the bundle: use a manual install
(Option B in [`getting-started.md`](./getting-started.md)) or a self-hosted run, both of
which take the full environment.

## Remote OAuth (claude.ai web connector)

Turn the Streamable HTTP `/mcp` endpoint into an OAuth 2.1 + PKCE protected resource so it can be added as a claude.ai custom connector. See [`remote-oauth.md`](./remote-oauth.md) for the full walkthrough.

| Variable | Default | Purpose |
|---|---|---|
| `ZOTEUS_OAUTH_ENABLED` | `false` | Enable the built-in OAuth 2.1 authorization server + bearer-auth on `/mcp`. |
| `ZOTEUS_PUBLIC_URL` | — | Public HTTPS origin claude.ai reaches (OAuth issuer), e.g. `https://zoteus.example.com`. Required when enabled; must be HTTPS in production. |
| `ZOTEUS_OAUTH_PASSCODE` | — | Operator passcode gating consent (≥ 12 chars; `openssl rand -base64 24`). Required when enabled. |
| `ZOTEUS_OAUTH_ACCESS_TTL` | `3600` | Access-token lifetime (seconds). |
| `ZOTEUS_OAUTH_REFRESH_TTL` | `2592000` | Refresh-token lifetime (seconds). |
| `ZOTEUS_ALLOWED_HOSTS` | — | Comma-separated extra `Host` values for DNS-rebinding protection (merged with the public host); use if a proxy rewrites `Host`. |
| `ZOTEUS_ALLOW_INSECURE_HTTP` | `false` | Override the guard that forbids binding a non-loopback host without OAuth. Trusted networks only. |
| `ZOTEUS_OAUTH_MODE` | `passcode` | `passcode` (single operator key) or `zotero` (per-user Zotero login, multi-tenant). |
| `ZOTERO_OAUTH_CLIENT_KEY` / `ZOTERO_OAUTH_CLIENT_SECRET` | — | Zotero app credentials (https://www.zotero.org/oauth/apps). Required when `mode=zotero`. |
| `ZOTEUS_OAUTH_STORE` | `memory` | `memory` or `file` (persist clients/tokens/per-user keys under the data dir, encrypted at rest). |
| `ZOTEUS_OAUTH_TOKEN_SECRET` | — | AES-256-GCM key material encrypting stored Zotero keys at rest. Required when `store=file` (`openssl rand -base64 32`). |

When OAuth is enabled, `--http` binds `0.0.0.0` and enables DNS-rebinding protection (`allowedHosts` = public host + `ZOTEUS_ALLOWED_HOSTS`). Put TLS (Caddy / cloudflared / Fly) in front; the proxy must forward the public `Host` header verbatim.

## Connector directory / CIMD

Client ID Metadata Document support — resolve a URL `client_id` to a registered client without per-connection Dynamic Client Registration. Required only to list the hosted connector in the claude.ai directory; off by default, so OSS self-host is unaffected. See [`distribution.md`](./distribution.md) §7.

| Variable | Default | Purpose |
|---|---|---|
| `ZOTEUS_CIMD_ENABLED` | `false` | Resolve a URL `client_id` via its metadata document and advertise `client_id_metadata_document_supported`. DCR keeps working in parallel. |
| `ZOTEUS_CIMD_CACHE_TTL_SEC` | `3600` | How long a fetched CIMD document is cached (seconds). |
| `ZOTEUS_CIMD_MAX_BYTES` | `16384` | Max bytes accepted for a CIMD document (enforced while streaming). |
| `ZOTEUS_CIMD_ALLOWED_REDIRECT_SCHEMES` | `https` | Comma-separated `redirect_uri` schemes permitted in a CIMD document. |
| `ZOTEUS_CIMD_ALLOWED_HOSTS` | — | SSRF guard: comma-separated host allowlist for `client_id` (exact or `.suffix`). Empty = any **public** host (private/loopback/link-local/reserved IPs are always rejected). Set to the directory host (e.g. `claude.ai`) for a directory connector. |

## Ops / production

| Variable | Default | Purpose |
|---|---|---|
| `ZOTEUS_LOG_FORMAT` | `text` | `text` (human-readable) or `json` (structured, for log aggregators). Never logs tokens, keys, or the passcode. |
| `ZOTEUS_METRICS_ENABLED` | `false` | Expose `/metrics` in Prometheus text format: labelled request and per-tool counters plus a latency histogram. Unauthenticated unless `ZOTEUS_METRICS_TOKEN` is set. |
| `ZOTEUS_METRICS_TOKEN` | — | Bearer token required by `/metrics` and `/usage.json`. Unset leaves both open, which is only safe behind a proxy that blocks them. |
| `ZOTEUS_USAGE_LOG` | `false` | Keep a usage log in `<data dir>/usage.sqlite`: one row per tool call and request (tool name, outcome, duration, caller). Nothing is ever transmitted, and argument values are never recorded, only their names, types and sizes. See [Usage log](#usage-log). |
| `ZOTEUS_USAGE_RETENTION_DAYS` | `30` | Days of raw events kept. Daily rollups survive pruning and are kept indefinitely. |
| `ZOTEUS_USAGE_IDENTIFY` | `user` | Whether a caller is recorded as their Zotero user id (`user`), a salted hash of it (`hash`), or not at all (`none`). |
| `ZOTEUS_READYZ_CHECK_ZOTERO` | `true` | Whether `/readyz` pings the Zotero API (HEAD) to report upstream reachability. |
| `ZOTEUS_MCP_RATE_LIMIT_WINDOW_SEC` | `60` | Sliding window length (seconds) for the per-IP rate limiter on `/mcp`. |
| `ZOTEUS_MCP_RATE_LIMIT_MAX` | `120` | Max requests per IP per window on `/mcp`. Set to `0` to disable. |

## Usage log

Off unless you turn it on, and it never leaves the machine that writes it: there is no
endpoint, no upload, and no third party. It exists so that an operator running a shared
instance can answer which tools are used, by whom, how fast and how often they fail.

```bash
ZOTEUS_USAGE_LOG=true node dist/index.js --http
npx tsx scripts/usage-report.ts --days 30
```

What a row contains: timestamp, tool name (or normalised route), Zotero user id, OAuth
client and session id, ok/failed, a classified error kind, duration, and an argument
*shape* such as `{"q":"string(32)","limit":"number","top":true}`.

What it never contains: search strings, item titles, note or attachment text, argument
values of any kind, Zotero API keys or tokens. Booleans are the one value kept, because
`fulltext:true` is worth knowing and cannot carry content. Error *messages* are not
recorded either, only a class such as `zotero_4xx`, since a message can quote library
content.

Raw events are pruned after `ZOTEUS_USAGE_RETENTION_DAYS`; the daily per-tool, per-user
rollup they are folded into is about a kilobyte a day and is kept. Reading:

- `scripts/usage-report.ts` prints a table from the file, or from a running server with
  `--remote https://host --token "$ZOTEUS_METRICS_TOKEN"` (`--json` for the raw rollups).
- `GET /usage.json?days=30` serves the same rollups, behind `ZOTEUS_METRICS_TOKEN`.
- `GET /metrics` exposes live counters: `zoteus_tool_calls_total{tool,outcome}`,
  `zoteus_tool_duration_ms` (histogram), `zoteus_http_requests_total{route,status_class}`
  and `zoteus_http_scanner_requests_total`. These are process counters and reset on
  restart; the SQLite rollups are the history.

## Optional dependencies

**PDF reading**: `zotero_get_fulltext` uses `pdfjs-dist` (declared as an `optionalDependency`) for exact page locators (`precise_pages:true`, and `page_range`), for the `outline:true` table of contents, and for extracting the text of a PDF Zotero has not indexed. Without it, page locators degrade to approximate (proportional) numbers with a notice and no error, and the outline and unindexed-PDF paths say the parser is missing:

```bash
npm i pdfjs-dist
```

EPUB extraction needs nothing extra: an EPUB is a zip of XHTML, which Zoteus unpacks with Node's own `node:zlib`.

**Better BibTeX export** — `zotero_export format:"better-biblatex"` calls the Better BibTeX plugin running in your local desktop Zotero instance. It is desktop-local only: when desktop Zotero or the plugin is unavailable (e.g. the hosted connector), the tool automatically degrades to Zotero's built-in stock `biblatex` translator. See [`grounding.md`](./grounding.md) for details.

## Library backends

Zoteus uses both Zotero backends and chooses per request:

- **Desktop app** (`http://127.0.0.1:23119`, personal library `users/0`) — fast, key-free reads with full local PDFs and real saved-search execution. From Zotero 10 it serves **group libraries** it holds too, under `groups/<id>`; a group the app does not hold still reads from the cloud. It also takes **writes** for your personal library: local-API writes on Zotero 10+ (behind a key granted once in-app, or `ZOTEUS_LOCAL_API_KEY`), else the connector protocol. Preferred whenever the app is running. See [`writing.md`](./writing.md).
- **Cloud Web API v3** (`https://api.zotero.org`) — universal, and the fallback for writes; still required for sync, group-library writes, group libraries the desktop app does not hold, and personal-library writes with no desktop app.

At startup Zoteus probes both and logs the result, e.g.
`Capabilities: cloud=user 19552201, localApi=true, localGroups=2`

That line is the answer at startup, not the answer for the life of the process. Zoteus
re-checks the desktop local API in the background as tools are called, so starting Zotero
*after* your MCP host no longer leaves it invisible until you restart the host, and a Zotero
you quit is noticed too. `zotero_whoami` always probes afresh and reports `localApi` plus
`localApiChecked`, so a `false` there is a live answer. Where no desktop app can apply — a
hosted server, or `ZOTEUS_LOCAL=off` — nothing is probed at all.
(`localGroups` counts the group libraries the desktop app is serving).

### Local API prerequisite

To use the fast, key-free desktop path, run Zotero 7 or newer and enable
**Settings → Advanced → "Allow other applications on this computer to communicate with Zotero."**
If the desktop app is not running or the toggle is off, Zoteus transparently falls back to the cloud Web API.
