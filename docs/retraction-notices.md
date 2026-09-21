# Retraction and correction notices

`zotero_scholar action:"notices"` reports the **update notices** two free sources hold for a
DOI: retractions, corrections, expressions of concern, errata, withdrawals, removals, new
editions and partial retractions.

It reports records. It never issues a verdict.

## Why there is no `retracted` boolean

Two things were measured against the live APIs while this was built, and both of them rule
out a single flag:

1. **OpenAlex sets `is_retracted` on retraction notices too.** The Wakefield retraction notice
   (OpenAlex `W4245876183`) is `type: "retraction"` and `is_retracted: true`. A consumer that
   reads the flag without the work type reports the notice as the offence.
2. **Publisher-deposited notices can simply be wrong.** `10.1016/s2468-2667(23)00083-x` is
   itself titled "RETRACTED: Addressing hearing loss at all ages", and its Crossref
   `update-to` claims to retract three unrelated DOIs, one of which is the Lancet dementia
   Commission. OpenAlex therefore flags the Commission `is_retracted: true`. The Commission
   has not been retracted.

The two sources also disagree at scale: roughly 135,000 works carry OpenAlex's
`is_retracted` against roughly 75,000 Crossref retraction notices. A tool that reconciled
them into one boolean would be misstating coverage by about a factor of two, and a false
retraction label on a named researcher's paper is not a rounding error.

So the answer is a list of records with their provenance, and the reader opens the notice DOI.

## The sources

| Source | What it contributes | Credentials |
| --- | --- | --- |
| Crossref `/works/{doi}` | `updated-by` and `update-to`: the notices publishers deposited, **including the Retraction Watch database**, which arrives as `source: "retraction-watch"` with its own `record-id` | none, `mailto=` only |
| OpenAlex `/works/doi:{doi}` | its own `is_retracted` flag and the work `type` | none; `ZOTEUS_OPENALEX_API_KEY` is optional |

Retraction Watch needs no separate integration and no licence: Crossref redistributes it.

Both sources are asked **in parallel on the happy path**. `lookup` only reaches Crossref when
OpenAlex throws, which would make `updated-by` unreachable for any DOI OpenAlex knows, so
`notices` is one deliberate extra request rather than a fallback.

## What the answer contains

```jsonc
{
  "action": "notices",
  "mode": "doi",
  "doi": "10.1016/s0140-6736(97)11096-0",
  "notices": [
    { "type": "correction", "label": "Correction", "doi": "10.1016/s0140-6736(04)15715-2",
      "date": "2004-03-06", "source": "retraction-watch", "recordId": "17269" },
    { "type": "retraction", "label": "Retraction", "doi": "10.1016/s0140-6736(10)60175-4",
      "date": "2010-02-06", "source": "retraction-watch", "recordId": "4036" }
  ],
  "isNoticeFor": [],                       // non-empty when THIS DOI is itself a notice
  "openalex": { "isRetracted": true, "workType": "article" },
  "sources": [
    { "name": "crossref", "reached": true, "found": true },
    { "name": "openalex", "reached": true, "found": true }
  ],
  "disagreement": false,
  "coverage": "Coverage: two sources, both of DOI-registered records only...",
  "checkedAt": "2026-09-14T20:00:00.000Z"
}
```

Three rules hold the shape together.

**A source that did not answer is never folded into "nothing found."** It comes back as
`reached: false` with its HTTP status, and the summary says so in those words. If neither
source answered, the call is an error rather than a result with an empty `notices` array,
because an empty array reads as "clean" however carefully the rest is worded.

**Absence is the absence of a deposited record.** The `coverage` paragraph ships inside every
answer, not only here: a journal that never deposited a notice is invisible to both sources,
neither covers literature without a DOI, and the two disagree with each other.

**Disagreement is reported, not resolved.** `disagreement: true` when both sources answered
with a record, the DOI is not itself a notice, and exactly one of them indicates a retraction.
Neither source is preferred.

`found: false` with `status: 404` means that source has no record of the DOI at all, which is
a different sentence from `reached: false` and is written differently.

## Checking the library

```
zotero_scholar { "action": "notices", "library_scan": true }
```

Pages the library once, collects the DOIs it holds, and checks them in batches (50 per
OpenAlex query with the OR-pipe filter, 40 per Crossref query). Only items a source reported
something about come back, each with its `itemKey`.

Because "nothing to report" and "never checked" look identical in a short list, the answer
carries the counts that tell them apart:

- `scan.scanned` / `scan.totalResults` / `scan.complete`: how much of the library the crawl saw.
  `complete: false` means part of the library was never looked at.
- `scan.withDoi` / `scan.checkedDois` / `scan.truncatedDois`: items carrying a DOI, DOIs
  actually queried, and whether the per-sweep cap (2000 DOIs) cut some.
- `sources[].checked` / `sources[].asked`: DOIs each source actually answered for. A failed
  batch leaves its DOIs unchecked, and the summary says how many.
- `unqueryable`: DOIs containing a character the batch filters use as a separator. Not checked.

The result comes back through `okLibraryContent()` because it echoes item titles, which are
library-authored text.

## Citation context

`action: "citations"` with `include_in_library: true` now puts `libraryItemKey` on every
citing work the library already holds. That key is the way into the passages:

```
zotero_scholar  { "action": "citations", "doi": "<retracted DOI>", "include_in_library": true }
zotero_get_fulltext { "item_key": "<libraryItemKey>", "query": "<the retracted paper's claim>" }
```

`zotero_get_fulltext` ranks passages against the query and returns each with its surrounding
context, so "what did this citing paper actually say about the retracted one" is answerable
for the papers already in the library, at no extra HTTP.

**Not implemented:** textual citation context for papers *outside* the library. The sentence
around a citation ("citances") is only available from Semantic Scholar's `contexts` field,
which is not dependable without an API key: a probe returned empty `contexts` arrays on the
first unauthenticated request and HTTP 429 on the second. That needs a key, a new client and a
new outbound host in PRIVACY.md.

## What this is not

`zotero_search_items` with `qmode: "everything"` will match a publisher's "RETRACTED:" title
prefix on items already synced. That is a string match over whatever text the library happens
to hold, it misses every notice not written into a title, and it is not a substitute for this
check.
