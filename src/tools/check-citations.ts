import { z } from 'zod';
import { provenance } from './common-output.js';
import type { ToolDefinition } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { okLibraryContent, resolveLibrary } from '../registry/registry.js';
import { refusal } from '../features/notes/write-note.js';
import { checkCitations, type CitationResult } from '../features/citecheck/check.js';

/** Longest draft read in one call: about 30,000 words. */
export const MAX_DRAFT_CHARS = 200_000;

const itemSummary = z
  .object({
    key: z.string().describe('Item key.'),
    title: z.string().describe('Its title.'),
    citation: z.string().describe('Zotero\'s short citation for it, e.g. "Smith, 2019".'),
  })
  .passthrough();

/** Counts per outcome, and the verdict line built from them. */
export function summarize(citations: CitationResult[]) {
  const works = citations.flatMap((c) => c.works);
  const quotes = citations.flatMap((c) => c.quotes);
  const count = <T extends { status: string }>(list: T[], s: string) => list.filter((x) => x.status === s).length;
  const summary = {
    citations: citations.length,
    works: works.length,
    matched: count(works, 'matched'),
    ambiguous: count(works, 'ambiguous'),
    notInLibrary: count(works, 'not_in_library'),
    unresolved: count(works, 'unresolved'),
    quotes: quotes.length,
    quotesFound: count(quotes, 'found'),
    quotesCloseMatch: count(quotes, 'close_match'),
    quotesNotFound: count(quotes, 'not_found'),
    quotesNoFulltext: count(quotes, 'no_fulltext'),
    quotesNotChecked: count(quotes, 'not_checked'),
  };
  const problems: string[] = [];
  if (summary.notInLibrary) problems.push(`${summary.notInLibrary} cited work(s) are not in the library`);
  if (summary.ambiguous) problems.push(`${summary.ambiguous} match several items`);
  if (summary.unresolved) problems.push(`${summary.unresolved} could not be looked up`);
  if (summary.quotesNotFound) problems.push(`${summary.quotesNotFound} quotation(s) were not found in the cited source`);
  if (summary.quotesCloseMatch) problems.push(`${summary.quotesCloseMatch} quotation(s) differ from the source's wording`);
  const head = !citations.length
    ? 'No citations were found in this part of the draft.'
    : problems.length
      ? `Needs attention: ${problems.join('; ')}.`
      : `All ${summary.works} cited work(s) resolve to library items` +
        (summary.quotesFound ? ` and all ${summary.quotesFound} checked quotation(s) appear verbatim in their sources` : '') +
        '.';
  const verdict =
    head +
    ' Only existence and exact wording were checked: whether a source supports a paraphrased claim was not checked, ' +
    'and should be read with zotero_get_fulltext before it is asserted.';
  return { summary, verdict };
}

