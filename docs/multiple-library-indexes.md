# Several library indexes in one data directory

Zoteus keeps a semantic-search index per library, in one data directory, and can answer a
single query across more than one of them.

## One store holds one library

A passage in the index is identified by `<itemKey>#<n>`, and Zotero item keys repeat across
libraries: `ABCD1234` in a group is a different item from `ABCD1234` in your personal
library. Two libraries in one store would therefore alias each other's passages, silently.
So each library gets its own index file, and a search over several libraries fans out over
those files and merges what comes back. Nothing is merged inside a store.

Each index stamps the library it holds. A build or update for a different library is
refused rather than allowed to erase the rows that are there (`zotero_index action:"status"`
reports the stamp as `library`).

## Where the files live

| Library | File |
| --- | --- |
| The one this data directory was already indexing | `search-index.json` (unchanged) |
| The same, in hosted mode | `search-index-<zoteroUserId>.json` (unchanged) |
| Any other library | `search-index-lib-user.json`, `search-index-lib-group-<id>.json` |

The first row is the compatibility rule: an index built by an earlier version stays exactly
where it is, under exactly its old name, and needs no migration. That holds whether the
library it holds is your personal library or (on a `ZOTERO_LIBRARY_TYPE=group` install) a
group: the file is keyed by the library it actually holds, not by what the configuration
says today.

The SQLite database sits beside each JSON path under the same name, as it always has.

Group tokens are written `group-4523` in a filename rather than `group:4523`, because a
colon is illegal in a Windows filename.

In hosted mode every path keeps the `<zoteroUserId>` segment. Two tenants who both belong to
group 4523 index it through different Zotero keys and may see different subsets of it, so
they never share a file, and neither can list or open the other's.

## Building a second library

```
zotero_index action:"build" library_type:"group" library_id:4523
```

`library_type`/`library_id` pick the FILE, not just the crawl: this builds, updates and
reports that group's own index, beside the default library's. `action:"update"`,
`action:"status"`, `action:"stop"`, `action:"pause"` and `action:"resume"` take the same
arguments and address the same file.

`action:"status"` for a library with no index says so and creates nothing.

```
zotero_index action:"libraries"
```

lists every library that has an index here, with its passage/item/vector counts, its stamp,
its state and where its file is. It starts nothing.

## Searching across libraries

```
zotero_semantic_search q:"error bars in ecology" libraries:["user", "group:4523"]
zotero_semantic_search q:"error bars in ecology" libraries:"all"
```

`"all"` means every library that has an index here, not every library you can reach. Entries
are spelled `user`, `group:<id>`, `group-<id>`, or a bare numeric group id.

Each hit carries `library` (which library it came from) and `libraryRank` (its position
within that library's own answer). The result also carries a `libraries` array with one row
per library that was looked at, including the ones that could not be searched and why.

A library named here that has no index is reported with the command that would build it.
Nothing in a combined search starts a build.

### What "merged" means, exactly

**Merged by rank, never by score.** Each index scores against its own library's statistics
(BM25 is a function of that library's document frequencies), and the two may hold vectors
from different embedding models. Scores from two indexes are therefore not on one scale, and
Zoteus does not add, average or sort them together. The merge interleaves by rank: the best
hit from each library, then the second best from each, and so on.

`score` on a hit is the score its own index gave it, and it is only comparable with other
hits from the same library.

Two consequences are reported rather than smoothed over:

- **Different embedding models.** When the indexes searched hold vectors produced by
  different models, the result carries `embedderMismatch` naming them, and the summary says
  so. Their vector rankings are answers from different models; nothing on this side makes
  them one ranking. Rebuild with one `ZOTEUS_EMBEDDING_MODEL` to compare like with like.
- **One library with vectors, another without.** The summary names the libraries whose rows
  were ranked by keyword alone while others also used vector similarity.

A single-library search is unchanged: no `library`/`libraryRank` on the hits, no `merge`, and
the one library it answered from named once at the top level.

## How many indexes are held open

`ZOTEUS_INDEX_MAX_OPEN` (default 4) bounds how many indexes are open at once. Each open index
is a SQLite handle, a write-ahead log and, on the JSON backend, a resident copy of every
passage. When the bound is reached the least recently used index is saved and closed; the
next call that needs it reopens it, which costs a reopen and nothing else.

Two indexes are never closed to make room: the default library's, which the rest of the
server holds a reference to, and any index with a build running. If those are the only ones
left, the bound is exceeded rather than enforced.

Closing is also how a shutdown checkpoints SQLite's write-ahead log, and every library's
index is closed on shutdown, not just the default one's.

## Limits worth knowing before you build several

- **A second library is a second full embedding bill** with an API embedding provider, and a
  second full crawl either way.
- `ZOTEUS_INDEX_MAX_ITEMS` is per index, not per data directory.
- Automatic repair of an unreadable index (`zotero_index action:"build"` deleting the file
  the fault named) covers the default library's index only. For another library's index the
  tool names the files and asks you to remove them by hand, rather than deleting a file it
  was not asked about.
