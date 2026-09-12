# Full-text grounding, tag audit, and BBT export

Zoteus adds tools for research grounding: retrieve PDF passages with page locators, look at PDF pages and figures as images, audit tag hygiene against a controlled vocabulary, and export with Better BibTeX formatting.

## `zotero_get_fulltext` — retrieve PDF text for grounding

Retrieve the full text of a PDF or EPUB attachment for use as grounding context. Pass either:
- A **parent item key**, whose best child attachment is resolved automatically (a PDF first, then an EPUB, then whatever else is attached).
- An **attachment key** directly — returned as-is.

### Retrieval modes

One of four modes is selected based on the arguments:

**`query` mode** (pass `query`): Returns the top-k passages most relevant to the query, ranked by an ephemeral BM25 index (fused with vector re-ranking when an embedder is configured). Each passage carries:
- `charStart` / `charEnd` — inclusive/exclusive character offsets in the source text.
- `section` — nearest preceding section heading (best-effort).
- `pageApprox` — proportional page estimate (1-based), or `page` (exact) when `precise_pages` succeeds.
- `score` — BM25 score.
- `max_passages` caps the number of passages returned (default 5, max 20).

**`page_range` mode** (pass `page_range`, e.g. `"3-7"`): Returns the text for the specified page span (1-based, inclusive). The PDF is re-extracted so the span is the real one, which is what makes reading a long document page by page practical; asking for "page 5" and getting a proportional slice of the character stream answers a different question. Pass `precise_pages: false` to opt back out and take the proportional slice of the indexed text (no file read at all). When exact extraction is not possible the tool degrades to the proportional slice with a notice, exactly as `precise_pages` does.

**`outline` mode** (pass `outline: true`): Returns the PDF's own table of contents instead of text. See [PDF outline](#pdf-outline-table-of-contents) below.

**Document mode** (no argument): Returns a truncated head of the document with a notice prompting use of `query` or `page_range` for targeted retrieval.

In all text modes, `max_chars` caps total returned text (default 12000, max 100000). A single passage is never split, so one passage may slightly exceed the cap.

### Page locators

By default, page numbers are **approximate** (`pageApprox`): a proportional estimate derived from the character offset divided by the total character count, clamped to 1-based page numbers. This requires only the Zotero cloud full-text index.

