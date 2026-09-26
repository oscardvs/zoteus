---
name: citations
description: Format citations and bibliographies from the user's Zotero library in any CSL style (APA, Chicago, MLA, IEEE, Vancouver, Nature and thousands more), export BibTeX, BibLaTeX, RIS or CSL-JSON, or write a Word document whose citations are live Zotero fields. Use when the user asks for a reference list, a citation in a particular style, a .bib file, or a draft with citations.
---

# Citations and bibliographies from the Zotero library

These steps use the Zoteus tools, named `zotero_*`. Take every formatted reference from a tool. Never type one from memory, because a wrong year, page range or DOI in a reference list is hard for the user to spot.

1. **Find the item keys** with `zotero_search_items` (by title, author or year) or `zotero_semantic_search` (by topic), and confirm them with the user when there is any doubt.
2. **Resolve the style.** When the user names a style, call `zotero_styles` with `action:"resolve"` and `name` set to their wording, for example "APA 7th", "IEEE" or "Chicago author-date", and pass the returned `styleId` on. Default to APA only when the user has no preference.
3. **Render.**
   - A bibliography for library items: `zotero_bibliography` with `item_keys` and `style`, which returns XHTML and takes up to 150 items.
   - Plain text, RTF, or items that are not in the library: `zotero_format_bibliography` with `item_keys`, or with `items` as CSL-JSON, plus `style` and `format:"text"`.
   - One inline citation: `zotero_get_item` with `include:"citation"` and `style`.
4. **Export for LaTeX or another manager** with `zotero_export` and `format` set to `bibtex`, `biblatex`, `ris` or `csljson`, plus `item_keys` or `collection_key`. Use `better-biblatex` only when the user has the Better BibTeX plugin in Zotero and wants its citation keys.

## Word documents with live citations

`zotero_word_document` writes a .docx whose citations are live Zotero fields, which the Zotero Word plugin can refresh and restyle. Write `body` as paragraphs with placeholders:

- `[[cite:ITEMKEY]]` for one work
- `[[cite:ITEMKEY,p. 12]]` for a work with a locator
- `[[cite:KEY1;KEY2]]` for several works in one citation

Set `style`. A bibliography field is appended by default. The file is saved under the Zoteus data directory unless you pass `save_path`, so tell the user where it went. Suggest that they open the first document in Word and use Zotero's **Refresh** once to confirm the fields behave in their setup.

Formatted references from the other tools are plain text, not live fields. Say so when the user is going to paste them into a manuscript they manage with the Zotero Word plugin.
