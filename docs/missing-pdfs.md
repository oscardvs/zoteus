# Fix missing or unreadable Zotero PDFs

Finding a reference, reading its PDF and searching its body are separate checks. Hosted Zoteus does not upload files from your computer. Start with one known item and ask:

> Find this item by title in the selected library. List its attachments and check whether the PDF can actually be read. If not, explain whether the problem is permissions, attachment bytes, text extraction or index coverage. Do not say a PDF was read when only metadata was returned.

## Check where the file lives

| File situation | Hosted connector | Free local connector |
|---|---|---|
| PDF available through Zotero online file storage | Can retrieve it with the right permissions | Can use the local copy or online access |
| Linked file or attachment stored only on your disk | Cannot fetch your disk | Needs a readable local file and the Zotero app/local storage path |
| PDF stored through WebDAV | Zoteus does not connect to your WebDAV server; synced metadata or extracted text does not prove file bytes are available through Zotero | Sync/download the file in Zotero first, then check local reading |
| Reference with no attached PDF | Metadata and any abstract only | Metadata and any abstract only |
| Scanned PDF with no text layer | Page images may be viewable if bytes are available; no searchable text to extract | Same text limitation; local access does not add OCR |

## Fix the failing step

1. **Confirm the account and library.** Check your personal library or the group's numeric ID. A key can read metadata without having the needed file or group access.
2. **Open the attachment yourself.** For hosted use, try the file in the Zotero web library, not just the desktop app. If only the desktop copy opens, resolve Zotero file sync or use the local route. Follow [Zotero's file-sync troubleshooting](https://www.zotero.org/support/kb/files_not_syncing).
3. **Check text extraction.** Try selecting a sentence in the PDF. Scans need a text layer. Zoteus can show page images, but page-image viewing is not an OCR index. Use your institution's approved OCR process, then reindex the resulting text in Zotero.
4. **Separate reading from indexed search.** A PDF can be readable even when its body has not been indexed for search. Check [body indexing and caps](./search-readiness.md). Conversely, synced extracted text may be readable without the original file bytes needed for page images and precise locators.
5. **Read the reported error.** Unsupported or oversized files, password protection and extraction failures need the specific remedy in the tool output. Do not repeatedly rebuild an index to fix a missing file.

Zoteus retrieves content under the permissions you granted. Retrieved passages go to the AI service you are using, even with the connector on your own computer. [Data paths and privacy](../PRIVACY.md).

## Still stuck?

Send [support@zoteus.com](mailto:support@zoteus.com) the client, local/hosted route, Zoteus version, personal/group library type, whether the attachment opens in Zotero online, and the redacted error. Do not send keys, private PDFs or unpublished passages unless you intentionally choose to share them.

[Retry your first research task](./first-research-task.md) · [Files and sync reference](https://zoteus.com/docs/files-and-sync/)
