---
name: library-upkeep
description: Add papers to the user's Zotero library and keep it tidy. Import by DOI, arXiv id, ISBN, PMID, URL, or a BibTeX or RIS file, attach open-access PDFs, find and merge duplicates, tag, file into collections, edit metadata, highlight PDF passages, and trash or restore items. Use when the user asks to save, import, organize, tag, deduplicate, annotate or clean up items in Zotero.
---

# Add to and organize the Zotero library

These steps use the Zoteus tools, named `zotero_*`. They change the user's library, so **show what will change and get a yes before every write**, and ask again before any change that touches many items.

## What needs a Zotero API key

With the Zotero desktop app running, these writes to the personal library need no key: adding items by identifier, attachments, annotations, and trash and restore. The following go to the Zotero cloud and need an API key with write access, set in this plugin's settings:

- metadata edits, tags, collections and saved searches
- every write to a group library
- any write while the desktop app is closed

When a write is refused for lack of a key, say that plainly rather than retrying.

## Add papers

- **By identifier:** `zotero_import` with `action:"by_identifier"`, `identifier` (a DOI, arXiv id, ISBN, PMID or ADS bibcode), `save_to_library:true` and `check_duplicates:true`. Add `collection_key` to file the item at once. Only when the user confirms they want a second copy of a match, save again with `allow_duplicate:true`.
- **From a web page:** `zotero_import` with `action:"by_url"`. When it returns several choices, let the user pick.
- **From a bibliography file:** `zotero_import` with `action:"by_file"` and either `text` (the file's contents) or `path`. BibTeX, RIS and CSL-JSON are parsed with no network access.
- **Attach the open-access PDF:** `zotero_attach_file` with `parent` and `find_oa:true`. Tell the user which version it found: an accepted manuscript is not the published version of record. When there is no free copy, say so; this is not a way around a paywall.

## Organize

- **Collections:** find keys with `zotero_list_collections`. Use `zotero_manage_collections` with `action` set to `"create"`, `"rename"`, `"add_items"` or `"remove_items"`.
- **Tags:** list them with `zotero_list_tags`. Use `zotero_manage_tags` with `action:"add"` or `"remove"`, `tags` and `item_keys`. Tag names are case-sensitive. To check tags against a controlled vocabulary, use `zotero_tag_audit`.
- **Metadata:** `zotero_update_item` with `item_key` and a `patch` of plain field values, for example `{"title": "New title"}`. Pass `dry_run:true` first to show the change.
- **Duplicates:** `zotero_merge_items` with `master_key` and `duplicate_keys` previews by default. Show the plan field by field, and run it with `dry_run:false` only after the user agrees. It fills only fields the master lacks and moves the emptied copies to the trash.
- **Highlights and notes on a PDF:** `zotero_annotate` with `action:"add"`, `parent` (the item or its PDF) and `annotations`, each with `type` (`highlight`, `underline` or `note`), the exact passage as `text`, and an optional `comment`. Take `text` verbatim from `zotero_get_fulltext`. No page coordinates are needed.

## Remove

Use `zotero_trash_items`, which is reversible; `action:"restore"` brings items back. Do not use `zotero_delete_items` unless the user explicitly asks for permanent, irreversible deletion. It is disabled unless the server was started with `ZOTEUS_ALLOW_DELETE=true`.
