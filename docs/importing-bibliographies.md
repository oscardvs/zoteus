# Importing bibliographies and recovering PDF metadata

Two actions on `zotero_import` cover the cases that are not "I have one identifier":

- `action: "by_file"` takes a whole BibTeX, RIS or CSL-JSON bibliography.
- `action: "by_pdf"` takes a PDF and works out what it is from the identifier printed in it.

Neither needs a translation-server. Both return the metadata without writing anything unless
you ask for the write.

## `by_file`: a bibliography you already have

```jsonc
// preview: nothing is written
{ "action": "by_file", "path": "~/Downloads/zotero-export.bib" }

// the same file, saved into a collection, checked against what you already hold
{ "action": "by_file", "path": "~/Downloads/zotero-export.bib",
  "save_to_library": true, "collection_key": "ABCD1234", "check_duplicates": true }

// on a hosted server, where a filesystem path names the operator's disk, not yours
{ "action": "by_file", "text": "@article{…}" }
```

`text` and `path` are alternatives: pass exactly one. `format` (`bibtex`, `ris`, `csljson`)
overrides the sniffer, which recognises BibTeX by its `@type{` entries, RIS by its `XX  - `
tag lines, and CSL-JSON by being JSON.

The result carries `parsed` (entries in the file), `items` (what would be created, when you
did not save), `warnings` (what could not be done exactly), `skipped` (entries that were not
imported, and why), and `format`.

### What the parsers do and do not do

The three formats are parsed by Zoteus itself, in `src/features/import/`. That is a
deliberate choice: the alternative was to require a Zotero translation-server, which is
optional, off by default, published as an arm64-only Docker image (see
[`resolver.md`](./resolver.md)), and unreachable from a hosted deployment. A reachable
translation-server is still tried first, because it is Zotero's own translator set and it
reads formats Zoteus does not (EndNote XML, MODS, RDF); when there is none, or when it does
not recognise the payload, the built-in parser takes it.

BibTeX: entries with `{}` or `()` delimiters, braced, quoted and bare values, nested braces,
backslash escapes, `#` concatenation, `@string` macros including the twelve predefined month
abbreviations, `@comment` and `@preamble` skipping, `--` page ranges, and the LaTeX accent
forms real exports contain (`\"{o}`, `\'e`, `\c{c}`, `\v{r}`, `\H{o}`, `\ss`, `\o`, `\l` and
the rest). Not supported: `crossref` inheritance between entries, user-defined `\newcommand`
macros, and math mode. A `crossref` is reported as a warning on the entry rather than
silently producing a half-filled item.

RIS: `TAG  - value` lines (one to three spaces before the dash), values continuing on
following lines, repeated tags (every `AU` an author, every `KW` a keyword), `ER`
termination, a missing final `ER`, byte-order marks and CRLF. `L1`/`L2`/`L4` local file links
are reported, not fetched.

CSL-JSON: a bare array or an `{ "items": [...] }` wrapper, both CSL date shapes
(`date-parts` and `raw`), and literal names.

### How a field becomes a Zotero field

Every format is parsed into a CSL-shaped record first, then mapped to Zotero item-data using
Zotero's own tables from the global schema (`csl.types`, `csl.fields`, `csl.names` at
<https://api.zotero.org/schema>), which this server already fetches and caches. The
per-item-type field list decides where a variable actually lands: a conference paper's
container title travels through the base field `publicationTitle` to reach
`proceedingsTitle`, and a thesis's publisher reaches `university`, with nothing type-specific
written into Zoteus.

Only the BibTeX-to-CSL and RIS-to-CSL legs are hand-written tables, because nothing publishes
those. An entry type absent from them becomes `document`, Zotero's own name for "some other
kind of thing", and the entry is named in `warnings`.

A field with no home on the chosen item type is written into Extra as `name: value` rather
than dropped, which is where Zotero itself parks what its schema cannot model.

If the schema cannot be fetched (no network), the mapper falls back to a frozen copy of those
tables and the result says `mapping: "snapshot"`. That mode is worse: with no per-type field
list, the first candidate field is taken, so the conference paper above keeps its container
title in Extra.

### Caps and refusals

- More entries than `ZOTEUS_IMPORT_MAX_ENTRIES` (default 200): refused outright, cap named.
  Nothing is written and no entries are returned. Split the file or raise the setting.
- More than 2 MB of payload: refused before parsing.
- `save_to_library` above `ZOTEUS_CONFIRM_BULK_WRITES` (off by default): needs `confirm: true`.
- `check_duplicates: true` compares each entry against the library and refuses a save that
  would add a second copy, unless `allow_duplicate: true`. See
  [`duplicates-and-merging.md`](./duplicates-and-merging.md).
- Every item produced by the built-in parsers is validated against the Zotero schema before
  the write. An entry the schema refuses is listed in `skipped` with the reason, and the rest
  are still saved.

Items carry `resolved:bibtex`, `resolved:ris`, `resolved:csljson` or
`resolved:translation-server-import` in Extra, so where a record came from stays traceable.

## `by_pdf`: metadata for a PDF you already have

```jsonc
// a file on the machine running Zoteus
{ "action": "by_pdf", "path": "~/Downloads/unknown-paper.pdf" }

// a PDF already in the library: the only route that works on a hosted server
{ "action": "by_pdf", "attachment_key": "ABCD1234", "save_to_library": true }
```

It extracts the text of the first pages (`scan_pages`, default 2), looks for a DOI or an
arXiv id, and resolves the strongest hit through the same path `by_identifier` uses.

The result says where the identifier came from, because that is what makes it checkable:

```jsonc
"identifierFound": {
  "type": "doi", "value": "10.1103/PhysRev.28.1049", "page": 1,
  "label": "https://doi.org/", "confidence": "high",
  "context": "Published online 12 December 1926 https://doi.org/10.1103/…"
}
```

`confidence` is `high` when something introduced the identifier (`doi:`, `https://doi.org/`,
`arXiv:`) and `low` for a bare `10.x` string. The distinction matters: a first page routinely
carries DOIs that belong to other works, in a "cite as" block, a footnote or publisher
boilerplate. Every hit is returned in `identifierCandidates`, strongest first, so a wrong
first guess is visible rather than silent. Nothing is saved without `save_to_library`.

### What it cannot do

- **A scanned PDF has no text layer**, so there is nothing to search. The result says so
  explicitly (`textLayer: false`) rather than reporting "no identifier found". There is no
  OCR in this path.
- **No title-based lookup.** A PDF with no DOI and no arXiv id cannot be identified here: the
  scholarly providers Zoteus uses are DOI-keyed. Read page 1 as an image with
  `zotero_pdf_images` and pass what you see to `by_identifier`.
- **Nothing is invented.** When no identifier is found, the call succeeds and reports that it
  found none. When an identifier is found but does not resolve, the call fails and names the
  identifier and its page, so you can check it yourself.
- Files over 20 MB are not parsed (the PDF parser needs several times the file size in
  memory; the same cap applies to `zotero_get_fulltext`).
- `path` is refused on a shared or hosted deployment, where a filesystem path would name the
  operator's disk. Use `attachment_key` there.