const checkCitationsTool: ToolDefinition = {
  name: 'zotero_check_citations',
  title: 'Check a draft\'s citations and quotations against the library',
  description:
    'Check a draft (Markdown, LaTeX or plain text) for invented citations and misquotations, deterministically and without changing anything. Finds every citation: pandoc [@key, p. 12; @other], Zotero item keys [@ABCD2345], LaTeX \\cite/\\citep/\\citet/\\parencite/\\textcite/\\autocite{a,b}, author-year (Smith, 2020), (Smith & Jones, 2020, p. 4), Smith et al. (2020), numeric [3] (through the reference list) and bare DOIs. Each cited work is looked up in the library by item key, citation key (Zotero\'s Citation Key field, then Better BibTeX when it runs on this machine), DOI, or author + year (+ title words from the reference list) and reported as matched (item key, title, how), ambiguous (candidates) or not in the library. A direct quotation next to a citation (in quotation marks, or a block quote) is searched for in the cited item\'s full text, ignoring case, whitespace, line-break hyphenation, ligatures and quote/dash styles: found (with the page: exact when the PDF was read, else `pageApprox`), close match (similarity and the source\'s actual words), not found, or no full text. Paraphrased claims are NOT checked, because nothing here reads for meaning: read the passage with zotero_get_fulltext `query` before asserting support. Pass the reference list as `references`, or leave it at the end of the draft under a "References" heading. Work is paged: `max_citations` per call and `max_fulltexts` full texts read per call; call again with `start: nextStart`. Reads go to the running Zotero desktop app when it serves the library, otherwise to the cloud Web API. On a hosted or cloud-only server Better BibTeX keys cannot be looked up (only the Citation Key field), and quotations can be checked only in items whose full text Zotero has synced or whose file is in Zotero cloud storage.',
  inputSchema: {
    draft: z.string().min(1).max(MAX_DRAFT_CHARS).describe(`The draft text, up to ${MAX_DRAFT_CHARS} characters. A trailing "References" or "Bibliography" section is read as its reference list.`),
    references: z.string().max(MAX_DRAFT_CHARS).optional().describe('The reference list, when it is not at the end of the draft: one entry per line or paragraph, numbered ([1], 1.) for numeric citations.'),
    check_quotes: z.boolean().optional().describe('Verify quotations against full texts (default true). false only resolves the citations, which reads no full text.'),
    start: z.number().int().min(0).optional().describe('Index of the first citation to check (default 0). Use `nextStart` from the previous call.'),
    max_citations: z.number().int().min(1).max(200).optional().describe('Citations checked per call (default 60, max 200).'),
    max_fulltexts: z.number().int().min(1).max(20).optional().describe('Full texts read per call for quotation checks (default 5, max 20).'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      citations: z
        .array(
          z
            .object({
              index: z.number().describe('Position of the citation in the draft (0-based), across all pages.'),
              kind: z.string().describe('zotero-key, pandoc, latex, numeric, doi or author-year.'),
              cite: z.string().describe('The citation as written.'),
              line: z.number().describe('1-based line of the draft it is on.'),
              works: z
                .array(
                  z
                    .object({
                      cited: z.object({}).passthrough().describe('What the draft gave: itemKey, citekey, doi, author, year, number, locator, reference.'),
                      status: z.enum(['matched', 'ambiguous', 'not_in_library', 'unresolved']).describe('The lookup outcome.'),
                      matchedBy: z.string().optional().describe('item_key, citation_key, better_bibtex, doi, author_year or author_year_title.'),
                      item: itemSummary.optional().describe('The library item, when matched.'),
                      candidates: z.array(itemSummary).optional().describe('Up to five items that fit, when ambiguous.'),
                      note: z.string().optional().describe('Why it did not match, or what to do.'),
                    })
                    .passthrough(),
                )
                .describe('One entry per cited work in the citation.'),
              quotes: z
                .array(
                  z
                    .object({
                      text: z.string().describe('The quotation as written in the draft.'),
                      status: z.enum(['found', 'close_match', 'not_found', 'no_fulltext', 'not_checked']).describe('The verification outcome.'),
                      itemKey: z.string().optional().describe('The item whose full text was searched.'),
                      page: z.number().optional().describe('Exact 1-based page, when the PDF itself was read.'),
                      pageApprox: z.number().optional().describe('Proportional page estimate from Zotero\'s indexed text; confirm with zotero_get_fulltext.'),
                      similarity: z.number().optional().describe('close_match: similarity 0 to 1 of the closest passage.'),
                      bestSimilarity: z.number().optional().describe('not_found: similarity of the closest passage found.'),
                      sourceText: z.string().optional().describe('close_match: the source\'s actual words.'),
                      note: z.string().optional().describe('Why it was not checked, or why there is no full text.'),
                    })
                    .passthrough(),
                )
                .describe('Direct quotations attached to this citation.'),
            })
            .passthrough(),
        )
        .describe('The citations checked on this call, in draft order.'),
      summary: z.object({}).passthrough().describe('Counts per outcome for the citations on this call.'),
      verdict: z.string().describe('One plain-language line on what was found and what was not checked.'),
      totalCitations: z.number().describe('Citations found in the whole draft.'),
      start: z.number().describe('Index of the first citation on this call.'),
      nextStart: z.number().optional().describe('Pass as `start` to check the rest; absent when done.'),
      fulltextsRead: z.number().describe('Full texts read on this call.'),
      referenceEntries: z.number().describe('Reference-list entries read.'),
      unquotedClaims: z.string().describe('What was not checked: paraphrased claims.'),
      notices: z.array(z.string()).optional().describe('What was degraded or assumed.'),
      provenance,
    })
    .passthrough(),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    if (!args.draft?.trim()) return refusal('Pass the draft text as `draft`.');
    const lib = resolveLibrary(ctx, args);
    const report = await checkCitations(ctx, lib, {
      draft: args.draft,
      references: args.references,
      start: args.start ?? 0,
      maxCitations: args.max_citations ?? 60,
      maxFulltexts: args.max_fulltexts ?? 5,
      checkQuotes: args.check_quotes ?? true,
    });
    const { summary, verdict } = summarize(report.citations);
    const more =
      report.nextStart != null
        ? ` Checked citations ${report.start + 1} to ${report.nextStart} of ${report.totalCitations}: call again with start:${report.nextStart}.`
        : '';
    const structured: Record<string, unknown> = {
      citations: report.citations,
      summary,
      verdict,
      totalCitations: report.totalCitations,
      start: report.start,
      fulltextsRead: report.fulltextsRead,
      referenceEntries: report.referenceEntries,
      unquotedClaims:
        'Not checked. Claims without a direct quotation were not compared with their sources; read the passage with zotero_get_fulltext (item_key, query) before asserting that a source supports a claim.',
    };
    if (report.nextStart != null) structured.nextStart = report.nextStart;
    if (report.notices.length) structured.notices = report.notices;
    return okLibraryContent(structured, `${report.totalCitations} citation(s) found. ${verdict}${more}`);
  },
};

export default checkCitationsTool;
