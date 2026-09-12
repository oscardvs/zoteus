# Changelog

All notable changes to Zoteus are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- An older read's desktop catch-up check no longer clears the pending marker for a newer
  cloud write in the same library. Baseline probes also belong to the exact write that
  started them, so two writes to the same key cannot inherit one another's baseline.

## [1.19.0] - 2026-09-12

### Added
- **ChatGPT is a supported client, documented and verified against the hosted connector.**
  Tested on 2026-09-12 from a ChatGPT Plus account in the web app: `zotero_whoami`, keyword
  and semantic search, full item records, PDF outlines with page numbers and exact page
  ranges read from Zotero cloud storage, APA bibliographies, and adding and removing tags all
  worked, with ChatGPT asking before the writes it rates as risky and never before a read.
  ChatGPT connects to remote MCP servers only, so the `npx` and `.mcpb` installs do not apply
  there; the two paths are the hosted connector at `mcp.zoteus.com` and a self-hosted OAuth
  remote, which serves ChatGPT unchanged (it registers a confidential client through Dynamic
  Client Registration and uses a per-connector `chatgpt.com` redirect URI, so there is
  nothing to allowlist). The README, `getting-started.md`, `remote-oauth.md`,
  `configuration.md` and `deployment.md` now carry the ChatGPT steps: Developer mode on a
  paid plan, Plugins, Create app, OAuth, and the Refresh click that makes the tool list
  appear the first time.
- **`zotero_pdf_images`: PDF pages and figures as images the model can look at.** Every PDF
  feature returned extracted text, and text is exactly what a figure, a table, an equation
  and a scanned page lose: a figure arrived as its caption, a table as its numbers run
  together, an equation as a few stray glyphs, and a scan with no text layer as "extraction
  yielded nothing". A prospective customer asked whether the assistant could examine
  figures, tables, equations and scanned pages, and until now the honest answer was no.
  `mode:"pages"` renders whole pages and returns them as MCP `image` content blocks between
  the summary line and the JSON mirror (the strict-args registry and the transports pass
  image blocks through untouched; `ToolHandlerResult.content` is widened to say so). The
  default resolution fits the long edge to 1568 px, which is as much as the model is shown
  anyway; measured on a letter page (1212x1568, 143 dpi, a 196 KB JPEG rendered in about
  250 ms) it keeps 9-point body text and inline maths legible, and `dpi` up to 300 and
  `format` jpeg or png override it. `mode:"figures"` walks each page's operator list for
  image XObjects, inline images and stencil masks, tracking the transform the way pdfjs's
  own canvas does, decodes each to opaque RGBA (a translucent figure is flattened onto
  white rather than black), skips icons and rules under 32 px, folds an image repeated
  across pages into one, and reports each with its pixel size, its box on the page in
  points from the top left, and whether it covers the page (a scan). Measured against the
  test library: page 3 of "Attention Is All You Need" gives back its architecture figure as
  the 1520x2239 image it is embedded as, with a 2000 px preview inline and the full file on
  disk, and page 4 its two 445x884 and 835x1282 figures with their positions. On a local
  install figures are saved under `<data dir>/pdf-images/<attachment key>/`; a shared
  server refuses `save`, since the files would sit on the operator's disk. Vector figures
  are named for what they are, lines in the content stream that only rendering shows, and
  so is text scanned letter by letter: a 2006 conference paper in the test library paints
  4389 stencil masks on its first page, one per glyph, with no text layer at all, and
  figures mode now reports that instead of returning the alphabet, while pages mode renders
  the page legibly.

  The caps are part of the feature, because the hosted tier runs on a 1 GB machine and the
  images travel as base64 inside JSON: 4 pages a call (8 at most, with the notice naming
  the next span), 16 figures (40 at most), a 3508 px long edge, an image pixel limit pdfjs
  enforces while decoding (16 megapixels on a shared server, 40 locally), one job at a time
  per process, files above 20 MB not parsed, and about 5 MB of inline image data per
  response, beyond which pages and figures are still rendered (and saved when asked) but
  not returned inline, with a notice saying which and how to ask for them. A
  password-protected PDF is refused with a message that says so; one whose encryption only
  carries an owner password opens normally; a truncated file is called a broken PDF; an
  EPUB is told it has no pages; a missing canvas package is named with its one-line fix.

  No new dependency ships. pdfjs-dist draws under Node through its own optional dependency
  `@napi-rs/canvas`, which a plain `npm install` brings in with it and which the desktop
  bundles already carry for every OS and CPU they name. What did need building was a
  canvas pool. Measured here, `@napi-rs/canvas` 0.1.100 does not return a dropped canvas's
  memory to the operating system (`width = 0`, a forced GC and idle event-loop turns all
  leave RSS where it was), pdfjs allocates two or three scratch canvases per stencil mask,
  and rendering that 4389-mask page once took the process from 180 MB to 690 MB and twice
  to 1 GB. Canvases are now pooled by exact size through pdfjs's public `CanvasFactory`
  option and reset with a same-size width write (the binding's `context.reset()` leaves a
  clip set outside a `save` in place); four such pages render in 344 MB of process peak
  over stdio instead of 797 MB, a four-page batch of an ordinary paper in 294 MB, and the
  pool is bounded at 16 megapixels and 8192 canvases. The attachment resolver that
  `zotero_get_fulltext` used moved to `features/attachments/resolve.ts` so both tools mean
  the same file by "the PDF", and the page-span parser to `pdf-pages.ts` so both read the
  same syntax.

## [1.18.1] - 2026-09-10

### Added
- **`zotero_whoami` reports the running Zoteus `version`.** Nothing in a conversation could
  say which Zoteus was answering it. The update notice only appears when a NEWER release
  exists, so silence meant either "you are current" or "nothing ever checked", and a client
  pinned several releases back looked exactly like a healthy one. Found the hard way on the
  machine this was written on: Claude Code was pinned to 1.17.0 and the Claude Desktop
  extension was still 1.13.0, five releases behind, with nothing anywhere to say so. A
  manually installed `.mcpb` never auto-updates, so this is the only place that answer can
  come from.

### Fixed
- **Every PDF feature was degraded inside Claude Desktop, and the message blamed the wrong
  thing.** Found by driving the shipped bundle through Claude Desktop itself; no issue was
  filed, because nobody outside could have diagnosed it from the message it produced. pdfjs
  decides once, while its module body runs, whether it is running under
  Node, and the last clause of that test is `!(process.versions.electron && process.type &&
  process.type !== "browser")`. Claude Desktop runs MCP servers inside Electron, where
  `process.type` is `"utility"`, so pdfjs concluded it was in a browser, evaluated the browser
  half of its own module body, and threw `DOMMatrix is not defined` before reading a byte of
  any file. The import is wrapped in a bare `catch` that returns null to degrade gracefully,
  so nothing surfaced: `zotero_get_fulltext outline:true` answered "could not be read (corrupt
  PDF, or the optional pdfjs-dist parser is missing)", `page_range` and `precise_pages` fell
  back to `pageSource: "approximate"`, and `zotero_annotate` lost the text anchoring that
  places a highlight from a quoted passage. Every one of those blamed a missing optional
  dependency that was installed and working. Measured on Electron 44.2.0, which ships Node
  24.20.0, so neither the Node version nor a native ABI mismatch was ever involved: the same
  1.8 MB PDF, the same installed pdfjs 5.6.205, read 14 pages and 9 outline entries under
  plain Node and failed to import at all with `process.type` set. `process.type` is now
  masked for the duration of the import and restored in a `finally`, which is the whole
  window that matters because `isNodeJS` is captured then and never read again; a
  non-configurable descriptor is left alone rather than forced, since deleting one throws and
  a thrown loader is worse than the degradation it prevents. pdfjs is imported in exactly one
  place now, so the four call sites cannot drift apart again. Verified end to end against the
  1.18.0 bundle installed in Claude Desktop: under a process made to look like Electron's it
  reproduces the reported failure, and the fixed build returns the 19 outline headings and
  `pageSource: "exact"` in the same environment.

  The messages no longer offer a cause they have not checked. Where the parser really cannot
  load, the error it threw is quoted instead of asserting the dependency is absent; and
  `zotero_get_fulltext` knows at the branch point whether it failed to read the bytes or
  failed to parse them, so it now says which, rather than handing back "PDF bytes or the
  optional pdfjs-dist parser missing" and leaving the reader to guess between two unrelated
  problems.