Pass `precise_pages: true` to re-extract the PDF for **exact** page numbers (`page_range` already does this without the flag). This:
1. Reads the attachment bytes, from the running Zotero desktop app, the local Zotero storage folder, or the cloud API, in that order (see [Where the file bytes come from](#where-the-file-bytes-come-from)).
2. Lazily imports the optional `pdfjs-dist` dependency (declared as an `optionalDependency`).
3. Extracts per-page text and locates each passage.

If the PDF bytes are unavailable or `pdfjs-dist` is not installed, the tool **degrades to approximate pages** and sets `pageSource: "approximate"` with a notice in `structuredContent.notice`. It never throws — the degrade is transparent.

Install the optional dependency for exact pages:
```bash
npm i pdfjs-dist
```

### PDF outline (table of contents)

Pass `outline: true` to get the PDF's own bookmark tree instead of its text:

```jsonc
{
  "mode": "outline",
  "fileSource": "local-api",
  "outline": [
    { "title": "Introduction", "page": 1, "level": 0 },
    { "title": "Related work", "page": 3, "level": 0 },
    { "title": "Anchoring", "page": 4, "level": 1 }
  ],
  "entries": 3
}
```

- `level` is the nesting depth (0 for a top-level heading, 1 for its children).
- `page` is the 1-based page the heading points at. A heading whose destination cannot be resolved is still listed, without a page.
- The outline is read from the file itself and never touches Zotero's full-text index, so it works for an attachment added a minute ago.
- A PDF with no bookmarks returns `outline: []` and a notice, not an error. An EPUB is refused with a pointer back to plain-text mode.
- At most 500 headings are returned (`truncated: true` says when a longer tree was cut).

Reading the outline first and then asking for the pages it names is the cheap way to work through a long document: two small calls instead of one call that returns a book.

### Unindexed attachments: local extraction fallback

`zotero_get_fulltext` normally serves text from Zotero's full-text index. When an attachment has **not been indexed yet** (no stored full text), the tool reads the file itself and extracts the text locally:

- **PDF** via the same `pdfjs-dist` parser used for exact pages, with `fulltextSource: "pdf"` and **exact** page locators (`pageSource: "exact"`).
- **EPUB** via a dependency-free reader (an EPUB is a zip of XHTML: Zoteus unpacks it with `node:zlib`, follows the package document's spine so the chapters come back in reading order, and strips the markup), with `fulltextSource: "epub"`. An EPUB reflows and has no fixed pages, so `page_range` does not apply to one and says so rather than inventing a span.
- The response is served exactly like indexed text: `query`, `page_range` and document modes all work, and `fulltextSource` plus `fileSource` tell a caller that this text was extracted locally rather than read out of Zotero's index.
- The fallback is on by default; pass `fallback: false` to opt out (the tool then returns an actionable "not indexed" error).
- Same OOM guard as `precise_pages`: attachments larger than 20 MB are not parsed; the error tells you to open the file once in Zotero to index it.
- Scanned/image-only PDFs yield no text: the error explains that extraction found nothing. [`zotero_pdf_images`](#zotero_pdf_images-see-pages-figures-and-scans-as-images) shows such a page as a picture instead.

This is what makes "summarise the paper I just added" work. It covers libraries where many PDFs were never indexed, and grounding no longer waits for Zotero to re-process anything.

### Where the file bytes come from

Everything that reads the attachment file itself (the fallback above, `precise_pages`, `page_range`, `outline`, and `zotero_annotate`'s passage anchoring) tries three sources in order, and reports the one that answered as `fileSource`:

| `fileSource` | Source | Reaches |
|---|---|---|
| `local-api` | The running Zotero desktop app (`/items/<key>/file`, which answers a `file://` redirect into its data directory) | Everything Zotero holds, including unsynced attachments and libraries with no storage quota. No cloud key. |
| `storage` | `<Zotero data dir>/storage/<attachment key>/` read straight off disk | The same files **while Zotero is closed**, as long as Zoteus shares the machine. No cloud key, no desktop app. |
| `cloud` | The Web API file download | Anything that has synced, from anywhere. Needs `ZOTERO_API_KEY` with file access. |

The storage folder defaults to `~/Zotero` (`%USERPROFILE%\Zotero` on Windows). Zotero lets you move it, and the moved path lives in the app's own preferences where Zoteus cannot see it, so set `ZOTERO_DATA_DIR` if yours is elsewhere. A directory that is not there is skipped silently, so a hosted Zoteus loses nothing by looking.

When no source can produce the file, the error names each one it tried and why it could not answer, rather than reporting only the last failure.

### Where the indexed text comes from

Zotero's stored full text is read through the library router, not the cloud alone: a running desktop app (Zotero 7+) serves the `/fulltext` endpoints itself, so grounding works with **no cloud API key**, and for items that never synced. Group libraries, and everything when the app is closed, go to the cloud Web API.

The same text feeds the opt-in full-text pass of the semantic index, so a passage found by `zotero_semantic_search` (marked `source: "fulltext"`) can be re-fetched here with a page locator. See [`semantic-search.md`](./semantic-search.md#full-text-indexing-opt-in).

### Read-only mode

`zotero_get_fulltext` is annotated `readOnlyHint: true` and remains available under `ZOTEUS_READ_ONLY=true`.

---

## `zotero_pdf_images`: see pages, figures and scans as images

Everything above returns text, and text is what a figure, a table, an equation and a scanned page all lose: a figure arrives as its caption, a table as its numbers run together, an equation as a few stray glyphs, and a scan with no text layer as nothing. `zotero_pdf_images` returns pictures instead, as MCP `image` content blocks the model can look at, followed by the usual summary and JSON.

It takes the same `item_key` as `zotero_get_fulltext` (a parent item, whose PDF attachment is resolved the same way, or an attachment key), reads the file from the same three sources (desktop app, local storage folder, cloud), and has two modes:

### `mode: "pages"`: render whole pages

```jsonc
{ "item_key": "ABCD1234", "mode": "pages", "pages": "3-4" }
```

- `pages` is a 1-based span, `"3"` or `"3-7"` (default `"1"`).
- The default resolution fits the long edge of the page to about 1568 px (roughly 142 dpi on a letter page, 1212x1568), which keeps body text and inline maths legible and is as much as the model is shown anyway. `dpi` (36 to 300) overrides it; nothing renders longer than 3508 px on its long edge (A4 at 300 dpi).
- `format` is `"jpeg"` (default, quality 80, about 200 KB for a text page) or `"png"` (sharper line art, larger).
- Each page comes back as an image block, and `structuredContent.pages` lists `page`, `width`, `height`, `dpi`, `mimeType`, `bytes`, `inline` and, with `save: true`, `path`.

### `mode: "figures"`: extract the embedded images

```jsonc
{ "item_key": "ABCD1234", "mode": "figures", "pages": "1-8" }
```

The tool walks each page's content for the raster images it draws (image XObjects, inline images and stencil masks), the way `pdfimages` does, and returns each one at its native pixel size:

```jsonc
{
  "page": 3, "index": 1, "width": 1520, "height": 2239, "mimeType": "image/jpeg", "bytes": 148213,
  "source": "xobject", "bbox": { "x": 108.5, "y": 70.2, "width": 395, "height": 582 },
  "coversPage": false, "inline": true, "path": "/home/me/.local/share/zoteus/pdf-images/ABCD1234/page-003-image-001.jpg"
}
```

- `bbox` is where the image is drawn on the page, in PDF points with the origin at the top left, so it can be matched against the text around it.
- `coversPage: true` marks an image drawn over most of the page: a scanned page rather than a figure on one. When every requested page is such an image, the notice says the PDF is a scan and that `zotero_get_fulltext` will have no text for it unless Zotero has OCRed the file.
- Images under `min_size` px on a side (default 32: icons, rules, bullets) are skipped, an image repeated across pages is returned once, and a translucent figure is flattened onto white rather than black. Without `format`, images up to 2 megapixels are PNG and larger ones JPEG; an image longer than 2000 px is sent inline as a 2000 px preview while the saved file keeps its native size.
- **Vector figures do not appear here.** A plot from matplotlib, TikZ or a vector PDF export is lines and text in the content stream, not an image; the notice says which requested pages embed no raster image, and `mode: "pages"` is how to see them.
- **Text scanned letter by letter is not a figure either.** Some older papers (a 2006 conference paper in the test library paints 4390 stencil masks on its first page, each one glyph) carry no text layer and no page image, only thousands of small bitmaps. A page painting 200 or more stencil masks is reported as `bitmapTextPages` with the count, its masks are left out of the figures, and the notice points at `mode: "pages"`, which renders such a page legibly.

### Saving files

On a local install, figures are saved by default (pages on request with `save: true`) under `<Zoteus data dir>/pdf-images/<attachment key>/`, as `page-003.jpg` and `page-003-image-001.png`, and the paths come back in the result. The names are deterministic, so a repeat call overwrites the same files. On a shared server (any OAuth deployment) `save` is refused, because a file written there sits on the operator's disk, not the caller's; the images still arrive inline. Pass `inline: false` to get metadata and paths only.

### Caps

Rendering is the most expensive thing the server does per call, the hosted tier runs on a 1 GB machine, and the images travel as base64 inside JSON. So:

| Cap | Value | Why |
|---|---|---|
| Pages per call | `max_pages`, default 4, at most 8 | A section of a paper, not a book; a longer span is cut and the notice says which `pages` to ask for next. |
| Figures per call | `max_images`, default 16, at most 40 | Bounds the decoding and encoding work. |
| Long edge | 3508 px | A4 at 300 dpi; one canvas is about 35 MB at that size. |
| Image pixels pdfjs will decode | 16 megapixels on a shared server, 40 locally | pdfjs decodes every image on a page to raw pixels before anything is drawn; a 600 dpi letter scan is 34 megapixels and still opens on a laptop. A page whose only image is above the limit renders blank, and figures mode reports it as holding neither text nor an image. |
| Inline image data per response | about 5 MB of base64 | Four default-resolution JPEG pages are about 1 MB. Beyond the budget, pages or figures are still rendered (and saved when asked) but not returned inline, and the notice names them and the remedy: fewer pages, a lower `dpi`, `format: "jpeg"`, or `save`. |
| File size | 20 MB | The same cap as `zotero_get_fulltext`, for the same reason. |
| Concurrency | one job at a time per process | Two concurrent peaks on the small machine would be an out-of-memory kill for everyone on it. |
| Scratch canvases | pooled by size, at most 16 megapixels and 8192 canvases | pdfjs allocates two or three scratch canvases per stencil mask and drops them, and the Node canvas binding does not return a dropped canvas's memory to the operating system (measured: one render of the 4390-mask page cost 500 MB that never came back). Pooled through pdfjs's public `CanvasFactory` option, four such pages render in about 300 MB total instead of 750 MB and stay there. |

### Errors it explains

A PDF that needs a password to open is refused with a message that says so (one whose encryption only restricts printing or copying opens normally). A broken or truncated file is reported as not a readable PDF. An EPUB has no pages to draw and is pointed at `zotero_get_fulltext`. Pages beyond the end of the document are named, and a call that asks only for those is an error. When the canvas package that pdfjs draws through is missing, the error names it (`npm install @napi-rs/canvas`) instead of surfacing a stack trace.

### What it needs

Nothing new. pdfjs-dist, the optional dependency that already gives `zotero_get_fulltext` its exact pages, draws through `@napi-rs/canvas`, its own optional dependency, which a plain `npm install` brings in with it; the Claude Desktop bundles carry its native binary for every OS and CPU they name (see [Distribution](./distribution.md)). An install made with `--omit=optional` has neither, and both tools say so.

### Read-only mode

`zotero_pdf_images` is annotated `readOnlyHint: true` and remains available under `ZOTEUS_READ_ONLY=true`. It writes nothing to the library; the only thing it writes anywhere is the image files under the Zoteus data directory, and only when asked.

---

## `zotero_tag_audit` — audit tags against a controlled vocabulary

Audit a Zotero library's tags against a controlled vocabulary with optional required tiers.

### Vocabulary schema

Supply inline as `vocabulary` (a JSON object) or as a JSON file path via `vocabulary_path`. On a server with OAuth enabled, `vocabulary_path` must resolve inside the data directory (see [Files and sync](./files-and-sync.md)); pass the vocabulary inline instead:

```json
{
  "tags": [
    { "name": "machine-learning", "tier": "topic" },
    { "name": "RQ1", "tier": "subquestion" }
  ],
  "tiers": [
    { "name": "topic", "required": true },
    { "name": "subquestion", "required": false }
  ]
}
```

- `tags[].name` — canonical tag name.
- `tags[].tier` — optional tier membership (used for the missing-tier report).
- `tiers[].name` — tier name.
- `tiers[].required` — if `true`, every item must have at least one tag from this tier.

### Reports

The tool produces three reports:

1. **Off-taxonomy tags** (`offTaxonomy`): library tags that are not in the vocabulary. Zotero automatically-applied tags (`meta.type === 1`, e.g. PDF keyword extraction) are bucketed separately as `autoTags` rather than flagged as off-taxonomy — unless `include_auto: true` is passed, in which case they are included in `offTaxonomy`.

2. **Missing required tiers** (`missingByTier`): for each required tier, the items that have no tag belonging to that tier. Each entry lists `tier`, `itemCount`, and a capped list of `items` (key + title).

3. **Per-collection coverage** (`collections`): pass `scope.collection_keys` with an array of collection keys to run the missing-tier analysis scoped to each collection separately.

### Other options

- `limit` — caps the number of items listed per report entry (default 50, max 500). Does not limit the tag or item enumeration — all are scanned.
- `include_auto` — treat Zotero auto-applied tags as off-taxonomy too.
- `library_type` / `library_id` — target a group library.

Tags and items are enumerated via the cloud Web API with automatic pagination.

### Read-only mode

`zotero_tag_audit` is annotated `readOnlyHint: true` and remains available under `ZOTEUS_READ_ONLY=true`.

---

## `zotero_export format:"better-biblatex"` — Better BibTeX export

`zotero_export` now accepts `format: "better-biblatex"` in addition to all existing formats.

### Built-in `biblatex` vs `better-biblatex`

| Format | Route | BBT options | Availability |
|---|---|---|---|
| `biblatex` | Zotero cloud Web API (stock translator) | Not available | Always (cloud) |
| `better-biblatex` | Local desktop Better BibTeX plugin | Your configured BBT options apply | Desktop-local only |

**`biblatex`** uses Zotero's stock cloud translator. BBT-specific features (citation-key generation rules, sentence-case handling, `biblatexExtendedNameFormat`, unicode→LaTeX transliteration, and any BBT export options you have configured) are **not** available.

**`better-biblatex`** uses the Better BibTeX plugin running in your desktop Zotero instance at `http://127.0.0.1:23119/better-bibtex`. It requires:
- Desktop Zotero running locally.
- The [Better BibTeX for Zotero](https://retorque.re/zotero-better-bibtex/) plugin installed.

When `better-biblatex` is requested but Better BibTeX / desktop Zotero is unavailable (e.g. the hosted cloud connector, or Zotero is not running), the tool **degrades to the built-in `biblatex`** stock translator and includes a notice in the response. `structuredContent.degradedToBuiltIn` is set to `true`.

`better-biblatex` requires explicit `item_keys`; whole-library or query-based exports fall back to built-in `biblatex`.

---

## `zotero_list_tags` and `zotero_list_collections` — read-only listing tools

Two new read-only tools surface information that was previously only accessible through the mutating `zotero_manage_tags` and `zotero_manage_collections` tools.

### `zotero_list_tags`
Lists tags in a Zotero library with usage counts and an `auto` flag (`true` for Zotero-applied tags, `false` for manual). Supports an optional `q` substring filter and `limit`. Available under `ZOTEUS_READ_ONLY=true`.

### `zotero_list_collections`
Lists collections with key, name, parent collection key, and item count. Optional `top: true` returns only top-level collections. Collection keys can be passed to `zotero_search_items` (`collectionKey`) or `zotero_tag_audit` (`scope.collection_keys`). Available under `ZOTEUS_READ_ONLY=true`.

---

## Read-only mode summary

Under `ZOTEUS_READ_ONLY=true`, the following tools remain available:

| Tool | Purpose |
|---|---|
| `zotero_get_fulltext` | Retrieve PDF passages |
| `zotero_pdf_images` | Render PDF pages and extract figures as images |
| `zotero_tag_audit` | Audit tag vocabulary |
| `zotero_list_tags` | List tags with usage/auto flag |
| `zotero_list_collections` | List collections |
