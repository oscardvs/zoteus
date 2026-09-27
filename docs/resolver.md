# Import resolution & the built-in fallback

`zotero_import` resolves bibliographic metadata for identifiers and URLs so you can
save items without hand-typing metadata. Resolution has two paths:

| Input | translation-server reachable | translation-server down |
|---|---|---|
| DOI (`10.…`) | translation-server | **built-in** (OpenAlex → Crossref) |
| arXiv id (`YYMM.NNNNN`) | translation-server | **built-in** (export.arxiv.org Atom) |
| ISBN / PMID / ADS bibcode | translation-server | ✗ needs the server |
| Web page URL | translation-server | ✗ needs the server |

## Why there is a built-in fallback

The official `zotero/translation-server` Docker image is published for
**linux/arm64 only**. On amd64/x86_64 hosts (most VPS, older laptops) it fails at
container start with `exec format error`, so anything depending on it breaks.
DOI/arXiv resolution can be done with plain HTTP against public APIs, so Zoteus
does that itself rather than fail the whole tool.

## Built-in resolution

Started when the translation-server is unreachable **or** when it returns no
record for a DOI/arXiv identifier. Outputs Zotero item-data; the result carries a
`source` field (`"arxiv"` or `"scholar"`).

### arXiv ids → `preprint` (or `journalArticle` with a journal_ref)

`GET https://export.arxiv.org/api/query?id_list=<id>&max_results=1`

The arXiv record itself is the source of record (arXiv publishes no preferred
journal version for an id), so the feed's own title/authors/published date are
used directly. When the record includes a `journal_ref`, the item is typed
`journalArticle` and the arXiv id is kept in `extra` (`arXiv:NNNN.NNNNN`) for
traceability. Abstracts are capped at 2000 chars.

### DOIs → `journalArticle` (or keeps arXiv preprint-ness)

Uses the same scholar providers as `zotero_scholar` (`src/features/scholar/`):
OpenAlex primary, Crossref fallback. `fromScholarWork` picks the item type from
OpenAlex's own work type (`article` is a `journalArticle`, `conference-paper` a
`conferencePaper`, and so on; an unknown type is a `document`), then maps title,
authors, the venue (into the type's own container field: `publicationTitle`,
`proceedingsTitle`, `bookTitle` or a preprint's `repository`), the full
publication date, volume, issue, pages, ISSN and a publisher landing page when it
is not just `doi.org` (#89). A field the item type does not accept is left out
rather than sent, because Zotero refuses the whole item over one unknown field.

## Explicit conventions (documented, not encoded)

- **DOI for arXiv**: when an arXiv record carries a DOI, put it in the item's
  `DOI` field, not `extra` — the arXiv id lives in `extra` (`arXiv:…`), keeping
  one canonical, resolvable identifier per field.
- **string discipline**: `itemType` (and all single-value fields) are plain
  JSON strings, never `{"itemType": "report"}`-style nested objects. The server
  additionally *repairs* nested wrappers when it detects them
  (`src/schema/item-payload.ts`), but emitted payloads should be flat.
- **preprint demotion**: a client-specified `itemType: "preprint"` is demoted to
  `journalArticle` by `foldSpec` when the fetched record shows a published venue
  (journal name), because the arXiv id already marks it as a preprint in `extra`.

This is a best-effort fallback, not a replacement for Zotero translators: it
handles the two most common identifiers and deliberately does not scrape web
pages (disambiguation, paywalls, site rules). When you need that, run a
translation-server.

## Rate limiting

arXiv asks for at most ~1 request per 3 seconds. Zoteus paces its arXiv calls
accordingly and backs off on HTTP 429/503 (honouring `Retry-After`). If arXiv
keeps throttling even after back-offs, the tool says so explicitly —
"arXiv is rate-limiting us … wait a minute and retry" — instead of claiming the
id does not exist. When importing a long list of identifiers, just retry the
failed ones a little later.

## Running translation-server

```sh
# arm64 (Apple silicon, arm64 VMs):
docker run -d -p 1969:1969 zotero/translation-server

# amd64: Docker Hub has no amd64 image. Build it:
git clone https://github.com/zotero/translation-server && cd translation-server
docker build -t translation-server .
docker run -d -p 1969:1969 translation-server
```

Point Zoteus at it with `ZOTEUS_TRANSLATION_SERVER_URL` (default
`http://127.0.0.1:1969`). The `/web`, `/search`, and `/export` endpoints are used
when available.
