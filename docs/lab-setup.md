# Running Zoteus for a lab

This page describes what Zoteus actually does when several people work off one shared Zotero group library. It documents only what the server implements today. Where something is an agreement rather than a mechanism, it says so, in [What is contractual, not enforced](#what-is-contractual-not-enforced).

## What a "lab" is here

Zoteus has no account of its own. It stores no lab, no roster, no seat and no member list. A lab, to this server, is exactly two things that already exist in Zotero:

- **A Zotero group library**, which holds the shared references. Zotero owns its membership and its edit policy.
- **One Zotero account per person**, each with its own API key (or, on a shared deployment, its own Zotero authorisation).

Everything below is a report on those two, taken from what Zotero itself says.

## The two calls that answer the setup questions

### `zotero_whoami`: whose context am I on, and which library will a call land in?

Beyond identity and version, it reports:

| Field | What it answers |
|---|---|
| `context.perUser` | `true` when this call is answered by a context of its own: its own Zotero API key and its own search index, keyed by the Zotero account that authorised. `false` means it is answered by the context whoever runs the server configured, shared by every caller of that server. |
| `context.confined` | `true` when the caller is someone other than the operator of the machine (any HTTP/OAuth deployment). File paths a tool accepts are then confined to the server's data directory. |
| `context.zoteroUserId` | The Zotero user id this context and its search index are keyed by. Absent on a single-user install, where there is only one context. |
| `defaultLibrary.source` | Why *this* library is the default: `configured` (`ZOTERO_LIBRARY_ID`, set by whoever runs the server), `key` (the personal library of the account the key belongs to), or `local` (no key and no setting, so the desktop app's own library, addressed as `users/0`). |
| `defaultLibrary.sourceDetail` | The same answer in words, including how to address a different library on a call. |
| `localApi`, `localApiChecked`, `localApiWatched`, `localApiReason` | Whether the Zotero desktop app answered a probe taken for this call, when, whether this server watches for it at all, and, on a shared server, why it never will. |
| `searchIndex` | Which single library this context's search index holds, and whether that is the default library. |

`zotero_whoami` never returns an API key.

### `zotero_groups`: can this key write to the shared library, and is it searchable yet?

Each cloud-listed row carries:

| Field | What it answers |
|---|---|
| `canWrite` | Whether this API key is allowed to write to that group, decided from the key's own access map without sending a write. |
| `writeBlockedReason` | Why it cannot, and what to change, present only when `canWrite` is `false`. |
| `indexed` | Whether this data directory holds a search index for that group. Each library gets its own index file, so several rows can be `true`. |

Rows with `source: "local"` come from the Zotero desktop app and carry no `canWrite`: write permission is a property of the cloud API key, and the desktop reports none.

`canWrite` is absent, rather than `true`, when the key reported no access map at all. That is "unknown", and saying otherwise would move the surprise instead of removing it.

Two limits worth knowing:

- `canWrite: true` is the key's permission, not a promise the group accepts the write. A group can be configured so only its admins may edit the library (`libraryEditing`), which no key setting overrides.
- If the server runs with `ZOTEUS_READ_ONLY=true`, no tool writes to any library whatever the key allows, and the summary line says so.

## Pinning one library for everyone

`ZOTERO_LIBRARY_ID` / `ZOTERO_LIBRARY_TYPE` set the library every call uses when it names none. The setting is **process-wide**: on a shared deployment every account connecting to that server gets the same default library, whatever their own account holds. There is no per-user library preference in Zoteus. A call can always name another library with `library_id` and `library_type`.

`zotero_whoami` reports which of the two happened, in `defaultLibrary.source`, so a lab does not have to infer it from the contents of a search result.

## Search indexes

One index file holds one library, and a data directory holds one file per library you index. A library is searchable by meaning (`zotero_semantic_search`) only after `zotero_index action:"build"` has run for it, and each library gets an index file of its own in the same data directory, so building for a second library no longer touches the first. What is refused is indexing one library over another library's rows inside the same file: Zotero item keys repeat between libraries, so two libraries in one store would alias each other's passages.

On a shared deployment each authorised account gets its own index file, so every member of a lab indexes the shared group library once for themselves. There is no shared index, and no member sees another's.

`zotero_groups[].indexed` comes from the index files this data directory holds; `zotero_whoami.searchIndex.library` comes from the default index's own library stamp and, when nothing has been indexed yet or the index predates that stamp, `library` is absent rather than guessed. `zotero_index action:"libraries"` is the complete list.

## What Zotero enforces, not Zoteus

- **Who is in the group** and who may edit the library: Zotero group settings, changed at zotero.org.
- **What an API key may do**: the key's own permissions, set at https://www.zotero.org/settings/keys. `writeBlockedReason` quotes the remedy.
- **Who a shared deployment will answer**: whoever completed the Zotero authorisation for it. See [`remote-oauth.md`](./remote-oauth.md).

Zoteus reports all three. It decides none of them.

## What is contractual, not enforced

This is the part that is easy to misread, so it is stated plainly:

- **There is no seat model in this software.** No part of Zoteus counts people, tracks members, or refuses a call because a number was exceeded. If a subscription describes a limit on how many people may use it, that limit is an agreement between you and whoever sold it, and it is not enforced by this server.
- **There is no licence, plan, tier or billing concept in this repository at all.** Zoteus stores no customer record. What identity it holds is what Zotero gave it: a numeric user id, a username, and a key.
- **There is no invitation, seat assignment or billing-owner feature.** Adding people to a lab means adding them to the Zotero group, in Zotero.
- **`canWrite` describes a key, not an entitlement.** It is read from Zotero's answer about that key, and says nothing about any subscription.

If you need a technically enforced seat count, Zoteus does not provide one today, and nothing in the output of these tools should be read as one.

## Checklist for a new shared library

1. Create the group in Zotero and add the members there.
2. Each member creates a Zotero API key with read/write access to that group, or authorises the shared deployment.
3. Each member calls `zotero_whoami`. Check `defaultLibrary.source`: if it is `key` and the lab works in the group, either pass `library_id`/`library_type` per call or pin the group with `ZOTERO_LIBRARY_ID` (remembering it pins everyone on that server).
4. Each member calls `zotero_groups`. Every row for the shared group should say `canWrite: true`; a row that does not names the fix in `writeBlockedReason`.
5. Each member runs `zotero_index action:"build"` against the shared library once, then checks `indexed` on that row.
