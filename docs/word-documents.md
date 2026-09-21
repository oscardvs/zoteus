# Word documents with live Zotero citations

`zotero_word_document` writes a `.docx` whose citations are **Zotero fields**, not text that
looks like citations. A field carries the item's full CSL data plus a Zotero item URI, which
is what Zotero's word-processor plugin reads when you press Refresh: change the style, fix a
typo in the item, add a page number, and the document re-renders.

Everything else in the citation pipeline ([`citations.md`](./citations.md)) produces finished
text. This is the one tool that produces something Zotero can still edit.

## What it does, and what it does not

It does:

- one Word field per `[[cite:...]]` placeholder, carrying `ADDIN ZOTERO_ITEM CSL_CITATION`
  with the citation id, the rendered citation, the item URI and the full CSL-JSON record;
- a `ADDIN ZOTERO_BIBL ... CSL_BIBLIOGRAPHY` field for the bibliography, one paragraph per
  entry;
- the `ZOTERO_PREF_1`, `ZOTERO_PREF_2`, … document properties Zotero reads to learn which
  style the document is bound to;
- citeproc rendering across the whole document at once, so a numeric style numbers in
  document order and an author-date style disambiguates two 2026 papers by the same author
  into 2026a and 2026b.

It does not:

- create headings (beyond `title`), tables, images, footnotes or numbering. It is a citation
  emitter over paragraphs you already wrote, not a document generator. A **note style**
  (Chicago notes, for instance) therefore renders its notes inline in the body, and the tool
  says so in `warnings`;
- format the citation text richly. Citations and bibliography entries are written as plain
  text, so a title a style would italicise is not italic until Zotero refreshes the document
  and rewrites it;
- refresh anything itself. Only Zotero can do that.

## Writing a document

```json
{
  "title": "Perceptive locomotion: a short review",
  "body": [
    "Model-predictive control over rough terrain is now practical [[cite:8VXEIRQF,p. 4]].",
    "Two recent systems take the same approach [[cite:MPXQK6X2;72BIK3KC]].",
    "The classic treatment remains [[cite:72BIK3KC,ch. 3]]."
  ],
  "style": "apa",
  "bibliography": true
}
```

Placeholder language, in full:

| Placeholder | Meaning |
| --- | --- |
| `[[cite:ABCD1234]]` | one item |
| `[[cite:ABCD1234,p. 12]]` | with a locator; `p.`, `pp.`, `chap.`, `sec`, `vol.`, `§`, `¶` and the rest of the CSL locator terms are understood |
| `[[cite:ABCD1234,12]]` | a bare number means a page, which is Zotero's own default |
| `[[cite:ABCD1234;EFGH5678]]` | both works in **one** field, rendered as one cluster: `(Wu, 2026; Devos, 2026)` |

An item key that cannot be read from the library is **not** invented. It comes back in
`missing`, and its placeholder is left in the document as literal `[[cite:ABCD1234]]` text so
whoever reads the draft can see exactly what is uncited.

## Where the file goes

By default, under the server's data directory in `documents/`, with a timestamp in the name
so two runs never overwrite each other. Pass `save_path` to choose, and `overwrite: true` to
replace a file that is already there (without it the tool refuses and writes nothing: a
`.docx` at a path you chose is usually a document you have been editing).

On a **shared deployment** a filesystem path is the operator's disk, not yours, so a
`save_path` outside the data directory is dropped rather than honoured. The document is still
written, to the default location, and the result says where. To get it off the server, push it
into your library:

```json
{ "action": "upload", "file_path": "<savedTo>", "parent_item": "ABCD1234", "title": "Draft" }
```

through `zotero_attachment`, then download it from Zotero like any other attachment.

## Refreshing in Word

You need Microsoft Word with the **Zotero word-processor plugin** installed, and Zotero
running. Open the `.docx`, then use Refresh in the Zotero tab. Until then Word shows the
citation text cached in each field, which is what Zoteus rendered.

LibreOffice with Zotero's extension reads the same `ADDIN ZOTERO_*` field codes, but its
native integration uses ReferenceMarks rather than Word fields; whether it adopts a
Word-field document is not something this project has tested.

### What has and has not been verified

Tested, on every build: the package is a valid `.docx` (correct CRC-32s in both zip headers,
content types, relationships, well-formed XML in every part, and the child order ECMA-376
requires inside every `w:pPr`), each citation is the five-part Word field sequence in the
right order, each instruction parses back to a Zotero payload carrying the expected item key,
locator and CSL record, `properties.plainCitation` is byte-identical to the visible text run
(Zotero compares those two on refresh and prompts "this citation was modified" when they
differ), and library text containing `&` or `<` is escaped in both the instruction and the
visible run.

Two things about the text itself, both tested: characters XML 1.0 cannot represent (a form
feed or a stray control byte, which is what a broken PDF extractor leaves in a title) are
dropped from the field code as well as from the visible run, so the two stay identical
rather than diverging into a "modified citation" prompt; and a long instruction is split
across several `instrText` runs without ever cutting a surrogate pair, so an emoji or a CJK
extension glyph in a record survives the split instead of becoming two replacement
characters in the embedded CSL data.

Not tested: that Word's Zotero plugin actually refreshes a document Zoteus wrote. There is no
Word and no Zotero word-processor plugin on the machine this was built on, so that step has
never been run. The field format, the `data-version="3"` preferences blob and the 255-character
property chunking were read off Zotero 7's own integration code rather than guessed, but
reading the source is not the same as running the plugin.

## Linked versus embedded citations

A citation is *linked* when its field carries a Zotero item URI such as
`http://zotero.org/users/19552201/items/ABCD1234`. Refreshing a linked citation re-reads the
item from your library, so edits to the item show up in the document.

Zoteus builds that URI from the library's real numeric id. It has one whenever a cloud key or
OAuth token is configured, and also on a key-free desktop install, because every item record
the local API returns carries its own `library` block with the account's real user id in it.
A group library always has one.

When it genuinely cannot find a real id (a Zotero that has never synced with zotero.org), the
fields carry the full item data but an **empty** URI list. The citations render as *embedded* references, using the data in the document instead of
links to library items. Plugin refresh of this output remains unverified, as described above. The result says so, in `linked: false` and in `warnings`. A wrong URI
(`users/0/...`, which matches nothing anywhere) is never written.

## Styles

`style` accepts the same names and ids as `zotero_styles` and
`zotero_format_bibliography`: `"apa"`, `"APA 7th"`, `"ieee"`, `"chicago author-date"`, or any
id from the CSL styles repository.

The document is **stamped with the style you asked for**, not with the independent parent that
a dependent style resolves to for rendering. That matters: the stamped URL is what Word
re-binds to on every later refresh, so stamping the parent would quietly move your document to
a style nobody chose.
