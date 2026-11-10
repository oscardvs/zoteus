# Screening and review teams

Three tools support a team doing a systematic review in a shared Zotero group library:

| Tool | Writes? | What it does |
| --- | --- | --- |
| `zotero_review` | no (`readOnlyHint: true`) | The screening queue, the status of the screen, the PRISMA flow, and the duplicates inside the review collection |
| `zotero_screen_items` | yes, tags only (`destructiveHint: true`, because changing a decision replaces the earlier tag) | Records include / exclude / maybe decisions as Zotero tags |
| `zotero_activity` | no | What was added, changed, highlighted and annotated in the last N days, and by whom |

Every one takes `library_type: "group"` and `library_id` (from `zotero_groups`) like the
other tools, and works the same on the desktop local API and the cloud Web API, except where
the table at the end says otherwise.

## Decisions live in Zotero, as tags

Zoteus keeps no screening database. A decision is an ordinary Zotero tag on the item, so it
syncs to everyone in the group, shows in Zotero's tag selector, can be filtered and colour-coded
there, and stays readable if you stop using Zoteus.

```
screen/<stage>/<decision>[:<reason>][@<reviewer>]
```

| Part | Values |
| --- | --- |
| stage | `title-abstract`, `full-text` |
| decision | `include`, `exclude`, `maybe` |
| reason | only on `exclude`; a lowercase slug, e.g. `wrong-population` |
| reviewer | a lowercase slug, e.g. `alice`; **absent on the final decision** |

Examples:

- `screen/title-abstract/include`: the final title-and-abstract decision is include
- `screen/title-abstract/exclude:wrong-population@alice`: Alice excluded it, for that reason
- `screen/full-text/include@bob`: Bob's full-text decision
- `screen/full-text/exclude:no-outcome-data`: the final full-text exclusion and its reason

Reasons and reviewer names are slugged on the way in: "Wrong population" becomes
`wrong-population` and "Alice B." becomes `alice-b`. Agree a fixed list of exclusion reasons
before you start, because the PRISMA diagram counts them by exact slug.

A tag that starts with `screen/` but does not fit the shape (say `screen/ta/yes`) is never
rewritten or removed; `zotero_review action:"status"` lists it under `malformedTags` so you can
fix it by hand.

### Single screening and dual (independent) screening

- **One screener:** call `zotero_screen_items` without `reviewer`. Each decision is final.
- **Two or more independent screeners:** each passes their own `reviewer`. Each reviewer's
  queue (`zotero_review action:"queue", reviewer:"alice"`) contains only records that reviewer
  has not decided, and it never shows what the others decided, so screening stays blind.
  When reviewers disagree, `action:"status"` lists the record under `disagreements`; someone
  resolves it by recording a final decision (no `reviewer`), which leaves the reviewers' own
  tags in place as the audit trail.

### How tags become an outcome

For each record and stage:

1. A final tag (no `@reviewer`) is the outcome.
2. Otherwise, reviewer tags that all give the same decision are the outcome (reported with
   `source: "reviewers"`).
3. Reviewer tags that differ are a **conflict**.
4. No tag is **pending**.

`maybe` is counted on its own, and PRISMA treats it as still awaiting a decision.

A record enters full-text screening when its title-and-abstract outcome is `include`, or when
it already carries any full-text tag (so a team that only tags the second stage is still
counted).

### What a write changes

`zotero_screen_items` reads each item, removes the screening tag for **the same stage and the
same reviewer** (or the same final slot) if there is one, and adds the new one. Your own tags,
tags for the other stage, other reviewers' tags and malformed `screen/` tags are never
touched. Recording the decision an item already carries writes nothing (`unchanged: true`).
Up to 100 items per call; the bulk-write threshold (`ZOTEUS_CONFIRM_BULK_WRITES`) applies like
any other write. Writes go to the running desktop app (Zotero 10+) for every library it holds,
otherwise to the cloud with a key that can write the group.

## `zotero_review`: queue, status, PRISMA, duplicates

All four views read the top-level records of one collection (`collection_key`, subcollections
not included). Standalone notes and attachments in the collection are not records. One call
reads up to 5000 records; a larger collection answers with `complete: false` and a `note`.

### `action: "queue"`

```json
{"action":"queue","collection_key":"ABCD2345","stage":"title-abstract","reviewer":"alice","limit":25,
 "library_type":"group","library_id":5234875}
```

Returns `queue: [{key, title, year, authors, abstract, itemType}]` sorted by title, plus
`queued` (how many wait in total). Recording decisions removes records from the queue, so the
next batch is again `start: 0`. Without `reviewer`, the team queue holds pending records and
unresolved conflicts (flagged `conflict: true`).

