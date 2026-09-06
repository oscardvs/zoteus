# Uninstalling Zoteus

**Zoteus writes everything it derives into one directory.** Removing that
directory removes the search index, the on-device model weights, and the
update-check cache — every file the server has ever written for itself. Your
Zotero library is somewhere else entirely, and nothing below goes near it.

## Where that directory is

`ZOTEUS_DATA_DIR`, if you set it. Otherwise the OS default:

| Platform | Default |
|---|---|
| macOS | `~/Library/Application Support/zoteus` |
| Windows | `%APPDATA%\zoteus` |
| Linux, BSD, everything else | `${XDG_DATA_HOME:-~/.local/share}/zoteus` |

The table above is the whole rule: no tool reports the resolved path, so if
you set `ZOTEUS_DATA_DIR` yourself, read it back from wherever you set it.

## The steps

1. **Stop the server.** Quit whatever holds the stdio connection — Claude
   Desktop, your editor, or the `node` process, if you started it yourself.
   A running server holds the index's
   SQLite file open and will rewrite its `-wal` sidecar underneath you.

2. **Remove the registration.** Delete Zoteus's entry from your MCP client's
   configuration, or uninstall the desktop extension bundle through the
   client that installed it. Nothing else in this list depends on the order,
   but doing this second means the client will not relaunch the server while
   you are deleting its files.

3. **Delete the data directory.** The one from the table above — and only
   that one. It is not your Zotero library, which lives elsewhere and is not
   part of this procedure; check the path you are about to remove against the
   table before you run anything.

   ```sh
   # Linux/BSD, default location
   rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/zoteus"
   # macOS, default location
   rm -rf ~/Library/Application\ Support/zoteus
   # Windows, PowerShell, default location
   Remove-Item -Recurse -Force "$env:APPDATA\zoteus"
   # any platform, if you set the variable yourself
   rm -rf "$ZOTEUS_DATA_DIR"
   ```

   That is the whole removal. The index (`search-index.sqlite` and its
   `-wal`/`-shm` sidecars, or the older `search-index.json`), the downloaded
   model weights under `<ZOTEUS_DATA_DIR>/models`, `update-check.json`, the
   local-API key Zotero granted (`local-api-key.json`), the usage log if you
   turned `ZOTEUS_USAGE_LOG` on (`usage.sqlite`), and on a self-hosted OAuth
   deployment the encrypted token store (`oauth-store.json`) all live inside
   it. A log file you named with `ZOTEUS_LOG_FILE` is wherever you put it.

4. **Remove the embedding runtime, if you installed one by hand.** Semantic
   search needs `@huggingface/transformers`, which Zoteus does not vendor. If
   you installed it yourself and pointed `ZOTEUS_TRANSFORMERS_PATH` at it,
   that directory is yours and outlives every step above — delete it if
   nothing else uses it. An install that never enabled semantic search has
   nothing to do here.

## What is deliberately left alone

**Your Zotero library.** Zoteus reads the desktop app's data directory
(`~/Zotero` by default, `ZOTERO_DATA_DIR` if you moved it) to open attachment
files, and writes no file into it. That is a claim about the directory, not
about your library: unless you ran with `ZOTEUS_READ_ONLY=true`, Zoteus could
add and edit items through the API like any other client, and removing it
leaves those items where they are. Do not delete the directory as part of
removing Zoteus.

**Your cloud API keys.** They live wherever you put them: a shell profile,
your MCP client's configuration, a secret manager. A personal install never
writes them to disk, so nothing in this list reaches them. The only key such an
install stores is the one Zotero grants it for the local API; it lives at
`<ZOTEUS_DATA_DIR>/local-api-key.json`, and deleting the data directory in step
3 removes it. Revoke cloud keys yourself if you want them gone. The one
exception is a self-hosted OAuth deployment run with `ZOTEUS_OAUTH_STORE=file`:
it keeps its users' Zotero keys, encrypted with `ZOTEUS_OAUTH_TOKEN_SECRET`, in
`<ZOTEUS_DATA_DIR>/oauth-store.json`, and step 3 removes that file too.

**Zotero's own settings.** Two things on Zotero's side were changed for Zoteus
and stay as they are. The setting you enabled for key-free local access
(Settings → Advanced → "Allow other applications on this computer to
communicate with Zotero") stays on; turn it off there if nothing else on the
machine uses it. And if you ever answered "Always Allow" to Zotero 10's local
write grant, Zotero remembers that grant in `localAPIKeys.json` in its
*profile* directory (not its data directory). Deleting Zoteus's copy of the
key does not revoke it there; a Zoteus that is gone can never use it, but if
you want the record gone too, remove it with Zotero closed.

## If you installed before v1.10.0

**Earlier versions left the model weights outside the data directory**, and
deleting the data directory alone was an incomplete uninstall for those
installs. `@huggingface/transformers` caches downloaded weights inside its own
package directory by default; Zoteus did not override that until the fix that
pins the cache to `<ZOTEUS_DATA_DIR>/models` before the pipeline is built.
Under `ZOTEUS_TRANSFORMERS_PATH` pointing at a global `node_modules`, those
weights outlived even uninstalling the desktop extension — and they are the
largest artifact of the lot, tens of megabytes for the default model and
gigabytes for a larger one.

If your install predates that fix and you never removed the package, look for
a `.cache` or `models` directory inside the `@huggingface/transformers`
install you pointed at and delete it. A fresh install writes nothing there.

## Checking

Nothing should remain:

```sh
ls "${ZOTEUS_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/zoteus}"    # no such file or directory
```

Reinstalling later rebuilds the index from your library. Nothing removed here
is unrecoverable, and nothing removed here was yours.
