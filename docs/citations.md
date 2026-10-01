# Citation pipeline

M5 adds an (account-free where possible) import-and-cite pipeline: four tools.

## `zotero_import` — add by identifier or URL
Resolves bibliographic metadata and optionally saves it to your library.
- `by_identifier` — a **DOI, ISBN, PMID, arXiv id, or ADS bibcode**.
- `by_url` — scrape a web page (may return multiple choices to pick from).
- `save_to_library: true` (optional `collection_key`) persists the resolved items; otherwise the metadata is returned without saving. Saves go to the running Zotero desktop app when it is available — no cloud key needed — and to the cloud Web API otherwise (see [`writing.md`](./writing.md)). `collection_key` accepts an 8-char collection key or a Zotero `treeViewID` like `"C20"`.
- `attach_url` (with optional `attach_title`) downloads a file — e.g. the arXiv PDF — and stores it on the imported item, on **every** save path: streamed into the save session on the connector path, stored as a child attachment right after the save on the Zotero 10 local-API path, and pushed into Zotero file storage on the cloud path (which is the only path a remote or hosted Zoteus has). If the download or the upload fails the import still succeeds and the response carries a `warning`.

A reachable **Zotero translation-server** is the primary resolution path. Without one, DOIs and arXiv ids still resolve through built-in fallbacks (OpenAlex/Crossref and the arXiv API — the result carries a `source` field; see [`resolver.md`](./resolver.md)); ISBN/PMID/bibcode and URL scraping need the server, and the tool returns setup instructions instead of failing:

```bash
docker run -d -p 1969:1969 zotero/translation-server
# then (optional) set ZOTEUS_TRANSLATION_SERVER_URL if not on the default port
```

## `zotero_styles` — resolve CSL styles
- `resolve` maps a human name ("APA 7th", "IEEE", "Vancouver", "Chicago", "MLA", "Nature", …) to a valid CSL id and confirms it can be fetched.
  Long names work as well, including the titles Zotero lists styles under: "Chicago Manual of Style 17th edition (author-date)" resolves to `chicago-author-date-17th-edition`, and "American Psychological Association 7th edition" to `apa`. A past edition the CSL repository still carries (Chicago 16th and 17th, APA 6th, AMA 10th) resolves to that edition's own style, not to the current one. A name it cannot read is tried as a CSL id as given.
- `list` returns the built-in common aliases. Any id from the [CSL styles repository](https://github.com/citation-style-language/styles) works too. Dependent styles are resolved to their independent parent automatically.

## `zotero_format_bibliography` — citeproc, any style, no library needed
Formats a bibliography with **citeproc-js** over either `items` (arbitrary CSL-JSON, e.g. from `zotero_import`) or `item_keys` (library items, exported to CSL-JSON first over the same route as every other library read, so a library the desktop app serves needs no cloud key). Pick `style` (name or id, default `apa`), `locale` (default `en-US`), and `format` (`html`/`text`/`rtf`). Styles and locales are fetched from the CSL CDN and cached.

## `zotero_bibliography` — server-rendered (library items)
Asks Zotero to render a bibliography for library `item_keys` in a CSL style (`format=bib`). The request follows the library's read route: the desktop app renders it for a library it serves (Zotero 10 honours `style`, `locale` and `linkwrap` locally, fetching a style it lacks from the repository), so no cloud key is needed there; any other library is rendered by the Web API. Item-only and capped at 150 items. For arbitrary items or styles, use `zotero_format_bibliography`.

### Which bibliography tool?
- Items **in your library**, quick render → `zotero_bibliography`.
- **Arbitrary** CSL-JSON, items not in the library, or full control of output format → `zotero_format_bibliography`.