- **`zotero_saved_searches action:"list"` reached the cloud too.** The last read still
  calling `ctx.web` directly, and the same defect as `zotero_manage_tags action:"list"` one
  release earlier, with `zotero_list_tags` and `zotero_sync` before that. A desktop-only
  install asked api.zotero.org for `users/0`, got "Invalid user ID" back, and the tool then
  dressed that up as advice to "check field names and itemType against the schema" on a call
  that carries no fields at all. Zotero 7+ serves the definitions locally (measured: `GET
  /api/users/0/searches` answers 200), so they were next door the whole time. The list action
  is routed now, like every other read, and an explicit `library_id` still picks the group it
  names. Installs holding a cloud key were never affected, so this broke exactly the keyless
  desktop user, which is the setup the documentation calls local-only read mode.

- **`zotero_tag_audit` no longer reports the whole library as one collection's coverage.**
  `scope.collection_keys` was passed straight to the item listing with nothing checking that
  the library had those keys. The desktop app answers `/collections/<unknown>/items` with the
  WHOLE library rather than a 404, so a mistyped or stale key came back as that collection's
  coverage, counting every item in the library. Measured against a 285-item library with a
  required tier: the real collection `RANF9BFV` reports `itemCount: 6`, and `ZZZZZZZZ`, which
  does not exist, reported `itemCount: 285` under that same key, with nothing in the answer to
  say which question had been answered. In an audit that is the worst shape a wrong answer can
  take, because the same typo against a vocabulary with no required tier reports an empty
  `missingByTier`, which reads as perfect compliance. `zotero_search_items` and `zotero_export`
  already refuse an unknown collection key for this exact reason and say so in the refusal;
  the audit now uses the same guard, and refuses before any listing work rather than after
  paying for a full-library scan.

- **`include` on `zotero_get_item` no longer drops the item record it promises.** The
  description offers `include` as a way to "additionally" request rendered output, but Zotero
  REPLACES the representation when `include` is set: `include=bib` answers with the rendered
  bibliography alone and no `data` object at all. Every bibliographic field the tool documents
  went missing, silently, and the summary line rendered `Item SUU9EI96: (no title)` for an
  item whose title the same call had just formatted into its bibliography. Measured against a
  real library before the fix: the string `"title"` appeared nowhere in the response. `data` is
  now requested alongside whatever was asked for, so the record and the rendered output both
  come back, and a caller that already named `data` is not charged for it twice. `bib`,
  `citation` and `csljson` all behaved this way and all three are fixed.

## [1.18.0] - 2026-09-10

### Fixed
- **A `tools/call` that omits `arguments` no longer fails.** `arguments` is optional in the
  MCP spec, and the SDK types it that way, so a client calling a tool that needs nothing may
  leave it out. Every one of the 30 tools answered such a call with a JSON-RPC -32602 about
  the shape of the envelope, `zotero_whoami` included, which is the tool the documentation
  tells callers to reach for first. An absent argument object is now read as an empty one. A
  tool that does require an argument still refuses, but the refusal names the field it wanted
  and the values it accepts, rather than complaining that the envelope was undefined.


- **A desktop write whose grant has gone now falls back to the cloud instead of failing.**
  Zotero gates local-API writes behind a grant the user accepts in a dialog, and a "Allow"
  grant is single-use: Zotero deletes it on first successful use. `LocalWriteClient` answers
  the first 401 by re-authorizing and retrying, but a 401 that survived that reached the
  caller as a plain write failure, and the predicate deciding whether to try the cloud
  instead only recognised the Zotero 9 shape (404, 501, unreachable). So a run whose
  re-authorization dialog nobody answered stopped with "Invalid or expired API key" while
  holding a cloud key that could have served the write. It now falls back. An explicit
  denial deliberately still does not: Zotero answers "Deny" with 403 and its own error, and
  someone who has just refused a write is not asking for it to be routed somewhere else.


