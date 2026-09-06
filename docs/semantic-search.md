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
  The two differ in one thing only: `build` **resumes** a build that was interrupted, where
  one is on disk, while `refresh` always starts from scratch. See
  [Resuming an interrupted build](#resuming-an-interrupted-build).
- `action: "update"` re-indexes only what changed since the last build, and drops what the
  library no longer holds. This is the cheap one; see
  [Updating the index](#updating-the-index).
- `action: "status"` — live progress and index size. Reports
  `state` (`idle` | `building` | `done` | `error`), `operation` (`build` | `update`),
  `itemsFetched` / `itemsTotal`, `itemsRemoved`,
  `itemsAvailable` (what the library holds, before the cap; larger than `itemsTotal`
  exactly when the build was truncated), `passages`, `vectors`, `items`, the
  **effective** `embedder`, `libraryVersion` / `libraryBackend` (the version stamp an
  update diffs from), `fulltextVersion` (how far into Zotero's separate full-text sequence
  the index has read, see [Text extracted after the
  build](#text-extracted-after-the-build)), `resumedFrom` (items inherited when a build
  resumed an interrupted one), `updateNotice` (what the last update did, or why a rebuild
  replaced it), `localApiDegradedAt` (present only when this job saturated Zotero's local
  API and the session fell back to the Web API; see [Full-text
  indexing](#full-text-indexing-opt-in)), and `lastError` when
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
  index could not be written). Two more describe how the last semantic query ranked
  vectors: `vectorScan` (`codes` or `exact`) and `vectorScanNotice`, see
  [Two-stage vector search](#two-stage-vector-search).
- `action: "stop"` cooperatively cancels a running job. A build halts between
  pages/batches and the partial index is kept and stays searchable; it also leaves a
  checkpoint, so the next `action:"build"` carries on from it rather than starting over. A
  stopped **update** keeps what it applied but leaves the version stamp where it was, so the
  next update simply repeats the delta.
- `action: "pause"` sets a durable hold and cooperatively stops any running job. The hold
  survives a server restart and makes `build`, `refresh`, `update`, and semantic search's
  automatic first build refuse without creating background work. Existing indexed content
  remains searchable.
- `action: "resume"` clears that hold. It deliberately starts no job by itself: follow it
  with `build` to continue a checkpoint or `update` to request a delta.
- `limit` — optional max number of items to index. It lowers the configured cap for one
  build and can never raise it: the build stops at the lower of `limit` and
  `ZOTEUS_INDEX_MAX_ITEMS` (default 5000).
- `own_words` — index your own child notes and PDF annotations (see
  [Your own notes and annotations](#your-own-notes-and-annotations) below). Defaults to
  `ZOTEUS_INDEX_OWN_WORDS` (on).
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

**One index file, one library.** Because the file is keyed by the data dir, a build for a
*different* library than the one the index holds would silently erase it — or, where an
interrupted build left a checkpoint, resume into it and leave one file holding two
libraries' rows. The index
therefore stamps the library it was built for (the personal library counts as one library
however it is addressed, `users/0` or by user id), and a build or update for another one
refuses up front, naming both. To index a second library, run Zoteus with its own
`ZOTEUS_DATA_DIR` for it — or delete the index file to hand the data dir over.

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
4. Asks Zotero's **full-text sequence**, a second and independently numbered one, what
   it has extracted since the cursor the index stored, and indexes the new body text
   through the same attachment-to-parent map a build uses. One request when nothing was
   extracted. See [Text extracted after the build](#text-extracted-after-the-build).
5. Advances both cursors **only after all of that succeeded**, and persists once.
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
| No version stamp | An index built before 1.7, imported from an older JSON file, or left by a cancelled build, covers an unknown slice of the library. The rebuild it falls back to **resumes** that cancelled build rather than starting over, see [Resuming an interrupted build](#resuming-an-interrupted-build). |
| The serving backend changed | The desktop app and the cloud number their library versions independently, so a stamp from one names a different point in the other's sequence. Closing Zotero between runs is enough to trigger this. |
| The embedding model changed | Only the changed items would come back with vectors in the new space; the rest would be ranked against a foreign one. (Same rule as [Changing the model](#tuning-api-embeddings).) |
| The store cannot delete rows | Deleted items could never leave the index. Both shipped backends can, so this is a guard for future stores. |
| The census came back empty | Treated as a failed read, not an emptied library: deletions are skipped, the stamp is withheld, and `updateNotice` says so rather than erasing the index. |

### Text extracted after the build

Zotero numbers extracted full text on a sequence of its **own**, unrelated to item
versions. Opening a PDF for the first time makes Zotero extract it and touches no item
version at all, so that item appears in no `?since=` delta, ever. An update that keyed
everything on the item version therefore left the index's full-text coverage frozen at
build time, with a full rebuild as the only remedy.

So a build records a second cursor beside the version stamp (`fulltextVersion` in
`status`, the highest version in the `/fulltext?since=0` census it consumed), and an update
asks `/fulltext?since=<that cursor>` for what has been extracted since. New text is
attached to its parent item through the same attachment map the build uses, replacing that
item's body passages and leaving its metadata ones alone. `updateNotice` counts them
separately, because they are a different question answered by a different sequence: *"N
unchanged item(s) gained newly extracted attachment full text."*

- **On a library where nothing was extracted, this costs one request.** The probe comes
  first and on its own; only a non-empty answer is worth building the attachment map.
- **The cursor advances only when the update fully succeeded**, under the same rule as the
  version stamp, so a failed update repeats the catch-up rather than skipping past it.
- **An index written before 1.10 has no cursor.** The first update that wants full text
  cannot tell which text is new, so it catches up its **coverage gap** instead: the items
  holding no body passages at all. That runs once, because the same update stores a real
  cursor. An index that holds no body text at all is left alone entirely: turning
  `action:"update"` into the hours-long full-text crawl that was never asked for is not an
  update. Run `action:"build"` with `fulltext:true` for that.
- **`fulltext` must be on for the update too.** An update not asked for full text never
  consults the other sequence at all.

### Resuming an interrupted build

A build stopped by `action:"stop"`, a crash or a restart used to be lost work: the only
progress a build recorded was the version stamp, which is deliberately **withheld** from a
build that did not finish (it covers an unknown slice of the library), and the desktop
local API commonly answers with no version at all. So the next build cleared the store and
crawled from 0 over items it had already fetched, chunked and paid to embed.

A build now commits a **checkpoint** (the crawl offset, the pass it was in, the library
totals it saw, the API that served it, the embedder identity, and the handful of passages
queued but not yet embedded) in the same write as the rows it describes. `action:"build"`
finds it and carries on:

- Everything already committed stays searchable throughout, and is never re-fetched,
  re-chunked or re-embedded. What gets redone is bounded by the last save (200 items / 10s
  on the metadata pass, 500 items / 60s on the full-text one).
- The resume point is a stored offset, not a search for one: no scan of the index, and the
  first request asks for the item after the last one committed.
- The stored offset is **verified** against the library's own totals on the first page it
  reads, since Zotero pages items newest-modified-first and one edit made while Zoteus was
  down shifts everything down by one. If they disagree, the crawl walks the library from
  the top again and steps over what the index holds by key: pages, never re-embedding.
- The full-text pass resumes on the same principle: items whose body text is already
  indexed are skipped, so no PDF is read twice.
- A resumed build stamps the library version the **interrupted** crawl began from, so
  anything modified in between is still waiting for the next `action:"update"`.
- It refuses to resume under a different embedding model: two vector spaces in one index is
  exactly what an update is refused over, and a resume must not create it by the back door.
- `status` reports `resumedFrom` (the items inherited), and `updateNotice` says outright
  that a resume is what started.

`action:"refresh"` is the one that always starts over: same crawl, checkpoint discarded.
That is the only behavioural difference between the two actions.

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

## Your own notes and annotations

The index covers the words **you** wrote, not only the ones you collected. Every child
note, and every PDF annotation — its highlighted passage together with your comment on it —
is indexed as an extra passage carrying the **parent item's** key:

```jsonc
// on by default; this is how you turn it off for one build
{ "tool": "zotero_index", "action": "build", "own_words": false }
```

```bash
# or for every build
ZOTEUS_INDEX_OWN_WORDS=false
```

A hit whose snippet came from one is marked `source:"note"` or `source:"annotation"`, so
you can tell your own objection from the abstract it was written against. Because the
passages carry the item's key, an item with forty annotations is still **one** search
result rather than forty: your own words extend what an item can be found by instead of
crowding the page.

This is on by default where full text is not, and the reason is cost. The whole corpus is
one paged crawl of the library's child items (`itemType=note || annotation`, a page per
hundred children, text included in the response) plus one batched lookup per fifty
annotated attachments — an annotation names the attachment it sits on, never the item that
attachment belongs to, so that hop is what attributes it. On a library of 280 items with
606 notes and annotations that is a handful of requests, where the attachment crawl behind
full text is orders of magnitude more. Notes are stored as HTML and indexed as text, so
markup never reaches a snippet, and a standalone note is left to the metadata crawl that
already indexes it.

**`zotero_annotate` and search now agree.** Before this, Zoteus could write an annotation
onto an attachment and then never find it again, on any query: the crawl asked for
top-level items, and an annotation is not one.

**Staying current costs one request.** Notes and annotations are ordinary items carrying
ordinary versions in the library's own sequence, so `action:"update"` asks one keys-only
question (`?format=versions&itemType=note || annotation`) and compares the answer against
the note and annotation keys the index already holds. That finds all three shapes of
change at once: an edit (a version past the stamp), an addition (a key the index has no
passage for) and a **deletion** — the one no `?since=` can ever report, because deleting a
note moves no version anywhere in Zotero. The crawl that reads note bodies is opened only
when there is something to re-index, so an update over a library nobody has annotated
since costs exactly that one request. An index built before this existed fills its gap on
its first update, once, and says so in `updateNotice`.

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
back to reading and parsing the files itself: that would mean fetching and decoding the
whole library. A single unindexed attachment is still readable on demand through
`zotero_get_fulltext`, which extracts it from the file (see
[`grounding.md`](./grounding.md#unindexed-attachments-local-extraction-fallback)).

**Local-first, key-free.** Zotero 7+ serves `/fulltext` from the desktop app, so full-text
indexing works with no cloud API key, exactly like the metadata build. Group libraries (and
everything else when the app is closed) go to the cloud Web API.

**How hard the crawl leans on Zotero.** Body reads run concurrently, and how many at once
depends on which API is serving them: **2** for the desktop app, **4** for the cloud Web
API. The two tolerate load in opposite ways. The Web API is a fleet that answers a burst
with a `429` and a `Backoff` header the fetcher honours, so overshooting costs latency and
nothing else. The local API is one desktop application, sharing a process with Zotero's UI,
its sync engine and its own PDF indexer, and it has no rate limiter: it answers everything
until it cannot. Four continuous body reads were enough to stop Zotero 10 answering on port
23119 at all, 60 to 90 seconds into a 358-attachment crawl. That is worse than a slow build,
because local-API reachability is a session-wide fact: the moment it goes, *every* read and
write falls back to the Web API, which is the slower, rate-limited path the crawl was
avoiding in the first place.

Two things follow. `ZOTEUS_INDEX_FULLTEXT_CONCURRENCY` overrides the number for anyone who
has measured their own machine. And if it happens anyway, the crawl notices and backs off to
one read at a time for the rest of the job, so the app can recover, rather than holding it
down for the hours the crawl has left to run. `zotero_index action:"status"` then reports
`localApiDegradedAt` (an ISO timestamp) and explains, in the summary, that the job fell back
to the Web API and why the rest of it is slower.

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
  land near `max_chars / 1200`. In Claude Desktop's settings pane the number input will not
  display a `0` you type, so the field blanks itself and looks like it refused the value; it
  did not, and the server reads it as "no cap" (see
  [`configuration.md`](./configuration.md#desktop-extension-settings-mcpb)).
- `limit` — index fewer items.
- Body passages are chunked at 1200 characters (against 512 for metadata), which keeps the
  vector count down and gives each passage enough context to embed usefully.

Progress and outcome are reported by `zotero_index action:"status"`: `fulltextItems`,
`fulltextPassages`, and `fulltextEnabled`. If full text was requested but produced nothing
(no extracted attachments, or the endpoints were unreachable) the build still completes as
a metadata index and `fulltextReason` says why, rather than looking complete.

**Metadata first, then bodies.** A build runs in two passes, and `status` reports which one
is running as `phase`. The first indexes every item's own text — title, abstract, creators,
tags — across the whole library; only then does the second crawl attachment bodies, tracked
by `fulltextItemsScanned` of `fulltextItemsTotal`. The point is the gap between them: on a
large library the body crawl can run for hours or days, and the library is fully searchable
on its metadata for all of it rather than only at the end. A build stopped during the second
pass therefore leaves complete metadata and partial full text, which is worth knowing before
you decide whether to resume it.

The version stamp an `action:"update"` diffs against is written only when *both* passes have
finished. A build interrupted during the body crawl is deliberately left unstamped, because
a stamp would make the next update skip every item whose attachments were never read: those
items are unchanged in Zotero, so they would appear in no delta, ever. The checkpoint is
what such a build leaves instead, and `action:"build"` picks the body crawl up from it: see
[Resuming an interrupted build](#resuming-an-interrupted-build).

### Full-text builds inside Claude Desktop

Claude Desktop runs a bundled (`.mcpb`) extension inside its own process rather than as a
separate program: it forks an Electron `utilityProcess`
(`--utility-sub-type=node.mojom.NodeService`) and imports the server into it, which is what
"Using built-in Node.js for MCP server" means in its log. Through 1.12.0, a build that
reached the full-text pass **killed the server process** there partway through: no thrown
error, no stack, no out-of-memory report, nothing on stderr, just
`Server transport closed unexpectedly` in the host's log ([#37]). It is fixed in 1.13.0, and
what it turned out to be is worth writing down.

**The process was crashed on purpose, by the allocator.** The reproduction, outside Claude
Desktop but faithful to it, is a prebuilt Electron 42.10.0, the desktop app's own
`mcp-runtime/nodeHost.js`, the same `utilityProcess` fork and the same JSON-RPC bridge over
a `MessagePort`. The child dies of **SIGTRAP**, which is Chromium's deliberate crash rather
than a fault, and the crash report the desktop app itself filed for the original failure
says the same thing on the same utility sub-type. Chromium replaces the process allocator,
and an allocation it will not serve does not come back as null for the caller to handle: it
takes the process down immediately, before any handler could run. That is why the death was
silent, and why no `uncaughtException` hook would ever have caught it.

**What asked for the allocation was the on-device embedding model.** Three runs separate the
causes:

| Run | Runtime | Embedder | Full text | Outcome |
|---|---|---|---|---|
| A | Electron `utilityProcess` | `local` | yes | **SIGTRAP**, 14 s into a resumed build, peak RSS 1008 MB |
| B | Electron `utilityProcess` | `off` | yes | **completed**: all 262 items, 18287 body passages, peak RSS 283 MB |
| C | Electron `utilityProcess`, no Zotero and no SQLite at all | `local` | n/a | **SIGTRAP** inside `extractor()` |

B exonerates the crawl, the concurrent attachment reads, the SQLite write path and the
persist cadence in one run. C removes everything except the model: load
`@huggingface/transformers` in a bare `utilityProcess` and call the feature-extraction
pipeline on batches of growing length, and it embeds 32 passages of 512 characters and 32 of
1200 characters happily, then dies on a batch whose sequences reach the model's 512-token
limit. The identical loop under standalone Node completes, at 2 GB RSS, having never been
refused an allocation.

**So the size of one pipeline call is the whole story**, and that size is batch x sequence².
`all-MiniLM-L6-v2` computes a batch x 12-head x seq x seq attention tensor: at 32 passages
of 512 tokens that is about 400 MB in a single block, and onnxruntime's arena asks for it in
one piece. Metadata passages are chunked at 512 characters, roughly 128 tokens, so the same
batch of 32 needs about 25 MB and never comes close, which is why the metadata pass
embedding thousands of passages first proved nothing about the native layer, and why the
full-text pass, chunked at 1200 characters (`FULLTEXT_CHUNK_SIZE`) and dense enough to reach
the token cap, was the one that always died.

**The fix is a bound, not a gate.** Under Electron the local embedder takes 8 passages per
call instead of 32, which puts the largest tensor it can ask for at roughly 100 MB, a
quarter of the size measured to crash. Only the local provider is capped and only under
Electron: an API provider's batch is an HTTP request body and allocates nothing large in
this process. A `ZOTEUS_EMBED_BATCH_SIZE` lower than the cap is kept; a higher one is
lowered to it, and the server logs one line saying so. With that in place the full-text
build this issue was filed about runs to completion inside a `utilityProcess`, on the same
library, with the model in the same process.

The refusal that 1.12.0 put in front of the pass, and its `ZOTEUS_ALLOW_ELECTRON_FULLTEXT`
override, are both gone. A build inside the desktop app is a little slower than the same
build in a terminal and produces exactly the same index, so building headlessly once against
the same `ZOTEUS_DATA_DIR` is still the faster route on a large library, and Desktop reads
the result either way:

```bash
# In a terminal, pointed at the same data directory Claude Desktop uses.
# (~/.local/share/zoteus on Linux, ~/Library/Application Support/zoteus on macOS.)
ZOTEUS_DATA_DIR=~/.local/share/zoteus \
ZOTEUS_INDEX_FULLTEXT=true \
npx -y @oscardvs/zoteus
```

Drive that server over stdio with any MCP client (`npm run inspector` is one) and call
`zotero_index action:"build" fulltext:true`. `zotero_index action:"update"` then keeps the
index current from inside Claude Desktop, body text included: an update re-reads only the
items Zotero changed, plus the attachments its full-text sequence has extracted since the
stored cursor (see [Text extracted after the build](#text-extracted-after-the-build)).

[#37]: https://github.com/oscardvs/zoteus/issues/37

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

The SQLite backend stores passages in an **FTS5** table (`unicode61 remove_diacritics 0`,
ranked with `bm25()`) and vectors as per-passage `BLOB`s, so a keyword search reads only
the rows it ranks and never materializes the library. The semantic path used to be the one
that grew with the library, because it read every vector; it now reads a binary code per
vector instead and fetches the float32 vectors of a few hundred candidates. See
[Two-stage vector search](#two-stage-vector-search).

**Diacritics.** An unaccented search finds accented words: `Bronte` finds `Brontë`, and
`theorie` finds `théorie`, on both backends. An accented search is answered exactly:
`Brontë` finds documents that spell it `Brontë`.

The index holds each word exactly as it was written — the FTS5 table is declared
`remove_diacritics 0` and nothing strips marks on the way in. The tolerant direction is
paid on the **query** side instead: an unaccented query term is expanded to the accented
spellings the library's vocabulary actually holds (`theorie` runs as
`theorie OR théorie`), through a small folded-form → spellings map each backend derives
from its own vocabulary. Because nothing extra is indexed, document length, term
frequency and idf are what the text says they are, and ranking is untouched for every
query that needs no expansion.

Expansion is optional (`ZOTEUS_ACCENT_EXPANSION`, on by default): it compensates the
recall that keeping diacritics in the index removed for unaccented queries, and setting
it to `false` opts into strict as-typed exactness — a query-time switch only, so flipping
it never needs a rebuild.

Expansion is **dominance-gated**: a term expands only when the accented spellings
outweigh the typed one in this library (by document frequency, compared at derivation
time). `theorie` expands because the library overwhelmingly writes `théorie`; `trong`
does not, because the library holds it 25 771 times as typed and its accented siblings
(`trọng`, `trồng`, …) are different, rarer words whose high idf would otherwise outrank
what the user asked for. The gate is corpus-derived — there is no threshold to tune.

It used to strip marks from everything on both sides, and that is a different thing from
being insensitive to them. In a library holding more than one language it merges
vocabulary rather than normalizing spelling: Vietnamese `án`, `bé`, `thể` and `thế` all
land on English `an`, `be` and `the`, and a tone mark in Vietnamese is part of the word,
not an accent on it — `ma má mà mả mã mạ` are six words. Once merged into a token that
common, they could not be searched for at all.

The remaining asymmetry is deliberate: an accented query does **not** find a document that
spells the word without its accents. Expansion runs one way only, because expanding `thể`
toward `the` is exactly the merge above.

Marks are stripped (for the expansion map's keys) the way `unicode61` strips them and no
further — `ø œ æ ł đ ð þ ß` are letters to it rather than accented forms, so they are
letters here too, and `søren` does not answer to `soren`.

**Common words.** A keyword query is answered by OR-ing its terms, so a term that occurs
in most of the library costs a full posting-list walk and separates nothing. Zoteus used to
handle that with 29 hard-coded English function words, dropped from every query and every
document. That list is wrong for a multilingual library — German `die` and English `die`
are one string in the index, so no list can drop one and keep the other — and it is a guess
about frequency rather than a measurement of it: `energy` sits at 26% document frequency in
one real library, higher than several words that were on the list.

Zoteus now measures the library instead. At the end of a full build it scans the keyword
index's own term vocabulary (`fts5vocab`, a view over the index — no new tables, no
rebuild) and records the terms that appear in **30% or more** of the passages. That list is
applied to queries only, never to documents, and it is stored in the index, so it costs
nothing at query time and nothing at startup. On a 477 512-passage library it is 23 terms
and 75 bytes, and deriving it costs one scan of 639 888 vocabulary terms — a couple of
seconds against a build that takes minutes. A delta update does not redo it unless the
passage count has moved by more than 10%, since a handful of new items cannot change a
30% threshold.

Two consequences worth knowing. A query in which **no term survives** the prune is sent
unpruned: a measured list can hold the library's own subject words (`economics` reaches 35%
of the English passages of one real library), so answering such a query with silence would
look like an empty library. While any term survives, the survivors are what runs — they
are, by measurement, the words this library can discriminate on, and the prune is never
abandoned on their account. And an index built by an earlier version prunes nothing
until its next build or update, at which point it adopts a list of its own; nothing is
stranded and no rebuild is forced.

**Where this sits relative to accent expansion.** Both run between tokenizing the query
and building the MATCH string, and the order is: prune first, then expand the survivors.
The droplist judges the terms you typed, because they are the question, and expansion then
serves whatever the prune ruled worth running (including the raw set, when nothing
survived). A term the prune dropped is never expanded, so it costs no vocabulary lookup
and no accented posting list. A variant is not re-pruned, because it is another spelling
of a surviving term rather than a query term of its own, and the dominance gate above
already requires it to outweigh the spelling you typed.

**Where the files are.** `<ZOTEUS_DATA_DIR>/search-index.sqlite` beside the older
`search-index.json` (and `search-index-<userId>.*` per tenant in multi-tenant mode). SQLite
also writes `-wal` and `-shm` sidecar files while the database is open; a clean shutdown
folds them back in. On-device model weights are cached under `<ZOTEUS_DATA_DIR>/models`,
so removing the data directory removes everything the index ever wrote.

**If the index is damaged.** A search index that cannot be read no longer stops the server
from starting: it is a derived cache, and no other tool reads it, so item lookups,
bibliographies, attachments and citations carry on working. Search alone refuses, and says
why.

To repair it, call `zotero_index` with `action:"build"`. That call — and only that call —
deletes the unreadable file and its write-ahead sidecars, opens a fresh index in their
place, and rebuilds in the background. Asking for a build is what makes the deletion
consented to: nothing repairs the index at startup or inside a query, because a rebuild
re-reads the whole library and takes minutes to tens of minutes, which is not a job to
begin without being asked. `action:"update"` refuses and points you here, since a delta
needs the index it cannot read. If the files cannot be deleted — another Zoteus is holding
them, or they are read-only — the message falls back to naming them for `rm`.

Deletion rather than truncation is deliberate: the version stamp lives inside the same
database, so a repair that dropped the passages and kept the stamp would leave an empty
index reporting itself as up to date. Removing the file removes the stamp with it.

The same applies to a `search-index.json` that cannot be parsed. It used to load as an
*empty* index, which reads exactly like a library holding nothing — and, because loading
resets before it parses, the next clean shutdown wrote that emptiness back over the file.
A JSON artifact that fails to parse is now refused, left untouched on disk, and repaired by
the same `action:"build"`.

**An older schema version is upgraded in place.** When Zoteus bumps the index schema, a
database stamped with an earlier version of *this* schema is migrated where it lies: the
ladder of upgrade steps runs inside one transaction with the new stamp, so the file is
either fully upgraded or fully unchanged, and nothing is re-crawled or re-embedded.
`storageNotice` says what moved it forward. A step that fails rolls the whole thing back
and the database is moved aside instead, exactly as an unmigratable one is.

**A database from an unreachable schema version is moved aside, never written into.** The
schema stamp is read before anything touches the file. A database stamped with a version
this build cannot reach — one written by a newer Zoteus after a downgrade, a file with no
stamp at all, or a version no ladder covers — is renamed to
`search-index.sqlite.incompatible-<timestamp>` (its write-ahead sidecars with it, nothing
deleted), a fresh index is created in its place, and `storageNotice` says what moved and
where. The moved file stays a complete database, readable by the build that stamped it;
rebuild with `zotero_index action:"build"`, and a later re-upgrade finds the moved file
intact.

**A sideline hands its vectors to the rebuild that replaces it.** The expensive half of a
rebuild is not the crawl but the embedding — hours of local CPU on a large library, or real
spend on a hosted provider — and none of that cost is inherent: an embedding is a function
of the passage text and the model, neither of which a schema change touches. So the
moved-aside database stays open as a read-only vector source, and every passage the rebuild
re-reads with the same id and byte-identical text takes its vector from there instead of
being embedded again. Only genuinely new or edited text costs embedding time. The reuse is
refused outright when the embedder has changed (`embedderId` covers provider *and* model),
and `storageNotice` prices the rebuild either way: how many passages must be re-indexed, how
many vectors that involves, and whether they have to be paid for.

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

## Two-stage vector search

A semantic query used to read every stored vector: on a 255,703-passage index at 3072
dimensions that is 3.1 GB decoded and multiplied per query, and it took **90 to 105
seconds** whatever was asked (issue #30). The cost was never the store, it was the bytes:
number of vectors x bytes per vector x cost per byte, and at 3072 dimensions the middle
term is 12,288 bytes a passage.

The SQLite backend now shrinks that middle term. Beside each vector it keeps a **binary
code**: one bit per dimension, set where that coordinate is above the corpus mean, so a
3072-dimensional vector becomes 384 bytes. A query is centred on the same mean, reduced to
the same 384 bytes, and compared against every code by **Hamming distance** (a XOR and a
popcount over `Uint32Array`s, which is cheap enough to do a quarter of a million times).
That first pass produces a *candidate pool*, and only those candidates' real float32
vectors are read and ranked by the exact cosine the full scan used.

Two properties follow, and they are the whole design:

- **Every score you see is exact.** The codes decide which rows get scored, never how they
  rank. The page returned is ordered by exact cosine over real vectors, so scores are
  comparable with anything the full scan produced and no index needs rebuilding.
- **What can be lost is recall, not correctness.** A relevant passage the codes rank
  outside the pool is not seen at all. Measured on real embeddings against the exact
  ranking, a pool of 8x the result set recovered 0.953 of it and 16x recovered 0.986, and
  the codes get *better* as vectors get wider (0.953 at 384 dimensions, 0.997 at 1024),
  because a wider vector makes a longer code. Binary codes with no rescore recovered only
  0.592, which is why the float32 vectors stay in the index.

**This makes queries fast; it does not reclaim disk or memory.** The vectors are still
there, and they must be: the rescore is what buys the accuracy back. The codes are an
addition, about 3% of the size of the vectors they describe.

**Where the codes live.** In the index file, in a `vector_codes` table, beside the corpus
mean they were centred on. They are written by `zotero_index action:"build"` and kept
current by `action:"update"`, which codes the passages it adds and drops the codes of the
items it removes. An index built by an older Zoteus has none: the first semantic query
builds them in one pass over the vectors (the same pass that query was going to make
anyway) and says so in `vectorScanNotice`. Nothing is rebuilt and no re-embedding
happens; the codes are derived from vectors that are already on disk. They are held in
memory while the server runs (dimensions ÷ 8 bytes per passage: about 98 MB for 255k
passages at 3072 dimensions) and dropped whenever the index is written to.

**When it does not apply.** An index with fewer vectors than the candidate pool would
cover is scanned exactly, and gets no codes at all: there is nothing to narrow, and small
libraries were never slow. A build or update in progress also leaves the codes alone, so
queries during a build take the exact path. Whichever path served the last query is
reported by `zotero_index action:"status"` as `vectorScan` (`codes` or `exact`), with
`vectorScanNotice` explaining anything that needs explaining: the fallback, or the
one-time backfill.

| Variable | Default | What it changes |
|---|---|---|
| `ZOTEUS_INDEX_ANN` | `true` | The escape hatch. `false` turns the coded path off entirely: every semantic query scans every vector, exactly as before, and no codes are written. |
| `ZOTEUS_INDEX_ANN_OVERSAMPLE` | `16` | Candidates rescored per vector hit the fusion asks for. Higher is more accurate and slower; the measured recall at 4x/8x/16x was 0.884/0.953/0.986. |
| `ZOTEUS_INDEX_ANN_MIN_CANDIDATES` | `500` | Floor on that pool, so a small `limit` still rescores a real neighbourhood. It is also the size below which an index is simply scanned exactly. |

`bench/two-stage-search.ts` measures both paths over a synthetic index of any shape
(`npx tsx bench/two-stage-search.ts --vectors 255703 --dim 3072`).

## Embedding backends (privacy-first)

Set `ZOTEUS_EMBEDDINGS`:

| Value | Behaviour |
|---|---|
| `local` (default) | On-device embeddings via `@huggingface/transformers`, with any transformers.js model you name (default `Xenova/all-MiniLM-L6-v2`; see [Choosing a local model](#choosing-a-local-model)). **No data leaves your machine.** |
| `openai` / `gemini` | API embeddings (opt-in; requires `OPENAI_API_KEY` / `GEMINI_API_KEY`; data is sent to the provider). |
| `off` | Keyword-only (BM25). |

### Choosing a local model

`ZOTEUS_EMBEDDING_MODEL` names the model of whichever provider is active, and that includes
`local` (#43): set it to any [transformers.js](https://huggingface.co/models?library=transformers.js&pipeline_tag=feature-extraction)
feature-extraction model and the on-device pipeline loads that one instead. Unset keeps
`Xenova/all-MiniLM-L6-v2`, so nothing changes for an existing install.

The default is English-centric, which is the whole reason the knob exists. It was trained on
English sentence pairs, and on a mixed-language library it ranks by *language* before topic: a
German question puts every German passage above the English paper that actually answers it.

| Model | Dimensions | Downloaded once (fp32 / q8) | Languages | Input prefixes |
|---|---|---|---|---|
| `Xenova/all-MiniLM-L6-v2` (default) | 384 | 87 MB / 23 MB | English | none |
| `Xenova/multilingual-e5-small` | 384 | 465 MB / 129 MB | ~100, German included | `query: ` / `passage: `, applied for you |

The second size is what [`ZOTEUS_EMBEDDING_DTYPE`](#choosing-a-precision) fetches instead.

Measured on a 12-passage German/English corpus with four German questions (the script is in
the [#43](https://github.com/oscardvs/zoteus/issues/43) thread): both models put the German
passage that answers the question first, but MiniLM ranked its English twin **9.5th of 12**,
below every unrelated German passage, while `multilingual-e5-small` ranked it **2.5th**.
Same 384 dimensions, so the index costs exactly what it did before.

**E5 models want their prefixes.** The E5 family is trained with a marker on every input, and
an asymmetric one: `query: ` in front of a question, `passage: ` in front of a document.
Zoteus applies them for you when the model id carries `e5` as a segment
(`Xenova/multilingual-e5-small`, `intfloat/e5-base-v2`), and never otherwise, so a symmetric
model such as MiniLM keeps getting exactly the text you gave it. The prefix goes to the model
and nowhere else: it is not stored with the passage, and it is not part of the embedder
identity below. `ZOTEUS_EMBEDDING_PREFIXES` overrides the detection in both directions: `off`
never prefixes, `e5` always does (for a mirrored checkpoint whose name does not say what it
is), `auto` is the default.

**Pooling is decided by the model, from a table.** A model folds its per-token outputs into one
vector either by averaging them (`mean`) or by taking the first, `[CLS]`, token (`cls`), and it
is trained for one of the two. The other reads its outputs wrong without ever failing: the
graph still returns a unit vector of the right width, it just retrieves worse. Measured on a
257-passage, 68-query cross-lingual set with pooling as the only variable at fp32, mean pooling
costs `granite-embedding-97m-multilingual-r2` 27.5% of its MRR and 34.6% of its hit@1,
`gte-multilingual-base` 12.7% and 10.3%, `arctic-embed-m-v2` 10.3% and 14.7% (the harness and
the corpus manifest are in the [#43](https://github.com/oscardvs/zoteus/issues/43) thread).
Those are fp32 figures. At `q8` the gap narrows sharply on `granite-embedding-97m`, where the
mean and CLS readings of a passage come out around cosine 0.999 of each other rather than the
0.53 MiniLM shows at either precision, so on that model the correction buys much less than the
numbers above once the weights are quantized. Why is not established; it is not a general
property of `q8`. Unlike the E5
prefixes, nothing in the model id says which pooling a model wants, and the value cannot be
read at load time either: it is published in `1_Pooling/config.json` on the model's source
repository, which the ONNX mirrors the pipeline loads (`Xenova/*`, `onnx-community/*`) do not
republish. So Zoteus carries a curated table (`MODEL_POOLING` in `embeddings.ts`, each row naming
the repository its value was read from): `mean` for MiniLM, the E5 family and the
paraphrase-multilingual models, `cls` for the granite, gte, arctic-embed, bge and mxbai models, and
`mean` for any model the table does not list, which is exactly what every model got before the
table existed. The table is a record of what each model was trained with, not a list of models
this project recommends: naming one there says its pooling was read, nothing more.

`ZOTEUS_EMBEDDING_POOLING=mean` or `=cls` overrides the table for every model, for a mirrored
or renamed checkpoint whose id the table cannot speak for; `auto` is the default. A pooling
that is not the default joins the embedder identity, the way a precision above `fp32` does:
`local:onnx-community/gte-multilingual-base#cls`. So setting it is not free. It makes a
different vector space, the stored vectors stop matching the identity, and they are dropped
with a notice the next time the server opens the index. Leave it unset unless you have read
that file for your model.

Every model the table pools the default way, the default model included, keeps the identity it
always had, so an index built with one of those is untouched. An index built with one of the
`cls` models under 1.13.0 is the exception, and the only one: it holds mean-pooled vectors, its
identity does not carry the `#cls` this server now embeds with, and it is dropped with that same
notice. One `zotero_index action:"build"` re-embeds it. If you would rather defer that,
`ZOTEUS_EMBEDDING_POOLING=mean` reproduces the identity the index already carries and it keeps
working, at the retrieval quality it was built with.

**Changing the model means rebuilding**, exactly as it does for an API provider: the identity
stored beside the vectors becomes `local:Xenova/multilingual-e5-small`, the old vectors are
dropped with a notice, and one `zotero_index action:"build"` re-embeds the library. See
[Changing the model means rebuilding the index](#tuning-api-embeddings) below. An index built
with one of the `cls` models before this release holds mean-pooled vectors, and it is dropped
with the same notice for the same reason: its identity does not carry the `#cls` this server
now embeds with. One `zotero_index action:"build"` re-embeds it.

The weights are downloaded once into `<ZOTEUS_DATA_DIR>/models/<org>/<model>`, so deleting the
data directory still removes them along with the index.

### Choosing a precision

`ZOTEUS_EMBEDDING_DTYPE` picks which of a repository's published weight files the on-device
pipeline loads. Unset means `fp32`, the full-precision ONNX graph, which is what
`@huggingface/transformers` 4.2.0 fetches on CPU and therefore what every local index built
before this setting existed holds.

```bash
ZOTEUS_EMBEDDINGS=local
ZOTEUS_EMBEDDING_MODEL=Xenova/multilingual-e5-small
ZOTEUS_EMBEDDING_DTYPE=q8
```

That is the multilingual model at **129 MB instead of 465 MB** on disk, which is the
difference between comfortable and marginal on a machine where the OS, a browser and a Linux
container share a few gigabytes (#43: a ChromeOS/Crostini student setup is the case this was
asked for). The ONNX graph itself is 113 MB against 449 MB; the remaining 16 MB is the
sentencepiece tokenizer, which is the same file at either precision. `q8` is the useful one;
`fp16`, `int8`, `uint8`, `q4`, `q4f16`, `q2`, `q2f16`, `q1`, `q1f16` and `bnb4` are accepted
because a repository can publish any of them.

**A dtype is a file, not a conversion.** `q8` asks the repository for
`onnx/model_quantized.onnx`. The `Xenova/` mirrors publish the whole suffixed set; a model's
own repository frequently publishes the plain fp32 graph alone, so
`intfloat/multilingual-e5-small` has no `q8` to load while `Xenova/multilingual-e5-small`
does. Asking for a variant that was never uploaded fails at load with a message naming the
setting, the model and the mirrors that do serve it, rather than silently falling back to a
precision you did not choose.

**Quantization is a quality decision, and the answer is model-specific.** The benchmark in
[#43](https://github.com/oscardvs/zoteus/issues/43) put six multilingual ONNX models through
a cross-lingual probe with negative controls: the E5 family was the only one whose controls
stayed clean at *every* quantization level, and `multilingual-e5-small`'s hit@10 moved by
0.12 or less per lane between fp32 and 8-bit. The same probe found `granite-97m` respectable
at fp32 and collapsing to 0.00–0.25 on several lanes at 8-bit. So `q8` is close to free on
the model this table recommends, and that is a fact about E5, not about quantization.

The 14-passage German/English probe used above agrees, for whatever four questions are worth:
`multilingual-e5-small` ranks the German passage that answers each question **first at both
precisions**, and ranks its English twin 2.0th on average at fp32 against 2.5th at `q8` (one
question's twin moved from rank 2 to rank 4; the other three did not move). MiniLM ranks that
twin 9.5th. The precision costs a fraction of what the model choice buys.

**A precision change means one rebuild**, on exactly the mechanism a model change uses. Above
`fp32` the dtype joins the stored embedder identity, so `Xenova/multilingual-e5-small` at
`q8` stamps `local:Xenova/multilingual-e5-small@q8` and can never be confused with the fp32
index of the same model: the old vectors are dropped with a notice and one
`zotero_index action:"build"` re-embeds. `fp32` stays unsuffixed so that no existing index is
declared stale by the arrival of this setting.

`ZOTEUS_EMBEDDING_DTYPE` is on-device only. An API provider returns vectors computed on its
own hardware at whatever precision it runs, so setting this under `ZOTEUS_EMBEDDINGS=openai`
or `gemini` logs that it is ignored rather than implying a choice Zoteus cannot make.

### Tuning API embeddings

Four variables tune whichever provider is active, and all four default to today's
behaviour:

| Variable | Default | What it changes |
|---|---|---|
| `ZOTEUS_EMBEDDING_MODEL` | provider default | The model the active provider embeds with: `text-embedding-3-small` (openai), `text-embedding-004` (gemini), `Xenova/all-MiniLM-L6-v2` (local, see [Choosing a local model](#choosing-a-local-model)). |
| `ZOTEUS_EMBEDDING_DTYPE` | `fp32` | Weight precision of the **local** model, e.g. `q8` for a quarter-size download (see [Choosing a precision](#choosing-a-precision)). Ignored by the API providers. |
| `ZOTEUS_EMBED_BATCH_SIZE` | `32` | Passages per embedding call — one API request, or one local pipeline call. |
| `ZOTEUS_EMBED_BATCH_DELAY_MS` | `0` | Pause between those calls. `0` only yields to the event loop; a positive value sleeps. |
| `ZOTEUS_EMBED_MAX_RETRIES` | `5` | Retries a rate-limited (`429`), timed-out or `5xx` embedding request gets before the build gives up. `0` restores the old behaviour, where one transient failure ended the job. |

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

### When a build gets rate-limited

A rate-limited request no longer ends the build. On a `429`, a `5xx`, a timeout or a
dropped connection, the request waits and tries again: 1s, 2s, 4s, 8s, 16s, plus a little
jitter, honouring the provider's `Retry-After` when it sends one, capped at 60 seconds per
wait and about three minutes of waiting per request. `ZOTEUS_EMBED_MAX_RETRIES` sets how
many attempts that is. A `400` is never retried: that is the oversized-batch answer above,
and the batch would be exactly as oversized next time.

**A build that still ends short keeps everything it indexed, and the next one continues
it.** Run `zotero_index action:"build"` again: the items already crawled are not re-fetched,
the PDF bodies already read are not re-read, and the passages already embedded are not
re-embedded. Only the passages carrying no vector are bought, and `action:"status"` says how
many those are (`passagesWithoutVectors`). Use `action:"build"`, not `action:"refresh"`:
refresh is the one that starts the whole crawl over and pays for every vector a second time.

**Pacing it up front.** `zotero_index action:"status"` reports `embedRate` for an API
provider: the batch size, the pause, the estimated tokens per request, and the tokens per
minute the build is actually sustaining. The server log prints the same line when the
full-text pass starts. What makes the rate hard to guess is that at `ZOTEUS_EMBED_BATCH_DELAY_MS=0`
it is set entirely by how fast the provider answers, and on a large full-text build that
lands at roughly a provider's ceiling regardless of tier: a 10,428-item library measured
about 1,000,000 tokens/min against OpenAI's Tier 2 limit of exactly 1,000,000 tokens/min for
`text-embedding-3-small`, and 429'd on six builds in a row ([#48](https://github.com/oscardvs/zoteus/issues/48)).
These settings carried that same library through in one uninterrupted 45-minute run, at
about 400K tokens/min and roughly 21M tokens (about $0.42) in total:

```bash
ZOTEUS_EMBED_BATCH_SIZE=256
ZOTEUS_EMBED_BATCH_DELAY_MS=8000
```

The default delay stays `0`, because backoff makes a standing pause unnecessary for the
libraries that never approach a limit, and no single pause is right for both a Tier 1
account and a Tier 5 one. Set it when a build tells you it is riding the ceiling, or set it
up front on a full-text build of several thousand items.

**Changing the model means rebuilding the index.** Vectors from two models share neither
dimension nor vector space, so comparing them produces scores that look plausible and mean
nothing. Zoteus therefore stores the embedder identity (`openai:text-embedding-3-small`,
`local:Xenova/multilingual-e5-small`)
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

The first local build downloads the model once (~90 MB for the default MiniLM, more for a
larger one) into `<ZOTEUS_DATA_DIR>/models`, so deleting the data directory removes the
weights along with the index.

### Why it is not bundled

`@huggingface/transformers` statically imports `onnxruntime-node`, whose prebuilt native
binaries ship for every platform in one package. The resolved tree is **~700 MB installed**
(686 MB measured on Linux x64 against `@huggingface/transformers` 4.2.0; onnxruntime's
per-platform binaries are the bulk of it, with `sharp` and the tokenizers behind them),
against a ~35 MB bundle today. There is no WASM-only shortcut either: the package's Node
entry point imports the native runtime unconditionally, so it cannot be pruned. Shipping it
would mean five per-platform `.mcpb` files of 100 MB+ each, and users picking the right one.

So the `.mcpb` bundle carries **keyword search out of the box**, and local vectors are an
opt-in that lives outside the bundle, in a directory of its own:

```bash
mkdir -p ~/.zoteus-deps && cd ~/.zoteus-deps
npm init -y
npm i @huggingface/transformers
```

Then set **`ZOTEUS_TRANSFORMERS_PATH`** to `~/.zoteus-deps/node_modules` (in Claude Desktop:
the extension's **"Local embeddings path"** setting, which wants the absolute path, so
`/home/you/.zoteus-deps/node_modules`) and restart.

**Not `npm i -g`.** Claude Desktop does not run the server with the Node on your `PATH`. It
runs it with its own built-in one, which its `main.log` says out loud:

```
Using UtilityProcess for extension Zoteus: appConfig.isUsingBuiltInNodeForMcp is true and built-in node is compatible
[LocalMcpServerManager] Using built-in Node.js for MCP server: Zoteus
```

So under nvm (or any version manager) `npm root -g` names a directory belonging to a Node
that never executes this server, holding onnxruntime binaries built for that other runtime:
the path resolves nothing, or resolves something that throws on import. Switching or
upgrading the Node version later breaks a path that used to work, silently. A standalone
directory belongs to no version manager and survives both (#38).

Living outside the bundle also means surviving extension updates, which wipe anything
installed *into* the extension folder. The variable accepts a `node_modules` directory, the
package directory itself, or an npm prefix whose modules live under `lib/node_modules`. It
works for npm/Docker installs too, whenever the module lives somewhere the server cannot
resolve on its own.

If local embeddings still do not come up, the diagnosis is in
`zotero_index action:"status"`: `embedderReason` names the directory that was searched, and
a package that resolves but fails to load reports the file it loaded plus the Node version,
platform and architecture it loaded it under, which is the ABI mismatch above spelled out.

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
  keyword search, set `ZOTEUS_EMBEDDINGS=off` for a quick keyword-only (BM25) index. The
  model runs on a worker thread of its own, so the server keeps answering status polls,
  searches and new connections while a batch is being embedded (before 1.15.0 each batch
  blocked the whole process, which on a large model looked like a hang, #59); a search
  that arrives mid-build waits for the batch in flight and no longer.
- **First local run downloads the model** (~25 MB) before embedding begins — expect a
  one-time delay (and a slower first build) while it fetches and caches (under
  `<ZOTEUS_DATA_DIR>/models`).
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
