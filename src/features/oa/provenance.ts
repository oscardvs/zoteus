import type { OaPdf, OaVersion } from '../scholar/openalex.js';

/**
 * How an open-access copy is described wherever it is shown.
 *
 * The whole point of this feature is that "the PDF" is not one thing. A gold copy on the
 * publisher's site is the version of record; a green copy in a repository is often the
 * author's accepted manuscript, with the same words in different places on different pages,
 * or a submitted preprint that predates review entirely. Attaching the second as though it
 * were the first is how a citation tool ends up producing page numbers that do not exist in
 * the version the reader holds. So the source, the version and the licence travel with the
 * file: into the tool result, into the attachment's title, and into the sentence the caller
 * reads.
 */

const VERSION_LABEL: Record<OaVersion, string> = {
  published: 'published version',
  accepted: 'accepted manuscript',
  submitted: 'submitted manuscript',
};

/** The version in words, including the honest answer when OpenAlex did not say. */
export function versionLabel(version?: OaVersion): string {
  return version ? VERSION_LABEL[version] : 'version not stated';
}

/**
 * Why a non-published copy is not simply "the paper", or undefined when it is the version of
 * record. Returned rather than logged: it belongs in front of whoever is about to cite it.
 */
export function versionCaveat(version?: OaVersion): string | undefined {
  if (version === 'published') return undefined;
  if (version === 'accepted')
    return 'This is the accepted manuscript, not the publisher’s version of record: the text is the reviewed one but pagination and copy-editing can differ, so do not cite page numbers from it.';
  if (version === 'submitted')
    return 'This is a submitted manuscript (a preprint), not the published paper: it predates peer review, so its text as well as its pagination can differ from the version of record.';
  return 'OpenAlex did not say which version this copy is, so it may be the author’s manuscript rather than the published paper; check it before citing page numbers.';
}

/** "arXiv, submitted manuscript, cc-by": what qualifies this copy, in one phrase. */
export function oaQualifier(oa: OaPdf): string {
  return [
    oa.source ?? 'an unnamed repository',
    versionLabel(oa.version),
    oa.licence ?? 'licence not stated',
  ].join(', ');
}

/**
 * The attachment's title in Zotero. The qualifier goes here because the tool result is read
 * once by a model and the library is read for years by a person: whoever opens this file in
 * six months has to be able to see what it is without asking anything.
 */
export function oaAttachmentTitle(oa: OaPdf): string {
  return `Open-access PDF (${oaQualifier(oa)})`;
}
