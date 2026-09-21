# Open-access PDFs

Zoteus can find the free copy of a paper and attach it, using the DOI already on the item.

This is not a way past a paywall. It finds only copies OpenAlex already knows about: arXiv,
PubMed Central and Europe PMC, DOAJ journals, and institutional repositories. When there is
no free copy, it says so in one sentence instead of guessing.

## Finding, without attaching

`zotero_scholar` with `action: "lookup"` reports what it found and writes nothing:

```json
{
  "action": "lookup",
  "doi": "10.1038/nature14539",
  "work": { "title": "Deep Learning", "citationCount": 80000 },
  "oa": {
    "url": "https://arxiv.org/pdf/2501.12345v1",
    "source": "arXiv",
    "version": "submitted",
    "licence": "cc-by",
    "versionCaveat": "This is a submitted manuscript (a preprint), not the published paper: ..."
  },
  "oaChecked": true
}
```

Three answers, kept apart on purpose:

| What you get | What it means |
| --- | --- |
| `oa` present | OpenAlex knows of a free PDF, at that URL, of that version |
| no `oa`, `oaChecked: true` | OpenAlex looked and reports no open-access copy |
| no `oa`, `oaChecked: false` | OpenAlex did not answer and the metadata came from Crossref, which has no open-access verdict. Nobody looked |

The lookup costs no extra request: the open-access block was already in the work object
Zoteus fetches for every lookup.

## Attaching

`zotero_attach_file` with `find_oa: true` and no `url`/`path`:

```
zotero_attach_file { "parent": "ABCD1234", "find_oa": true }
```

It reads the item's DOI (the DOI field, or a `DOI: 10.…` line in Extra for the item types
Zotero gives no DOI field), asks OpenAlex, downloads the PDF, checks that it really is one,
and stores it through whichever write path is available (the Zotero desktop app when it is
reachable, otherwise the cloud Web API).

## Which version you got

An open-access copy is often **not** the publisher's version of record. A green copy in a
repository may be the author's accepted manuscript (the reviewed text, different pagination)
or a submitted preprint (before review at all). Citing a page number from one of those points
at a page that does not exist in the version your reader holds.

So the version travels with the file rather than being flattened away:

- the tool result carries `oa.source`, `oa.version`, `oa.licence` and a `versionCaveat`
  sentence whenever the copy is not the version of record;
- the attachment's **title** in Zotero is written as, for example,
  `Open-access PDF (arXiv, submitted manuscript, cc-by)`;
- the attachment's **URL** field is the link the file came from.

Pass your own `title` to override the generated one.

## What it refuses, and why

Each refusal is a different fact, and none of them is reported as any of the others:

| Situation | What Zoteus says |
| --- | --- |
| The item has no DOI | It records no DOI, so there is nothing to search by. Attach with `url` or `path`, or put the DOI on the item |
| OpenAlex reports the work is closed | No open-access copy of that DOI. Get the PDF through your institution |
| OpenAlex has no record of the DOI | It cannot say whether a free copy exists. Check the DOI |
| OpenAlex returned an error | The provider failed. That is **not** evidence there is no free copy. Retry shortly |
| The item already has a PDF | Nothing is downloaded, and the existing attachment's key is named |
| What the link served is not a PDF | Nothing is attached, and the served content type and byte count are quoted |

That last one is the important one. A sign-in page or a "verify you are human"
interstitial is frequently served with `Content-Type: application/pdf`, and stored as the
item's full text it would then be read as the paper by `zotero_get_fulltext` and indexed by
`zotero_semantic_search`. So the decision is made from the bytes alone: no `%PDF-` header
means no attachment, whatever the server claimed, and the refusal happens before any item is
created, so a rejected candidate leaves the library byte for byte unchanged.

## Operator controls

`ZOTEUS_OA_FETCH` (default `true`) decides whether Zoteus may **download** from the host a
lookup named. Finding and reporting a link is always allowed, so turning it off does not make
discovery go silent: `zotero_scholar` still returns the `oa` block, and `find_oa` still tells
you the URL it found and then declines to fetch it.

Turn it off on a shared deployment where egress to arbitrary hosts is not wanted. Users can
still download the file themselves and attach it with `url` or `path`.

Downloads are bounded whether or not that setting is on: https only, redirects followed by
hand so every hop is re-checked against private address space, and a 64 MB cap enforced while
streaming rather than after buffering. A legitimate file above the cap is still attachable by
hand with `url` or `path`.

There is a clock on them too, and it covers the body, not just the connection: 120 seconds for
the whole download including every redirect, and 30 seconds of silence mid-file before the
host is given up on. A repository that answers instantly and then trickles the file cannot
hold the tool call open; you get a sentence saying which limit was reached, and the link, so
you can fetch it yourself and attach it with `path`.