- **Every tool now refuses an argument it does not know, instead of dropping it and answering
  a different question.** Each tool hands the MCP SDK a `ZodRawShape` and the SDK builds a
  plain `z.object` from it, which strips what it does not recognise, so an argument one letter
  out never reached a handler and the call ran as though it had never been sent. Measured
  against a 285-item, 211-tag library before the fix: `zotero_search_items {q:"kalman"}`
  answered "found 55 full-text match(es)", while `{query:"kalman"}` and `{search:"kalman"}`
  both answered "Found 1266 item(s); showing 3", which is the whole library reported as a
  success; `zotero_list_tags {filter:"core"}` returned 50 tags where `{q:"core"}` returns 1;
  `zotero_list_collections {top_level:true}` returned all 46 collections where `{top:true}`
  returns 3; `search_tools {q:"bibliography"}` returned the full 30-tool catalog where
  `{query:"bibliography"}` returns 5; `zotero_schema {itemType:"journalArticle"}` returned the
  whole 40-type schema instead of that one type's fields; `zotero_get_fulltext {item_key,
  passages:1}` returned 12000 characters instead of one passage; `zotero_export {format,
  limit, query:"kalman"}` exported the unfiltered library; and `zotero_tag_audit
  {collection_keys:[...]}` ran a full-library audit with the scope dropped. `query` for `q` is
  the single likeliest mistake a language model makes against this API. The JSON Schema those
  tools advertise already said `additionalProperties: false`, and it is unchanged byte for
  byte for all twenty-eight of them; only the runtime had never enforced it, and no documented
  argument moved. A refusal names the argument that was not understood and, where its only fault was
  how it was spelled, the one it was probably meant to be (`query` is answered with `q`,
  `itemtype` with `itemType`, `passages` with `max_passages`, `include_automatic` with
  `include_auto`); where it was a nested field hoisted to the top level, the path it belongs
  at (`collection_keys` with `scope.collection_keys`, `itemType` on `zotero_create_items` with
  `items[].itemType`). An argument that resembles two of them at once is answered with the
  list of arguments rather than with a guess. Objects that are deliberately open stay open:
  item data (`patch`, `items[]`) keeps its catchall, because Zotero item fields are an open
  set, and `zotero_format_bibliography` still takes any CSL-JSON. `zotero_whoami` and
  `zotero_groups` declare no arguments and were left open here; the entry below closes them
  too. Same consequence as the
  `zotero_tag_audit` fix below: these refusals are raised while the arguments are being
  validated, so they come back as ordinary tool results with `isError` set but never reach the
  usage log or the metrics counters, which has always been true of a malformed argument.


- **A key the protocol reserves for itself is accepted and ignored rather than refused, and
  the last two tools that dropped arguments in silence now refuse them.** Two gaps left by
  the entry above. MCP carries its own bookkeeping in `_meta`, on the request's `params` and
  never inside a tool's `arguments`, and nothing in this server puts anything else in
  `arguments` either. But strict arguments meant that a client which ever did would have had
  every call refused at once, which is the whole hosted user base failing together over a key
  nobody meant as an argument. Any top-level key beginning with `_` is now removed before the
  arguments are checked. Measured over stdio against the desktop app: `zotero_search_items
  {q:"kalman", _meta:{progressToken:7}}` answered "found 55 full-text match(es)" where it had
  answered "unknown argument `_meta`", and the handler was handed `{"q":"kalman"}` with the
  key gone, so no handler can read protocol bookkeeping as though a user had sent it. Nothing
  else moved: `{query:"kalman"}` is still refused with "this tool spells it `q`", and all
  eight refusals measured for the entry above come back word for word, including one sent
  alongside a `_meta` that is now tolerated.

  `zotero_whoami` and `zotero_groups` were the two tools still dropping an argument in
  silence, because an empty raw shape is the one input here that reaches the SDK through Zod
  v4-mini rather than v3, and that dialect emits no `additionalProperties` line at all, so
  those two had never advertised a strictness there was anything to enforce. Handing the SDK
  a built object instead of an empty shape puts them on the same path as the other
  twenty-eight: their published schema gains `"additionalProperties": false` and nothing else
  in `tools/list` changes, verified by diffing full dumps from builds either side of the
  change, which differ in exactly those two lines. `zotero_groups {library_type:"group"}`
  stops working as a result, deliberately. That tool's own description names `library_type`
  and `library_id` as parameters of other tools, and the same sentence invites
  `{library_type:"user"}` and `{library_id:5678}` just as strongly; both of those returned
  every group as though the filter had been applied, which is the failure the entry above
  exists to end. A key cannot be tolerated for one of its values, so the choice was between
  one spelling that reads correctly by luck and every spelling corrected in a turn. Both
  tools now answer an argument they do not take with "unknown argument `library_type`: this
  tool takes no arguments. Nothing ran, because the key would have been dropped and the
  answer would have read as though it had been honoured. Call this tool with no arguments."


- **`zotero_tag_audit` no longer audits something other than what it was asked about.**
  `scope`, the `vocabulary` object and each of its `tags` and `tiers` entries were plain
  `z.object`s with optional members, so a key one letter out was stripped by Zod before the
  handler saw it and the audit ran on as if it had never been sent. `scope:
  {"collections": [...]}`, a near miss for `collection_keys`, produced a whole-library audit
  with no per-collection coverage in it: measured against a 211-tag, 285-item library, the
  right spelling and the wrong one both answered "Audited 211 tag(s) over 285 item(s): 89
  off-taxonomy, 119 auto, 284 required-tier gap(s)", the first carrying coverage for the two
  collections asked about and the second carrying none, with nothing in either to say which
  question had been answered. Three more keys did the same. `Tier` on a vocabulary tag lost
  that tag's tier, so every item holding it counted as missing the tier (284 gaps became
  285). `require` on a tier left the tier unrequired, so the audit reported no gaps at all.
  `tier` for `tiers` on the vocabulary itself dropped the entire tier list, likewise no gaps.
  All four now fail the call, naming the key that was not understood and, where only its
  spelling was wrong, the one it was probably meant to be (`collections` is answered with
  `collection_keys`, `require` with `required`). The JSON Schema the tool advertises already
  said `additionalProperties: false` at every one of those levels and is unchanged; only the
  runtime had never enforced it, and no documented field moved. A vocabulary read from
  `vocabulary_path` is parsed by the same schema and now reports the same sentences with the
  file named, in place of a dump of Zod's issue objects. One consequence worth knowing: a
  refusal over an inline `vocabulary` or `scope` is raised while the arguments are being
  validated, so it comes back as an ordinary tool result with `isError` set but never reaches
  the usage log or the metrics counters. That has always been true of a malformed argument
  (an out-of-range `limit`, say) and is not new here; a vocabulary file rejected for the same
  reason is refused by the handler and is recorded like any other tool error.


- **An item Zoteus had just written no longer reads back as missing.** Writes go to the
  cloud Web API: always for a group library, and for the personal library too from
  `zotero_create_items` and `zotero_update_item`, which both require a cloud key. Reads go
  to the running Zotero desktop app for any library it holds. So between the write and
  Zotero's next sync the two disagreed, and the call that had just answered "Wrote 1
  item(s)" with a key was followed by `zotero_search_items` finding nothing and
  `zotero_get_item` answering "Local API 404". Measured on both libraries, and worst for an
  agent that verifies its own work: told the item does not exist, it writes it again, and
  the library fills with duplicates. Reads of a library now go to the API that took the last
  write to it, until the desktop app can be shown to hold that write. Nothing changes for a
  library nobody has written to: those reads are routed exactly as before, and cost no extra
  request. Comparing the two APIs' library versions would have been the tidier fix and does
  not work, because they number their libraries independently (on the machine this was
  measured on, the same personal library was at version 3476 on the cloud and 681 on the
  desktop); the desktop is compared against its own earlier answer instead. Still stale
  until Zotero syncs: full text stored with `zotero_fulltext action:"set"`, which the
  desktop files beside the attachment rather than in it, so there is nothing to watch for.

- **`zotero_manage_tags action:"list"` reached the cloud too.** The same defect as
  `zotero_list_tags` and `zotero_sync`, one tool further along: the list action read
  `ctx.web` directly, so a desktop-only install asked api.zotero.org for `users/0` and got
  "Invalid user ID" back, while the desktop had been serving the tags all along. It is
  routed now, and an explicit `library_id` still picks the group it names.

- **A desktop write that landed nothing no longer reports success (#77).** Every write path
  collects per-item outcomes instead of throwing, so a payload Zotero refused came back as
  `Trashed 0 item(s) via the Zotero desktop app.` with no error flag and the 400 buried in
  `failed`. `zotero_trash_items` and `zotero_annotate action:"delete"` both did this on their
  local branch, which is the default on a desktop setup, and both are what an agent reaches
  for to undo its own work: it would read the summary, believe the item was gone, and move
  on. The cloud branch of `zotero_trash_items` already appended `; N failed.`; the local one
  said nothing. A write that attempted items and landed none of them is now an error quoting
  the first reason, and a partial write stays a success but names the failure count in the
  summary rather than only in the payload. The check is one shared helper, so `zotero_import`
  and these two cannot drift apart again.


- **A build whose attachment map stopped early no longer stamps a full-text cursor over the
  attachments it never reached (#78).** The map that turns Zotero's full-text keys into item
  keys is a paged crawl of every attachment in the library, and on a large library it can
  stop partway: one listing request past the per-request budget ends it, and it says so on
  `zotero_index action:"status"`. An `action:"update"` already withheld its cursor when that
  happened (#26, #67). A build did not. It narrowed its full-text worklist to the keys the
  map had reached, so nothing ever asked about the rest and no read failed, and it then
  stamped the high-water mark of the *whole* full-text census. The attachments the map never
  listed were left named by no `?since=` on either sequence, ever: their items had not
  changed in Zotero, so no later update went back for them, and the index claimed coverage
  it did not have with only a status sentence to say otherwise. The cursor is now withheld
  whenever the map did not reach the end of the library (a failed request, the crawl's page
  ceiling, or a listing that stops serving pages before its own total), and the status says
  both what stopped and what was withheld because of it. The item version stamp is
  deliberately still recorded: the metadata pass really does finish, and withholding it
  would turn every later update into a full rebuild on exactly the libraries that cannot
  finish one.

- **The update that recovers from such a build now reads the items it skipped, instead of
  sealing them (#78).** With no cursor to work from, an update asks `/fulltext?since=0` and
  gets the whole census back, and it narrows that to the index's coverage *gap*: the items
  holding no body passages at all. Over a map that stopped early that filter is wrong.
  Zotero lists attachments newest-modified first, so one item's attachments are not adjacent
  in the crawl, and an item with one attachment on a mapped page and another on a page the
  map never reached already holds passages, so it was skipped, and the same update then
  stamped the census-wide cursor and cleared the reason, making that attachment's text
  unreachable for good. A build (or an update) that indexes body text over an incomplete map
  now records that its coverage is partial, in the index and on disk, and while that stands
  the first `action:"update"` asked for full text whose own attachment map reaches the end of
  the library runs its catch-up in **full** rather than gap-only mode: every indexed item that
  update's census names is re-read, once. While the mark stands that catch-up asks Zotero's
  full-text sequence **from the start**, whatever cursor the index holds, because the text a
  truncated map missed was extracted before that cursor and no `?since=` delta will ever name
  it. That is also what makes a mark raised by an *update* actionable: a delta that re-indexes
  a changed item's body text over a truncated map writes only part of that item's text, and it
  does so on an index that already carries a cursor. Only a run that was paid in full, over a
  map that was opened and did reach the end of the library, with every read succeeding and
  nothing cancelled, stamps the cursor and clears the mark: a pass that read nothing (an empty
  full-text census, say) recovers nothing and says so, rather than retiring a mark that is the
  index's only record of the missing text. An update whose map stops short again falls back to
  filling the coverage gap alone (the items holding no body text at all), says so on
  `action:"status"`, and leaves the mark and the withheld cursor standing, so the full re-read
  is paid once rather than on every update. It costs one full body crawl, which is the work a
  rebuild would do anyway, without re-crawling the metadata. **If you have run `action:"build"`
  with full text on a library large enough for the map to stop early, your index is holding a
  cursor from before this release, and nothing in the index can tell:** any `action:"build"`
  that starts over clears it, which is what `action:"refresh"` is (it is exactly a build with
  `fresh:true`) and what a plain `action:"build"` does too unless it is resuming an interrupted
  build's checkpoint. From this release on, such a build records no cursor and the next
  ordinary `action:"update"` fills the missing body text in by itself.

- **That recovery is bounded, so one unreadable attachment cannot cost a body crawl on every
  update (#78).** Body-text reads are caught per attachment, so a file that can never be read
  (moved out from under Zotero, a 403, a linked file the server will not serve) leaves the
  whole-census re-read unfinished however often it runs. With the mark standing and the map
  complete, that meant re-reading the entire census on every single update, forever: on the
  reporting library, a full body crawl of 8,953 attachments per update. After three such
  re-reads have been paid and still ended on unreadable text, the body crawl stops being paid
  and each update fills in only the items holding no body text at all. The cheaper attachment
  listing crawl does continue, because the mark keeps the cursor withheld and every later
  update therefore asks the sequence from the start. Nothing is claimed for
  that: the mark stays standing, the cursor stays withheld, and the status says the re-read
  keeps failing, so the index still never reports coverage it does not have. A transient
  failure still recovers, because the count only rises on a re-read that was actually paid
  for; `action:"refresh"` with `fulltext:true` (or any build that starts over) clears both the
  count and the mark.

- **`action:"status"` says when an index holds partial full-text coverage (#78).** The mark
  is persisted and outlives the process that recorded it; the per-pass `fulltextReason` does
  not, so after a restart an index that still owed a full body re-read said nothing about it.
  Status now reports `fulltextPartial: true` for exactly those indexes, with a
  `fulltextReason` saying what the mark means (including which of the two shapes it is: no
  cursor was ever earned, or one earned before the gap still stands) and
  what the next full-text update may cost (one whole body crawl), or that the re-read has
  stopped being attempted. Indexes whose coverage is whole report neither.

- **An update that indexed no body text no longer stamps a full-text cursor (#78).**
  `action:"update"` deliberately leaves a metadata-only index alone rather than turning into
  the hours-long full-text crawl nobody asked for, but it handed the whole census's
  high-water mark back on its way past, and that was stamped. Everything Zotero had already
  extracted was then behind the cursor, named by no `?since=` on either sequence, and the
  first PDF opened afterwards would be indexed alone over a library whose body text never
  was. The cursor now stays where it was. That is not free on a large library: while it
  stays at 0, every later update asks `/fulltext?since=0`, gets the whole census back and
  re-opens the attachment map to resolve it, so it pays that listing crawl (roughly 90
  requests on a 9,000-attachment library) on every update rather than once. It reads no body
  text, and the alternative was a cursor that lied.
  **What this costs you:** an index holding no body text at all now gains none from
  `action:"update"`, ever, including one built with `fulltext:true` over a library Zotero had
  extracted nothing in yet. Before this release such an index picked up whatever was
  extracted after its first update, on the strength of a cursor stamped for coverage it had
  never indexed, and everything extracted before that point stayed missing with nothing to
  say so. Such an update now also says so on `action:"status"`, which it did not: at exactly
  the moment this describes, the reason had been cleared and the status said nothing about
  full text at all. `fulltextReason` now tells the user what to do about it (open the PDFs
  they want searchable in Zotero, which is what makes Zotero extract the text, then run
  `action:"build"` with `fulltext:true`), and one build fills in the whole library rather
  than the tail of it.

- **Time queued behind Zoteus's own other requests is no longer charged to a request's
  budget, or blamed on Zotero (#78).** The per-request time budget is a statement about how
  long Zotero took to answer, and its error says so; the clock started when the call was
  made, before the request had a slot on the four-permit semaphore every Zotero read shares.
  A busy fetcher could therefore spend a request's whole budget waiting for its turn and
  then report a desktop app answering in under a second as one that had hung. The clock now
  starts when the request does. Abort behaviour is otherwise unchanged.

- **`zotero_import` wrote an item type Zotero does not have, and called it success (#77).**
  With no translation-server running, a DOI resolves through OpenAlex and the Zotero item
  type was chosen from whether OpenAlex reported a venue: `journalArticle` if it did,
  `generic` if it did not. `generic` is not one of Zotero's 40 item types, so Zotero refused
  every such save with `400 Unknown itemType 'generic'`. OpenAlex reports no venue for most
  conference papers and many books, so this was the common path, not a corner: ResNet,
  XGBoost, the DSM-5 and the CRC Handbook all fail to import on any release from 1.1.0 to
  1.17.0. OpenAlex's own `type` now picks the Zotero type (`conference-paper` to
  `conferencePaper`, `book` to `book`, `dissertation` to `thesis`, and so on), a venue still
  means `journalArticle`, and anything unmapped falls to `document`, which is a real Zotero
  type. The arXiv path was never affected.

- **A save that wrote nothing no longer reports success.** The write paths collect per-item
  outcomes rather than throwing, so a payload Zotero rejected outright came back as
  `Imported 0 of 1` with no error flag, and a model reading that summary reported success
  while the library stayed empty. That is why the item type above went unnoticed for a
  month. An import that resolves items and creates none of them now returns an error and
  quotes the first reason. Partial success is still success: `failed` already carries the
  rest.


- **`zotero_groups` lists the groups the Zotero desktop app holds, instead of demanding a
  cloud key it does not need (found while investigating #77).** Group libraries have been readable without a cloud key
  since Zotero 10 began serving `/groups/<id>` locally: the router sends a read for a group
  the desktop holds to the desktop, keyless, and only a group it does not hold goes to the
  Web API. The one tool that would tell a user a group's id refused outright without
  `ZOTERO_API_KEY`, so a local-API-only user could not learn the id that every other tool
  needs, and the refusal named a cloud key as the requirement. With no key the tool now
  lists what the desktop serves: `id`, `name`, `description` and the desktop's own item
  count. The cloud's `type` and `libraryEditing` are membership facts the desktop never
  stores, so they are absent from those rows rather than guessed, and the desktop's count
  includes child attachments, notes and trashed items, so it is not the cloud's figure; the
  answer carries a note saying both. Where a key and a local Zotero are both present the
  two lists merge into one row per group, each marked `source: "cloud"`, `"local"` or
  `"both"`, with the cloud's richer fields kept for a group that appears in both. The
  answer for a key with no local Zotero is unchanged, down to its wording. The refusal
  survives only when neither source has anything to list, and it now says which one was
  missing. Listing also refreshes the set of locally held groups, so a group joined (or a
  Zotero started) after the server was launched becomes readable without a restart.
  Writing to a group still goes through the cloud and still needs a key with write access
  to it.


- **A collection key the library does not have is refused, instead of being answered with
  the whole library.** `zotero_search_items` and `zotero_export` pass `collectionKey`
  straight to Zotero, and the desktop app does not refuse an unknown one: measured against a
  running Zotero 10, `/collections/ZZZZZZZZ/items` answers `200 Total-Results: 723`, which is
  the entire library, where a real collection answers 14. A scoped search was therefore
  byte-for-byte identical to an unscoped one (`collectionKey:"ZZZZZZZZ", q:"attention"`
  returned exactly the same two items as `q:"attention"` alone), and an export scoped to a
  mistyped or deleted key returned the whole library's RIS with nothing to say so. It hit
  exactly the key-free desktop user: the cloud Web API 404s that same sub-route, so the cloud
  path was never wrong. The collection itself does 404 on the desktop, which is the one place
  the app admits the key is unknown, so a read that names a collection asks that first and
  refuses by name when it is absent, pointing at `zotero_list_collections` for the right key.
  The extra request is paid only when a collection key was given and only when the desktop
  app serves that library, so unscoped searches, cloud reads and reads of a real collection
  are unchanged. A check that itself fails (the app going away between the two calls) is not
  read as absence: the read goes ahead and reports its own failure.


- **An empty DOI no longer fabricates a successful lookup.** `zotero_scholar {action:
  "lookup", doi: ""}` answered `isError: false` with an untitled work, no authors and
  "0 citations". Traced: `https://api.openalex.org/works/` 404s, the Crossref fallback then
  fetches `https://api.crossref.org/works/`, and that is Crossref's works-LIST endpoint,
  which answers 200 with `"message-type": "work-list"` and 186 million results. The list
  envelope was parsed as though it were one work. Both halves are fixed: a blank or
  whitespace-only `doi` is refused before any provider is asked (a padded one is trimmed
  rather than refused), and the Crossref parser now requires a single-work payload, so a 200
  from the wrong endpoint is never read as a result. `doi: "hello world not a doi"` already
  errored; the empty string was the hole.

