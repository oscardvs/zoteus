# Structured extraction

Large literature analyses need the same handful of facts from every paper: sample size, method, country, outcome. Zotero has no custom fields, so Zoteus keeps them in a child note on each paper. A note syncs like everything else in Zotero, shows up in the item pane, and can be read by anyone in the group without Zoteus.

Two tools do this:

| Tool | What it does | Hints |
|---|---|---|
| `zotero_save_extraction` | Saves named fields for one or many papers (at most 50 per call) as a child note per paper. | writes, not destructive |
| `zotero_extraction_table` | Gathers every saved extraction for a collection, for given items, or for the whole library into one table. | read-only |

The server has no language model. The assistant reads each paper (with `zotero_get_fulltext`) and supplies the values; Zoteus stores them, checks the quotes, and lays them out.

## Saving

```json
{
  "schema": "rct-review",
  "items": [
    {
      "item_key": "ABCD2345",
      "fields": [
        { "name": "sample_size", "value": 120, "quote": "We randomised 120 participants", "page": "3" },
        { "name": "country", "value": "Kenya" },
        { "name": "blinded", "value": false }
      ]
    }
  ]
}
```

- `schema` names the extraction. One note per paper and schema; papers saved under the same schema form one table.
- A value is a string, a number or a boolean. `null` removes the field.
- `quote` and `page` are optional. When a quote is given and the paper's text is available, the quote is checked against it.

Saving again for the same paper and schema **updates that note in place**. Fields you send replace fields of the same name, fields you do not mention are kept (pass `replace_all: true` to drop them), and the result lists every value that was replaced or removed, with the value it held, under `items[].replaced` and `items[].removed`. If nothing changed, nothing is written (`status: "unchanged"`). A version conflict (someone saved the note in between) is merged onto their copy once, never written over it. Nothing else in the library is touched, which is why the tool is not marked destructive.

### Quote checks

Each quote gets one of three verdicts, stored beside the value:

| Verdict | Meaning |
|---|---|
| `verified` | The quote occurs in the paper's text. With a PDF read directly, the page it was found on is stored too (`foundPage`), when exactly one page holds it. |
| `not-found` | The text was read and the quote is not in it. The value is still saved, and the result names the field so the assistant can correct it. |
| `unchecked` | No text to check against (no attachment, a scan with no text layer, a file over the 20 MB on-the-fly limit), a quote under 12 characters, or `verify_quotes: false`. `checkNote` says which. |

The text comes from the same places `zotero_get_fulltext` reads: Zotero's full-text index first, then the PDF or EPUB itself. OCR is not run. Matching ignores case, whitespace, typographic quotes and dashes, ligatures and end-of-line hyphenation, and a quote trimmed with `...` must match fragment by fragment, in order. It is an occurrence check, nothing more: a verified quote proves the words are in the paper, not that the value is a fair reading of them. Formulas and symbols extracted differently by different PDF readers can come out `not-found` even when they are there.

## The note

The note is titled `Extraction: <schema>` and holds:

1. a table, one row per field: field, value, source quote, page, quote check;
2. a "Machine-readable copy" heading and a code block with the same extraction as JSON, marked `"zoteus-extraction": 1`.

It carries the tag `zoteus-extraction`. `zotero_extraction_table` finds notes by that tag and reads the JSON block, not the table. If you correct a value by hand in Zotero, edit both, or save it again through Zoteus. Removing the tag hides the note from the table.

## The table

`zotero_extraction_table` takes `schema` (optional when only one exists in scope), and `collection_key` or `item_keys` (or neither, for the whole library), plus an optional `fields` list to choose and order the columns.

It returns:

- `rows`: one per paper, each field with its value, quote, page and verdict;
- `missingItems`: papers in the collection or in `item_keys` with no extraction under this schema;
- `missingFields`: per paper, the columns it has no value for;
- `markdown`: the table, with `(missing)` in empty cells and `[quote not found]` after a value whose quote failed the check;
- `csv`: RFC 4180, with four columns per field (value, quote, page, quote check). A cell that a spreadsheet would run as a formula is written with a leading apostrophe and named in `warnings`, as in [evidence tables](./evidence-tables.md).

A collection is read one level deep: papers filed in its subcollections are not included.

## Where it works

Both tools take `library_type` and `library_id`, so they work in group libraries. Writes go to the running Zotero desktop app (Zotero 10 or newer) for your own library and every group it holds, and to the cloud Web API otherwise, as every note write does ([writing](./writing.md)). Reads follow the usual routing. On Zotero 9 and earlier the desktop's local API is read-only, so saving needs a cloud API key; the table works on either.

[Evidence tables](./evidence-tables.md) · [Notes](./notes.md) · [Safe writes](./writing.md)
