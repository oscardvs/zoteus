import { randomBytes } from 'node:crypto';
import { chunkText, stripIllegalXml } from './xml.js';

/**
 * The Zotero side of a Word field: the instruction text a ZOTERO_ITEM / ZOTERO_BIBL field
 * carries, and the document preferences blob Zotero stores in docProps/custom.xml.
 *
 * Every shape here was read off Zotero 7's own integration code rather than guessed:
 *
 *   chrome/content/zotero/xpcom/integration.js
 *     - `setCode` writes `ITEM CSL_CITATION <json>` for a citation and
 *       `BIBL <json> CSL_BIBLIOGRAPHY` for a bibliography (note the different order).
 *     - `DATA_VERSION = 3`, and `serializeXML` emits
 *       `<data data-version="3" zotero-version="..."><session id="..."/><style id="..."
 *       locale="..." hasBibliography="1" bibliographyStyleHasBeenSet="0"/><prefs>...</prefs></data>`.
 *     - `unserializeXML` reads exactly those attributes back.
 *   Zotero_LibreOffice_Integration.oxt, org/zotero/integration/ooo/comp/Document
 *     - the word-processor layer prefixes the code with ` ADDIN ZOTERO_`.
 *   Zotero_LibreOffice_Integration.oxt, org/zotero/integration/ooo/comp/Properties
 *     - `MAX_PROPERTY_LENGTH = 255`, and the prefs blob is split across properties named
 *       `<name>_1`, `<name>_2`, ... read back by concatenation until one is missing.
 *   chrome/content/zotero/xpcom/uri.js
 *     - an item URI is `http://zotero.org/users/<userID>/items/<KEY>` or
 *       `http://zotero.org/groups/<groupID>/items/<KEY>`.
 */

/** The schema every Zotero-written CSL_CITATION payload names. */
export const CSL_CITATION_SCHEMA =
  'https://github.com/citation-style-language/schema/raw/master/csl-citation.json';

/** Zotero's own document-data version. 3 is the XML form every Word document uses. */
export const ZOTERO_DATA_VERSION = 3;

/** Word caps a custom document property at 255 characters, so Zotero chunks the prefs. */
export const MAX_PROPERTY_LENGTH = 255;

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * An 8-character alphanumeric id, the shape Zotero uses for citation ids and session ids.
 *
 * Rejection sampling rather than a modulo, so every character is equally likely: these ids
 * are compared for equality across a document and a skewed generator narrows the space for
 * no reason.
 */
