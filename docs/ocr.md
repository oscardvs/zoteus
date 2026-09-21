# Scanned PDFs and OCR

A scanned PDF is a picture of a page. It has no text layer, so nothing can extract text
from it: not Zotero, not Zoteus, not `pdftotext`. Zoteus now does two separate things about
that, and it is worth keeping them apart, because the first one is always available and the
second one is not.

1. **It says so precisely, always.** Ask `zotero_get_fulltext` for a PDF with no text layer
   and it tells you that it is a scan rather than a corrupt file, how many pages it has,
   what the file stores instead of text, and the three ways to read it. That needs no
   configuration and no extra software.
2. **It can read one, if you install an OCR engine.** `ocr:true` renders a few pages and
   recognises the text on them. The engine is not shipped with Zoteus and is off by
   default. This half is optional, and what it produces is a machine's reading of a
   picture, which is not the same thing as the publisher's text.

## What the answer looks like with no engine installed

```
No extracted full text for attachment ABCD1234 (Zotero has not indexed it). This PDF has
no text to extract: not one of its 312 pages carries a text layer, and the file stores its
pages as JPEG images, which is what a scanner produces. It is a scan, not a corrupt file.
Zoteus can read a scan with OCR, which is off until you switch it on, because the engine is
a separate install: `npm i tesseract.js`, then start Zoteus with ZOTEUS_OCR=auto and call
again with ocr:true (8 pages a call). Otherwise, zotero_pdf_images mode:"pages" renders the
pages as pictures you can read right now, and running the file through an OCR tool outside
Zotero (OCRmyPDF, Acrobat, ABBYY, or the Zotero OCR plugin) writes a real text layer into
it, which Zotero then indexes and this tool returns like any other PDF.
```

The three remedies are listed in the order of how much they cost you:

| Remedy | Needs | Gives you |
| --- | --- | --- |
| `zotero_pdf_images mode:"pages"` | nothing | the page as a picture the model reads directly. Costs image tokens, no text, no quoting |
| `zotero_get_fulltext ocr:true` | an OCR engine installed locally | text with exact page numbers, a few pages a call, stored nowhere |
| An OCR tool outside Zotero | OCRmyPDF, Acrobat, ABBYY, or the Zotero OCR plugin | a real text layer written into the file, which Zotero indexes: searchable forever after |

Writing a text layer into the file is the right answer for a book you will come back to:
Zotero has no OCR of its own, but it indexes the text layer whatever put it there. OCR here
is the right answer for a scan you are reading now and want to quote with a page number.

How the file is classified, and what the classification is worth: Zoteus reads the PDF's
own object dictionaries, which is free, and reports what it finds. Pages stored as JPEG,
JPEG 2000, CCITT fax or JBIG2 images are what scanner software writes, so that is called a
scan. Text painted as hundreds of 1-bit stencil glyphs is a scan stored letter by letter.
A file with neither text nor images is empty, corrupt, or had its text converted to vector
outlines, which print-ready PDFs do and which no text extractor can read. That last one is
the only reading that is a guess, and it is reported as a guess.

## Turning OCR on

Two steps, both deliberate, neither done for you.

```bash
npm i tesseract.js          # the engine: wasm, and not a dependency of Zoteus
export ZOTEUS_OCR=auto      # then restart Zoteus
```

Then call the tool with `ocr:true`:

```json
{ "item_key": "ABCD1234", "query": "cavitation threshold", "ocr": true }
```

| Setting | Default | What it does |
| --- | --- | --- |
| `ZOTEUS_OCR` | `off` | `auto` means "use OCR when the engine resolves, and say clearly when it does not". `off` is a hard off: `ocr:true` is refused with the two steps above. |
| `ZOTEUS_OCR_PATH` | (unset) | Where to resolve `tesseract.js` from when the install cannot see it itself, notably a `.mcpb` desktop bundle. Point it at a `node_modules` directory holding the package, at the package directory, or at an npm prefix whose modules live under `lib/node_modules`. Exactly what `ZOTEUS_TRANSFORMERS_PATH` does for the embedder. |
| `ZOTEUS_OCR_MAX_PAGES` | `8` | Pages one call may read. Recognition is seconds a page, and an MCP tool call that runs for minutes looks like a hang to every client. |
| `ZOTEUS_OCR_LANGS` | `eng` | Tesseract language codes, `+`-separated: `eng`, `eng+deu`, `fra`. Each one is a separate trained-data file. |

### Why the engine is not bundled

`package.json` declares exactly one optional dependency, `pdfjs-dist`, and it earns that
place because four features sit on the default path through it. An OCR engine does not: the
wasm core and one language pack together are tens of megabytes that every `npm install`,
every desktop bundle and every Docker image would carry for something most libraries never
need. So it is loaded at runtime from wherever it is installed, the same way
`@huggingface/transformers` is for on-device embeddings, and its absence is a reportable
state with an install line rather than a crash.

### The language pack, and the one time it needs the network

Tesseract needs a trained-data file per language, roughly 10 to 25 MB each, which
`tesseract.js` downloads on first use. Zoteus points that cache at `<data dir>/ocr`, so
deleting the Zoteus data directory remains the whole uninstall, and so the download happens
once rather than once per run. Until it has happened, the first OCR call needs network
access; after it, OCR works offline. On a machine with no network, put the `.traineddata`
file into `<data dir>/ocr` yourself.

## What you get back

The OCR text arrives as one string per page, in page order, which is exactly the shape
text-layer extraction arrives in. Everything downstream therefore works unchanged:

- `passages[].page` is an **exact** page, and `pageSource` says `"exact"`. The document text
  IS the pages joined together, so the page is read straight off the passage's own character
  offset: it is the page the passage was cut from, by construction, and no search can put it
  on the wrong one. There is no `pageApprox` beside it. A proportional estimate would be
  meaningless here anyway, since the text covers only the pages this call read while
  `totalPages` counts the whole book.
