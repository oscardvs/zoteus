# Notes and annotation digests

Five tools work with the reader's own material: three write Zotero notes from Markdown, one lists the annotations on a paper or a collection, and one saves that list as a note.

| Tool | What it does | Hints |
|---|---|---|
| `zotero_create_note` | A new note from Markdown: a child note under a paper (`parent_item`), or a standalone note, optionally filed in `collections`. | write, not destructive |
| `zotero_append_to_note` | Markdown added to the end of an existing note. Everything already in the note stays as it was. | write, not destructive |
| `zotero_replace_note` | The whole text of an existing note replaced with new Markdown. Returns the old HTML as `previousNote`. | write, **destructive** |
| `zotero_annotation_digest` | The annotations on one paper or on every top-level item of a collection, grouped per paper. | **read-only** |
| `zotero_save_annotation_digest` | The same digest, saved as a Zotero note. | write, not destructive |

Every write goes to the running Zotero desktop app (Zotero 10+) for every library it holds, and to the cloud Web API otherwise, like the other [write tools](./writing.md). The digest reads the same way.

## Markdown in a note

The note tools convert Markdown into the HTML Zotero's note editor stores, so the note opens in Zotero as if it had been typed there:

- headings (`#` to `######`, and underlined `===` / `---` headings)
- paragraphs, with two trailing spaces or a trailing backslash for a line break
- bullet and numbered lists, nested by indentation; a numbered list keeps its start number; `- [ ]` and `- [x]` become ☐ and ☑
- `**bold**`, `*italic*`, `~~strikethrough~~`, `` `code` ``
- fenced code blocks
- `> blockquotes`
- links: `[text](https://...)`, `<https://...>`, and bare `https://` or `www.` addresses; `doi:10.xxxx/...` links to doi.org
- pipe tables
- horizontal rules
- math: `$x^2$` inline and `$$...$$` as a block, stored as Zotero's own math nodes. A `$` followed by a space, or a closing `$` followed by a digit, is not math, so "$5 and $10" stays text.

Raw HTML in the Markdown is shown as text, not interpreted. Links may only point to `http`, `https`, `mailto`, `ftp` or `zotero:` addresses; any other link keeps its text and loses the link. An image (`![alt](url)`) becomes a link to the image, because a note cannot show a remote picture.

Zotero names a note after its first line. Pass `title` to put a heading there.

## Citing library items

Put an item key in brackets and the note gets a real Zotero citation:

```markdown
Filters diverge under model mismatch [@ABCD2345, p. 12].
Both groups report it [see @ABCD2345; @WXYZ6789, pp. 3-5].
The derivation is in [@ABCD2345, ch. 3].
```

Each group becomes the span Zotero's own note editor writes, `(Smith, 2019, p. 12)`, and the note stores each cited item's CSL-JSON, as Zotero does. In Zotero the citation opens the item (or the PDF at that page), and "Add Note to Word" or "Add Note to LibreOffice" turns it into a live citation field.

- The key is the 8-character Zotero item key (`zotero_search_items` returns it). Better BibTeX citation keys are not read.
- After the key, a page (`p. 12`, `pp. 3-5`, or a bare `12`) becomes the locator. `ch.`, `sec.`, `fig.`, `tab.`, `para.`, `vol.`, `l.`, `n.` and `eq.` set a CSL label. Anything else after the comma is kept as a suffix, and text before `@` as a prefix.
- Every cited key is read before anything is written. A key that names nothing, or names a note, an attachment or an annotation, refuses the whole write and says which key, because a citation that points nowhere prints as "(MISSING CITATION)" when the note is exported.
- `[@KEY]` inside code is left alone. Pass `cite: false` to keep every `[@KEY]` as plain text.

## Appending and replacing

`zotero_append_to_note` reads the note, adds the new HTML inside its container, merges any new cited items into the note's stored list, and writes it back at the version it read. If someone edits the note in between, the write is refused with a version conflict; the tool then reads the note again and appends to the fresh copy, so the other edit is kept.

`zotero_replace_note` writes the new content over the old. Zotero keeps no history of a note, so the result returns the old HTML as `previousNote`; `zotero_update_item` with `{"note": <previousNote>}` puts it back. Pass the `version` you read (from `zotero_get_item`) to replace only if nobody changed the note since; without it the current text is replaced whatever it holds. Replacing a note with nothing is refused: trash it with `zotero_trash_items` instead.

Both refuse a key that is not a note. The parent, tags and collections of the note never change.

## The annotation digest

`zotero_annotation_digest` takes `item_key` (a paper, or a standalone PDF or EPUB) or `collection_key`, never both. For each paper it returns:

- `title` and `citation`, Zotero's short form ("Smith, 2019"), so a synthesis can cite it as `[@ITEMKEY, p. 12]`
- `attachments`: the annotated PDFs, EPUBs and snapshots, with a count each
- `annotations`, in reading order: `type` (highlight, underline, note, text, image or ink), `color` and its palette name (`colorName`: yellow, red, green, blue, purple, magenta, orange, gray), `pageLabel`, the highlighted `text` verbatim, the reader's `comment`, `tags`, and the `attachment` it sits on

Filter with `types`, `colors` (names or hex values) and `tags` (any of them, case-insensitive). A collection is read 25 top-level items at a time by default (`limit`, up to 100), sorted by title; `nextStart` says where the next call starts. Subcollections are not included. Items with no matching annotation are counted in `itemsScanned` and left out of `items`.

The digest is read-only (`readOnlyHint: true`), so it is available under `ZOTEUS_READ_ONLY` and clients may run it without asking. Like every result carrying library text, it is marked as untrusted content: annotation text was written by whoever wrote the PDF.

## Saving the digest as a note

`zotero_save_annotation_digest` takes the same arguments, plus `title` and `note_tags`, and writes one note laid out the way Zotero's own "Add Note from Annotations" lays one out:

- a heading, by default "Annotations (date)" or "Annotations: collection name (date)"
- for a collection, a heading per paper; for a paper with several annotated files, or a standalone file, a heading per file
- one paragraph per annotation: the highlighted passage in quotes, a citation with its page, the comment, and the annotation's tags

Each highlight keeps the link Zotero uses to open the PDF at that spot, and each citation opens its paper. A paper's digest is attached to the paper. A standalone PDF's digest is filed in the PDF's collections, since Zotero does not allow a note under an attachment. A collection's digest is a standalone note in that collection, covering up to 200 items; past that, the note and the result both say it stopped. Nothing is written when no annotation matches.

The note text is built from the annotations as Zotero stores them, never retyped by the model, so a quotation in the note is the quotation in the PDF.

Image and ink annotations appear as "[image annotation, page N]" with their citation and comment: the picture itself is not embedded, because only Zotero's reader can render the region. A note holding underline annotations is stamped with note schema 10, as Zotero does; every other note with schema 9.

[Safe writes](./writing.md) · [Annotations to literature notes](./annotations-to-literature-notes.md) · [Annotating PDFs](./writing.md#examples)
