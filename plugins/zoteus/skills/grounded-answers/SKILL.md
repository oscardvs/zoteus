---
name: grounded-answers
description: Answer questions from the user's Zotero library with verbatim quotations and page numbers from their own PDFs. Use when the user asks what a saved paper says, where a claim comes from, what they highlighted or noted, whether something is in their library, or wants a passage, figure or table from a PDF in Zotero.
---

# Answer from the Zotero library, with the passage to show for it

These steps use the Zoteus tools, named `zotero_*`. If none are available, tell the user the Zoteus server is not running. In Claude Code, and in Cowork on their computer, this plugin starts it, which needs Node.js 20.19 or later and either the Zotero desktop app running or a Zotero API key in the plugin's settings. In claude.ai chat, a local server cannot run, so they need a remote Zoteus connector instead.

## Steps

1. **Confirm the library.** On the first library request in a conversation, call `zotero_whoami`. It reports which library calls default to and whether the desktop app or the cloud API serves it. If the user means a group library, get its numeric id from `zotero_groups` and pass `library_type:"group"` and `library_id` on every later call. Never ask the user to type a numeric user id.
2. **Find the item.** For a known title, author or year, use `zotero_search_items` with `q`, which is instant and needs no index. For a topic or a question, use `zotero_semantic_search` with `q`. When its index is empty it starts a background build and says so: tell the user, and meanwhile use `zotero_search_items` with `qmode:"everything"`, which also searches notes and indexed PDF text. Show the title, first author, year and item key so the user can confirm it is the right item.
3. **Retrieve the passage.** Call `zotero_get_fulltext` with the item key and `query` set to the claim or question. Quote `passages[].text` verbatim. Give the page and say what kind it is: `page` is exact, `pageApprox` is a proportional estimate, and `pageSource` says which one this call produced. For a long document, call it with `outline:true` first and then with `page_range` for the pages the outline names.
4. **Look at what text extraction loses.** For a figure, a table, an equation or a scanned page, call `zotero_pdf_images` with `mode:"pages"` and `pages` set to that page, and read the image.
5. **Report coverage.** If the full text could not be retrieved, say so and say what you worked from instead: the abstract from `zotero_get_item`, a note, or nothing.

## Rules

- Never invent a quotation, a page number or an item key. Leave the gap visible.
- A search snippet is not a quotation. It has no page locator, and a snippet whose `source` is `"annotation"` can join the author's words to the user's own comment on them. Retrieve the passage with `zotero_get_fulltext` before quoting.
- A reference being in the library is not evidence that a claim is correct. Keep what the source says, quoted, apart from your reading of it.
- When reading several items, call `zotero_get_fulltext` one item at a time rather than in parallel: PDF extraction is slow and Zotero rate-limits.
- Printed page labels can differ from the PDF viewer's page numbers. When the user will cite the page, suggest they check it in Zotero.