### `action: "status"`

Per stage: `records`, `include`, `exclude`, `maybe`, `conflict`, `pending`, and exclusion
`reasons`. Also per-reviewer tallies, `agreement` for each pair of reviewers who screened the
same records (percent agreement and Cohen's kappa over include / exclude / maybe; kappa is
`null` when it is undefined, e.g. both reviewers only ever said include), the first 100
`disagreements` with each reviewer's decision and whether a final tag resolved it, and
`malformedTags`.

### `action: "prisma"`

Returns the PRISMA 2020 flow numbers, a plain-text version ready to paste, and a Mermaid
`flowchart TD` you can drop into Markdown:

| Field | Meaning |
| --- | --- |
| `recordsIdentified` | What your searches returned. From `records_identified`, else the sum of `sources`, else records in the collection plus duplicates removed (`identifiedFrom` says which) |
| `duplicatesRemoved` | From `duplicates_removed`; else derived as identified minus records in the collection; else the number of records merged away, read from the `dc:replaces` relations that Zotero's own merge and `zotero_merge_items` leave on the kept record; else `null` (unknown). `duplicatesFrom` says which |
| `duplicatesStillInCollection` | Records beyond one per work that the duplicate check still finds in the collection; merge them before reporting |
| `recordsScreened`, `recordsExcluded` | Title-and-abstract include + exclude, and exclude |
| `reportsSought`, `reportsAssessed`, `reportsExcluded`, `reportsExcludedReasons` | Full-text stage |
| `studiesIncluded` | Full-text include |
| `recordsAwaitingScreening`, `reportsAwaitingAssessment` | Pending, conflicting and maybe records: the flow is not final while these are above zero |

Zotero cannot know how many records a database export contained before you imported it, so
pass `sources` (e.g. `{"PubMed": 412, "Scopus": 380, "Web of Science": 297, "Embase": 350}`)
for an exact first box. "Reports not retrieved" is not tracked: there is no tag for it.

### `action: "duplicates"`

For the "I imported exports from four databases into one collection" case. Groups records in
the collection that are the same work by the same exact rules as every other duplicate check
in Zoteus (identical DOI, then ISBN, then normalised title with years within one; see
[Duplicates and merging](./duplicates-and-merging.md)). It is not fuzzy matching: a record
with a mistyped title and no DOI is not found. Matches are joined transitively, so three
copies are one group of three. Each group names a `suggestedMaster` (the copy with the most
child items such as PDFs and notes, then the oldest), to pass as `master_key` to
`zotero_merge_items`. Nothing is merged by this view.

## `zotero_activity`: what happened this week

```json
{"days":7,"collection_key":"ABCD2345","library_type":"group","library_id":5234875}
```

Lists what was added or modified in the last `days` days (default 7, at most 365), newest
first, split into `items` (papers and attachments), `notes` (with the first 300 characters of
text) and `annotations` (type, highlighted text, comment, colour, page label, and the paper it
belongs to). Each row says whether it was `added` or `modified` in the window. With
`collection_key`, only items in that collection and their notes, attachments and annotations
are kept. It reads at most the 1000 newest changes; past that, `complete: false`.

In your own library this is a "what did I read and mark this week" view.

**Who did it.** For a group library, the cloud Web API reports `meta.createdByUser` and
`meta.lastModifiedByUser` on each item, so when a cloud API key can read the group the activity
is read from the cloud and each row carries `createdBy` and `modifiedBy`, with `byUser` totals.
Changes made in a desktop app appear there once it has synced. The desktop local API does not
report who made a change (checked against Zotero 10.0.8: its item `meta` holds only
`creatorSummary`, `parsedDate` and `numChildren`), so a group read without a usable cloud key
has no names, and `attribution: "unavailable"` says so.

**Not available: "Recently Read".** Zotero 9 added a Recently Read view built from the last
time an attachment was opened. That timestamp lives in a column of the desktop app's own
database that neither the local API nor the Web API includes in any response, so Zoteus
cannot read it. Annotation activity is the closest signal either API offers.

## What works where

| | Desktop local API | Cloud Web API |
| --- | --- | --- |
| Queue, status, PRISMA, duplicates | yes, in the personal library and every group the app holds | yes |
| Recording decisions | yes (Zotero 10+, after the one-time write grant) | yes, with a key that can write the group |
| Activity: items, notes, annotations | yes | yes |
| Activity: who made each change (groups) | no | yes |
| Recently Read | no | no |
