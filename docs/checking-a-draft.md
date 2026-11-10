# Checking a draft's citations

`zotero_check_citations` answers two questions about a draft, without a language model and without changing anything in Zotero:

1. Is every work the draft cites actually in your library?
2. Does every direct quotation actually appear, word for word, in the source it is attributed to?

It does **not** answer whether a source supports a paraphrased claim. That needs reading for meaning, which the server cannot do. The report says so in every answer, and points the calling model at `zotero_get_fulltext` with a `query` to read the passage before asserting support.

## What it recognises

| Form | Example |
|---|---|
| Pandoc | `[@smith2020, p. 12; see @jones2019]`, and `@smith2020` in prose |
| Zotero item key | `[@ABCD2345, p. 12]` (the form `zotero_create_note` writes) |
| LaTeX | `\cite{a,b}`, `\citep[p.~4]{c}`, `\citet`, `\parencite`, `\textcite`, `\autocite`, `\footcite` |
| Author-year | `(Smith, 2020)`, `(Smith & Jones, 2020, p. 4; Lee 2019)`, `Smith et al. (2020)` |
| Numeric | `[3]`, `[1, 4-6]`, resolved through the reference list |
| DOI | `10.1109/LRA.2023.3243526` anywhere in the text |

Code spans, code blocks and LaTeX verbatim environments are skipped. Markdown links `[text](url)` and footnotes `[^1]` are not citations.

The reference list is read from `references` when you pass it, otherwise from a trailing section headed "References", "Bibliography", "Works Cited" or `\begin{thebibliography}`. Entries may be numbered (`[1]`, `1.`, `\bibitem`) or one per line or paragraph. From each entry the tool reads a DOI, the first author's surname, the year and the title words.

## How a cited work is looked up

In this order, stopping at the first that applies:

- **Item key**: an eight-character key is read directly. A note, attachment or annotation is reported as not citable.
- **Citation key**: Zotero 8 and later have a native Citation Key field; the tool searches for the key and keeps only items whose field is exactly that key. When nothing matches and the desktop app runs Better BibTeX, its keys are asked as well.
- **DOI**: searched across all fields and compared case-insensitively, also against a `DOI:` line in Extra.
- **Author and year**: items whose creators include the surname (accents ignored) and whose date has that year. When several fit and the reference list gives a title, the title words decide if one item clearly wins.

Each work comes back `matched` (with the item key, title, short citation and `matchedBy`), `ambiguous` (up to five `candidates`; cite one by `[@ITEMKEY]` to settle it), `not_in_library`, or `unresolved` (a numeric citation with no reference entry, for example).

## How a quotation is checked

A quotation is text in straight or curly double quotation marks, LaTeX ``` ``...'' ``` or `\enquote{}`, a Markdown block quote (`>` lines) or a LaTeX `quote` environment, of at least four words, next to a citation in the same sentence: right before it (`"..." (Smith, 2020, p. 4)`) or right after it (`Smith (2020) writes "..."`). A block quote belongs to a citation on its last line or the line right after it.

Both the quotation and the source are normalised the same way before comparing: Unicode compatibility forms (ligatures such as "fi"), case, all quotation marks, all dashes, words hyphenated across a line break, soft hyphens and runs of whitespace. An ellipsis (`...`, `…`, `[...]`) splits the quotation into parts that must appear in order.

| Status | Meaning |
|---|---|
| `found` | Appears in the source. `page` is exact when the PDF itself was read; `pageApprox` is an estimate from Zotero's indexed text. |
| `close_match` | No exact match, but a passage with at least 0.85 similarity. `sourceText` is what the source really says. |
| `not_found` | Nothing close. `bestSimilarity` says how far off the nearest passage was. |
| `no_fulltext` | The item has no readable PDF or EPUB (no attachment, a scan with no text layer, or a file that cannot be reached). |
| `not_checked` | The citation did not resolve to one library item, or `check_quotes` was false. |

The full text comes from the same machinery as `zotero_get_fulltext`: Zotero's index first, otherwise the attachment file read on the fly. A `pageApprox` should be confirmed with `zotero_get_fulltext` `page_range` before it goes into a manuscript.

## Limits and paging

- The draft is at most 200,000 characters (about 30,000 words).
- Each call checks at most `max_citations` citations (default 60, max 200) and reads at most `max_fulltexts` full texts (default 5, max 20). When either runs out, the answer carries `nextStart`: call again with `start: nextStart` and the same draft. Counts in `summary` cover the citations on that call.

## Desktop and hosted

On the desktop the lookups go to the running Zotero app. On a hosted or cloud-only Zoteus they go to the Zotero Web API, and two things degrade:

- Better BibTeX keys cannot be looked up, because Better BibTeX lives in the desktop app. Keys in Zotero's own Citation Key field still resolve.
- A quotation can be checked only in items whose full text Zotero has synced to the cloud, or whose file is in Zotero cloud storage. A linked file, or one kept only on WebDAV, comes back `no_fulltext` unless Zotero has indexed it.

## The prompt

The `zotero-citation-audit` prompt starts from this tool, then looks up works missing from the library with `zotero_scholar`, then reads passages for paraphrased claims with `zotero_get_fulltext`.
