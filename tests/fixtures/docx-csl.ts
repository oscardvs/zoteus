/**
 * Small but real CSL for the .docx tests.
 *
 * These go through the actual citeproc-js, not a mock. Mocking citeproc would let the two
 * things the field format depends on slip through untested: that `properties.plainCitation`
 * is byte-identical to the text run it wraps, and that a locator reaches the renderer at
 * all. A hand-written style is enough for both and keeps the tests offline.
 */

/** An author-date style with a locator and year-suffix disambiguation. */
export const AUTHOR_DATE_STYLE = `<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0" demote-non-dropping-particle="never">
 <info><id>test-author-date</id><title>Test Author Date</title><updated>2026-01-01T00:00:00Z</updated></info>
 <macro name="year"><date variable="issued"><date-part name="year"/></date><text variable="year-suffix"/></macro>
 <citation disambiguate-add-year-suffix="true">
  <layout prefix="(" suffix=")" delimiter="; ">
   <names variable="author"><name form="short"/></names>
   <text macro="year" prefix=", "/>
   <group prefix=", "><label variable="locator" form="short"/><text variable="locator" prefix=" "/></group>
  </layout>
 </citation>
 <bibliography><layout><names variable="author"/><text macro="year" prefix=" ("  suffix=")"/><text variable="title" prefix=". "/></layout></bibliography>
</style>`;

/** The same thing declared class="note", which is what triggers the footnote warning. */
export const NOTE_STYLE = AUTHOR_DATE_STYLE.replace('class="in-text"', 'class="note"').replace(
  '<id>test-author-date</id>',
  '<id>test-note</id>',
);

/** Enough locale terms for citeproc to build a name and a page label. */
export const LOCALE = `<?xml version="1.0"?><locale xmlns="http://purl.org/net/xbiblio/csl" version="1.0" xml:lang="en-US">
 <style-options punctuation-in-quote="true"/>
 <terms>
  <term name="et-al">et al.</term>
  <term name="and">and</term>
  <term name="page" form="short"><single>p.</single><multiple>pp.</multiple></term>
  <term name="chapter" form="short"><single>chap.</single><multiple>chaps.</multiple></term>
 </terms>
</locale>`;

/** A CSL-JSON record whose title carries the two characters XML cannot hold literally. */
export const AMPERSAND_ITEM = {
  id: 'ignored-by-the-tool',
  type: 'article-journal',
  title: 'Ships & Shoes < Sealing Wax',
  'container-title': 'Journal of R&D',
  author: [{ family: 'Wu', given: 'Wen' }],
  issued: { 'date-parts': [[2026]] },
};

/**
 * A record carrying the bytes a broken PDF extractor leaves behind: a form feed in the
 * author's name, a vertical tab in the title. XML 1.0 cannot represent either of them, so
 * they have to leave the document by the same door on BOTH routes, the visible run and the
 * JSON of the field code, or Zotero reads every such citation as hand-edited.
 */
export const CONTROL_CHAR_ITEM = {
  id: 'ignored-by-the-tool',
  type: 'article-journal',
  title: 'DeepLearning for robots',
  author: [{ family: 'Devos', given: 'Oscar' }],
  issued: { 'date-parts': [[2026]] },
};

export const PLAIN_ITEM = {
  id: 'ignored-by-the-tool',
  type: 'article-journal',
  title: 'On Kalman filters',
  author: [{ family: 'Devos', given: 'Oscar' }],
  issued: { 'date-parts': [[2026]] },
};

export const SECOND_2026_ITEM = {
  id: 'ignored-by-the-tool',
  type: 'article-journal',
  title: 'A second 2026 paper by the same author',
  author: [{ family: 'Devos', given: 'Oscar' }],
  issued: { 'date-parts': [[2026]] },
};
