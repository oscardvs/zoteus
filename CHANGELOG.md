# Changelog

All notable changes to Zoteus are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **A durable pause for index work (#56).** `zotero_index action:"pause"` stops a running job and
  persists a hold even when the index is idle; `build`, `refresh`, `update`, and the
  semantic-search automatic build then refuse until `action:"resume"` explicitly clears
  it. Queries remain available, and resume clears the hold without starting work by itself.
- **An uninstall procedure, [`docs/uninstall.md`](./docs/uninstall.md) (#55).** Zoteus has
  no host uninstall hook, so the removal surface is documentation: the one directory that
  holds everything it derives, per platform, what that directory contains, the pre-v1.10.0
  case where model weights landed outside it, what is deliberately left alone (the Zotero
  library, cloud keys) and what Zotero itself remembers (the local-access setting, an
  "Always Allow" grant).
- **`ZOTEUS_LOG_FILE`, a file every log line is appended to as well as stderr.** The server
  in #59 ran under a Windows scheduled task whose stderr went nowhere, so when it stopped
  answering there was no record of what it had been doing. Same format as stderr (`text` or
  `json`); a file that cannot be written is reported once and never stops the server from
  starting.

### Fixed
- **`zotero_get_item` now honours `style` and `locale` (#58).** Both arguments were
  accepted, documented and dropped on the floor: the request Zotero saw carried only
  `include`, so `include:"bib"` with `style:"apa"` and with `style:"chicago"` rendered the
  same entry, in Zotero's default style, every time. They are forwarded now, and `style`
  goes through the same alias table `zotero_bibliography` uses, so "apa", "chicago
  author-date", a CSL id and a CSL URL all work. When the desktop app serves the request
  this also means the styles it has installed, and any it can fetch from the repository,
  are usable from here without further plumbing.
- **"chicago" resolved to a CSL id the style repository no longer has (#58).** The
  repository renamed its Chicago styles for the 18th edition and `chicago-note-bibliography`
  is gone: `zotero_format_bibliography style:"chicago"` failed with a 404 and `zotero_styles`
  reported Chicago unavailable, while the suite asserted the stale id. The alias follows
  the repository's own rename record to `chicago-shortened-notes-bibliography` (what
  zotero.org redirects the old id to, and what the desktop app renders by default), "chicago
  notes" and "chicago full note" name the full-notes variant, and a 404 on any id now
  consults `renamed-styles.json` before giving up, so an id copied from Zotero's
  preferences survives the next rename too.
- **The local embedding model no longer freezes the server while it runs (#59).** With
  `ZOTEUS_EMBEDDINGS=local`, every batch the model embedded blocked the whole process for as
  long as the inference took: onnxruntime-node's `run()` is a synchronous native call behind a
  `setImmediate`, so the event loop got exactly one turn between batches. On a large model at
  full precision that is seconds to tens of seconds per batch, and for as long as a build, an
  update or a catch-up was embedding, the HTTP server answered nothing: a plain `GET /mcp`
  could slip into the gap between two batches, an `initialize`, which needs several turns,
  timed out, and the process sat at every core the runtime could take while reporting no
  progress. It looked like a hang after a completed build; it was the next job embedding,
  with nothing able to say so. The model, the pipeline and every inference now live on a
  worker thread: the same call blocks only that thread, the server keeps answering, and a
  query that lands mid-build waits for the batch in flight and no longer. Concurrent callers
  share one model instead of each loading their own, a worker that dies is reported and
  replaced on the next call, and a runtime that cannot start one falls back to the old
  in-thread loader with a warning. Verified inside an Electron 42 `utilityProcess`, which is
  how Claude Desktop runs the server, as well as under plain Node.

## [1.14.0] - 2026-09-04

### Added
- **An opt-in usage log, so an operator can see how their own server is used
  (`ZOTEUS_USAGE_LOG`).** Until now a running Zoteus said almost nothing about itself: the
  only trace a tool call left was a line in the catch block when it failed, and `/metrics`
  offered four unlabelled counters that reset on every restart. One of them,
  `tool_calls_total`, did not even count tool calls: it counted `POST /mcp`, so an
  `initialize`, a `tools/list` and a batch of five calls were all worth one.

  Set the knob and every tool call and request is recorded in `<data dir>/usage.sqlite`:
  tool name, outcome, duration, Zotero user, client and session. Raw events are pruned
  after `ZOTEUS_USAGE_RETENTION_DAYS` (30); the daily per-tool, per-user rollup they fold
  into is about a kilobyte a day and is kept. `scripts/usage-report.ts` prints it, from the
  file or from a running server over `GET /usage.json`.

  It is **off by default and nothing is ever transmitted**: there is no upload, no third
  party, and no endpoint that serves it without a token. Argument *values* are never
  recorded, only their names, types and sizes, so a search string cannot be reconstructed
  from the log; error *messages* are not recorded either, only a class such as
  `zotero_4xx`, because a message can quote library content. `ZOTEUS_USAGE_IDENTIFY`
  chooses between the Zotero user id, a salted hash of it, and no caller identity at all.
- **`ZOTEUS_METRICS_TOKEN`**, a bearer token for `/metrics` and `/usage.json`. `/metrics`
  has always been unauthenticated, which on a reachable deployment publishes exactly how
  much the service is used to anyone who asks. Unset keeps the old behaviour, and the
  server now warns at startup when metrics are enabled on an OAuth deployment without one.
- **Per-tool counters and a latency histogram.** `zoteus_tool_calls_total{tool,outcome}`,
  `zoteus_tool_duration_ms` (buckets at 5/25/100/500/2000/10000 ms),
  `zoteus_http_requests_total{route,status_class}` and `# TYPE` headers. Latency was
  measured before and thrown away: `ms` was logged and never aggregated.

- **The local model's weight precision is selectable, and it is part of the vector identity
  (#43).** `Xenova/multilingual-e5-small` is the answer for a multilingual library, but at
  full precision it is 465 MB on disk, which is the difference between comfortable and
  marginal on a Chromebook where ChromeOS, a browser and the Linux container share a few
  gigabytes. `ZOTEUS_EMBEDDING_DTYPE=q8` loads the quantized graph instead: **129 MB**,
  measured, of which 113 MB is the ONNX file and 16 MB the sentencepiece tokenizer that is
  the same at either precision. `Xenova/all-MiniLM-L6-v2` goes from 87 MB to 23 MB the same
  way. `fp16`, `int8`, `uint8`, `q4`, `q4f16`, `q2`, `q2f16`, `q1`, `q1f16` and `bnb4` are
  accepted too, because a repository can publish any of them.

  Above `fp32` the precision joins the persisted embedder identity, which was the stated
  precondition for offering this at all: `local:Xenova/multilingual-e5-small@q8` is a
  different vector space from `local:Xenova/multilingual-e5-small` and can never be mistaken
  for it, so switching precision drops the old vectors with a notice and costs one
  `zotero_index action:"build"`, exactly as switching model does. `fp32` stays *unsuffixed*
  on purpose: it is what every local index ever built holds, and spelling it `@fp32` now
  would declare all of them stale over a setting nobody touched. Unset also passes `fp32` to
  the pipeline explicitly rather than leaving the choice to the package, so `local:<model>`
  keeps meaning one precision even if a future transformers.js changes its own default.

  Measured on the same German/English probe as the model change above: `q8` ranks the German
  answer first for all four questions, as fp32 does, and its English twin 2.5th on average
  against fp32's 2.0th. MiniLM ranks that twin 9.5th, so the precision costs a fraction of
  what the model buys. This agrees with the six-model benchmark in #43, where the E5 family
  was the only one whose negative controls stayed clean at every quantization level (and
  where `granite-97m`, by contrast, collapsed on several lanes at 8-bit).

  A dtype is a *file* the repository has to publish, not a conversion Zoteus performs: `q8`
  asks for `onnx/model_quantized.onnx`, and the `Xenova/` mirrors carry the full suffixed set
  while a model's own repository frequently carries the fp32 graph alone. Asking
  `intfloat/multilingual-e5-small` for `q8` therefore fails, and it now fails with a message
  naming the setting, the file and the mirror that does serve it, rather than a bare 404 on a
  URL. `ZOTEUS_EMBEDDING_DTYPE` is on-device only; setting it under an API provider logs that
  it is ignored, because that provider's precision is decided on its own hardware. There is a
  matching field in the desktop extension's settings pane.

### Changed
- **JSON logs carry real fields.** `ZOTEUS_LOG_FORMAT=json` used to stringify the
  structured object into `msg`, so a line read
  `{"level":"info","msg":"http {\"status\":500,...}"}` and `jq 'select(.status >= 500)'`
  matched nothing. A trailing object is now spread into the record as top-level keys.
- **A logged `Error` says what it was.** `redactArgs` walked an Error's enumerable own
  properties, of which there are none, so every error passed as an object reached the log
  as `{}`. It is now rendered as `name: message`.
- **`zoteus_tool_calls_total` now counts tool calls.** What it counted before (`POST /mcp`)
  is still there under its right name, `zoteus_mcp_requests_total`. A dashboard reading the
  old name needs updating.
- **404s on paths this server does not have are counted as scans, not errors.** A public
  instance takes a steady trickle of bots probing `/credentials.json`, `/key.json` and
  friends; they were the bulk of the 4xx, which made the error rate a measure of the
  internet's weather. They now increment `zoteus_http_scanner_requests_total`, log at
  `debug`, and are kept out of the usage log.

- **Every tool now says whether it destroys anything, and several were saying the wrong
  thing by omission.** MCP's `destructiveHint` defaults to *true* when a tool is not
  read-only, so leaving it unset told every client to assume the worst about eleven of the
  thirteen writing tools, `zotero_create_items` and `zotero_import` included. Each was read
  against its handler rather than its name, which changed three answers from what the
  obvious guess would have been. `zotero_annotate` is **not** destructive: its `delete`
  sets `deleted: 1` and lands in the reversible trash rather than issuing the erasing
  DELETE. `zotero_create_items` **is**: its own description offers "include its `key` and
  current `version`" to update, so one call can overwrite an existing item's fields in
  place. `zotero_attachment` is too, but for a reason outside Zotero entirely: `download`
  writes to the local filesystem. `zotero_semantic_search` keeps `readOnlyHint: true`; its
  auto-build writes only Zoteus's own derived index, which is the same judgment that put
  `zotero_index` on the read-only allowlist, and flipping it would drop semantic search out
  of every `ZOTEUS_READ_ONLY` deployment.

- **The update check is off by default, and the desktop bundle can switch it on (#54).**
  `ZOTEUS_UPDATE_CHECK` defaulted to `true`, so a default install did one unauthenticated
  `GET https://api.github.com/repos/oscardvs/zoteus/releases/latest` at startup, once a day,
  before anyone had been asked. Nothing user-identifying went with it, and nothing about the
  library did either, but it was still the only request Zoteus made on its own initiative, and
  the one class of user this project is built for is the one who runs it against their own
  library precisely so that nothing leaves the machine. It now defaults to `false`.

  The check exists for a real reason and keeps it: a manually installed `.mcpb` has no
  auto-update channel, so without the check it never learns a newer version exists. So the
  desktop bundle gains a **Check for updates** switch in its settings pane, defaulting to off,
  which is the first time that knob has been reachable from a `.mcpb` install at all. Reported
  by MinhHaDuong, with the whole causal chain cited line by line.

### Security
- **A caller-supplied filesystem path reached the operator's disk on a shared deployment.**
  Four tool arguments took a path and used it as given: `zotero_attach_file`'s `path`,
  `zotero_attachment`'s `file_path` and `save_path`, and `zotero_tag_audit`'s
  `vocabulary_path`. On a single-user install that is the tool working as intended, because
  the caller owns the machine. On an OAuth deployment the caller is not the operator, and
  those paths pointed at the *server's* filesystem.

  So an authenticated user of a hosted instance could read any file the process could read,
  by attaching it into their own library and downloading it again, and write any file the
  process could write, by uploading bytes and then naming a destination. On a multi-tenant
  server that reaches the encrypted per-user token store under the data directory and the
  process environment, which is where the secret that encrypts that store lives; the write
  side reaches the server's own `dist/`, which is what the entrypoint executes.

  Paths from a caller are now resolved through `resolveCallerPath` and, whenever the caller
  is not the operator (any per-user context, and any deployment with OAuth enabled), must
  land inside the data directory. Resolution follows symlinks, so a link planted inside the
  data directory cannot step out of it, and prefix matching is on a path boundary, so
  `/data-evil` does not pass for `/data`. A caller-supplied `save_path` also refuses to
  replace a file that already exists unless the new `overwrite: true` is passed; the default
  download location is exempt, because that one is Zoteus's own cache for the attachment key
  and re-downloading over it is the ordinary case. Nothing changes for a stdio install:
  `zotero_attachment` can still write to `~/Desktop`, which is the point of the tool.

  The container also no longer runs as root. It ran as uid 0, which is what turned the write
  into code execution rather than a nuisance; it now runs as the image's unprivileged `node`
  user. **Upgrading an existing deployment needs one manual step:** a volume mounted at
  `/data` holds root-owned files written by the old image, so `chown -R 1000:1000` it once
  before starting the new container.

  Found while auditing every tool's MCP annotations for the Claude Connectors Directory
  submission, not from a report, and there is no evidence it was exploited.

### Fixed
- **`/metrics` and `/usage.json` were reachable from the public internet with one trailing
  slash.** The 404 block added in 1.13.0 matched exact paths, and Express routes non-strictly:
  it serves `/metrics/` from the same handler as `/metrics`. So `curl https://host/metrics`
  answered 404 while `curl https://host/metrics/` returned request counts, tool-call volume and
  issued-token counts to anyone who asked. `/usage.json/` reached the application the same way
  and only escaped notice because 1.13.0 has no such route, which means shipping the usage log
  would have turned that one into a 200 as well. The matcher is now
  `path /metrics* /usage.json*`, matching by prefix; Caddy's path matcher is case-insensitive,
  so `/METRICS/` is covered too. Verified against a live instance across every path shape:
  bare, trailing slash, double slash, dot segment, query string, uppercase and a trailing
  path segment. `/healthz` and `/readyz` stay public, as before.
- **`npm i github:oscardvs/zoteus` installed a package whose `bin` did not exist.** `dist/` is
  gitignored and only `prepublishOnly` built it, and npm does not run `prepublishOnly` for a
  git dependency: it runs `prepare`, which the package did not have. So a git-URL install, the
  one this project has pointed people to for trying an unreleased fix, produced a `zoteus`
  binary pointing at a file that was never built. `prepare` is now defined. Both `npm ci`
  layers in the Dockerfile take `--ignore-scripts`, because each runs before `tsconfig.json`
  and `src/` are copied into the image and would otherwise try to compile a source tree that
  is not there yet.
- **The privacy policy denied that the project runs a hosted service.** `PRIVACY.md` claimed
  Zoteus has "no servers operated by the project" and that "the Zoteus project does not operate
  any hosted instance for the public". Both were true when they were written and neither has
  been since `mcp.zoteus.com` went live as a paid tier. The policy now says what it actually
  governs, which is the software you install, and points at
  [zoteus.com/privacy](https://zoteus.com/privacy) as the controlling policy for the hosted
  service. The desktop bundle lists both, hosted-aware one first.
- **`server.json`'s description fits the MCP registry's 100-character cap.** A README rewrite
  had pushed it to 150, which the registry rejects with a 422 at publish time rather than at
  validation, so it only surfaced mid-release.
- **`deploy/Caddyfile` no longer publishes `/metrics` to the internet.** The shipped proxy
  config was a blanket `reverse_proxy`, so every ops endpoint was public: on a live
  instance `curl https://host/metrics` returned request and tool-call volume to anyone who
  asked. `/metrics` and `/usage.json` now answer 404 from outside, in `handle` blocks so
  the ordering does not depend on Caddy's directive ranking; `/healthz` and `/readyz` stay
  open. `docker-compose.yml` also caps container logs at 3 x 10 MB, which Docker's default
  `json-file` driver does not do at all.
- **The local pipeline pools each model the way it was trained, instead of mean-pooling
  every model it is handed.** `ZOTEUS_EMBEDDING_MODEL` can name any transformers.js
  feature-extraction model, and the one pipeline call pooled all of them with `mean`: right
  for `Xenova/all-MiniLM-L6-v2` and the E5 family, wrong for roughly half the multilingual
  field, which is trained on the `[CLS]` token. The wrong pooling never fails, it retrieves
  worse: measured on a 257-passage, 68-query cross-lingual set with pooling as the sole
  variable at fp32, `mean` costs `granite-embedding-97m-multilingual-r2` 27.5% of its MRR
  and 34.6% of its hit@1, `gte-multilingual-base` 12.7% and 10.3%, `arctic-embed-m-v2`
  10.3% and 14.7%.

  The value cannot be detected the way an E5 prefix is: it lives in `1_Pooling/config.json`
  on a model's source repository, and the ONNX mirrors the pipeline loads (`Xenova/*`,
  `onnx-community/*`) do not republish it. So it is curated: a table in `embeddings.ts`
  maps each known model id, mirror and source alike, to its pooling, and every row names the
  repository the value was read from. A model the table does not list keeps `mean`, which is
  exactly what it got before, so no existing install changes and no model is refused; the
  default model's vectors were byte-compared before and after. `ZOTEUS_EMBEDDING_POOLING`
  (`auto`, `mean`, `cls`) is the escape hatch for a mirrored or renamed checkpoint the table
  cannot speak for, in the same position `ZOTEUS_EMBEDDING_PREFIXES` occupies for the
  prefixes.

  A pooling that is not the default **joins the embedder identity**, exactly as a precision
  above `fp32` does and for a sharper reason: two poolings of one model are as different a
  vector space as two models are, and unlike two models they share a dimension, so the width
  check that catches a foreign vector cannot see this one. `local:<model>#cls` is what the
  ten `cls` model families in the table now stamp, over seventeen ids counting each mirror.

  Every model the table pools the default way keeps the identity it always had, the default
  model included, so an index built with one of those is untouched. The exception is an index
  built with one of the `cls` models under 1.13.0, the only window in which that was possible:
  it holds mean-pooled vectors under an identity without the suffix, so it is dropped with the
  notice the server already emits and one `zotero_index action:"build"` re-embeds it.
  `ZOTEUS_EMBEDDING_POOLING=mean` reproduces the old identity for anyone who would rather
  defer that. Setting the override is therefore not free either: it makes a different vector
  space and costs the vectors that were there.

## [1.13.0] - 2026-09-03

### Added
- **The local embedding model is now yours to choose, and multilingual libraries have a
  model that works (#43).** `ZOTEUS_EMBEDDINGS=local` always loaded
  `Xenova/all-MiniLM-L6-v2`, a constructor default no setting could reach, and that model
  was trained on English sentence pairs. On a mixed-language library it ranks by *language*
  before topic: measured here over a 12-passage German/English corpus and four German
  questions, MiniLM put the German passage that answers the question first every time, and
  its English twin 9.5th of 12, below every unrelated German passage. A German question
  therefore never surfaced the English paper on its subject.

  `ZOTEUS_EMBEDDING_MODEL` now names the model of whichever provider is active, `local`
  included, instead of only the API ones. That knob already meant "the model of the active
  provider", it already lives in the desktop settings pane and the manifest, and the index
  already refuses to rank vectors from one model against queries from another, so a
  separate `ZOTEUS_LOCAL_EMBEDDING_MODEL` (as the issue proposed) would have been a second
  spelling of a setting that exists, with its own field, its own docs and its own way of
  disagreeing with the first. Unset still means `Xenova/all-MiniLM-L6-v2`, so nothing moves
  under an existing install. Setting it to `Xenova/multilingual-e5-small` moved that English
  twin from 9.5th to 2.5th, at the same 384 dimensions and so at exactly the same index
  size. A variable named `ZOTEUS_LOCAL_EMBEDDING_MODEL` is not silently ignored either: the
  server logs that it is not a setting and names the one that is.

- **E5 models get the prefixes they were trained with, without anyone having to know
  that.** The E5 family embeds asymmetrically: a question is `query: ` plus the question, a
  document is `passage: ` plus the document. Leave the markers off and nothing fails, the
  retrieval is just quietly worse, which is the kind of loss nobody ever traces back to a
  missing string. Zoteus now applies them for you when the model id carries `e5` as a
  segment (`Xenova/multilingual-e5-small`, `intfloat/e5-base-v2`, not `sentence-t5-base`),
  which meant teaching the embedder API which side of a search a text is: `embed()` takes a
  `query`/`passage` kind, the index build passes `passage`, a semantic query passes `query`,
  and the passage re-ranker inside `zotero_get_fulltext` now embeds its question and its
  candidates separately rather than in one batch. The prefix reaches the model and nothing
  else: it is not stored with the passage and not part of the embedder identity, so
  `local:Xenova/multilingual-e5-small` still identifies the vector space by model alone.
  `ZOTEUS_EMBEDDING_PREFIXES` overrides the detection in both directions (`off`, `e5`,
  default `auto`) for a mirrored checkpoint whose name does not say what it is.

- **The rate math a build is running at, where the person watching it can read it (#48).**
  Whether an API embedding provider will throttle a build is a sum of the batch size, the
  pause between requests and the tokens a passage carries, and until now nothing Zoteus
  printed mentioned a rate at all: the reporter worked it out from OpenAI's dashboard
  against a reading of `dist/config.js`. `zotero_index action:"status"` now carries
  `embedRate` for an API provider (batch size, pause, estimated tokens per request at four
  characters per token, and the tokens per minute the build is actually sustaining), the
  server log prints the same line when the full-text pass begins, and the status summary
  speaks up when the measured rate reaches 800,000 tokens/min or a single request approaches
  the 300,000 OpenAI rejects whole. Status also reports `passagesWithoutVectors`, so a
  half-embedded index is no longer indistinguishable from one with no vectors at all, and
  both `zotero_index` and `zotero_semantic_search` name the remedy: `action:"build"`, which
  resumes, and never `action:"refresh"`, which pays for every vector a second time.
- **`ZOTEUS_EMBED_BATCH_SIZE` and `ZOTEUS_EMBED_BATCH_DELAY_MS` are documented where a
  failing build sends you (#48).** Both were in `docs/configuration.md` and
  `docs/semantic-search.md` already, and the reporter still found them only by reading
  `dist/config.js`, which says the tables were not the problem. They are now in the README's
  own configuration table, in a README note about embedding a large library through an API,
  in the descriptions of the desktop-extension settings that set them (each naming the
  other, since neither dial works alone), and in the `zotero_index` tool description the
  model reads before it explains a failure. `docs/semantic-search.md` gains a **When a build
  gets rate-limited** section with the retry policy, the resume behaviour, and the
  `ZOTEUS_EMBED_BATCH_SIZE=256` / `ZOTEUS_EMBED_BATCH_DELAY_MS=8000` pairing that carried the
  reporter's library through in one uninterrupted 45-minute run at about 400,000 tokens/min.

### Changed
- **The documented download size for local model weights was low by a factor of three.**
  "~25 MB" described a quantized build; `@huggingface/transformers` 4.2.0 fetches the
  full-precision ONNX weights, which measure 90 MB for the default MiniLM and 470 MB for
  `Xenova/multilingual-e5-small` (the issue's 118 MB figure is the quantized variant).
  `docs/semantic-search.md` now gives the measured numbers, and says why Zoteus does not
  pick a quantized variant for you: a dtype does not appear in the embedder identity, so an
  index silently rebuilt at another precision could not be told apart from one that was not.

- **The keyword index keeps diacritics.** It used to strip them from every token on both
  sides (`remove_diacritics 2`), which in a multilingual library merges distinct words
  rather than normalizing spelling: Vietnamese `án`, `bé`, `thể` and `thế` all landed on
  English `an`, `be` and `the` and could not be searched for at all. Each word is now
  indexed exactly as written (`remove_diacritics 0`), an accented query is answered
  exactly, and an unaccented query still reaches accented documents by expanding to the
  accented spellings the library's vocabulary holds (`theorie` runs as
  `theorie OR théorie`) — but only where those spellings dominate the typed one in this
  library, so a common word is never dragged toward its rare accented siblings. Nothing
  extra is indexed, so ranking is untouched for queries that need no expansion.
  Expansion is optional (`ZOTEUS_ACCENT_EXPANSION`, default `true`): it compensates the
  recall that keeping diacritics removed for unaccented queries, and disabling it opts
  into strict as-typed exactness, at query time only — no rebuild either way. Search
  semantics change accordingly: `thé` no longer answers as `the`, and `soren` still does
  not answer to `søren` (`ø` is a letter, not an accent).
  **Existing SQLite indexes are migrated in place** on first open (schema 1 → 2: the
  keyword table is re-tokenized; no vectors are re-computed and nothing re-reads Zotero).
  A migrated index cannot be opened by an older build — downgrading sidelines it and
  starts an empty one, so the library would need a rebuild there.

- **The common-word list is measured from the library instead of shipped with the code.**
  The 29 hard-coded English function words are gone. At the end of a full build the SQLite
  backend scans the keyword index's own term vocabulary (`fts5vocab`) and stores, in
  `meta`, the terms appearing in 30% or more of the passages; a delta update rederives the
  list only when the passage count has drifted by more than 10%. The list is applied to
  queries only — both backends keep indexing every term — and the in-memory backend
  answers from its resident document frequencies, storing nothing. An index built by an
  earlier version prunes nothing until its next build or update, at which point it adopts
  a list of its own: nothing is stranded, no rebuild is forced, and the schema version
  does not change. One behavior changes with the list's provenance: a query in which no
  term survives the prune now runs as typed instead of returning nothing, because a
  measured list can hold the library's own subject words, and silence would be a worse
  answer than a slow one.

### Fixed
- **The vector salvage no longer reuses vectors another library wrote (#44).** The salvage
  a schema sideline arms (#34) matches a rebuilt passage against the moved-aside index on
  passage id plus byte-identical text, and a passage id is an item key and a chunk number.
  Item keys are unique within a library rather than across libraries, so that match is an
  identity only once both sides are known to be the same library's rows, and nothing in the
  salvage path established that. It is armed inside `sideline()` at file open, before any
  build has said which library it is crawling, and the fresh index that replaces the
  moved-aside file is deliberately unstamped, which is exactly the state `assertLibrary`
  exempts: two gates on one file, and only one of them knew about libraries. Reaching a
  wrong vector took a conjunction (a schema-triggered sideline of one library's file, a
  build for a *different* library against the fresh file that replaced it, the same
  embedder, an item-key collision across the two libraries, and byte-identical passage
  text), which is remote enough that nobody has hit it, and it was untested rather than
  known-safe. The sidelined file's own library stamp now travels with it as a vector
  source, and the first passage a build offers the salvage is judged against it: a mismatch
  disarms the salvage for the rest of that build, says so once on the `INFO` channel naming
  both libraries, and those passages are embedded instead, which is the cost the rebuild
  would have paid anyway. Nothing else about the sideline changes: the moved-aside file is
  still kept, still complete, still named in the notice. A sidelined file carrying **no**
  stamp keeps salvaging, deliberately, on the same reasoning `assertLibrary` uses for a
  pre-stamp index: it says nothing about whose rows it holds, and refusing on that unknown
  would charge every index written before the stamp existed a full re-embed to guard
  against a collision nobody can demonstrate.

- **One OpenAI `429` no longer ends an index build (#48).** The embedding request path had
  no retry at all: a single rate-limit answer flipped the embedder off, and the build
  carried on writing passages BM25-only to the end. A `429`, a `5xx`, a timeout or a dropped
  connection now waits and tries again, exponentially from 1 s with jitter, honouring
  `Retry-After` in either form the header takes, capped at 60 s per wait and about three
  minutes of waiting per request; `ZOTEUS_EMBED_MAX_RETRIES` sets how many attempts that is,
  and `0` restores the old behaviour. A `400` is still fatal on the first answer, deliberately:
  that is OpenAI's reply to a request carrying more tokens than it accepts, and the batch
  would be exactly as oversized on every retry, so retrying it would turn an instant,
  actionable failure into a slow one. The default pause between requests stays `0`. Backoff
  is what a library that never approaches a limit needs, and no one standing pause is right
  for both a Tier 1 account and a Tier 5 one; the pause is for a build that has been told it
  is riding the ceiling, and now it gets told.
- **A build whose embedder gave up keeps its place instead of starting over (#48).** The
  reporter lost the full-text pass of a 10,428-item library six times running, and every
  retry re-embedded all 87,000 passages, which is the expensive half of the job. Two faults
  produced that. A provider failure never made the build *unfinished*: it reported
  `state:"done"` and deleted the very checkpoint that would have let the next build carry
  on. And even with a checkpoint, nothing could find the passages that were committed
  without a vector, because they are indexed, so the crawl steps over their items by key and
  the full-text pass steps over them by `hasFulltext`, both correctly. Now a build the
  embedder died in keeps its checkpoint and withholds the library version stamp (so an
  `action:"update"` falls back to the build that resumes, rather than running a `?since=`
  delta that finds nothing to do and freezes the index half-embedded for good), and a
  resumed build finishes by asking the store for committed passages carrying no vector, 500
  at a time, and buying exactly those. No page is re-fetched, no PDF is re-read, no passage
  is re-chunked. `action:"refresh"` still starts over, as it always has. The persist cadence
  is unchanged and was measured rather than assumed: at about 8 passages per item, the
  60-second trigger commits roughly 1,900 passages of work, and a SQLite commit of a 372 MB
  full-text index costs 56 ms against the 4.2 s the JSON backend spends re-serializing one,
  so halving the item trigger would double the dominant cost on one backend and bound the
  loss no more tightly than the clock already does.

- **A query made mostly of common words returned a confident wrong answer instead of an
  honest one.** `tokenize()` dropped 29 English function words from every query, and
  `to be or not to be` is all of them except `not` — so the search that ran was a
  single-term OR on a word that means nothing, and what came back was whatever prose
  happened to contain it. Not an empty result, which would at least have been honest.
  Pruning now stops when it would change the question rather than shorten it, and the
  list moved off the document side: `tokenize()` is also the in-memory backend's document
  tokenizer, so the list was deleting those terms from the index, and a term that is not
  indexed cannot be searched for even deliberately. Both backends now index every term and
  only queries prune; ordinary queries are unaffected. The list a query is pruned by is
  measured from the library in this same release, so what survives that rule is now a
  property of the corpus rather than of English (see above).
- **A migration that failed for a transient reason discarded an intact index.** Any
  error inside the schema-upgrade ladder — a full disk as much as a corrupt page — used
  to be treated as a foreign schema: the database was moved aside and a fresh empty one
  silently took its place. A non-corruption failure now leaves the file untouched at its
  old version and search refuses with the reason; the upgrade is retried on the next
  open. Only corruption still sidelines the file. That refusal also declines the rebuild
  that would undo it: `zotero_index action:"build"` repairs an unreadable index by
  deleting it, so a refusal whose remedy is a restart names no file to delete, and the
  call a user makes after reading it cannot discard the intact database. Deriving the
  query-expansion map is guarded on the same rule, being derived state like the binary
  vector codes: a vocabulary scan that fails for a transient reason leaves the map as it
  was and costs unaccented queries their expansion, where it used to stop the server from
  starting at all.
- **`npm run typecheck` was green on 15.7k lines of tests it never compiled (#49).** The
  build project is the only project this repo had, and it is shaped for emit: `rootDir:
  "src"`, `include: ["src/**/*"]`, `exclude: [..., "tests"]`. So the gate that CONTRIBUTING
  asks every contributor to keep green, and that runs in CI and on the deploy path, saw
  none of the test suite: 100 files and 15,754 lines at v1.12.0. Vitest did not cover the
  gap either, because under its SSR transform a missing export arrives as `undefined`
  instead of throwing at import time: a test that imports a symbol a rename deleted passes
  the compiler and the runner both, and only fails if the symbol is actually called. A
  renamed type, or a symbol read but never invoked, could have stayed broken
  indefinitely. There is now a second project, `tsconfig.test.json`, extending the first
  with `rootDir: "."`, emit off and `tests/` included, behind `npm run typecheck:tests`;
  it is a blocking step in `ci.yml` and `deploy.yml` from this release, and CONTRIBUTING
  names it in the gate. The two scripts stay separate on purpose. Widening the build
  project to reach the tests would have meant giving up its `rootDir`, and `npm run build`
  would then scatter `.js`, `.d.ts` and `.js.map` files next to the test sources.
- **The 89 real type errors that gate was hiding are fixed (#49).** Nineteen test files,
  none of them wrong at run time: the suite passed identically before and after. Five were
  genuine drift, fixtures explicitly annotated `: Capabilities` or `: ToolContext` that
  were never updated when `localGroupIds`, `reopenSearchIndex`, `fetcher` and
  `searchIndexPath` joined those types. The rest were untyped JSON bodies off `res.json()`,
  which is `unknown`, and `vi.fn` mocks declared with no parameters and then read back by
  argument index, where `mock.calls[0][2]` is a compile error against an inferred
  zero-length tuple. `noUncheckedIndexedAccess` is off in the test project and only there.
  Under it the suite reports 204 errors instead of 89, and 115 of those are index accesses
  like `text.split(' ')[0]` inside an assertion, where an undefined index throwing *is* the
  check being made; answering all 115 with `!` would have added noise and no safety.
  `src/` keeps the flag on.
- **`toJSON`/`loadFromJSON` stay off the `SearchIndex` interface (#49).** Six tests read
  them through a factory annotated `: SearchIndex`, which does not declare them, and the
  tempting fix was to widen the interface. That would have forced the SQLite backend, which
  writes rows and has no snapshot to hand back, to stub two methods it cannot mean. The
  narrow contract already exists and is already named: `JsonIndex` in
  `features/search/persistence.ts`. So the test factories now return `MemorySearchIndex`,
  the concrete JSON backend they were constructing all along, and no runtime type moved.

- **Full-text index builds work inside Claude Desktop again, and the crash that stopped
  them is diagnosed (#37).** Through 1.12.0 an `action:"build"` that reached the attachment
  full-text pass took the whole server process down inside the desktop app, with no thrown
  error, no stack, no out-of-memory report and nothing on stderr. That was reproduced
  outside Claude Desktop and taken apart: a prebuilt Electron 42.10.0, the desktop app's own
  `mcp-runtime/nodeHost.js`, the same `utilityProcess` fork
  (`--utility-sub-type=node.mojom.NodeService`) and the same JSON-RPC bridge over a
  `MessagePort`. The child dies of **SIGTRAP**, which is Chromium's deliberate crash rather
  than a fault, and the crash report the desktop app itself filed for the original failure
  says the same thing on the same utility sub-type. Chromium replaces the process allocator,
  and an allocation it will not serve is not handed back as null for the caller to deal
  with: it takes the process down immediately, before any handler runs. That is the whole
  reason the death was silent, and why no `uncaughtException` hook would ever have caught
  it.

  What asked for that allocation was the on-device embedding model, and three runs separate
  it from everything else. The same full-text build under Electron with **no embedder** ran
  to completion, all 262 items and 18287 body passages written to SQLite at a peak RSS of
  283 MB, which clears the crawl, the concurrent attachment reads, the SQLite write path and
  the persist cadence in one run. With the local embedder it died in 14 seconds. And with
  no Zotero and no SQLite anywhere near it, loading `@huggingface/transformers` in a bare
  `utilityProcess` and calling the feature-extraction pipeline on batches of growing length
  reproduces the crash on its own: it embeds 32 passages of 512 characters and 32 of 1200
  characters happily, then dies inside `extractor()` on a batch whose sequences reach the
  model's 512-token limit. The identical loop under standalone Node finishes, at 2 GB RSS,
  having never been refused an allocation.

  So the size of one pipeline call is the whole story, and that size is batch times sequence
  squared. `all-MiniLM-L6-v2` computes a batch by 12-head by sequence by sequence attention
  tensor: 32 passages at 512 tokens is about 400 MB in a single block, which onnxruntime's
  arena asks for in one piece. Metadata passages are chunked at 512 characters, roughly 128
  tokens, so the same batch of 32 needs about 25 MB and never comes close. That is why the
  metadata pass embedding thousands of passages first proved nothing about the native layer,
  and why the full-text pass, chunked at 1200 characters and dense enough to reach the token
  cap, was the one that always died.

  The fix is a bound rather than a gate: under Electron the local embedder takes 8 passages
  per call instead of 32, putting the largest tensor it can ask for at roughly 100 MB, a
  quarter of the size measured to crash. Only the local provider is capped and only under
  Electron, because an API provider's batch is an HTTP request body and allocates nothing
  large in this process. A `ZOTEUS_EMBED_BATCH_SIZE` below the cap is honoured; one above it
  is lowered, with a line in the log saying so, since there is no throughput past a process
  that has died. With that in place the build this issue was filed about runs to completion
  inside a `utilityProcess`, on the same library, with the model in the same process.

### Removed
- **The Electron full-text refusal and `ZOTEUS_ALLOW_ELECTRON_FULLTEXT` (#37).** 1.12.0
  refused the pass outright and offered that variable as an escape hatch. It was the honest
  thing to ship while the cause was unknown, and it is the wrong thing to keep now that the
  crash has a mechanism and a bound: refusing the headline feature in the primary
  distribution channel would cost more than it saves. The setting is gone from the extension
  manifest and the variable is no longer read; an install that still sets it just starts
  normally. Building headlessly against the same `ZOTEUS_DATA_DIR` remains the faster route
  on a large library, since a build inside the app is somewhat slower than the same build in
  a terminal, and it produces exactly the same index either way.

## [1.12.0] - 2026-08-31

### Fixed
- **The desktop instructions for on-device embeddings named an install Claude Desktop
  cannot see (#38).** The "Local embeddings path" field told users to run `npm i -g
  @huggingface/transformers` and paste what `npm root -g` prints. Claude Desktop does not
  run the server with the Node on the user's `PATH`; it uses its own built-in one
  (`isUsingBuiltInNodeForMcp is true`, in the app's `main.log`). So under nvm, which is how
  most people have Node, the global root belongs to a runtime that never executes this
  server and holds onnxruntime binaries compiled for that other runtime: the documented
  path steered users straight into the failure branch the code already anticipates, and a
  later nvm switch silently broke a path that had been working. The manifest, the README,
  `.env.example` and both docs now recommend a directory of its own instead
  (`mkdir -p ~/.zoteus-deps && cd ~/.zoteus-deps && npm init -y && npm i
  @huggingface/transformers`, then point the setting at `~/.zoteus-deps/node_modules`),
  which belongs to no version manager and survives extension updates and Node upgrades
  alike.
- **The size warning was low by about 300 MB (#38).** "onnxruntime's native binaries run to
  ~380 MB across platforms" priced the binaries alone; the resolved dependency tree measures
  686 MB on Linux x64 against `@huggingface/transformers` 4.2.0. Anyone planning disk space
  got a number off by nearly half. Every copy now says about 700 MB, and says it is the
  whole installed tree rather than the native part of it.
- **A local-embeddings failure now names the path it was given.**
  `ZOTEUS_TRANSFORMERS_PATH` lives in a settings pane and appeared in no message the reader
  could see, which made "not installed" unfalsifiable: an absent package and one sitting in
  another directory produced the same sentence. The unavailable reason (`zotero_index
  action:"status"`, `zotero_whoami`, and every `zotero_semantic_search` notice) now quotes
  the configured directory and the `lib/node_modules` reading of it, and the branch for a
  package that resolves but throws on import reports the file it loaded plus the Node
  version, platform and architecture it loaded it under. That last pair is the whole
  diagnosis for a package installed under the wrong Node: it resolves perfectly, then fails
  on a binary built for a runtime that is not this one.
- **"Set 0 for no cap" looked like a rejected value in Claude Desktop (#38).** The number
  input will not render or retain a displayed `0`, so "Full-text characters per item"
  blanks itself the moment you leave it and users reasonably concluded the setting had not
  taken. It had: the value persists and the server reads it as "no cap". The field
  description and `docs/configuration.md` now say so, and offer a very large number to
  anyone who would rather read back the value they set. Blank deliberately keeps meaning
  *the default*, 40000, whether or not full-text indexing is on: reading it as "no cap"
  would have uncapped every install that turned full text on and never touched the dial,
  turning a bounded build into a crawl of whole books.
- **A full-text build no longer drives Zotero's local API into the ground, and says so if
  it ever does (#39).** The full-text pass fetched attachment bodies four at a time
  whichever API was serving it, and the two do not tolerate load the same way. The cloud
  Web API is a fleet that answers a burst with a `429` and a `Backoff` header the fetcher
  already honours; the desktop local API is a *single process*, sharing itself with
  Zotero's UI, its sync engine and its own PDF indexer, with no rate limiter at all. Four
  continuous body reads were enough to stop Zotero 10 answering on port 23119 within 60 to
  90 seconds on a 358-attachment library, and because local-API reachability is a
  session-wide capability, that dropped *every* read and write onto the Web API: slower,
  rate-limited, needing a cloud key, and liable to leave the startup capability probe
  rate-limited too. So the default is now chosen by the API serving the crawl, 2 for the
  desktop app and 4 for the cloud, with `ZOTEUS_INDEX_FULLTEXT_CONCURRENCY` to override
  both. That number is still a guess about somebody else's machine, so it is not the whole
  fix: a build that watches the local API go down while it is reading from it backs off to
  one fetch at a time for the rest of the job, without restarting, so the app can recover
  instead of being held down for however many hours the crawl has left.
- **A build that degraded to the Web API stops being invisible.** The fallback works, which
  is exactly the problem: nothing errors, nothing fails, and all the user sees is a build
  that has quietly become several times slower, explained only by one `INFO` line on stderr
  that desktop hosts discard. `zotero_index action:"status"` now reports
  `localApiDegradedAt`, the moment this job saturated the desktop app, and the summary says
  in words that the session fell back to the Web API, that the crawl has throttled itself,
  and which dial to reach for if it keeps happening. It is scoped to the running job: a
  crawl the cloud was serving never reports it, an app closed between builds is nobody's
  degradation, and each build reports on itself rather than inheriting the last one's.
### Changed
- **A full-text index build is refused inside Claude Desktop instead of killing the server
  (#37).** Claude Desktop runs a bundled `.mcpb` extension inside its own process, an
  Electron `UtilityProcess` on Electron's embedded Node, and there an `action:"build"` that
  reaches the attachment full-text pass takes the whole server process down partway
  through: no thrown error, no stack, no out-of-memory report, nothing on stderr, just
  `Server transport closed unexpectedly` in the host's log. The identical build over the
  identical library, index file and environment runs to completion under standalone Node in
  about twelve minutes, and the metadata pass, which embeds thousands of passages through
  the same on-device model first, is never the one that dies. **The cause is not known.** It
  sits below the JavaScript layer, on a runtime Zoteus does not ship and cannot reproduce
  against, so this is a mitigation and not a fix: rather than guess at the native layer,
  Zoteus now refuses the one pass known to take the process down. Under Electron a build or
  refresh that asks for full text (by `fulltext:true`, or by `ZOTEUS_INDEX_FULLTEXT` /
  the "Index PDF full text" setting) returns an error naming the ways forward and **changes
  nothing**: the refusal happens before the build clears anything, so an index built
  headlessly survives being asked for again from in there. The workaround is documented and
  now named in the refusal itself: build once outside the desktop app against the same
  `ZOTEUS_DATA_DIR`, then let Desktop read the finished file. `action:"update"` is never
  gated, and it keeps that index current from inside Desktop, body text included, because an
  update re-reads only the delta and the attachments Zotero has extracted since the stored
  cursor. A metadata-only build (`fulltext:false`) is unaffected. `ZOTEUS_ALLOW_ELECTRON_FULLTEXT=true`
  lifts the refusal for anyone who wants to try it anyway; what a build indexed before the
  process died is kept, stays searchable, and `action:"build"` resumes from it. The gate is
  deliberately not narrowed to `ZOTEUS_EMBEDDINGS=local`: the reported suspicion
  (`onnxruntime-node` under Electron's Node ABI) is explicitly unconfirmed, and the
  full-text pass differs from the metadata pass in several other ways that also reach native
  code, so refusing on the one signal that actually correlates says only what is known.

## [1.11.0] - 2026-08-31

### Added
- **The index covers the words you wrote: child notes and PDF annotations (#33).** Every
  index crawl asked for `top: true`, so the corpus was the library's top-level items and
  nothing hanging off them. Since `zotero_annotate` shipped in 1.10.0 that was no longer
  only a coverage gap but a disagreement inside the server: Zoteus wrote an annotation onto
  an attachment and could then never find it again, on any query, ever. Notes and
  annotations (the highlighted passage together with its comment) are now indexed as
  passages carrying the **parent item's** key, labelled `source:"note"` / `source:"annotation"`
  on a hit, with notes stripped of their HTML. Because they carry the item's key, an item
  with forty annotations still takes one result slot: your own words extend what an item
  can be found by rather than crowding the page. On by default (`ZOTEUS_INDEX_OWN_WORDS`,
  `own_words:false` per build) where full text is opt-in, because the whole corpus is one
  paged crawl of hand-written text plus one batched lookup per fifty annotated attachments
  — an annotation names the attachment it sits on, never the item, and that hop is what
  attributes it. `action:"update"` keeps it current for the cost of one keys-only request:
  notes and annotations carry ordinary versions, so comparing the library's note keys
  against the ones the index holds finds edits, additions and — the case no `?since=` can
  report, because deleting a note moves no version anywhere — deletions. The crawl that
  reads note bodies is opened only when there is something to re-index. An index built
  before this existed fills its gap on its first update, once, and says so.
- **The search index has a migration path, so the next schema bump does not re-embed every
  library from zero (#34).** `SCHEMA_VERSION` has been 1 since the SQLite backend landed,
  and the open path accepted exactly two states: no tables, or this build's own stamp.
  Everything else was moved aside and rebuilt — *including a database stamped with an older
  version of our own schema*. That has never fired for anyone, which is exactly why it was
  worth fixing now: the first bump is the one that charges every index in the field a full
  rebuild, and the expensive half of a rebuild is re-embedding (a measured 5.5 hours of
  local CPU for 255k passages, or a hosted provider's bill). Two things change. A ladder of
  upgrade steps now carries an older index forward in place: each step runs inside the one
  transaction that stamps the new version, so a database is either fully upgraded or fully
  untouched, and a step that throws rolls back and falls through to the sideline. And where
  a sideline is still the right answer — a newer build's database, an unstamped file, a gap
  in the ladder — the moved-aside index becomes a read-only vector source for the rebuild
  that replaces it: any passage that comes back with the same id and byte-identical text
  takes its stored vector instead of being embedded again, so only genuinely new or edited
  text costs embedding time. Reuse is refused when the embedder identity (provider *and*
  model) differs, and `storageNotice` now prices the rebuild it prescribes — how many
  passages, how many vectors, and whether they must be paid for — instead of only saying
  where the old file went.

### Fixed
- **A build for one library no longer erases another library's index.** The index file is
  keyed by the data dir, never by the library — which is right, and had a sharp edge: the
  build path clears the store before crawling, so `zotero_index` pointed at a group library
  silently replaced the personal library's index (or any other), reported `done`, and said
  nothing. Resume gave that a second shape: a build that finds a checkpoint carries on from
  it instead of clearing, and the resume conditions never look at the library — so the same
  mistake against an interrupted index appended one library's items to another's rows and
  still reported `done`. The index now stamps the library it holds (the personal library is one identity
  however it is addressed, `users/0` locally or by user id on the cloud, so the local/cloud
  seam never trips it), and a build or update for a different library refuses up front,
  naming both and the way forward. Indexes written before the stamp existed refuse nothing —
  their first stamped build adopts them.

## [1.10.0] - 2026-08-29

### Added
- **`zotero_get_fulltext` reads the attachment file itself, from wherever it actually is
  (#29).** The fallback that parses an unindexed PDF used to have exactly one way to get
  the bytes: download them from Zotero cloud storage. That is the one route that does not
  work for the case the fallback exists for. A PDF added minutes ago has not synced, a
  local-only library has no cloud copy at all, and an account that never bought storage
  quota never will, so "summarise this paper I just added" failed on precisely the papers
  the user had just added. The bytes are now taken from three sources in order: the running
  Zotero desktop app (which reads them off its own disk), the local Zotero storage folder
  at `<Zotero data dir>/storage/<key>/` (which needs no cloud key **and no running Zotero**,
  only a Zoteus on the same machine), and a cloud download last. The answer says which one
  produced the file, as `fileSource`, alongside the existing `fulltextSource`, so a caller
  can always tell text Zotero indexed from text Zoteus extracted a moment ago, and from
  where. Where nothing can produce the file, the error names each source it tried and why
  each one could not answer, instead of reporting only the last failure. `ZOTERO_DATA_DIR`
  points at a moved Zotero data directory; a directory that is not there is skipped, so a
  hosted Zoteus loses nothing by looking. `zotero_annotate` shares the same loader, so
  passage anchoring picks up the storage-folder source too.

- **EPUB attachments extract locally, with no new dependency.** An EPUB is a zip of XHTML
  documents plus a package file that puts them in reading order, so Zoteus unpacks it with
  Node's own `node:zlib`, follows the spine (the reading order the book declares, which is
  not the archive's alphabetical order), and strips the markup. An item whose only
  attachment is an EPUB is no longer a dead end: the attachment picker prefers a PDF, then
  an EPUB, then anything else, and the text comes back marked `fulltextSource: "epub"`. An
  EPUB reflows and has no fixed pages, so `page_range` says so rather than inventing a span.

- **`zotero_get_fulltext outline:true` returns a PDF's table of contents** with a page
  number and nesting level per heading, read from the document's own bookmark tree and
  never from Zotero's index. It is the cheapest possible map of a long document: reading
  the outline and then asking for the pages it names is two small calls, where the
  alternative is one call that returns a book. A PDF with no bookmarks answers with an
  empty list and a notice rather than an error, and a heading whose destination cannot be
  resolved is still listed, without a page.

### Changed
- **`page_range` now reads the real pages.** Asking for pages 3 to 7 used to slice the
  indexed character stream proportionally unless `precise_pages:true` was also passed,
  which answers a different question: roughly this share of the characters, not these
  pages. A page range now re-extracts the PDF by default and returns the span itself,
  degrading to the old proportional slice (with a notice) where the file or the parser is
  out of reach. `precise_pages:false` opts back out and does no file read at all. `query`
  and document modes are unchanged: they still cost nothing beyond the index.
- **On-device model weights now cache under the data directory** (`<ZOTEUS_DATA_DIR>/models`)
  instead of inside the transformers package's own install, so deleting the data directory
  removes everything the index ever wrote — including its largest artifact, and including
  weights that previously landed in a global `node_modules` outliving even an extension
  uninstall. Existing installs re-download the model (~25 MB) once, into the new location;
  the old copy stays where the package left it.
- **`action:"build"` and `action:"refresh"` are no longer aliases**, in one respect: `build`
  resumes an interrupted build where a checkpoint is on disk, and `refresh` always starts
  the crawl over. Both still rebuild from scratch on an index whose last build finished,
  which is every index that was not interrupted.
- **The on-disk index format grows by two fields, and stays readable both ways.** A
  `checkpoint` record and a `fulltextVersion` cursor are added to the JSON artifact and to
  the SQLite `meta` table, with no schema-version bump: an index written by 1.9.0 loads
  unchanged (no checkpoint means nothing to resume, and no cursor means the first update
  that wants full text closes its coverage gap once), and an index written by this version
  still opens in 1.9.0, which ignores the two keys it does not know.
- **A semantic query no longer reads every vector in the index** (#30). On a 255,703-passage
  index at 3072 dimensions, every `zotero_semantic_search` took 90 to 105 seconds whatever
  was asked, because ranking meant decoding 3.1 GB of float32 vectors one row at a time. The
  SQLite backend now keeps a **binary code** beside each vector, one sign bit per dimension
  after the corpus mean is subtracted, and ranks in two stages: a Hamming scan over the
  codes (384 bytes a passage instead of 12,288, XOR and a SWAR popcount over `Uint32Array`s)
  picks a candidate pool, and only those candidates' real vectors are read and ranked by the
  exact cosine as before. Measured on a synthetic index of exactly that shape, a query goes
  from 2,107 ms to 50 ms on the same machine, **42x**, and the codes cost 94 MB beside 3.1 GB
  of vectors.

  What the codes decide is which rows get scored, never how they rank: every score returned
  comes from a float32 vector, so the page is ordered by exact cosine and nothing needs
  rebuilding. What an approximation can cost is recall, and the candidate pool is the dial
  for it: against the exact ranking on real embeddings, a pool of 4x the result set recovers
  0.884 of it, 8x recovers 0.953 and the default 16x recovers 0.986, and the codes get
  better as vectors get wider, because a wider vector is a longer code. Centring on the
  corpus mean is what buys the last few points, the same move Zotero's own semantic search
  makes (`modelCalibration.meanVector`).

  Existing indexes are neither rebuilt nor re-embedded: the codes are derived from vectors
  already on disk, the schema stamp does not move, and an index that has none is searched
  exactly as before until the first semantic query builds them in one pass, which is the
  pass that query was going to make anyway. Builds and updates keep them current from then on.
  `zotero_index action:"status"` reports which path served the last query (`vectorScan`:
  `codes` or `exact`) and why, when there is a why (`vectorScanNotice`). Three new knobs:
  `ZOTEUS_INDEX_ANN` (`true`; `false` forces the old exact scan and writes no codes),
  `ZOTEUS_INDEX_ANN_OVERSAMPLE` (`16`) and `ZOTEUS_INDEX_ANN_MIN_CANDIDATES` (`500`), which
  is also the size below which an index is small enough that the exact scan is simply kept.
  `bench/two-stage-search.ts` measures both paths over a synthetic index of any shape.

### Fixed
- **An interrupted index build now resumes instead of starting from 0** (#24). The only
  progress a build recorded was the library version stamp, and that stamp is deliberately
  withheld from a build that did not finish, because it covers an unknown slice of the
  library. The desktop local API frequently issues no version at all, so on that path there
  was nothing to resume from in any case: stopping a build and starting another one cleared
  the store and re-crawled, re-chunked and re-embedded items already committed to disk. A
  build now writes a **checkpoint** (the crawl offset, the pass it was in, the library
  totals it saw, the API that served it, the embedder identity, and the handful of passages
  queued but not yet embedded) into the same write as the rows it describes, and
  `action:"build"` carries on from it on either API. Committed passages stay searchable
  throughout and are never re-fetched or re-embedded; what is redone is bounded by the last
  save; the resume point is a stored offset rather than a scan; and the offset is verified
  against the library's own totals on the first page read, falling back to a walk from the
  top that steps over what the index already holds rather than to a rebuild. A resume is
  refused under a different embedding model, and stamps the version the *interrupted* crawl
  began from, so nothing modified in between is missed. `status` reports `resumedFrom`, and
  the tool says outright that a resume is what started.
- **`action:"update"` now sees full text Zotero extracted after the build** (#26). An update
  keyed its whole view of "what changed" on the item version, but Zotero versions extracted
  text on a sequence of its own: opening a PDF for the first time makes Zotero extract it
  and touches no item version, so that item appeared in no `?since=` delta, ever, and an
  index's full-text coverage stayed frozen at build time with a rebuild as the only remedy.
  A build now records the highest full-text version it consumed (`fulltextVersion` in
  `status`), and an update asks `/fulltext?since=<that cursor>` and attaches the new text
  through the same attachment-to-parent map the build uses, replacing only that item's body
  passages. On a library where nothing was extracted the probe is a single request and the
  attachment map is never built. The cursor advances only when the update fully succeeded,
  like the version stamp.

### Security
- **The Gemini API key no longer travels in the URL.** Gemini embedding requests carried
  the key as a `?key=` query parameter; it now goes in the `x-goog-api-key` header, like
  the OpenAI key's `Authorization` header. A URL is the part of a request that gets
  logged — by proxies, by error causes, by anything that prints which endpoint failed —
  and a header is not. Google accepts the header everywhere `?key=` works, so nothing
  changes about which requests succeed.

## [1.9.0] - 2026-08-28

### Added
- **Highlights can be made from the passage alone, with no page coordinates.** Zotero anchors
  a highlight by page rects, and nothing that reads extracted text can know them: the text
  carries content and page numbers, not positions. So a client that had read a PDF and
  wanted to mark a claim in it had one honest move left, a sticky note pinned to the corner
  of the page, because inventing rects draws a box over the wrong lines. `zotero_annotate`
  now takes a highlight or underline given as `text` with no `position` and finds that
  passage in the PDF itself, computing the rects Zotero stores. The comparison ignores
  everything two renderings of the same passage disagree about: line and column breaks,
  words hyphenated across a line, spacing, case, ligatures, smart quotes, and accents a PDF
  sets beside a letter rather than over it, so a passage quoted back from
  `zotero_get_fulltext` matches the page it came from. The result is one rect per visual
  line, superscripts widening their line rather than fragmenting it, which is the shape the
  reader itself produces: verified against 465 highlights drawn by hand in the Zotero
  reader, the reconstructed rects sit a median 1pt from the reader's own, and the vertical
  extent is exact wherever the font carries metrics (`[baseline + descent × size, baseline
  + ascent × size]`, both read from the font). Passages quoted from Zoteus's own extracted
  text anchored at 290/290 across 25 papers.

  Nothing is written on a doubtful match. A passage that is not in the document, and a
  passage that occurs more than once, are reported as themselves: the ambiguous case lists
  every occurrence with its page and surrounding words, and a new per-annotation
  `occurrence` (1-based, reading order) or the existing `page` picks between them. The
  located offset and page height now feed `annotationSortIndex`, so an auto-anchored
  highlight sorts into the sidebar in reading order like any other. An explicit `position`
  still takes precedence and skips the lookup entirely, so nothing about the existing
  calling convention changes.

  Reading the PDF is what the feature costs. A Zoteus running beside Zotero reads the file
  from the desktop app's own storage through the local API's `/file` endpoint (new
  `LocalApiClient.downloadFileBytes`, which follows the `file://` redirect the app answers
  with), so unsynced attachments and libraries with no storage quota work with no cloud key
  at all; a hosted Zoteus downloads from Zotero storage as it already does for full text.
  Where neither can reach the bytes, where the file exceeds the 20 MB parsing cap that
  keeps a small host from being OOM-killed, or where the optional `pdfjs-dist` parser is
  absent, the reply says which and suggests an explicit `position` or a page-anchored note.

### Fixed
- **A search index written by a newer Zoteus is moved aside, never written into** (#25,
  thanks @MinhHaDuong). `createSchema()` stamped `schemaVersion` with `INSERT OR REPLACE`
  before anything read what the file already said, and nothing anywhere read it back: the
  stamp was written and consulted by no one. So the ordinary result of a downgrade, a
  database created by a later build, was silently re-stamped with this build's version and
  then used under a schema it might not have, destroying the one piece of evidence the
  stamp exists to carry at exactly the moment it mattered. The stamp is now read through a
  read-only handle before any DDL or connection pragma touches the file (`journal_mode =
  WAL` is itself a write to the header, so even that waits). A database at a version this
  build does not understand, one whose stamp will not parse, or one that carries tables but
  no stamp at all, is renamed to `search-index.sqlite.incompatible-<timestamp>` with its
  write-ahead sidecars, nothing deleted, and a fresh index is created in its place;
  `action:"status"` reports what moved and where in `storageNotice`. The moved file stays a
  complete database that the build which stamped it can still open. A zero-byte file is
  treated as a first open rather than an incompatibility, since that is exactly what a
  handle opened and dropped before any DDL leaves behind, and a lock or an I/O error
  propagates instead of being read as a missing stamp, so a healthy index is never moved
  merely because another process held it. If the file can be read but not moved, the
  server survives, search refuses while naming the file, and an explicit
  `zotero_index action:"build"` clears it.

## [1.8.0] - 2026-08-27

### Added
- **A build indexes every item's metadata before it crawls any attachment full text**
  (#23, thanks @MinhHaDuong). A build used to walk the library once, indexing each item's
  own text and then fetching its attachment bodies before moving on to the next. So on a
  large library with `fulltext:true` nothing was searchable until the body crawl had
  finished, and that crawl can run for hours or days. The build now runs in two passes:
  titles, abstracts, creators and tags for the whole library first, then bodies. The gap
  between them is the point — the library is fully searchable on its metadata for the
  entire length of the body crawl. `action:"status"` reports which pass is running as
  `phase`, and the second pass's progress as `fulltextItemsScanned` of
  `fulltextItemsTotal`. The version stamp an `action:"update"` diffs against is still
  written only when *both* passes have finished: stamping after the first would make a
  build interrupted mid-crawl look complete, and the items whose attachments were never
  read are unchanged in Zotero, so they would appear in no delta, ever. Items with no
  extractable attachment are skipped outright rather than asked about one at a time, and
  the metadata pass keeps the fast save cadence that full text used to slow down.

### Fixed
- **`zotero_index action:"build"` now repairs an index that cannot be read** (#21, thanks
  @MinhHaDuong). 1.7.2 gave a damaged index the right floor: refuse, keep the rest of the
  server working, and name the files to delete. That is not the right ceiling. The people
  most likely to meet a damaged index are `.mcpb` desktop installs, and
  `rm ~/.../search-index.sqlite{,-wal,-shm}` is not a recovery path for someone who has no
  shell open and no reason to want one. An explicit build is consent — the caller has asked
  for the expensive thing and knows it — so that call, and only that call, now deletes the
  unreadable file and its write-ahead sidecars and opens a fresh index in their place before
  rebuilding. Nothing repairs the index at startup or inside a query: a server that silently
  takes ten minutes to start is worse than one that explains why it will not search.
  `action:"update"` refuses and points at `build`, since a delta needs the index it cannot
  read. The refusal text leads with the tool call and keeps `rm` as the fallback for the
  case the files cannot be deleted. Deletion rather than truncation remains deliberate: the
  version stamp lives inside the same database, and a repair that dropped the passages and
  kept the stamp would leave an empty index reporting itself as up to date.
- **Four more ways a broken index could read as an empty library** (#21). The catch in the
  SQLite backend's keyword search was written for one condition — SQLite rejecting the
  match string it had just built — and implemented as swallow-everything, so `disk I/O
  error`, `no such table: passages`, a locked database and an interrupted statement all
  came back as no matches rather than as a fault. It is now narrowed to genuine query
  rejections, which are the only errors a search should absorb; everything else says what
  went wrong. Damage discovered mid-query is also recorded rather than merely thrown, so
  the refusal sticks and the next call does not go straight back to the same broken file.
- **A `search-index.json` that cannot be parsed no longer loads as an empty index, or gets
  overwritten** (#21). A truncated artifact was swallowed into a silent empty index that
  reported itself healthy — and because loading resets the index before it parses, the next
  clean shutdown wrote that emptiness straight back over the file, destroying the index the
  failure was about. The JSON backend now refuses to read or write a store it could not
  load, leaves the file exactly as it found it, and is repaired by the same
  `action:"build"`. A file that is simply not there is still a first run, not a fault.
- **Starting Zotero after your MCP host no longer leaves it invisible until you restart**
  (#22, thanks @StianOby). Whether Zotero's local API was reachable was probed once at
  startup and frozen for the life of the process, so `zotero_whoami` reported
  `localApi: false` forever whenever the desktop app had not been up at that exact moment
  — a result that depended on launch order and nothing else, curable only by quitting and
  relaunching the host. The answer is now kept live: it is re-checked lazily as tools are
  called, cached with a short TTL, backed off toward one check a minute on a machine where
  nothing ever answers, and shared between concurrent calls, so it costs nothing where no
  desktop app can apply and no round trip per call where one does. A Zotero that quits mid-
  session is noticed too. `zotero_whoami` always probes afresh, reports when it last
  checked, and names the Zotero setting to turn on when the answer is no.
- **Desktop writes recover with it** (#22). The local-API and connector write clients were
  built only when the *startup* probe had succeeded, so on a server that started before
  Zotero they stayed undefined for the process lifetime: the re-probe could flip the
  capability to true and every write still fell through to the cloud, because the client it
  needed had never been constructed. Both are now created whenever the local API is
  configured at all. They authorize lazily and every call site still checks the live
  capability first, so nothing can reach a Zotero that is not running.
- **The startup probe is bounded** (#22). Each of its three attempts inherited the shared
  fetcher's 25-second budget, so a firewall that drops packets on 127.0.0.1:23119 rather
  than refusing them could spend over a minute deciding the answer was no. It now gets two
  seconds per attempt.

### Changed
- An index build holds the local-API answer still for its duration. The routing decision is
  re-read for every page, so a desktop app appearing or vanishing mid-build would splice
  pages from two APIs into one index and stamp it with a single library version — and the
  desktop app and the cloud number their versions independently.

## [1.7.3] - 2026-08-27

### Fixed
- **A setting left empty in the desktop pane no longer stops the server from starting**
  (#18, thanks @StianOby). A `.mcpb` host substitutes every environment entry its manifest
  declares, including the ones whose settings field the user never filled in. Where that
  field also carries no `default` in the manifest, Claude Desktop 1.37937 substitutes
  nothing at all and passes the reference through verbatim, so the server is handed the
  literal text `${user_config.embed_batch_size}`. Blank has meant "use the default" since
  1.7.0, the release that added these four numeric fields; an unresolved reference did not,
  so `z.coerce.number()` read `NaN` and `loadConfig` threw a `ZodError` about a second into
  startup, before the logger exists. That is a `FATAL` line and a dead process, which the
  host reports as a failed version negotiation: the negotiation was fine, there was simply
  nothing left alive to negotiate with. Every one of those four fields is empty on a fresh
  install, so 1.7.0, 1.7.1 and 1.7.2 could not start as a desktop extension on this host
  version unless all four were filled in by hand. Read out of `/proc/<pid>/environ` of the
  running extension rather than inferred; an unresolved reference, a blank string,
  `undefined` and `null` now all mean the setting's own default applies.
- **An unset marker can no longer become the data directory** (#18). `ZOTEUS_DATA_DIR` was
  the one setting whose fallback re-read the raw environment instead of the parsed value,
  so a marker the schema had just rejected was handed straight back by `defaultDataDir`.
  With an unexpanded reference in that variable the server created a directory named
  `${user_config.data_dir}` in whatever the working directory happened to be, silently, and
  put the search index, the OAuth store and saved attachments in it. The check that decides
  what counts as unset now lives in one place that both the schema and `defaultDataDir`
  read.
- **The stdio shutdown no longer ends the process it is running in** (#18). 1.7.2 finished
  every ending with `process.exit(0)`, which assumes the server owns its process. The host
  in #18 reports `Using built-in Node.js for MCP server` and a probe that `requires the
  SDK's base StdioClientTransport`, neither of which is obviously a plain subprocess, and
  exiting somebody else's process is a worse fault than the one being fixed. Now only the
  signal handlers exit, because installing them is what removes node's default
  termination, and they are installed only when nothing else is already handling those
  signals. On stdin EOF and on a transport closed from inside the process, Zoteus flushes
  the index, releases the transport and lets the loop drain, which exits 0 on its own in a
  process it does own. The stdio binding's own escalation (close stdin, wait, SIGTERM,
  SIGKILL) remains the backstop.

### Changed
- **A tuning knob can no longer stop the server from starting** (#18). Configuration used
  to be all-or-nothing: any value a schema rejected, whether a host marker nobody
  anticipated or a typo, threw out of `loadConfig` before there was a logger to explain it.
  A rejected knob is now reported by name on stderr and replaced by what its absence would
  have given, so `ZOTEUS_INDEX_MAX_ITEMS=lots` starts the server on 5000 items and says
  why, rather than taking down `zotero_get_item`, bibliographies and citations, none of
  which reads that setting. It is #20's reasoning (a damaged index stopped being fatal)
  applied to configuration, and it is what keeps the next unanticipated substitution a
  warning instead of another silent startup crash.

  Not every setting is a knob, and the ones that are not still refuse. `ZOTERO_LIBRARY_ID`
  and `ZOTERO_LIBRARY_TYPE` choose which library is read and written, so `Group` no longer
  quietly becomes `user`. With OAuth enabled, `ZOTEUS_OAUTH_MODE` and `ZOTEUS_OAUTH_STORE`
  choose a security model: falling back would have served every client from the operator's
  own Zotero key, or skipped the encryption key that file-backed tokens require. An
  unexpanded `${...}` in `ZOTEUS_CIMD_ALLOWED_HOSTS` refuses too, because an empty host list
  there means no restriction at all, and `docker --env-file` does no interpolation. None of
  these appears in the desktop manifest, so none of them can be reached by a settings pane
  a host fills in. A refusal now also carries the warnings collected before it, because
  throwing discarded them: a rejected `ZOTEUS_PUBLIC_URL` used to report only that the
  variable was required, which is misleading when it is plainly set.

### Documentation
- **Where a desktop install's logs actually are** (#18). Recent Claude Desktop versions run
  a bundled extension in an Electron `UtilityProcess`, so `mcp-server-Zoteus — Zotero MCP.log`
  carries only what the host says about the server, and every `[zoteus]` line, including the
  crash above, goes to `main.log` prefixed `[UtilityProcess stderr]`. Three rounds of #18
  were spent reading a file that could not have held the answer. Troubleshooting now says
  which file, and adds the `ZodError` symptom.

## [1.7.2] - 2026-08-27

### Fixed
- **Accented queries reach the passages they name** (#19, thanks @MinhHaDuong). The FTS5
  document side is folded by SQLite (`unicode61 remove_diacritics 2`), but the query side
  matched `[a-z0-9]+` over lowercased text, so `théorie` reached the index as `"th" OR
  "orie"`: two tokens it does not hold. Because terms are OR-ed, that is not an empty
  answer but a confident wrong one, retrieving whatever OCR'd full text happens to contain
  those fragments. One normalizer now sits in front of the tokenizer both sides share, so
  the symmetry is structural. It reproduces `remove_diacritics 2` and nothing more:
  folding harder would break Norwegian, Polish and Vietnamese the same way. Tokens are
  `\p{L}\p{N}` now, so `Θεωρία`, `теория` and `日本語` stay whole. No reindex needed.
- **A damaged search index no longer stops the server from starting** (#20, thanks
  @MinhHaDuong). One bad page in a derived cache file threw SQLite's own sentence out of
  `open()`, which nothing caught, so `initialize` went unanswered and item lookups,
  bibliographies and citations went down with it: none of which reads the search index.
  A corrupt store is now detected by result code as well as message, the handle is
  released, and search alone refuses, naming the file, its sidecars and the way back.
  Every other tool keeps working. Repairing it automatically is deliberately not in this
  release (#21).
- **The end of a stdio session is no longer silent** (#18). A stdio server dies with its
  input stream, and the MCP SDK's transport does not watch for that: it subscribes to
  `data` and `error` on stdin and nothing else, so EOF closed no transport, fired no
  `onclose`, and the process ran out of work and exited 0 having written nothing. Hosts
  report that as `Server transport closed unexpectedly ... process exiting early`, which
  is indistinguishable from a crash. Zoteus now names what ended the session on stderr
  before it goes, and uses the moment for a flush stdio never had: only the HTTP path
  installed shutdown handlers, so a stdio session left SQLite's write-ahead log for
  whichever process opened the file next.

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
