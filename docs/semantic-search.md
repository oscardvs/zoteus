# Hybrid semantic search

M6 adds local-first hybrid retrieval: BM25 keyword scoring fused with vector similarity (Reciprocal Rank Fusion), with results that cite the matching item and a snippet.

## Tools

### `zotero_index` — manage the index
The build runs **asynchronously on the server** so the tool call returns immediately and
can never time out the MCP client, even on very large libraries.

- `action: "build"` / `"refresh"` start a **background job** that rebuilds the whole
  index: it pages the library's top-level items (100-at-a-time, stopping at
  `ZOTEUS_INDEX_MAX_ITEMS`, **5000 by default**, or at a smaller `limit`) and indexes
  their text (title, abstract, creators, tags) for BM25, plus vector embeddings if an
  embedder is configured. Returns at once; **poll `action: "status"`**
  every few seconds until `state` is `done` (or `error`). Calling build again while one
  is running does **not** start a second build — it returns the current progress.
  `refresh` is an alias: both mean *from scratch*.
- `action: "update"` re-indexes only what changed since the last build, and drops what the
  library no longer holds. This is the cheap one; see
  [Updating the index](#updating-the-index).
- `action: "status"` — live progress and index size. Reports
  `state` (`idle` | `building` | `done` | `error`), `operation` (`build` | `update`),
  `itemsFetched` / `itemsTotal`, `itemsRemoved`,
  `itemsAvailable` (what the library holds, before the cap; larger than `itemsTotal`
  exactly when the build was truncated), `passages`, `vectors`, `items`, the
  **effective** `embedder`, `libraryVersion` / `libraryBackend` (the version stamp an
  update diffs from), `updateNotice` (what the last update did, or why a rebuild replaced
  it), and `lastError` when
  `state` is `error`. Backward-compatible fields (`documents`, `vectors`, `items`,
  `embedder`, `builtFromVersion`) are still present. Progress is also logged on the
  server (every 500 items / 10s).
  `embedder` is what is *actually* producing vectors, not what was requested: three extra
  fields split the two apart, so a keyword-only index always explains itself.
  | Field | Meaning |
  |---|---|
  | `embedderConfigured` | the `ZOTEUS_EMBEDDINGS` value that was asked for |
  | `embedderModel` | the model it embeds with (`ZOTEUS_EMBEDDING_MODEL`), when it names one |
  | `embedderActive` | `true` only while that provider is genuinely embedding |
  | `embedderReason` | present when it is not: why, and what to do about it |
  | `vectorsStaleReason` | present when stored vectors were dropped because another model had produced them (see [Tuning API embeddings](#tuning-api-embeddings)) |

  Three more fields describe the store rather than the embedder: `storage` (`sqlite` or
  `memory`, see [Storage backends](#storage-backends)), `storageNotice` (present when
  opening it imported a JSON index, or refused to), and `persistError` (present when the
  index could not be written).
- `action: "stop"` cooperatively cancels a running job. A build halts between
  pages/batches and the partial index is kept and stays searchable; a stopped **update**
  keeps what it applied but leaves the version stamp where it was, so the next update
  simply repeats the delta.
- `limit` — optional max number of items to index. It lowers the configured cap for one
  build and can never raise it: the build stops at the lower of `limit` and
  `ZOTEUS_INDEX_MAX_ITEMS` (default 5000).
- `fulltext` — also index the body text of each item's attachments (see
  [Full-text indexing](#full-text-indexing-opt-in) below). Defaults to
  `ZOTEUS_INDEX_FULLTEXT` (off).
- `fulltext_max_chars` — cap on indexed full-text characters per item; `0` means no cap.
  Defaults to `ZOTEUS_INDEX_FULLTEXT_MAX_CHARS` (40000).

**Local-first, key-free.** The build pages items through the library router, exactly like
every other read: a running Zotero desktop app serves them from its **local API** (no
cloud API key required), for your personal library and, on Zotero 10+, for any group
library the app holds. The cloud **Web API** takes over when the app is closed, and for a
group library this desktop does not hold. Item keys are identical on both backends, so an
index built against the desktop app stays valid when a later lookup goes to the cloud,
and the index file is keyed by the Zoteus data dir (plus the authenticated user in
multi-tenant mode), never by the library id the read happened to use.

**Incremental, crash-safe persistence.** Partial progress is persisted as the build runs
(roughly every 200 items or 10s), so a timeout, crash, or `stop` can never leave a corrupt
index: the JSON backend writes to a temp file and renames over the target, the SQLite one
commits a transaction (see [Storage backends](#storage-backends)). What was persisted is
what loads on the next startup, and it is fully queryable (BM25 keyword search works on
whatever was indexed). A build that could **not** be written says so: `persistError` is
reported by `zotero_index action:"status"` and repeated in every `zotero_semantic_search`
summary, because a build whose artifact never reached disk still reports `state: "done"`.

### `zotero_semantic_search` — search by meaning
- `q` — natural-language query. `mode`: `auto` (hybrid, default), `keyword` (BM25), or `semantic` (vector).
- Returns ranked items with a snippet and fused score. The index is built automatically on first use (see `auto_build` below), or ahead of time with `zotero_index`.
- `auto_build` (default `true`) — when the index is empty the tool starts a background build itself and tells you to poll `zotero_index` action:"status" until `done`, then retry, instead of returning a bare error; pass `auto_build: false` to opt out.
- `mode: "semantic"` ranks by vectors alone, so with **0 vectors** in the index it returns an
  explicit error naming the cause (missing embedder, or an index built before one was
  available) rather than an empty hit list, which would be indistinguishable from "your
  library has nothing on this". `auto` and `keyword` keep working on BM25; `auto` appends a
  one-line notice when vector ranking is off.
- Snippets are query-centred and trimmed to word boundaries: the excerpt is positioned around the first query token hit rather than always taken from the document head, so the relevant phrase appears in the snippet even when it occurs deep in the abstract.
- A hit whose snippet came from a PDF body rather than the item's metadata is marked
  `source: "fulltext"`, so the caller knows the passage is quotable and can fetch it with
  a page locator via `zotero_get_fulltext`.

For exact field/tag/itemType filtering, use `zotero_search_items`. Use semantic search for conceptual "papers about X" queries.

## Updating the index

A library changes by a handful of items at a time; rebuilding it from scratch to absorb
that is the wrong shape of work. `zotero_index action:"update"` re-indexes **only what
moved**:

```jsonc
{ "tool": "zotero_index", "action": "update" }
```

**What it does.**

1. Reads the **version stamp** the last build or update recorded: Zotero's
   `Last-Modified-Version` for the library, plus which API issued it
   (`libraryVersion` / `libraryBackend` in `status`).
2. Pages `?since=<stamp>` for the items that changed after it, and upserts each one:
   the item's old passages, vectors and keyword rows are removed, then it is re-chunked,
   its attachment full text re-fetched if `fulltext` is on, and its new passages embedded.
   **Untouched items are never re-chunked and never re-embedded**, which is where the
   saving comes from.
3. Reconciles deletions by diffing its own item keys against a
   `?format=versions` census of the library (keys and versions only, no item bodies).
   The `/deleted` endpoint is cloud-only, so a key-set diff is the only way this works
   against the desktop app too. A deleted item takes its passages, its vectors and its
   FTS5 rows with it.
4. Advances the version stamp **only after all of that succeeded**, and persists once.
   On SQLite the whole update is one transaction: a failure rolls back to the last good
   state rather than leaving an index that is half fresh. On the JSON backend nothing is
   written until the update succeeds, so the file on disk stays the last good one (the
   in-memory copy can be partially refreshed until the next restart, and `updateNotice`
   says so instead of claiming a rollback).
   Either way the stamp does not move, and the next `update` simply repeats the delta.

**When it falls back to a full rebuild.** An update is refused whenever a delta would be
*wrong* rather than merely stale. The fallback is never silent: the rebuild starts
immediately and `updateNotice` (repeated in the `status` summary) says which case it was.

| Condition | Why a delta cannot work |
|---|---|
| No version stamp | An index built before 1.7, imported from an older JSON file, or left by a cancelled build, covers an unknown slice of the library. |
| The serving backend changed | The desktop app and the cloud number their library versions independently, so a stamp from one names a different point in the other's sequence. Closing Zotero between runs is enough to trigger this. |
| The embedding model changed | Only the changed items would come back with vectors in the new space; the rest would be ranked against a foreign one. (Same rule as [Changing the model](#tuning-api-embeddings).) |
| The store cannot delete rows | Deleted items could never leave the index. Both shipped backends can, so this is a guard for future stores. |
| The census came back empty | Treated as a failed read, not an emptied library: deletions are skipped, the stamp is withheld, and `updateNotice` says so rather than erasing the index. |

**One caveat, for full text.** The delta is over top-level items, so an update sees an item
whose own record changed. Newly extracted text on an attachment does not always bump its
parent's version, so a PDF you opened in Zotero for the first time may not be picked up
until that item is edited, or until the next full `action:"build"`.

**The item cap still applies.** An update maintains the subset the index already holds: an
item already indexed is refreshed however full the index is, a *new* one only while there
is room under `ZOTEUS_INDEX_MAX_ITEMS` (or `limit`). If the previous build was truncated,
`updateNotice` says that the items the cap left out stay unindexed until a full
`action:"build"` covers them.

**Cost.** Measured shape rather than a benchmark, because the ratio is what matters: an
update's work is proportional to the *delta*, a build's to the *library*.

| | items fetched | passages embedded | requests |
|---|---:|---:|---:|
| `action:"build"`, 5000-item library | 5000 | all of them | 50 item pages (+ full-text reads) |
| `action:"update"`, 7 items changed | 7 | 7 items' worth | 1 item page + 1 census page |

With `ZOTEUS_EMBEDDINGS=openai` that is the difference between re-embedding the whole
library and embedding seven items: minutes and real API spend against seconds and
almost none. Rebuild when the model changes, when you raise the cap, or when the index is
new; update the rest of the time.

## Full-text indexing (opt-in)

By default the index covers item **metadata**: title, abstract, creators, tags, date,
publication. That finds papers, but it cannot find a claim that only ever appears on page
9 of a PDF. Turning full text on adds each item's attachment body as extra passages:

```jsonc
// per build
{ "tool": "zotero_index", "action": "build", "fulltext": true }
```

```bash
# or as the default for every build
ZOTEUS_INDEX_FULLTEXT=true
```

**What it indexes.** The text Zotero itself extracted when the PDF was first opened, read
from the `/fulltext` endpoints. Attachments Zotero has never extracted are skipped; open
them once in Zotero and rebuild. Unlike `zotero_get_fulltext`, the build does **not** fall
back to downloading and parsing PDFs itself: that would mean fetching and decoding the
whole library.

**Local-first, key-free.** Zotero 7+ serves `/fulltext` from the desktop app, so full-text
indexing works with no cloud API key, exactly like the metadata build. Group libraries (and
everything else when the app is closed) go to the cloud Web API.

**Passages are attributed to the parent item.** A body-text hit is reported as the item
that owns the attachment, with the item's title, and de-duplicated against its metadata
passages, so one paper never floods the result list.

**How it is resolved.** Two library-wide reads, not per-item probing: one
`/fulltext?since=0` call names every attachment that *has* extracted text, and paging
`itemType=attachment` maps each one to its parent. Only that intersection is fetched, so
the number of full-text requests equals the number of attachments that actually have text.

**Cost.** This is the expensive option, which is why it is off by default. Measured on a
212-item library with 151 extracted PDFs:

| | passages | index file (JSON backend) | build (keyword-only, desktop app) |
|---|---:|---:|---:|
| metadata only | 687 | 0.4 MB | 0.2 s |
| `fulltext: true` | 6246 | 7.9 MB | 4.0 s |

Roughly **9× the passages**, which is also how a mid-sized library reaches the JSON
backend's ceiling: full text is the usual reason to be on the SQLite backend (see
[Storage backends](#storage-backends)). Every one of them is also a vector to compute and store, so
with `ZOTEUS_EMBEDDINGS=local` (CPU-bound) the embedding stage grows by the same factor and
dominates the build. Ways to bound it:

- `fulltext_max_chars` / `ZOTEUS_INDEX_FULLTEXT_MAX_CHARS` — characters indexed per item
  (default 40000, about 13 pages of dense text; `0` disables the cap). Passages per item
  land near `max_chars / 1200`.
- `limit` — index fewer items.
- Body passages are chunked at 1200 characters (against 512 for metadata), which keeps the
  vector count down and gives each passage enough context to embed usefully.

Progress and outcome are reported by `zotero_index action:"status"`: `fulltextItems`,
`fulltextPassages`, and `fulltextEnabled`. If full text was requested but produced nothing
(no extracted attachments, or the endpoints were unreachable) the build still completes as
a metadata index and `fulltextReason` says why, rather than looking complete.

## Storage backends

Where the index lives is set by **`ZOTEUS_INDEX_BACKEND`**:

| Value | Behaviour |
|---|---|
| `auto` (default) | SQLite when the runtime provides `node:sqlite` (**Node 22.13+**), otherwise the JSON file, with one info line on startup saying so. |
| `sqlite` | Require SQLite. On a Node without `node:sqlite` the server **fails to start** rather than quietly falling back to the backend with the ceiling. |
| `memory` | The legacy in-memory index persisted as one JSON file. |

**Why there are two.** The JSON backend keeps every passage and vector in JS memory and
saves them with a single `JSON.stringify`. That string cannot exceed V8's maximum length
(~512 MB), so past roughly 250k passages the index can no longer be saved, and a file
anywhere near that size can no longer be *read* either: a 463 MB `search-index.json` needs
about 5.4 GB of heap to parse and OOMs stock Node. Measured on the same 7540-item library
(issue #10):

| | build | resident memory | query | reload |
|---|---:|---:|---:|---|
| JSON (`memory`) | 337 s | 5370 MB | 370-500 ms | re-parses the whole file |
| SQLite (`sqlite`) | 46.6 s | 162 MB | 1-76 ms | opens the file |

The SQLite backend stores passages in an **FTS5** table (`unicode61 remove_diacritics 2`,
ranked with `bm25()`) and vectors as per-passage `BLOB`s, so a keyword search reads only
the rows it ranks and never materializes the library. Two consequences worth knowing:
searches are **diacritics-insensitive** (`Bronte` finds `Brontë`, which the JSON
tokenizer cannot do), and a semantic search still scans the vectors, one row at a time,
so it is the semantic path that grows with the library.

**Where the files are.** `<ZOTEUS_DATA_DIR>/search-index.sqlite` beside the older
`search-index.json` (and `search-index-<userId>.*` per tenant in multi-tenant mode). SQLite
also writes `-wal` and `-shm` sidecar files while the database is open; a clean shutdown
folds them back in.

**If the index is damaged.** A search index that SQLite cannot read no longer stops the
server from starting: it is a derived cache, and no other tool reads it, so item lookups,
bibliographies, attachments and citations carry on working. Search alone refuses, with a
message naming the file, its sidecars and the command to remove them. It is not rebuilt for
you — a rebuild re-reads the whole library and takes minutes to tens of minutes, which is
not a job to start inside somebody's query. Delete the three files and run `zotero_index`
with `action:"build"`. Deleting them is also what clears the version stamp, which lives in
the same database: a recovery that dropped the passages and kept the stamp would leave an
empty index reporting itself as up to date.

**Migration is automatic and lossless.** The first time the SQLite backend opens a data dir
that holds a `search-index.json` and no database, it imports the JSON index and leaves the
file exactly where it was (a downgrade to an older Node still finds it). If the JSON file is
larger than **200 MB** it is *not* parsed, because that parse is the failure mode described
above: nothing is imported, the file is left alone, and `zotero_index action:"status"`
reports the reason and asks for one `action:"build"`. Either way the outcome is in
`storageNotice`, never silent.

**One warning line on stderr.** Node 22 LTS prints
`ExperimentalWarning: SQLite is an experimental feature and might change at any time` the
first time the module loads. It comes from Node, not from Zoteus, and stdio clients are
unaffected (the MCP stream is stdout).

## Embedding backends (privacy-first)

Set `ZOTEUS_EMBEDDINGS`:

| Value | Behaviour |
|---|---|
| `local` (default) | On-device embeddings via `@huggingface/transformers` (model `all-MiniLM-L6-v2`). **No data leaves your machine.** |
| `openai` / `gemini` | API embeddings (opt-in; requires `OPENAI_API_KEY` / `GEMINI_API_KEY`; data is sent to the provider). |
| `off` | Keyword-only (BM25). |

### Tuning API embeddings

Three variables tune whichever provider is active, and all three default to today's
behaviour:

| Variable | Default | What it changes |
|---|---|---|
| `ZOTEUS_EMBEDDING_MODEL` | provider default | The model the active **API** provider embeds with: `text-embedding-3-small` (openai) or `text-embedding-004` (gemini). |
| `ZOTEUS_EMBED_BATCH_SIZE` | `32` | Passages per embedding call — one API request, or one local pipeline call. |
| `ZOTEUS_EMBED_BATCH_DELAY_MS` | `0` | Pause between those calls. `0` only yields to the event loop; a positive value sleeps. |

The last two are what a large build is tuned with. An embeddings request is rejected as a
whole when it carries more tokens than the provider accepts (OpenAI answers `400` above
300K tokens per request), and full-text passages, at 1200 characters each, reach that
ceiling far sooner than metadata ones do: lower `ZOTEUS_EMBED_BATCH_SIZE` until a request
fits. `ZOTEUS_EMBED_BATCH_DELAY_MS` bounds the request *rate* instead, which is how a build
of tens of thousands of passages stays under a tokens-per-minute limit rather than being
throttled by the provider.

```bash
ZOTEUS_EMBEDDINGS=openai
ZOTEUS_EMBEDDING_MODEL=text-embedding-3-large
ZOTEUS_EMBED_BATCH_SIZE=16
ZOTEUS_EMBED_BATCH_DELAY_MS=200
```

**Changing the model means rebuilding the index.** Vectors from two models share neither
dimension nor vector space, so comparing them produces scores that look plausible and mean
nothing. Zoteus therefore stores the embedder identity (`openai:text-embedding-3-small`)
alongside the vectors: when the index is loaded under a different one, the stored vectors are
**discarded** and `zotero_index action:"status"` (plus every `zotero_semantic_search`
summary) says so and names the remedy. Keyword search keeps working throughout; run
`zotero_index action:"build"` once to re-embed the library with the new model (an
`action:"update"` refuses for the same reason and rebuilds for you, see
[Updating the index](#updating-the-index)). Index files
written before the identity was recorded carry none and are kept as they are; a switch under
one is caught at the first search instead, where the query vector turns out to be a different
width from the stored ones.

**`local` is opt-in by install** to keep the core package light:

```bash
npm i @huggingface/transformers
```

The first local build downloads the model (~25 MB) once.

### Why it is not bundled

`@huggingface/transformers` statically imports `onnxruntime-node`, whose prebuilt native
binaries ship for every platform in one package. The full tree is **~384 MB installed**
(211 MB onnxruntime-node + 130 MB onnxruntime-web + ~40 MB of `sharp`/tokenizers), against
a ~35 MB bundle today. There is no WASM-only shortcut either: the package's Node entry
point imports the native runtime unconditionally, so it cannot be pruned. Shipping it would
mean five per-platform `.mcpb` files of 100 MB+ each, and users picking the right one.

So the `.mcpb` bundle carries **keyword search out of the box**, and local vectors are an
opt-in that lives outside the bundle:

```bash
npm i -g @huggingface/transformers
npm root -g            # copy this path
```

Then set **`ZOTEUS_TRANSFORMERS_PATH`** to that path (in Claude Desktop: the extension's
**"Local embeddings path"** setting) and restart. Because it lives outside the bundle it
survives extension updates, which would wipe anything installed *into* the extension folder.
The variable accepts the `npm root -g` directory, the package directory itself, or an npm
prefix. It works for npm/Docker installs too, whenever the module lives somewhere the
server cannot resolve on its own.

### When vector ranking is off

Missing dependency, missing API key, a model download that failed mid-build: in every case
the index still builds and keyword search still works. What changed in **1.4.2** is that
this is no longer silent (it used to be a single stderr line, which desktop clients
discard):

- `zotero_index action:"status"` reports `embedderActive: false` with an
  `embedderReason`, and `embedder` reads `none (local requested; ...)` instead of `local`.
- `zotero_semantic_search` with `mode:"semantic"` returns an **error** explaining why, not
  an empty result set; `auto` mode appends the same notice to its summary.
- `zotero_whoami` reports embedding health alongside identity.

After installing the runtime, run `zotero_index action:"build"` again: an index built
without an embedder stays keyword-only until it is rebuilt.

The index is stored under `<ZOTEUS_DATA_DIR>` and reopened on startup: see
[Storage backends](#storage-backends) for which file that is.

## Large libraries

A few things to know when indexing a big Zotero library:

- **Run on Node 22.13+ so the index goes to SQLite.** It is the difference between a build
  that fits in 162 MB of memory and one that needs 5.4 GB, and past roughly 250k passages
  the JSON backend cannot save the index at all (see
  [Storage backends](#storage-backends)).
- **Local embeddings are CPU-bound.** With `ZOTEUS_EMBEDDINGS=local` the model runs on
  your CPU, so embedding thousands of passages takes real time. If you just want fast
  keyword search, set `ZOTEUS_EMBEDDINGS=off` for a quick keyword-only (BM25) index.
- **First local run downloads the model** (~25 MB) before embedding begins — expect a
  one-time delay (and a slower first build) while it fetches and caches.
- **Builds stop at `ZOTEUS_INDEX_MAX_ITEMS`, 5000 by default** (both Zotero APIs page
  100-at-a-time). A build that hits the cap reports how many items it left out, in status
  and in every later `zotero_semantic_search` result, so a bigger library never looks
  fully indexed when it is not. Raise the variable to cover it, or pass a smaller `limit`
  to index a subset faster.
- **Build once, then update.** `action: "update"` costs the delta rather than the library
  (see [Updating the index](#updating-the-index)), which on a big library is the
  difference between seconds and ten minutes of embedding. Keep the same backend between
  runs where you can: closing the desktop app between a build and an update forces a
  rebuild, because the two APIs number their library versions independently.
- **Indexing a big library is fastest against the desktop app** — it is served from disk
  over loopback, with no cloud rate limits to back off from.
- **Don't block on the build call.** `build` returns immediately; poll
  `action: "status"` (every few seconds) until `state` is `done`. A partially built
  index is usable for keyword search the whole time, and progress survives crashes.
- **Embeddings are batched** (32 passages per pipeline call or API request) to keep builds
  efficient and interruptible. `ZOTEUS_EMBED_BATCH_SIZE` and `ZOTEUS_EMBED_BATCH_DELAY_MS`
  resize and pace those batches when an API provider's per-request or per-minute limits
  need it (see [Tuning API embeddings](#tuning-api-embeddings)).
- **Full text multiplies all of the above** by roughly the passage ratio above. On a large
  library, start with a `limit` or a smaller `fulltext_max_chars` before indexing
  everything.