export function randomFieldId(length = 8): string {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= 248) continue; // 248 = 4 * 62, the largest multiple of 62 under 256
      out += ID_ALPHABET[byte % ID_ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export interface LibraryIdentity {
  type: 'user' | 'group';
  id: number;
}

/**
 * The Zotero URI for an item, or null when the library id is not the real one.
 *
 * A key-free desktop install addresses the personal library as users/0 (see
 * src/api/local-client.ts), and `http://zotero.org/users/0/items/KEY` matches nothing in
 * any Zotero. Returning null here is what lets the caller emit an empty `uris` array and
 * say so, rather than write a URI it knows is wrong.
 */
export function itemUri(library: LibraryIdentity, itemKey: string): string | null {
  if (!hasBindableId(library)) return null;
  return `http://zotero.org/${library.type === 'group' ? 'groups' : 'users'}/${library.id}/items/${itemKey}`;
}

/** Whether this library's id is a real one, i.e. whether its items have bindable URIs. */
export function hasBindableId(library: LibraryIdentity): boolean {
  return Number.isInteger(library.id) && library.id > 0;
}

export interface CitationItemPayload {
  /** The CSL id, matching `itemData.id`, which is what citeproc keys on. */
  id: string;
  /**
   * Zotero item URIs. ALWAYS present, even empty: Zotero's fallback path for an item it
   * cannot find reads `citationItem.uris.length` directly (integration.js), so an absent
   * array throws inside the plugin instead of falling back to the embedded item data.
   */
  uris: string[];
  itemData: Record<string, unknown>;
  locator?: string;
  label?: string;
  prefix?: string;
  suffix?: string;
  'suppress-author'?: boolean;
}

export interface CitationPayload {
  citationID: string;
  properties: {
    /**
     * What the field shows. Zotero compares `plainCitation` against the field's visible
     * text on every refresh and prompts "this citation was modified" when they differ, so
     * these two must be byte-identical to the text run this field wraps.
     */
    formattedCitation: string;
    plainCitation: string;
    /** 0 for an in-text style; a footnote index for a note style. */
    noteIndex: number;
  };
  citationItems: CitationItemPayload[];
  schema: string;
}

/**
 * JSON for a field instruction, with every string in it stripped of the characters the
 * document cannot carry.
 *
 * This is where the byte-identity above is actually kept. `JSON.stringify` escapes a form
 * feed into the two ASCII characters `\` and `f`, which survive the XML escaping that would
 * have DELETED the raw character in the visible run: the field would then claim a cached
 * text the document does not contain, and Zotero's refresh would report every such citation
 * as hand-edited. Stripping before the encoding, through the same filter the run goes
 * through, is what makes the two copies agree whatever the library holds. It applies to the
 * embedded `itemData` too, which is the record Zotero falls back to for an unlinked
 * citation, so the fallback matches the document as well.
 */
function fieldJson(payload: unknown): string {
  return JSON.stringify(payload, (_key, value) =>
    typeof value === 'string' ? stripIllegalXml(value) : value,
  );
}

/** The instruction text of a ZOTERO_ITEM field, ready to go into `<w:instrText>`. */
export function citationFieldCode(payload: CitationPayload): string {
  return ` ADDIN ZOTERO_ITEM CSL_CITATION ${fieldJson(payload)} `;
}

export interface BibliographyPayload {
  uncited: string[][];
  omitted: string[][];
  custom: unknown[];
}

/** The instruction text of a ZOTERO_BIBL field. Note the json comes BEFORE the marker. */
export function bibliographyFieldCode(
  payload: BibliographyPayload = { uncited: [], omitted: [], custom: [] },
): string {
  return ` ADDIN ZOTERO_BIBL ${fieldJson(payload)} CSL_BIBLIOGRAPHY `;
}

export interface DocumentPrefsOptions {
  /** Full CSL style URL, e.g. `http://www.zotero.org/styles/apa`. */
  styleId: string;
  locale?: string;
  hasBibliography: boolean;
  sessionId: string;
  /** Zotero's own noteType pref: 0 in-text, 1 footnote, 2 endnote. */
  noteType?: 0 | 1 | 2;
}

/**
 * The `<data>` blob Zotero stores as the document's preferences.
 *
 * Attribute values are escaped the way Zotero escapes them (`&`, `<`, `>`, `"`), because
 * this string is XML in its own right that then gets escaped AGAIN when it is written into
 * the `<vt:lpwstr>` of a custom property. Double escaping is correct here and not a bug.
 */
export function documentPrefsXml(opts: DocumentPrefsOptions): string {
  const attr = (v: string) =>
    v
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  const prefs =
    `<pref name="fieldType" value="Field"/>` +
    `<pref name="automaticJournalAbbreviations" value="false"/>` +
    `<pref name="noteType" value="${opts.noteType ?? 0}"/>`;
  return (
    `<data data-version="${ZOTERO_DATA_VERSION}">` +
    `<session id="${attr(opts.sessionId)}"/>` +
    `<style id="${attr(opts.styleId)}" ` +
    (opts.locale ? `locale="${attr(opts.locale)}" ` : '') +
    `hasBibliography="${opts.hasBibliography ? '1' : '0'}" ` +
    `bibliographyStyleHasBeenSet="0"/>` +
    `<prefs>${prefs}</prefs>` +
    `</data>`
  );
}

/**
 * Split the prefs blob into the 255-character chunks Word can hold in one custom property.
 *
 * Splitting happens on the RAW string, before any XML escaping: Zotero's reader
 * concatenates the property VALUES, so a chunk boundary inside an escape sequence would
 * only be a problem if the escaping were part of the value, which it is not. A boundary
 * between the halves of a surrogate pair IS a problem, for the reason `chunkText` gives,
 * so the same splitter is used here as for the instruction runs. Today's prefs blob is a
 * style URL, a locale and generated ids and cannot hold one; it is one string away from
 * being able to.
 */
export function chunkPrefs(raw: string, size = MAX_PROPERTY_LENGTH): string[] {
  if (!raw) return [''];
  return chunkText(raw, size);
}

/** Whether a CSL style renders citations as notes (footnotes/endnotes) rather than in text. */
export function isNoteStyle(styleXml: string): boolean {
  return /<style\b[^>]*\bclass\s*=\s*"note"/.test(styleXml);
}