- **`references`, `citations` and `related` report an upstream miss in the same words as
  `lookup`.** They reach OpenAlex directly, so a DOI it does not hold came back as
  `OpenAlex 404 for https://api.openalex.org/works/doi:...`, a raw request URL where `lookup`
  says `No scholarly record found for DOI ...`. They now give that same sentence. A status
  other than 404 is reported as the provider failing rather than as an absent record, because
  a throttled or broken OpenAlex is not evidence that a paper does not exist.


- **An export that rendered nothing says so, instead of handing back a blank body as
  success.** `zotero_export {format: "bibtex", item_keys: ["ZZZZZZZZ"]}` returned
  `isError: false` and the text `"\n\n"`, with no summary and no notice, so an agent could
  not tell an empty export from a failed one. Named `item_keys` that render not one entry are
  now an error that quotes the keys and says what else would explain it (only top-level items
  are exported, so a child attachment, note or annotation renders nothing). An export
  narrowed by a collection, a `q` or an `item_type` that renders nothing is a real answer of
  "no entries" and is reported as one, carrying `empty: true` and a `notice` in
  `structuredContent`, the way `zotero_format_bibliography` reports `(empty bibliography)`.
  A non-empty export is unchanged, down to the bytes.


- **A 403 now depends on the request that drew it, instead of describing a situation the
  caller is not in.** Zotero spends one status on several unrelated refusals whose remedies
  contradict each other, and the response says nothing about which applies, so the message
  listed them all. A read of the caller's own personal library, by its real user id, on an
  install with no API key at all, was answered with four clauses about group write
  permissions and one about a read-only key: every one of them wrong, and the true answer
  (in key-free local mode the personal library is `library_id: 0`, and any other id is sent
  to the cloud) was not among them. The three facts that decide the remedy now travel with
  the failure: which library the request addressed, whether it was a read or a write, and
  whether a key was sent at all. A key-free failure names local addressing and never
  mentions key permissions; a keyed read says the key cannot READ that library and does not
  offer write access as the fix; a keyed group write keeps the three gates it has named
  since #74; and a 403 on `/keys/current` says the key itself was rejected. Where the
  context is unknown the message says only what is certain of any 403.

