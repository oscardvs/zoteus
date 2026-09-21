# Build an evidence table

An evidence table compares several sources on one question, one row per study, with the exact words that support each row and the page they came from. The point of the table is not the layout. It is that every row shows how well its source was actually read, so a row resting on an abstract cannot be mistaken for a row resting on a retrieved passage.

Two pieces ship for this: the `zotero-evidence-table` prompt, which walks the retrieval, and the `zotero_evidence_table` tool, which renders what was retrieved.

## Run the workflow

In a client that exposes MCP prompts as slash commands, pick **Evidence table** and give it your question. Arguments:

| Argument | Required | What it does |
|---|---|---|
| `question` | yes | The research question. It becomes the table caption. |
| `item_keys` | no | Comma-separated item keys to compare. Given these, no search runs. |
| `collection` | no | Collection name or key to take the studies from. |
| `max_items` | no | How many studies (default 5). Each study is one `zotero_get_fulltext` call, run sequentially. |

If your client does not surface prompts, paste the same request:

> Build an evidence table answering "[question]" from my Zotero library, at most 5 studies. Retrieve one passage per study with zotero_get_fulltext before any factual claim, take the quotation verbatim, and say whether each page is exact or approximate. Classify coverage as passage retrieved, abstract only, or unavailable, from what the tools returned. Then render it with zotero_evidence_table.

A named collection is resolved to a collection key first and searched with `zotero_search_items`. `zotero_semantic_search` takes only `q`, `limit`, `mode` and `auto_build`: it cannot be scoped to a collection, and Zoteus refuses an argument a tool does not declare rather than silently ignoring it.

## What each column means

| Column | Where it comes from |
|---|---|
| Study | The item label and its key. |
| Finding | The assistant's reading of the study. Judgement, not a quotation. |
| Quotation | Verbatim `passages[].text` from `zotero_get_fulltext`. Never typed from memory. |
| Locator | `page` when the PDF gave a real page (shown as `exact`), `pageApprox` when it is a proportional estimate (shown as `approximate`), `(none reported)` when neither exists. |
| Coverage | `passage retrieved`, `abstract only`, or `unavailable`. |
| Support | `supported`, `contradicted`, `uncertain`, or `unverified`. Judgement, and a row with no passage is `unverified`. |

A Notes column is added when at least one row carries a caveat.

Pages are not guaranteed. An EPUB has no fixed pages, a Zotero full-text record with no page count yields no estimate, and a large PDF or a missing PDF reader degrades an exact page to an approximate one. The table shows those gaps rather than filling them.

## What the render tool adds

`zotero_evidence_table` does not search and does not read your library. It takes the rows the assistant gathered and renders them. Three things are worth the extra call:

- **The quotation cannot drift.** The cell is the string that was passed in, escaped only where the format would otherwise break, never reworded.
- **The coverage summary is counted, not claimed.** `coverage` in the result counts the rows; a sentence saying four of six rows rest on retrieved text is arithmetic, not a summary the assistant wrote.
- **A row that contradicts itself is named.** Three checks run, and each one names the row and its item key: a page locator with no quotation, coverage claiming a retrieved passage with no quotation, and a `supported` verdict on a source marked `unavailable`. These are warnings, not refusals. The table still renders, because a half-covered table is a real result and you need to see it to fix it.

The warnings are about a row disagreeing with itself. Nothing here checks whether the quotation actually supports the finding: that is your reading, and the reason the quotation and the page are in the table at all.

## Formats and files

`format: "markdown"` returns a caption, the table, the coverage line and any warnings, ready to paste.

`format: "csv"` returns RFC 4180 rows and nothing else, so it opens in a spreadsheet unaltered: no caption, no warnings, no coverage line inside the file. It has two columns Markdown folds into one, `Locator` and `Locator quality`, plus the item key, so you can sort on them.

`save_path` writes the rendered text to a file as well as returning it. An existing file is not replaced unless you pass `overwrite: true`. On a shared (hosted) deployment the path is confined to the server's data directory, because a filesystem path there points at the operator's disk rather than yours; the refusal says so, and you can copy the table out of the result instead.

Two honest limits on the rendering:

- Markdown escaping covers what breaks a table: pipes, backslashes and line breaks. It does not neutralise the rest of Markdown, so a quotation containing asterisks still renders as emphasis.
- A CSV cell that begins with `=`, `+`, `-` or `@` is a formula to a spreadsheet. Zoteus does not prefix or rewrite those cells, because the quotation has to stay verbatim. Import the file as text, or check such cells before opening them in a spreadsheet that evaluates formulas on import.

## Saving the table into Zotero

Nothing is written without you asking. If you want the table kept in the library, the assistant can save the rendered text as a Zotero note with `zotero_create_items`. That route uses the cloud Web API, so it needs a Zotero API key with write access (or OAuth on a hosted deployment); on a desktop-only install it fails rather than appearing to save. See [write tools](./writing.md).

## Before you use the table

Open one or two sources at the page given and read around the quotation. A retrieved passage proves the words exist in that document. It does not prove the finding in the next column is a fair reading of them.

[Your first research task](./first-research-task.md) · [Search readiness](./search-readiness.md) · [Missing PDFs](./missing-pdfs.md) · [Citations and bibliography styles](./citations.md)
