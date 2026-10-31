# Writing to Zotero (safe by design)

Writes go straight to the running Zotero desktop app for every library it holds: your **personal** library, and each **group library** synced into it. On Zotero 10+ that is the app's local-API writes, behind a key you grant once; on Zotero 9 and earlier, whose local API is read-only, the desktop connector protocol takes personal-library creates. No cloud key is needed for those paths. The cloud **Web API v3** is the fallback: for a group the app does not hold, when the desktop app is not running, and while a cloud write to that library is still waiting for the app to sync (it needs a `ZOTERO_API_KEY` with write access). The hard parts (optimistic concurrency, idempotency, batching, and partial-failure handling) are done for you inside the clients.

## Tools

"Route" is the order Zoteus tries: `desktop` means the running Zotero app, for the personal library and for any group library it holds, `cloud` the Web API v3. A group the app does not hold routes to the cloud; see [Group libraries](#group-libraries) below for what each path needs.

| Tool | What it does | Route | Safety |
|---|---|---|---|
| `zotero_create_items` | Create/update up to many items in one batch (auto-chunked to 50). Validates every item against the schema first — if any is invalid, **nothing** is written. | desktop (local-API writes) → cloud | non-destructive |
| `zotero_update_item` | Partial **PATCH** of one item (omitted fields are preserved). Fetches the version if you don't supply it; auto re-fetches and retries once on a 412 conflict. | desktop (local-API writes) → cloud | non-destructive |
| `zotero_trash_items` | Move items to the trash (`deleted:1`) or restore them (`deleted:0`). **Reversible** — the default for "remove". | desktop (local-API writes) → cloud | reversible |
| `zotero_delete_items` | **Permanent** purge. Disabled unless `ZOTEUS_ALLOW_DELETE=true`, and requires `confirm:true` on every call. | desktop (local-API writes) → cloud | ⚠️ irreversible |
| `zotero_manage_collections` | `list` / `create` / `rename` / `reparent` / `delete`, plus `add_items` / `remove_items` (membership lives on the item). | desktop (local-API writes) → cloud | mixed |
| `zotero_manage_tags` | `list`, or `add` / `remove` tags on items (edits each item's tag array). | desktop (local-API writes) → cloud | non-destructive |
| `zotero_saved_searches` | `list` / `create` / `delete` saved-search definitions. The cloud API does not *execute* them. | desktop (local-API writes) → cloud | mixed |
| `zotero_annotate` | Add or delete PDF annotations — highlights, underlines, notes — the same objects the Zotero PDF reader creates. Resolves the PDF attachment from any parent item, or takes an attachment key directly. `delete` needs local-API writes or a cloud key (the connector protocol cannot delete). | desktop → cloud | non-destructive; `delete` **trashes** (reversible) |
| `zotero_create_note` | A note from Markdown, under a paper or standalone in collections. `[@ITEMKEY, p. 12]` becomes a real Zotero citation; a key that names nothing refuses the write. See [Notes](./notes.md). | desktop (local-API writes) → cloud | non-destructive |
| `zotero_append_to_note` | Markdown added to the end of an existing note, inside its container, keeping what is there. Re-reads and re-appends once on a 412 conflict. | desktop (local-API writes) → cloud | non-destructive |
| `zotero_replace_note` | A note's whole text replaced with new Markdown. Returns the old HTML as `previousNote`; pass `version` to refuse rather than overwrite a note that changed. | desktop (local-API writes) → cloud | ⚠️ **destructive** (old text returned) |
| `zotero_save_annotation_digest` | The annotations on a paper or collection saved as one note, laid out like Zotero's "Add Note from Annotations". Its read-only twin, `zotero_annotation_digest`, lists them without writing. | desktop (local-API writes) → cloud | non-destructive |
| `zotero_attach_file` | Store a file (`url`, or `path` on the Zoteus machine) as a stored attachment under an existing item. Returns the new attachment key. | desktop → cloud | non-destructive |
| `zotero_attachment` | `upload` a file as an attachment (standalone, or under `parent_item`), `download` an attachment's file to disk, or `info`. Upload goes through the desktop's own upload endpoint, download reads the desktop's own copy of the file; `target` / `readFrom` say which side was used. | desktop (local-API writes) → cloud | non-destructive |
| `zotero_merge_items` | Fold duplicates into a master: fill the master's empty fields, union tags, collections and relations, reparent the children, trash the duplicates. Previews by default. Plans from, and writes to, one copy of the library (`readFrom`); see [Merging](#merging-duplicates). | desktop (local-API writes) → cloud | duplicates **trashed** (reversible) |

`zotero_import` with `save_to_library:true` also saves through the desktop app (both desktop paths), including `attach_url` to stream a PDF into the same save session and `collection_key` targeting — see [`citations.md`](./citations.md). When the local API answers but rejects every item of a save (Zotero 10.0.3 does this for creates, see #88), the same items go through the connector protocol instead and the result says so (`target` is `"desktop"`, `localApiRejected` carries the rejections); a partial success is never re-sent, because that would duplicate the items that did save. Without a reachable desktop it saves through the cloud, and `attach_url` goes up through Zotero file storage there.

## Group libraries

**Yes, writing to a group library works, and with the desktop app running it needs no cloud key.** Zotero 10's local API takes writes on `…/api/groups/<groupID>/…` exactly as on `…/api/users/0/…` (measured on 10.0.6: collections, items, tags, patches, merges, full text, attachment uploads and downloads, trash and collection delete all landed in a synced group, key-free), so every write tool goes to the desktop for a group the app holds, the same way it does for your personal library. "Holds" means the group is in the app's own group list (`zotero_groups` shows it), which Zoteus reads when the app comes up. The connector protocol is the one exception: it saves into whichever library the app has open, so on Zotero 9 and earlier a group write goes to the cloud.

**Through the desktop app**, a group write needs:

1. **The group synced into the app.** A group you joined since the app last synced is not there yet; Zoteus then sends the write to the cloud, or, with no key, says the app does not hold that group.
2. **Permission to edit the group's library.** The app enforces the group's **Library Editing** setting as synced from zotero.org (and **File Editing** for attachment files). A group that only lets admins edit is refused before anything is written, with a message naming the group and the setting; no key or Zoteus setting overrides it, and the cloud refuses the same account for the same reason, so Zoteus does not try it there.

**Through the cloud** (a group the app does not hold, or no app running), a group write needs all three of these, and each one fails differently:

1. **A cloud API key.** `ZOTERO_API_KEY`, created at [zotero.org/settings/keys](https://www.zotero.org/settings/keys). With no key and no desktop app holding the group, a group write stops before any request and says which of the two is missing.
2. **Write access to that group on the key.** A key's group access is separate from its personal-library access: on the key's settings page, either tick "Read/Write" under **All Groups**, or grant it per group. Zoteus reads the key's own permission map at startup, so a key that is read-only for the group is refused locally, naming the group, and no request is sent.
3. **Permission to edit the group's library on zotero.org.** The key's owner must be a member, and the group's **Library Editing** setting must allow it (a group can be set so only admins may edit). Nothing on the key overrides that, so this one surfaces as an HTTP 403 from Zotero.

### Addressing a group

A group is addressed by its **numeric library id**, which is not the same thing as a collection key:

- **Library id**: the group itself, e.g. `2405685`. Get it from `zotero_groups`, which lists every group the key can reach with its `id`, `numItems` and `libraryEditing`. Pass it as `library_id` (with `library_type: "group"`) to any tool. `library_type: "group"` on its own is **not** enough: without an id Zoteus refuses the call rather than quietly using your personal library.
- **Collection key**: an 8-character key like `ABCD1234`, naming a collection *inside* one library. A collection key from your personal library means nothing in a group. List a group's own collections with `zotero_list_collections` passing the same `library_id`, then use those keys in `collections` on the item, or in `zotero_manage_collections`.

```jsonc
// 1. find the group
// zotero_groups  ->  [{ "id": 2405685, "name": "Review team", "libraryEditing": "members" }]

// 2. list that group's collections (not your own)
// zotero_list_collections
{ "library_type": "group", "library_id": 2405685 }

// 3. create the item in the group, in one of its collections
// zotero_create_items
{ "library_type": "group", "library_id": 2405685,
  "items": [{ "itemType": "journalArticle", "title": "…", "collections": ["ABCD1234"] }] }
```

To make a group the default for every call instead of repeating it, pin it in the environment: `ZOTERO_LIBRARY_TYPE=group` and `ZOTERO_LIBRARY_ID=2405685`. Per-call `library_id` still overrides it.

A write the desktop app took is in the app at once, and reaches zotero.org on the app's next sync. A write that went to the cloud is the other way round: it appears in the desktop app on its next sync, not instantly, since the app pulls it down on its own schedule (or when you hit Sync).

**Reading one back does not wait for that sync.** Reads normally go to the desktop app for any library it holds, which for the interval between a cloud write and the sync would answer that the item does not exist. So Zoteus keeps reads of a library on the API that took the last write to it, until it can see that the desktop app holds that write. Writes to that library stay on the cloud for the same interval: a write sent to the app meanwhile would be invisible to those reads, and would act on a copy that does not yet have the change the cloud took (an update to an item the app has never seen is a 404 there). Once the app is seen to hold the cloud's write, reads and writes go back to it together. In practice this only arises when a write had to go to the cloud (the app was not running, or refused local writes); a desktop write needs no such bookkeeping, since reads of that library already go to the app. Reads of a library nobody has written to are routed exactly as before. The one thing still stale until Zotero syncs is full text stored in the cloud with `zotero_fulltext action:"set"`, which the desktop files beside the attachment rather than in it; with the desktop app running, `set` writes the desktop's own copy and is visible at once.

## Merging duplicates

`zotero_merge_items` plans and writes on **one** copy of the library: the desktop app's for any library the app holds, the cloud's otherwise, chosen by the same rule as every other write. The preview (`dry_run`, the default) reads that same copy and reports it as `readFrom`, so the plan you approve is computed from the records the write acts on, and the `versions` it hands back are that copy's own (the desktop numbers versions independently of the cloud, so a version read from one means nothing to the other). The guarantees are the same on both:

- **The approved plan is the plan that runs.** Pass the preview's `versions` back as `expect_versions` and the write runs only if every record is still at that version; otherwise nothing is written and the answer is the fresh plan, with `changed` naming what moved.
- **A conflict on the master replans it.** The master is PATCHed at the version it was read at; a 412 means it changed in between, so it is read again from the same copy and the plan rebuilt against it (`replanned`), never replayed over what changed.
- **Nothing is trashed that still has children.** Just before each duplicate is trashed its children are listed again, and the trash write is pinned to the library version that listing was read at, so both APIs refuse it with 412 if anything in the library moved since. Moving a child away does not save its old parent on either side, so the duplicate is trashed at the version the plan read.
- **The other copy gets a veto.** When it can be asked, the copy the merge does *not* write to is asked which children hang off each duplicate: a child only the desktop has (saved a minute ago, not yet synced) or only the cloud has (added on another computer, not yet pulled) keeps that duplicate out of the trash, since trashing it would take the child along at the next sync.
- **A desktop that turns out not to take writes** (Zotero 9) fails on the master's PATCH, before anything was written, and the whole merge reruns on the cloud from the cloud's records.

The `dc:replaces` relation the master records names each absorbed item by its Zotero URI, the same relation Zotero's own merge writes. With no cloud key Zoteus takes the account id from the desktop's own records, so the URI is one any Zotero resolves.

## Desktop write paths

Zoteus picks one of two desktop paths automatically, both against the running app on `127.0.0.1:23119` (the same local API used for key-free reads — see [`configuration.md`](./configuration.md)).

**1. Local-API writes (Zotero 10+).** `POST`/`PUT`/`PATCH`/`DELETE` on `…/api/users/0/…` for the personal library and `…/api/groups/<groupID>/…` for a group the app holds, gated by a **local** API key that Zotero grants through an in-app dialog. Zoteus asks for it lazily, on the first desktop write (`POST /api/local/authorize`); pick **Always Allow** so you are never prompted again. The grant is cached as `local-api-key.json` under the Zoteus data dir; set `ZOTEUS_LOCAL_API_KEY` to pre-provision one (headless/CI, or to skip the dialog entirely). Every write, including the `authorize` call itself, echoes the running instance's `Zotero-Server-ID` header (428 without it, 412 when it no longer matches), and carries a concurrency precondition, which Zotero requires for deletes and key-based writes: the object's own `version` where the write has one, otherwise the library's current version as `If-Unmodified-Since-Version` (each library has its own version sequence, so a group's is read from that group). A consumed key (401) or a restarted/moved-on Zotero (412/428) is re-authorized / re-probed transparently. This path covers item creates and patches (so `zotero_create_items`, `zotero_update_item` and tag edits), collections (create, rename, reparent, delete, membership), saved searches, full text (`zotero_fulltext action:"set"`), merges, trash/restore, permanent delete, and file uploads (`zotero_attachment`, `zotero_attach_file`, `zotero_import`'s `attach_url`); `zotero_attachment action:"download"` reads the file the app holds on its own disk. The versions these writes carry are read from the desktop too, since its version numbers are its own and mean nothing to the cloud, and the other way round. If the desktop turns out not to take writes before anything was written (Zotero 9, a grant that is gone), the whole operation runs on the cloud instead; once something has landed on the desktop it never does, because the two would then hold it twice after the next sync. Note that the local API's `DELETE` erases outright, exactly like the Web API's: trash and restore are writes of the `deleted` flag, never a `DELETE`.

**2. Connector protocol (Zotero 9 and earlier, local API read-only).** The protocol the browser connectors use — `saveItems` / `saveAttachment` / `updateSession`. No key, no grant dialog. Limits: it can only **create** (no updates, no deletes), saves land in the personal library only, and the response carries no item keys — Zoteus recovers them by polling the local API afterwards, so a result may list fewer keys than items even when everything saved.

Local API keys have nothing to do with zotero.org keys: they never leave your machine and only authorize the running app. `ZOTEUS_LOCAL=off` disables both desktop paths and forces every write to the cloud.

## How safety is enforced

- **Optimistic concurrency.** Updates send the object's `version` (or `If-Unmodified-Since-Version`). If the object changed on the server (HTTP 412), `zotero_update_item` automatically re-fetches the current version and retries once, rather than blindly overwriting.
- **PATCH, never PUT.** Updates only change the fields you pass; everything else is preserved. (A raw PUT would wipe omitted fields — Zoteus never does this.)
- **Validation before create.** New items are checked against the live Zotero schema (valid `itemType`, valid fields, valid creator types). Notes/attachments/annotations are exempt from field checks by design.
- **Batch limits & partial failure.** Requests auto-chunk to Zotero's 50-object limit. Batch responses are parsed per-object — a request that returns HTTP 200 with some failures reports exactly which objects failed and why.
- **Trash by default, delete gated.** "Removing" defaults to the reversible trash. Permanent deletion is double-gated: the server must be started with `ZOTEUS_ALLOW_DELETE=true` **and** each call must pass `confirm:true`.
- **An optional bulk threshold.** `ZOTEUS_CONFIRM_BULK_WRITES=<n>` (default `0`, off) makes `zotero_trash_items` (trashing, not restoring), `zotero_manage_tags` add/remove, and `zotero_manage_collections action:"remove_items"` refuse above `n` items in one call unless it also passes `confirm:true`. Single-item edits stay fluent. It is a deliberation step at the scale where a bad decision does real damage, not a human in the loop: the model can re-call with `confirm:true`. Read [the threat model](./threat-model.md) for why that distinction matters, and for what a write-enabled deployment is actually trusting.

## Examples

Create a paper:

```jsonc
// zotero_create_items
{ "items": [{
  "itemType": "journalArticle",
  "title": "Attention Is All You Need",
  "creators": [{ "creatorType": "author", "lastName": "Vaswani", "firstName": "Ashish" }],
  "date": "2017",
  "tags": [{ "tag": "transformers" }]
}] }
```

Move two items into a collection:

```jsonc
// zotero_manage_collections
{ "action": "add_items", "collection_key": "ABCD1234", "item_keys": ["KEY1", "KEY2"] }
```

Trash (reversible) vs permanent delete:

```jsonc
// zotero_trash_items  — safe default
{ "item_keys": ["KEY1"] }

// zotero_delete_items — only with ZOTEUS_ALLOW_DELETE=true
{ "item_keys": ["KEY1"], "confirm": true }
```

Highlight a passage in an item's PDF, quoting the passage and nothing else:

```jsonc
// zotero_annotate
{ "action": "add", "parent": "ABCD1234", "annotations": [{
  "type": "highlight",
  "text": "Attention mechanisms have become an integral part of sequence models",
  "comment": "core claim",
  "color": "#ffd400"
}] }
```

`parent` is a regular item key (the PDF child is resolved for you) or an attachment key directly.

**You do not need page coordinates.** Zotero anchors a highlight by page rects, which nothing that reads extracted text can know; Zoteus finds the passage in the PDF itself and computes them, so the same words you can quote are the words you can highlight. The rects follow the text across line breaks, column breaks and hyphenation, one per line, exactly as the reader draws them by hand. `annotationSortIndex` is derived from where the passage sits, so the sidebar order matches reading order.

Quote the passage as `zotero_get_fulltext` returns it. Line breaks, hyphenation, spacing, case, ligatures and smart quotes are all ignored in the comparison; changed wording is not. Two answers other than success are possible, and both write nothing rather than guess:

- **Not found**: the wording does not appear in the PDF (or not on the `page` given).
- **Ambiguous**: the passage occurs more than once. The reply lists each occurrence with its page and surrounding words; re-send with `page`, or with `occurrence` (1-based, reading order), to say which one.

Reading the PDF needs the file: a Zoteus running beside Zotero reads it from the desktop app's own storage, and a hosted one downloads it from Zotero storage, so a hosted Zoteus cannot anchor an attachment that has never synced.

Passing `position` yourself still works and skips all of the above: it is Zotero's stored form, `pageIndex` 0-based and `rects` as `[x1, y1, x2, y2]` in **native PDF points with a bottom-left origin** (`char_offset` and `page_height` refine the sort index, `sort_index` sets it outright). The sidebar order is measured from the bottom of the page, so the page height is read out of the PDF for this path too unless you pass `page_height` or `sort_index`; if it cannot be read the highlight is still placed, and the reply says which annotations therefore sort to the top of their page.

A rect that is not four finite numbers, or any other `position` that cannot be read, is refused, naming the annotation and what was wrong with it. It is never quietly replaced by anchoring the passage instead. Annotation field names are snake_case, and a key this tool does not know is refused rather than ignored: `pageLabel` and `sortIndex` are `page_label` and `sort_index`.

```jsonc
// zotero_annotate, explicit placement
{ "action": "add", "parent": "ABCD1234", "annotations": [{
  "type": "highlight", "text": "…",
  "position": { "pageIndex": 0, "rects": [[71.9, 520.4, 523.2, 534.8]] }
}] }
```

`action:"delete"` trashes annotations by key:

```jsonc
// zotero_annotate
{ "action": "delete", "annotation_keys": ["ANNO1234"] }
```

Store a PDF under an existing item:

```jsonc
// zotero_attach_file
{ "parent": "ABCD1234", "url": "https://arxiv.org/pdf/1706.03762", "title": "Full Text PDF" }

// …or from disk; filename/content_type are inferred when omitted
{ "parent": "ABCD1234", "path": "/home/me/papers/attention.pdf" }
```

The desktop app handles this when it is reachable (Zotero 10+ local-API writes). Otherwise the file goes up through the cloud Web API's File Storage protocol, which needs `ZOTERO_API_KEY` with file access and uses your storage quota. That cloud path is the only one a remote or hosted Zoteus has: the desktop local API is bound to your own loopback address, out of reach from another machine. `url` works on every setup, since the server downloads the bytes itself; `path` only makes sense when the file is on the machine running Zoteus.