- `page_range:"4-6"` returns those pages and no others, and reads only those pages. A span
  that lies past the last page is refused with the document's real page count.
- `totalPages` is the document's real page count, including the pages this call did not read.
- `fulltextSource` is `"ocr"`, which is how you tell OCR text apart from publisher text
  anywhere it surfaces. Every mode says so in its first sentence as well, so OCR text is
  never described the way a real text layer is.

The `notice` says which pages were read, with which engine, how long it took, which pages
the cap left for the next call and the exact `page_range` to ask for them with, and which
pages came back with no text at all.

## What it does not do

**It does not make your scans searchable.** Nothing OCR produces is stored: not in Zotero,
not in the Zoteus search index. `zotero_semantic_search` will not find it. The text is in
the answer to that one call and nowhere else.

There is a loop that does persist it, built out of tools that already exist:

1. `zotero_get_fulltext` with `ocr:true` to get the text.
2. `zotero_fulltext action:"set"` to write it into the attachment's full text in your
   Zotero account. This is a real change to your library and it needs a Zotero cloud key.
3. `zotero_index action:"update"`, after which semantic search finds the item like any
   other, marked `source:"fulltext"`.

That loop is manual on purpose. Step 2 writes into somebody's library, and a read-only tool
that quietly mutated your Zotero account to make its own output persist would be the wrong
default whatever the convenience.

Even after that loop, a semantic hit carries **no page**: the search index stores passages
without a page locator, for OCR text and publisher text alike. Getting a page still means
calling `zotero_get_fulltext` with the hit's snippet as the `query`. Putting a page into
the index is a schema change to the passages table with a migration behind it, and it is
not part of this.

**It does not make a scan annotatable.** `zotero_annotate` places a highlight from
per-character geometry that pdfjs reads out of the text layer, and a scanned page has none.
OCR makes a passage quotable and citable; it does not make it highlightable.

**It is not as good as real text.** Recognition mistakes are normal: `enêrgy` for `energy`,
`rn` for `m`, a dropped ligature. Quote from it with that in mind, and check the page image
with `zotero_pdf_images` when the words matter.

## Bounds, and why each one is there

- **Pages a call.** `ZOTEUS_OCR_MAX_PAGES`, 8 by default. Pass `page_range` to choose which
  pages; without one the call starts at page 1. What the cap leaves out is named in the
  notice along with the `page_range` to ask for it with, so a 300-page book is read in
  deliberate steps rather than in one call that times out.
- **One job at a time.** Rendering pages and recognising them are the two largest
  allocations this process makes, and they are serialised so two of them never peak
  together. On a small machine that is the difference between a slow answer and an
  out-of-memory kill for everybody using it.
- **Under Electron, at most 2 pages a call.** Claude Desktop runs the server inside an
  Electron utility process, where Chromium's allocator kills the process outright rather
  than refusing an allocation: no error, no stack, nothing logged. The cap keeps the
  largest single allocation well inside what it will serve, and the notice says when it
  lowered a number you set. This is the same shape of answer the local embedder uses.
- **20 MB a file.** The same ceiling every path that opens a PDF has. A scan is the file
  type most likely to exceed it, and OCR is not an exception to it.
- **Resolution.** Pages are rendered at 300 dpi, which is what Tesseract is trained for.

## On a shared or hosted Zoteus

OCR is off by default there, like everywhere else, and only the operator can turn it on.
That is a feature flag rather than a refusal: an operator who installs the engine and sets
`ZOTEUS_OCR=auto` gets OCR for their users, bounded by the same per-call page cap.

It is off by default for a reason worth stating: recognition is seconds of CPU per page on
a machine every user shares, and the hosted tier already halves its image decode limit to
16 megapixels, which a 600 dpi scan exceeds on its own. pdfjs removes an image above that
ceiling and renders the page as blank white paper, so such a scan OCRs to nothing at all;
the notice names the ceiling and the file's own pixel count when that is what happened,
rather than reporting a blank page or the wrong language. A caller on a shared server who
hits a scan is told that the operator has it switched off and is pointed at
`zotero_pdf_images`, and is never told to install anything on a machine they do not own.

## When something goes wrong

| What you see | What it means |
| --- | --- |
| `tesseract.js is not installed` | The engine is not reachable. The message carries the install line, and names `ZOTEUS_OCR_PATH` and the directory it searched when one is set. |
| `OCR is switched off on this shared Zoteus` | `ZOTEUS_OCR` is `off` on a server you do not run. |
| `could not start a worker for language "..."` | The language data is missing and could not be downloaded. Check `ZOTEUS_OCR_LANGS` and whether the machine has network access for its first run. |
| `Pages 3, 4 were rendered and recognised as no text at all` | Those pages are blank, or they are in a language `ZOTEUS_OCR_LANGS` does not name. |
| `this file holds a 33.7 megapixel image and this server decodes at most 16.8` | The page image is above pdfjs's decode ceiling, so it was dropped and the page rendered as blank white paper. Nothing is wrong with the file or the language. Only the operator can raise the ceiling (it is 16.8 megapixels on a shared server, 40 locally); a 300 dpi copy of the scan reads as it is. |
| `pages 50-60 are beyond the document, which has 3 pages` | The `page_range` asked for pages the file does not have. Nothing was rendered. |
| `it holds no embedded images either` | Not a scan. Either an empty or corrupt file, or one whose text was converted to vector outlines. OCR can still read outlines, since it reads the rendered page. |

## Related

- [`grounding.md`](./grounding.md) for `zotero_pdf_images` and reading pages as pictures.
- [`semantic-search.md`](./semantic-search.md) for what does and does not reach the index.
