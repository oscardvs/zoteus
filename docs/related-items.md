# Related items from citations

Zotero lets you link two items as "Related", by hand, in the item pane. Zoteus can suggest those links from the citation graph and add the ones you accept.

| Tool | What it does | Hints |
|---|---|---|
| `zotero_suggest_related` | Finds pairs of library items where one cites the other. | read-only |
| `zotero_relate_items` | Links pairs as Related, on both items. | writes, additive only |

## Suggesting

Citations come from OpenAlex reference lists, matched to library items by DOI (the DOI field, or a `DOI:` line in Extra). Each work's OpenAlex id and reference list are fetched 50 DOIs per request, and two items pair up when one's reference list names the other. Scope it with `item_keys`, a `collection_key`, or neither for the whole library (the first `max_items` top-level items, 500 by default, 2000 at most).

Pairs already linked as Related are left out unless `include_existing: true`. `counts` says how much of the scope could be checked: items without a DOI, DOIs OpenAlex does not know, and DOIs not checked because a request failed. A missing pair is not proof that one paper does not cite the other: OpenAlex reference lists are incomplete for some publishers, and Crossref's reference lists are not consulted here.

On this machine's library (2026-11-10), 400 top-level entries gave 147 DOIs, 141 found in OpenAlex, and 163 citation pairs, one of them already linked by hand.

## Linking

`zotero_relate_items` takes `pairs: [{ item_key, related_key }]` (at most 100) and writes the link on both items, as Zotero does. It reads every item before writing anything, so an unknown key refuses the whole call. Each item is patched at the version just read; on a conflict it is read again and the link applied to the fresh copy, so nothing added in between is lost. To remove a link, edit `relations` with `zotero_update_item`.

## How Zotero stores it

An item's `relations` object maps a predicate to one URI or an array of URIs. Related is the predicate `dc:relation`:

```json
"relations": { "dc:relation": ["http://zotero.org/users/19552201/items/B9IKRX2J"] }
```

Read from a real Zotero 10 local API on 2026-11-10; the linked item carries the reverse URI. The URI names the library by its sync identity: `http://zotero.org/users/<userID>/items/<KEY>` for a personal library and `http://zotero.org/groups/<groupID>/items/<KEY>` for a group, never the local API's `users/0`. The local API returns the account id on each record (`library.id`), which is where Zoteus takes it from, or from the cloud key. The local API answers an array even for one URI; the Web API documentation shows a single URI as a plain string. Both forms are read, and a write keeps every other predicate (`dc:replaces` from a merge, for one) and every other URI exactly as they were.

## Where it works

Both tools take `library_type` and `library_id` and work in group libraries. Writes go to the running Zotero desktop app (Zotero 10 or newer) for your own library and every group it holds, and to the cloud Web API otherwise. A personal library that has never synced to a zotero.org account cannot be linked: Zotero names it by a local id that neither API exposes, so `zotero_relate_items` refuses rather than write a link that points nowhere. Suggestions need network access to OpenAlex.

[Scholarly context](./scholar.md) · [Safe writes](./writing.md)
