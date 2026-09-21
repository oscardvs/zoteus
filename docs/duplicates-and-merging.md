# Duplicates: finding them, and merging them

Two tools share one idea of what a duplicate is: `zotero_import` with `check_duplicates:true`
(before a record is saved) and `zotero_merge_items` (after two records already exist).

## What "duplicate" means here

An **exact comparison of normalised identifiers**, in this order, first hit wins:

| Matched on | Compared as |
| --- | --- |
| `doi` | the bare DOI, doi.org prefix stripped, lowercased |
| `isbn` | digits and a trailing X only, so hyphenation never splits two copies |
| `title` | lowercased, accents folded, punctuation dropped, whitespace collapsed, plus the year |

A title match additionally requires the two years to be within one of each other, when both
records carry one: the ordinary same-title duplicate is a preprint in one year and the
journal version in the next, while two papers sharing a title a decade apart are usually
different works. When either record has no year there is nothing to check, so the match is
reported only when the title runs to at least four words or the two records share a creator
surname; a year-less record titled "Introduction" would otherwise match every "Introduction"
in the library. Such a match carries a `caveat` saying which side had no year and what the
match rests on instead.

This is **not fuzzy matching**. A duplicate whose title differs by one word, or a preprint
saved with no DOI next to a published article that has one, is not found. The reason is that
neither Zotero API can filter on a field: the comparison happens client-side, against a
census of the library, so it can only be as good as the strings themselves. A match that is
reported is a real match; "no match" means "nothing matched these three rules".

The census walks up to 5000 top-level items (one request per 100), which is why every caller
opts in. When it stops early, the answer says so: `duplicateScan.complete:false` plus a note
naming how much was covered. Treat a `false` there as "unknown", not as "no".

## Checking before you import

```json
{"action":"by_identifier","identifier":"10.1038/nature14539","check_duplicates":true}
```

reports `duplicates: [{item_key, title, matchedOn, value, candidate}]` and saves nothing.

With `save_to_library:true` as well, a match **refuses the save** and names the matching
keys. Pass `allow_duplicate:true` to save anyway (for a deliberate second copy, e.g. in
another collection). A duplicate check that could not run at all also refuses the save,
because a condition that was never evaluated is not a condition that was met.

Nothing changes for a call that does not pass `check_duplicates`.

## Merging two records

`zotero_merge_items` **previews by default**. `dry_run` unset or `true` writes nothing and
returns the plan:

- `plan.fields`: only fields the master is **missing**, with the value and the duplicate it
  would come from. A field the master already has is never overwritten, at all. Trashing is
  reversible; an overwritten abstract is not.
- `plan.fieldsSkipped`: values deliberately left behind, e.g. a `publisher` on a book being
  merged into a journal article, which the master's item type has no field for.
- `plan.tagsAdded`, `plan.collectionsAdded`, `plan.relationsAdded`
- `plan.childrenToMove`: the child notes and attachments that would be reparented
- `plan.duplicatesToTrash`
- `versions`: the master's, each duplicate's and each child's version the plan was computed
  from, which is how you approve **this** plan rather than a later one (below).

Pass `dry_run:false` to run it, in this order: one PATCH on the master carrying the unioned
fields, tags, collections and relations; one PATCH per child setting `parentItem` to the
master; then the duplicates are **trashed** (`deleted:1`), never deleted outright, so the
Zotero trash is the undo.

**Pass the preview's `versions` block back as `expect_versions`** on that call:

```json
{"master_key":"ABCD1234","duplicate_keys":["EFGH5678"],"dry_run":false,
 "expect_versions":{"master":3,"duplicates":{"EFGH5678":5},"children":{"IJKL9012":7}}}
```

The write is computed from a fresh read, and without `expect_versions` nothing ties that
read to the preview: if someone edited a duplicate in between, it is trashed with the edits;
if they moved a note under it, the note is moved again; and the answer's `plan` differs from
the preview with no flag. With `expect_versions`, any named record that is not at that
version, and any child that has appeared under a duplicate or left one, stops the write
before it starts: nothing is written, the answer is the plan as it now stands (`dryRun:true`),
and `changed` names each record that moved. Review it and pass its `versions` back to run it.
Without `expect_versions` the write behaves as before and plans from the records as they are
at call time.

If a step fails, the answer says exactly what landed. A master that could not be updated
stops the merge before anything is trashed. A child that could not be reparented keeps its
duplicate **out of the trash**, so the child is not trashed along with it.

The master records `dc:replaces` relations naming every item it absorbed. That is the same
predicate Zotero's own merge writes (`Zotero.Relations.replacedItemPredicate`), so the trace
survives a sync and is visible to the desktop client.

### What it does not do

- It does not run on the desktop local API. The write path needs a versioned PATCH, which
  only the cloud Web API offers, so applying a merge needs `ZOTERO_API_KEY`. The preview
  works without one.
- It does not set the master's `dateAdded` back to the earliest of the group, as the Zotero
  client's own merge does.
- It does not deduplicate attachments: Zotero's client compares file hashes and folds two
  copies of the same PDF together, while this moves every child across and leaves both.
- It does not update the search index. A merged-away item stays in `zotero_semantic_search`
  results until the next `zotero_index action:"update"`.
- Tags and collections are read, unioned and written back whole, because PATCH replaces an
  array rather than merging it. A tag added by the desktop app between the read and the
  write is lost.
