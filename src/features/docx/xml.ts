/**
 * Text on its way into the OOXML: escaping, the characters that cannot go in at all, and
 * the one rule about where a string may be cut.
 *
 * Everything written into a .docx comes from a Zotero library: titles, author names,
 * abstracts, and the JSON payload built out of them. An ampersand in a journal title is
 * ordinary, and an unescaped one produces a file Word refuses to open with a parse error
 * that names a byte offset and nothing else. So there is exactly one way text reaches the
 * XML, and it is through here.
 */

/**
 * Characters XML 1.0 cannot represent at all. PDF-derived metadata carries them (form
 * feeds, vertical tabs, stray control bytes from broken extractors), and no escaping makes
 * them legal, so they are dropped. Tab, newline and carriage return are legal and stay.
 *
 * Unpaired surrogates (\p{Cs}) are dropped for the same reason: they are not characters,
 * XML cannot hold them, and `TextEncoder` turns each one into U+FFFD on its way into the
 * zip, so leaving them in corrupts the bytes instead of failing. A well-formed surrogate
 * PAIR is one astral code point under the `u` flag and is never matched here.
 */
const ILLEGAL_XML_CHARS = /(?![\t\n\r])[\p{Cc}\p{Cs}￾￿]/gu;

/**
 * Drop the characters the XML cannot carry, without escaping anything else.
 *
 * This is the half of `escapeXml` that has to be applied EARLY, before a string is turned
 * into something else. A citation's text reaches the document twice: once as the visible
 * run, where `escapeXml` drops a form feed, and once inside the JSON of the field code,
 * where `JSON.stringify` has already turned that form feed into the two ASCII characters
 * `\` and `f` that no later escaping can recognise. Zotero compares the two on every
 * refresh, so a string that is going to be JSON-encoded must come through here first or
 * the two copies stop being identical.
 */
export function stripIllegalXml(value: string): string {
  return value.replace(ILLEGAL_XML_CHARS, '');
}

/** Text content of an element: `&`, `<` and `>` escaped, illegal characters dropped. */
export function escapeXml(value: string): string {
  return stripIllegalXml(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** An attribute value: the text rules plus both quote characters. */
export function escapeXmlAttr(value: string): string {
  return escapeXml(value).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Split a string into chunks of at most `size` UTF-16 code units, never cutting a surrogate
 * pair in half.
 *
 * Both places this repo chunks a string (the `instrText` runs of a field, the 255-character
 * document properties) hand the pieces to a consumer that concatenates them back, so the
 * obvious `slice(i, i + size)` looks safe. It is not: each piece is encoded on its own by
 * `TextEncoder`, and a piece that ends on a high surrogate carries a character that no
 * longer exists. The encoder writes U+FFFD for it, and for its orphaned other half in the
 * next piece, so a single emoji in a title becomes two replacement characters in the
 * embedded CSL data with nothing reporting it. Backing the cut off by one code unit keeps
 * every pair whole; a chunk is then at most `size` and at least `size - 1`.
 */
export function chunkText(value: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < value.length; ) {
    let end = Math.min(i + size, value.length);
    // `end - 1 > i` keeps a size of 1 from backing the cut off to nothing and looping for
    // ever; such a chunk cannot hold a pair at all, and escapeXml drops the halves.
    if (end < value.length && end - 1 > i) {
      const high = value.charCodeAt(end - 1);
      const low = value.charCodeAt(end);
      if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) end -= 1;
    }
    chunks.push(value.slice(i, end));
    i = end;
  }
  return chunks;
}
