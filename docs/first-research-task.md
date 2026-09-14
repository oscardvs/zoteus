# Your first research task with Zoteus

Start with a paper you know and a PDF you can open in Zotero. [Connect your client first](./getting-started.md), then use this checklist. A full semantic index is not required.

## 1. Confirm the library

> Use Zoteus to tell me which Zotero account and library you can access. Check my permissions. If several group libraries are available, ask which one I mean.

For a group, resolve its numeric ID with `zotero_groups`. A successful login alone does not confirm the intended library.

## 2. Find a known paper

> Search my selected library by the title "[paste a title you saved]". Show the title, authors, year and Zotero item key. Use direct keyword lookup first.

Confirm that these details match your item. If nothing appears, check the account, selected library and sync before starting an index build.

## 3. Retrieve one passage

> Read the PDF attached to that item using Zoteus. Find the passage about "[a phrase you remember]". Return the exact quotation, page locator and nearby context. Say explicitly if only the abstract or a note is available. Do not fill missing evidence from memory.

The assistant should use `zotero_get_fulltext`. An attachment record is not proof its bytes are available. If it fails, follow [missing PDFs](./missing-pdfs.md). If the PDF is readable but meaning search is not, see [search readiness](./search-readiness.md).

## 4. Verify in Zotero

Open the source PDF at the returned page. Check the wording, surrounding argument and any table headings. Printed page labels can differ from the PDF viewer's page number; ask which locator was returned. If the locator is absent or approximate, report that rather than inventing a page.

**First success:** the right library, the right item, a retrieved passage, and a page/context check that you performed. A citation existing in Zotero does not prove an AI interpretation is correct.

## Compare evidence

After the first passage works, try:

> Compare these five Zotero items on "[research question]". Retrieve relevant passages before making factual claims. Return a table with study, finding, exact quotation, page or locator, and evidence status. Use "passage retrieved", "abstract only", or "unavailable" for source coverage. Separately mark support as supported, contradicted, or uncertain. Leave gaps visible. Then format the references in my chosen citation style.

An illustrative table structure, not a research result:

| Study | Finding | Quotation | Locator | Coverage | Support |
|---|---|---|---|---|---|
| Item title and key | Claim to check | Exact retrieved words | Returned page | Passage retrieved | Supported / contradicted / uncertain |
| Another item | Not assessed | None | None | Abstract only or unavailable | Unverified |

Ask for the table as Markdown or CSV if useful. Check each passage before using the synthesis in your own work. Formatted references are plain text; they are not live Zotero citation fields in Word.

## Continue your research

- [Turn your annotations into a cited note](./annotations-to-literature-notes.md).
- [Work with a shared group library](https://zoteus.com/docs/group-libraries-for-review-teams/).
- Capture new sources with the [Zotero Connector](https://www.zotero.org/support/connector), then ask Zoteus about the saved material.
- [Review metadata changes and understand reversible trash](./writing.md).