- **`zotero_bibliography` reports the entries Zotero rendered, not the keys it was asked
  for.** `itemCount` was `item_keys.length`, so it echoed the request: a key the library
  does not have came back as `itemCount: 1` over an empty `csl-bib-body`, a number no
  rendering could contradict. Zotero drops a key it cannot render and still answers 200, so
  the count now comes from the rendering (`entryCount`, as `zotero_format_bibliography`
  already reported it, alongside `requestedCount`), and a shortfall is stated: how many of
  the requested keys produced no entry, from which library, and the two reasons a key
  renders nothing (the library does not have it, or it names an attachment or note rather
  than a regular item). An empty result reads `(empty bibliography)` like its sibling
  instead of an empty wrapper. `itemCount` is gone from the structured content.

- **An empty `identifier` is no longer blamed on the translation-server.** `zotero_import
  {action:"by_identifier", identifier:""}` answered "No Zotero translation-server reachable
  at http://127.0.0.1:1969" and suggested installing Docker: a missing identifier and a
  blank one are both falsy, so the empty argument fell through the guard meant for the case
  where there is nothing to resolve *with*. Arguments are now checked before the server is
  probed, and an empty `identifier` (or `url`) says which argument was empty, what a valid
  one looks like, and which action to use instead. The generic translation-server refusal
  it used to reach was reachable only through this bug and is gone; the URL one, which has
  no built-in fallback, is unchanged.

- **`zotero_fulltext action:"set"` says why it cannot run locally, instead of calling a
  personal-library call cloud/group.** With no key, a `set` on the personal library was
  refused with "This operation writes to a cloud/group library and requires a cloud API
  key", which described neither the library asked for nor the reason. The reason is the
  operation: storing full text is a PUT to the Web API, and neither desktop write path (the
  Zotero 10+ local API, the connector protocol) has a full-text endpoint for it to route
  to, so a running desktop app cannot stand in for the key here as it does for item writes.
  The refusal now names the library it was given, the operation's cloud-only nature, and
  what is unaffected: the desktop app keeps its own full-text index, which `action:"get"`
  and `action:"since"` read with no key. The group refusal, which was already accurate, is
  unchanged.

