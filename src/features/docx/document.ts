import { buildZip } from './zip.js';
import { chunkText, escapeXml, escapeXmlAttr } from './xml.js';
import { chunkPrefs } from './zotero-fields.js';

/**
 * The OOXML half of the .docx emitter: paragraphs, Word fields, and the eight package
 * parts Word needs to open the file.
 *
 * This is deliberately NOT a Word document generator. There are paragraphs, an optional
 * title, and fields; there are no headings beyond the title, no tables, no images and no
 * numbering. The whole value of the file is the field codes, and every feature added here
 * is a feature that then has to be kept working against Word.
 *
 * A Word field is five parts in document order: a `begin` fldChar, one or more `instrText`
 * runs carrying the instruction, a `separate` fldChar, the cached result (what the reader
 * sees until something refreshes it), and an `end` fldChar. Get the order wrong and Word
 * shows the reader the raw JSON instruction instead of "(Devos, 2026)".
 */

/** A run of plain text, or a complete field whose result sits inside one paragraph. */
export type Piece =
  | { type: 'text'; text: string }
  | { type: 'field'; instruction: string; text: string };

export interface ParagraphBlock {
  kind: 'paragraph';
  /** A styleId from styles.xml, e.g. "Title" or "Bibliography". */
  style?: string;
  pieces: Piece[];
}

/**
 * A field whose result spans several paragraphs, which is what a bibliography is: `begin`,
 * the instruction and `separate` open the first paragraph, each entry is a paragraph, and
 * `end` closes the last one. Zotero's own plugin writes the bibliography exactly this way.
 */
export interface SpanningFieldBlock {
  kind: 'spanningField';
  instruction: string;
  paragraphs: string[];
  style?: string;
}

export type Block = ParagraphBlock | SpanningFieldBlock;

export interface DocxOptions {
  blocks: Block[];
  /** Raw Zotero prefs blob; chunked across ZOTERO_PREF_1, _2, ... by this builder. */
  prefs?: string;
  /** Document title for docProps/core.xml (the visible heading is a block like any other). */
  title?: string;
  /** Injectable so a test gets a byte-stable package. */
  now?: Date;
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
  '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
  '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
  '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>' +
  '</Types>';

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
  '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties" Target="docProps/custom.xml"/>' +
  '</Relationships>';

const DOCUMENT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>';

/**
 * Just enough styles.xml for the three styleIds this emitter uses. "Bibliography" is the
 * name Zotero's own plugin applies to bibliography paragraphs, so a document Zoteus wrote
 * and a document Word wrote format the same way after a refresh.
 *
 * Child order is not cosmetic here. CT_PPrBase, CT_RPr and CT_Style are xsd:sequence in
 * ECMA-376, so `spacing` must precede `ind` inside a `w:pPr` and a part that gets it wrong
 * is schema-invalid OOXML: Word is then entitled to drop the style or to offer to "recover"
 * the file. tests/features/docx-document.test.ts asserts the order of every w:pPr this
 * emitter writes, because well-formed XML is not the same as valid OOXML.
 */
const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Bibliography"><w:name w:val="Bibliography"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:spacing w:after="0"/><w:ind w:left="720" w:hanging="720"/></w:pPr></w:style>' +
  '</w:styles>';

const SECT_PR =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>';

/** `<w:t>` always carries xml:space="preserve": a citation is glued to the text around it. */
function textRun(text: string): string {
  return `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

function fldChar(type: 'begin' | 'separate' | 'end'): string {
  return `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`;
}

/**
 * The instruction runs of a field.
 *
 * A CSL_CITATION payload with full item data is routinely several kilobytes, and Zotero's
 * own plugin splits a long instruction across several `instrText` runs rather than writing
 * one enormous one. Word concatenates them, and other consumers of .docx are happier with
 * bounded runs, so this splits at a fixed size.
 *
 * Splitting is safe at an XML escape, because escaping happens per piece AFTER the cut, so
 * an `&amp;` can never be halved. It is NOT safe between the two halves of a surrogate
 * pair: each piece becomes bytes on its own, and a lone surrogate is not a character any
 * encoder can write, so `chunkText` moves the cut rather than losing the emoji or the CJK
 * extension glyph it was standing in.
 */
function instrRuns(instruction: string, chunk = 1000): string {
  const parts = chunkText(instruction, chunk);
  return parts
    .map((part) => `<w:r><w:instrText xml:space="preserve">${escapeXml(part)}</w:instrText></w:r>`)
    .join('');
}

function pPr(style?: string): string {
  return style ? `<w:pPr><w:pStyle w:val="${escapeXmlAttr(style)}"/></w:pPr>` : '';
}

function renderParagraph(block: ParagraphBlock): string {
  const body = block.pieces
    .map((piece) =>
      piece.type === 'text'
        ? textRun(piece.text)
        : fldChar('begin') +
          instrRuns(piece.instruction) +
          fldChar('separate') +
          textRun(piece.text) +
          fldChar('end'),
    )
    .join('');
  return `<w:p>${pPr(block.style)}${body}</w:p>`;
}

function renderSpanningField(block: SpanningFieldBlock): string {
  // An empty bibliography still needs a well-formed field, or Word shows the instruction.
  const lines = block.paragraphs.length ? block.paragraphs : [''];
  return lines
    .map((line, i) => {
      const first = i === 0;
      const last = i === lines.length - 1;
      const open = first ? fldChar('begin') + instrRuns(block.instruction) + fldChar('separate') : '';
      const close = last ? fldChar('end') : '';
      return `<w:p>${pPr(block.style)}${open}${textRun(line)}${close}</w:p>`;
    })
    .join('');
}

function documentXml(blocks: Block[]): string {
  const body = blocks
    .map((block) => (block.kind === 'paragraph' ? renderParagraph(block) : renderSpanningField(block)))
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}${SECT_PR}</w:body></w:document>`
  );
}

function coreXml(title: string | undefined, now: Date): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    (title ? `<dc:title>${escapeXml(title)}</dc:title>` : '') +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>` +
    '</cp:coreProperties>'
  );
}

const APP_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
  'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
  '<Application>Zoteus</Application></Properties>';

/**
 * docProps/custom.xml carrying the Zotero prefs.
 *
 * The fmtid is the one Word uses for every user-defined custom property, and pids are
 * sequential from 2 (0 and 1 are reserved). The chunks must stay contiguous and in order:
 * Zotero reads ZOTERO_PREF_1, _2, ... and stops at the first one that is missing, so a gap
 * silently truncates the preferences to whatever came before it and the document then looks
 * unlinked with no error anywhere.
 */
function customXml(prefs: string | undefined): string {
  const chunks = prefs ? chunkPrefs(prefs) : [];
  const properties = chunks
    .map(
      (chunk, i) =>
        `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${i + 2}" ` +
        `name="ZOTERO_PREF_${i + 1}"><vt:lpwstr>${escapeXml(chunk)}</vt:lpwstr></property>`,
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    properties +
    '</Properties>'
  );
}

/** The finished .docx as bytes. */
export function buildDocx(opts: DocxOptions): Uint8Array {
  const now = opts.now ?? new Date();
  return buildZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: documentXml(opts.blocks) },
    { name: 'word/_rels/document.xml.rels', data: DOCUMENT_RELS },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'docProps/core.xml', data: coreXml(opts.title, now) },
    { name: 'docProps/app.xml', data: APP_XML },
    { name: 'docProps/custom.xml', data: customXml(opts.prefs) },
  ]);
}