- **`zotero_list_tags`, `zotero_tag_audit` and `zotero_sync` read from the Zotero desktop
  app instead of failing with "Invalid user ID" (same cause as #64, #26 and #67).** All
  three called the cloud Web API directly rather than the router, and with no cloud key the
  personal library is addressed as `users/0`, which api.zotero.org answers `400 Invalid user
  ID`. On the majority setup, a running Zotero and no key, every one of them was unreachable
  with ordinary arguments while the desktop app next door was serving the same data on
  `http://127.0.0.1:23119`. Three separate faults, all fixed: the tools work; the error they
  produced told the user to check their field names against the schema, which was neither
  the cause nor anything they could act on; and a local-only install no longer makes an
  unexpected request to zotero.org (it carried no key and no library content, but it is not
  what a local-only user expects). Tags, the version census and the deletion log now route
  like every other read, so a group the desktop holds is served locally too.

- **What the desktop app cannot answer is named, never returned as an empty result.** Zotero
  10.0.1 serves item and collection versions but answers `/tags?format=versions` with `{}`
  while the same response's header counts every tag in the library, and it has no `/deleted`
  endpoint at all (404). Reported as-is that is "0 tags changed, nothing deleted" for a
  library where both may have changed: a success that did nothing. `zotero_sync` checks each
  version map against the count the response itself gives, reports what could not be served
  in `unavailable` with the reason and where the answer does live, and errors outright when
  nothing it was asked for can be answered. It also reports which API served the delta, in
  `backend`, and takes the whole delta from that one API: the desktop app and the cloud
  number their library versions independently, so a delta answered half from each would be
  handed back under a single `since` belonging to neither sequence.

- **A hand-placed highlight sorts where it sits, instead of at the top of its page.**
  `zotero_annotate` derives `annotationSortIndex` from the topmost rect's distance to the
  BOTTOM of the page, so it cannot be computed without the page height, and the only thing
  that ever reported one was the passage-anchoring pass. A caller who passed `position`
  skips that pass by definition, so every hand-positioned highlight was stored with
  `00000|000000|00000` and jumped to the top of its page in the reader sidebar, whatever
  page coordinates it carried. Measured against a real Zotero desktop: rects
  `[[72, 696, 300, 712]]` on a US Letter page stored `00000|000000|00000` where the reader
  wants `00000|000000|00080`. The page height is now read out of the PDF for that path too,
  which costs opening a file the call would otherwise not open, so it is asked for only for
  the annotations whose sort index actually turns on it, never for a call that is about to
  be refused, never when `sort_index` or `page_height` was given, and it shares one read
  with the anchoring pass. Only page viewports are parsed, never page text: on four real
  papers (1 to 17 MB) that is 1 to 5 ms, against 142 to 449 ms for the anchoring pass on the
  same files, plus the file read. Where the PDF cannot be read at all the annotation is
  still written with its position intact, and the summary says which annotations sort to
  the top of their page and that `page_height` fixes it, rather than leaving it to be
  discovered in the sidebar.


- **An annotation field this tool does not know is refused, not silently dropped.** The
  annotation schema was a plain `z.object`, which strips unrecognised keys before a handler
  ever sees them, while the JSON Schema it advertised said `additionalProperties: false`.
  So `pageLabel: "xx"` and `sortIndex: "09999|000999|00999"` (Zotero's own camelCase
  spellings; this tool's are `page_label` and `sort_index`) produced `isError: false`, a
  cheerful summary, and an annotation stored with a page label of `"1"` and a computed sort
  index. Measured on a real Zotero desktop, and a test harness had been writing exactly that
  and reading the success as proof it worked. A silently ignored argument is the one failure
  a caller cannot detect, so an unknown key now fails the call, names itself, and names the
  field it was probably meant to be: `pageLabel`, `page-label` and `annotationPageLabel` all
  resolve to `page_label`, and a key that resembles nothing gets the list of fields. The
  advertised schema is unchanged, and so is every documented field.


- **A malformed `position` is refused, and the refusal says so.** A rect that was not four
  finite numbers was filtered out of `position.rects`, which left the position empty, which
  the handler read as "no position given" and answered by locating the passage in the PDF
  and writing entirely different coordinates, as a success. Measured: `rects: [[10, 20, 30]]`
  stored a text-anchored rect nothing in the request had asked for. With text that is not in
  the PDF the same input was refused with `passage not found in the PDF` and told the caller
  to re-quote it, and the generic form of that message says "no `position` was given" when
  one had been. A position that was given and cannot be read is now a caller error naming
  the annotation index and what was wrong with it (which rect, and whether it had the wrong
  number of values or a value that is not a finite number), and nothing is written and no
  passage is looked up. The same now holds for the other unreadable positions that used to
  vanish: a non-JSON string, an array that is not the `[pageIndex, [x1, y1, x2, y2]]`
  shorthand, and a `pageIndex` that is not a whole page number. `{"pageIndex": N}` with no
  rects is accepted as the page-only position it reads as, rather than discarded.

### Added
- **`ZOTEUS_ZOTERO_DEADLINE_MS`: the per-request budget for desktop reads is configurable
  (#78).** The 25 s default is right for a local API that normally answers a listing in under
  a second, and it is what turns a stuck read into an actionable message instead of a hang
  until the MCP client's own timeout. It is not right everywhere: on a 9,000-attachment
  library some machines answer an attachment listing slowly enough that an index build's map
  aborts every time, at the same page every time. Accepted between `5000` and `600000` ms;
  a value outside that is ignored with a warning and the default stands. It applies to
  listings and item reads against the **desktop app** only, so raising it cannot make a cloud
  Web API call hang that long, and it leaves the 1.5 s liveness probe, file uploads (which
  pass their own, longer budgets) and attachment downloads (which stay on the 25 s default)
  alone.
## [1.17.0] - 2026-09-09

### Added
- **The threat model is written down, and library text says where it came from (#71).** A
  Zotero library is not a trusted corpus: titles, abstracts, creator names, tags, note HTML,
  annotation text and extracted PDF/EPUB body text arrive from PDFs downloaded off the open
  web, from group libraries, and from items other people shared, and they reached the
  calling model unmarked. [`docs/threat-model.md`](./docs/threat-model.md) now states the
  boundary Zoteus does and does not draw, names the three deployment postures, and links
  from `SECURITY.md` and the README. `zotero_search_items`, `zotero_get_item`,
  `zotero_get_fulltext` and `zotero_semantic_search` carry one added `provenance` field
  (`source: "library-content"`, `trust: "untrusted"`) alongside their unchanged payload,
  which rides `ok()`'s text mirror so it reaches clients that surface only text. The marker
  makes the boundary expressible; it does not sanitise anything and it does not stop prompt
  injection.
- **`ZOTEUS_CONFIRM_BULK_WRITES`: an optional bulk-write threshold (#71).** Above `n` items
  in one call, `zotero_trash_items` (trashing, not restoring), `zotero_manage_tags`
  add/remove, and `zotero_manage_collections action:"remove_items"` refuse unless the call
  also passes `confirm: true`, following the `ZOTEUS_ALLOW_DELETE` + `confirm` idiom.
  Single-item edits stay fluent. Default `0`, meaning off, so no existing call changes. It
  is a deliberation step at the scale where a bad decision does real damage, not a human in
  the loop: a model can re-call with `confirm: true`.

- **The citeproc-js attribution travels with every artefact that redistributes it (#70).** The
  `.mcpb` bundles and the container image carry `node_modules/citeproc`, which is licensed
  CPAL-1.0 or AGPL, and the CPAL asks for a copyright notice, an attribution phrase and an
  attribution URL to be displayed when a session begins. `THIRD_PARTY_NOTICES.md` at the
  repository root now carries the three Exhibit B lines and states that Zoteus takes the
  CPAL option; it is in the npm package's `files`, staged into each bundle, and copied into
  the image, and the bundle gate checks it is there rather than trusting the script. An MCP
  server's only screen is its text, so the attribution line is written to the log once at
  startup and returned by `zotero_whoami`, in its summary and in a structured `attribution`
  field. The npm package itself never vendored citeproc and is unaffected.
- **`ZOTEUS_OPENALEX_API_KEY`, and `zotero_scholar` says when a list was cut (#76).** OpenAlex
  replaced its "polite pool" with free API keys before February 2026 and now ignores the
  `mailto=` parameter Zoteus appended to every request, so the parameter is gone from the
  OpenAlex calls (Crossref still reads it) and an optional key takes its place, sent as a
  bearer header and never in a URL that an error message would quote. Keyless calls still
  work on OpenAlex's small daily budget. `references`, `related` and `citations` answers now
  carry `total`, the size of the list the results were cut from, and `truncated` when `limit`
  dropped some: a review with 150 references used to come back as twenty works and nothing
  else, and a citation-gap pass had no way to know it saw a seventh of the list. The tool
  description also says what the tool is not, a thin helper around one DOI, and points at the
  OpenAlex API for full querying.
### Changed
- **`pdfjs-dist` is pinned to exactly 5.6.205 (#69).** It is the last release that runs on
  the Node 20.19 floor the package declares: 5.7.284 and the whole 6.x line require
  `>=22.13.0 || >=24`. The declared range was `^5.6.205`, which admitted all of them, so any
  resolve that ignored the lockfile (`npm update`, a deleted lockfile, a project depending on
  `@oscardvs/zoteus` and resolving its own tree) could take a build that cannot start on Node
  20, and exact-page extraction would have degraded to approximate pages with no error to
  read. The pin closes that, `tests/node-floor.test.ts` fails if the pin, the lockfile,
  `mcpb/manifest.json` and the CI matrix ever stop naming the same floor, and
  [`SECURITY.md`](./SECURITY.md) now records why the parser is frozen and why the advisory
  `npm audit` reports against it (GHSA-hq66-cqwq-w95j, a viewer-scripting flaw) does not
  reach a text extractor that builds no viewer.

### Fixed
- **The first `action:"update"` after a build no longer costs every later semantic query the
  two-stage vector path (#30).** An update runs two catch-up passes that replace one item's
  passages wholesale: the full-text pass that picks up newly extracted attachment text
  (#26), and the own-words pass that re-reads an edited note or annotation (#33). Both
  removed those passages and their vectors and left the binary codes taken from them behind,
  where a whole-item delete had always taken them with it. One code per replaced passage
  then described a row the index no longer held; the coverage check that reads the codes
  counts one per stored vector, found more codes than vectors, and sent every semantic query
  back to the exact scan the codes exist to avoid (the 42x this path was landed for) until
  someone noticed and ran a full `action:"build"`. Nothing said so beyond the scan notice on
  `zotero_index action:"status"`. A semantic query that arrived while a catch-up was still
  running could also fail outright, on a resident code cache naming a rowid SQLite had just
  handed back to a replacement passage that carried no vector yet. Both clears now drop the
  codes of the passages they remove, scoped by source so the item's other passages keep
  theirs.
- **A transient attachment read during `action:"update"` no longer drops an item's body
  passages and stamps past them (#67).** A changed item whose PDF could not be read got the
  same answer as an item with no extracted text at all, so the upsert replaced its indexed
  body with nothing and the version stamp advanced anyway: the attachment had not changed in
  Zotero, so no later delta named the item and `/fulltext?since=` would not either, and its
  body stayed unsearchable until a full `action:"refresh"`. On a saturated library (#39) or
  a rate-limited key that happened to every changed item on the page at once, with only a
  lower `fulltextItems` to show for it. The full-text source now says when a read failed
  instead of folding it into "no text", a failed read replaces nothing (the body passages
  the index holds are put back through the upsert), and the sequence that would have to
  offer the item again is held back: a gap on the delta's own items withholds the version
  stamp, and a gap in the catch-up withholds the full-text cursor. The status carries one
  `fulltextReason` sentence saying so, and the next `action:"update"` retries. This is the
  full-text sibling of #63, and it follows the same rule.
- **A second Zoteus process no longer undoes a finished index on its way out (#68).** Two
  processes sharing one `ZOTEUS_DATA_DIR` is the recommended setup for a first build: run one
  headlessly and let Claude Desktop read the result. The desktop app's index handle, open
  since before that build started, wrote its whole in-memory meta row back over the finished
  one when the app quit, putting the library version to 0, the library and embedder identity
  to empty, the full-text cursor to 0 and the checkpoint to nothing. Nothing errored and
  nothing logged, and the next `action:"update"` then found no stamp, fell back to a full
  build, found no checkpoint to resume from, and cleared the store: hours of crawling and
  embedding gone, by the same end state as #59 through another route. A flush now writes only
  the fields that handle changed itself and leaves every other field as it is on disk, and a
  durable pause writes its one flag instead of the whole row. The same handle also re-reads
  the store before deciding that a delta is impossible, so an index another process finished
  is no longer rebuilt from scratch by the session that never saw it; on the JSON backend a
  handle that indexed nothing leaves an artifact it did not write alone. A reset still writes
  its zeroed row whole, because the rows the old stamp described have just been deleted, and
  each case that keeps another process's values says so once in the log.
- **A group library write now says what is missing instead of failing at the cloud (#74).**
  Group writes have always been cloud-only (the desktop app's local API and the connector
  protocol both address the personal library and nothing else, even for a group the app is
  holding and reading key-free), but three things made that hard to act on. A call naming
  `library_type:"group"` without a `library_id` fell through to the default library, so a
  request that plainly said "the group" read from, or wrote to, the personal library and
  reported success; it is now refused, pointing at `zotero_groups` for the id. A key that
  cannot write the target group only found out at api.zotero.org, as a 403 reading "your
  API key may lack permission for this library or operation"; the key's own access map is
  now checked first, so a read-only or group-less key is refused locally by name, with the
  settings page to fix it. And the 403 that remains (the group's own Library Editing
  setting, which no key overrides) now names all three causes rather than none.
- **The `list` sub-actions of the manage tools read the library they were given (#74).**
  `zotero_manage_collections`, `zotero_manage_tags` and `zotero_saved_searches` all accept
  `library_type`/`library_id` and all ignored them when `action:"list"`, answering from the
  personal library: a model looking for a group's collection keys got the wrong library's,
  and the write that followed used a collection key that does not exist there.
- **A file moved to or from cloud storage gets a file's time budget, not a query's (#74).**
  Attachment uploads and downloads over the Web API ran on the 25 s budget meant for a JSON
  request, so a large PDF (the cloud path is the only one a group library has for files)
  timed out with "narrow the query, lower the limit". They now allow five minutes, matching
  the desktop upload path.
- **`mode:"semantic"` no longer answers "No matches" when there is no embedder to turn the
  query into a vector (#7).** Semantic ranking needs both ends of the comparison (vectors
  in the index, and a provider to embed the query), but the refusal only tested the first.
  An index built with an embedder and reopened with `ZOTEUS_EMBEDDINGS=off` keeps its
  vectors (they are unusable, not known-wrong), so `hasVectors` stayed true, the refusal did
  not fire, and the query fell through to a vector ranker with no query vector and a keyword
  ranker closed by `mode:"semantic"`. The result was a bare `No matches for "…"`,
  indistinguishable from a library that genuinely holds nothing on the subject;
  `embedderNotice` is deliberately silent about a provider switched off on purpose, so
  nothing else explained it either. Semantic mode now refuses whenever no provider is
  configured at all, names which of the two halves is missing, and, when the vectors carry
  their provenance, names the provider that built them. `auto` and `keyword` are
  unaffected. So is a provider that is configured and merely failed: it is still reported
  through the existing notice, and the next query ranks again as soon as it recovers,
  without an index rebuild.

- **Stock `zotero_export` reads a desktop-served library with no cloud key (#75).** Every
  stock format, and the `biblatex` that `better-biblatex` degrades to, went to api.zotero.org
  unconditionally, which in key-free local mode is `users/0` and a refusal. Both calls now
  take the same routed read as `zotero_format_bibliography` (#64): the desktop app renders the
  export for any library it serves, the Web API for everything else, with selectors and limit
  forwarded unchanged. The Better BibTeX branch and explicit cloud libraries behave as before.
### Documentation
- **A "Group libraries" section in `docs/writing.md`**: that group writes work but are
  cloud-only whatever the desktop app is doing, the three separate permissions a group
  write needs (a key, group write access on the key, and a group that lets you edit its
  library), how a numeric library id differs from a collection key, and that a group's
  collection keys must come from that group.

## [1.16.0] - 2026-09-07

### Fixed
- **A paper with many annotations no longer crowds every other result off the page (#65).**
  Search ranks passages and answers with items, and between the two sat a fixed pool of
  three passages per result asked for: an item whose forty annotations all ranked first
  (#33) filled a pool of fifteen by itself, so `limit:5` returned that one paper while
  `limit:20` returned the five relevant ones, in semantic, keyword and hybrid mode alike, for
  child notes as much as for annotations. The pool now doubles until the page holds the
  requested number of distinct items or the candidates are used up: a ranker that returns
  fewer than it was asked for is not asked again, the pool never exceeds the passages the
  index holds, and the query is embedded once for every round. A page the first pool fills
  costs exactly what it did before.
- **Writes and annotation reads follow the configured or explicit library, never silently
  the personal one (#61).** With `ZOTERO_LIBRARY_TYPE=group` and `ZOTERO_LIBRARY_ID` set,
  every cloud write resolved its target from the API key's user id rather than from the
  configured default, so `zotero_create_items` with no per-call library wrote to the
  personal library; `zotero_annotate` with an explicit group still looked the parent up in
  the personal library and failed with a 404 before writing; and the desktop shortcuts
  (local-API and connector writes, which can only ever reach the personal library) were
  gated on the absence of a per-call `library_id`, so a configured group default went to
  the desktop's personal library too. The effective library is now resolved once per call
  (explicit arguments, then the configured default, then the key's own library) and passed
  through the parent and children reads, the PDF lookup and the write; the desktop paths
  apply only when that library is the personal one, and a group target with no cloud key
  fails clearly before anything is fetched or written.
- **A failed notes-and-annotations catch-up no longer advances the version stamp (#63).**
  When the child census behind `action:"update"` failed (the keys-only versions request,
  the body crawl, or resolving annotated attachments to their items) the update swallowed
  the failure and stamped the newer library version anyway, so an edited note kept its old
  text searchable and an added note was never indexed until a rebuild; a census that
  stopped early even answered "no own words" for the affected items, and the update indexed
  that over the text it held. Own-words work that does not complete now withholds the
  stamp, exactly as an unreconciled deletion pass does, and a degraded census replaces
  nothing. The status carries one `ownWordsReason` sentence saying so, and the next
  `action:"update"` repeats the delta and retries.
- **The Claude Desktop bundle is now one file per operating system, each carrying its own
  native PDF dependency (#62).** `pdfjs-dist` draws through `@napi-rs/canvas`, whose skia
  binary is a separate npm package per OS and CPU that npm installs only for the machine it
  runs on, so the single `zoteus.mcpb` packed from a plain `npm ci` on the Linux release
  runner carried the two linux-x64 binaries under a manifest that promised darwin and win32
  as well; there, importing pdfjs failed with `DOMMatrix is not defined` and exact-page
  extraction quietly fell back to approximate pages. The release now stages a tree per OS
  with `npm ci --os --cpu` against the lockfile (both CPUs of each OS, no version repeated
  anywhere), narrows each manifest to the one OS it is for, and refuses to publish unless
  every archive holds a `.node` binary for each CPU the OS is promised on: `zoteus-macos.mcpb`,
  `zoteus-windows.mcpb` and `zoteus-linux.mcpb`, 32 to 57 MB each, where one file for every
  target would have been 103 MB. Verified by archive inspection and loader simulation on
  Linux; a run on a native macOS or Windows machine is still owed.
- **Item-key bibliographies render from the desktop app in key-free mode (#64).**
  `zotero_bibliography item_keys` and `zotero_format_bibliography item_keys` both read
  straight from the cloud client instead of the router every other library read goes
  through, so with `ZOTEUS_LOCAL=on` and no `ZOTERO_API_KEY` they asked api.zotero.org for
  `users/0`, which it rejects as an invalid user id, although the same items were readable
  locally. Zotero 10 serves `format=bib` itself, honouring `style` (fetching from the style
  repository whatever it lacks), `locale` and `linkwrap` exactly as the cloud does, and
  serves `format=csljson` as well, so both reads are now routed: the desktop renders or
  exports for any library it serves, the personal library or a group it holds, and an
  explicit cloud library still goes to the cloud with style and locale intact. The
  supplied-CSL path of `zotero_format_bibliography` never touched a transport and is
  unchanged, and so is style and locale retrieval for citeproc. Two desktop differences are
  absorbed in the local client: its CSL-JSON is a bare array where the cloud's is wrapped in
  `{ items }` (both shapes were already accepted), and its `?itemKey=` answers with the
  named items and their children, so the PDF of a cited paper would have rendered as a
  `document` entry of its own; a keyed export reads `/items/top`, which is exactly the items
  named, as on the cloud.
- **`ZOTEUS_LOG_FILE` now receives index build and update lines, not only HTTP requests (#59).**
  The server created one logger with the file attached and handed it to the HTTP transport,
  but the tool context built a second one from the level and format alone, and that second
  logger is the one every index job, the embedder and the Zotero clients write through. So
  the file held request lines and nothing else, while build progress and the error that
  ended a build went to a stderr nobody was reading. The context now logs through the
  server's logger, and a context built without one still attaches the file itself.
- **A build no longer aborts with `UNIQUE constraint failed: passages.id` when the library
  is edited while it is being paged (#59).** Both Zotero APIs page newest-modified first, so
  an item anyone edits mid-crawl (another client's annotation, a tag change, a sync) moves
  to the front and shifts the page boundary: the item at the boundary is served again at the
  top of the next page, and its second copy reached a plain INSERT that the unique passage
  id refused, ending the whole build about 1,300 items into a 10,500-item library. The crawl
  now steps over items it has already indexed in this run, the children census behind the
  reader's own words dedupes by key the same way, and the insert itself is `OR IGNORE`, so a
  duplicate id can never abort a build: it is counted, skipped, and reported in one log line
  at the end, with the reminder that anything edited during the crawl belongs to the next
  `action:"update"`. On SQLite each item is written under a savepoint as well, so a failure
  between an item's first and last passage rolls the item back whole instead of leaving a
  half-written item that a resume would step over as finished.
- **`action:"build"` says when it replaces an existing index (#59).** A build over an index
  that already holds rows is a rebuild from scratch and replaces those rows at its first
  commit. That is by design (the partial index is searchable at once and resumable from its
  checkpoint), but it surfaced in #59 as a 1,300-item partial index where a complete
  97,000-passage one had been. The tool now states it when the build starts, with the size
  of what is being replaced, and names `action:"update"` as the path that leaves a complete
  index in place.

## [1.15.0] - 2026-09-07

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
