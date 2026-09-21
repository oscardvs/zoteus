import { z } from 'zod';
import type { ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { ok, okLibraryContent } from '../registry/registry.js';
import {
  markInLibrary,
  type NoticeReport,
  type ProviderStatus,
  type ScholarList,
  type ScholarWork,
  type UpdateNotice,
} from '../features/scholar/graph.js';
import { oaQualifier, versionCaveat } from '../features/oa/provenance.js';
import { OpenAlexError } from '../features/scholar/openalex.js';
import { provenance } from './common-output.js';
// One census, shared. Whether the library already holds a work is asked by more than one
// tool now, and two crawls with two normalisations would give two answers to it.
import { libraryCensusReport, type CensusEntry, type CensusResult } from '../features/resolve/library-census.js';

/**
 * DOIs one library-wide notice check will query.
 *
 * The sweep shares a single four-permit fetcher with every Zotero read the user is making at
 * the same time, and each DOI costs roughly a fortieth of a Crossref request plus a fiftieth
 * of an OpenAlex one. Two thousand is about ninety requests, which is a wait rather than an
 * outage. Whatever it cuts is reported: the whole point of this feature is that an unchecked
 * DOI never passes for a checked one.
 */
const MAX_SWEEP_DOIS = 2000;

/**
 * What this check can and cannot see, shipped in the answer itself rather than only in docs.
 *
 * A user who runs a notice check and reads "nothing found" will reasonably conclude their
 * paper is sound. It does not follow, and the gap is large: journals that never deposited a
 * notice are invisible to both sources, neither covers literature without a DOI, and the two
 * sources' own totals differ by roughly a factor of two.
 */
const COVERAGE =
  'Coverage: two sources, both of DOI-registered records only. Crossref carries update ' +
  'notices deposited by publishers, including the Retraction Watch database it ' +
  'redistributes. OpenAlex carries its own is_retracted flag. A journal that never deposited ' +
  'a notice is invisible to both, neither covers work without a DOI, and the two disagree at ' +
  'scale. Absence here is the absence of a deposited record, not evidence that a paper is sound.';

/** The line that keeps a list of third-party records from being read as this tool's verdict. */
const NOT_A_VERDICT =
  'These are records other parties deposited, reported as records. Zoteus does not judge the ' +
  'paper: open the notice DOI and read what it says.';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** One deposited record as a phrase, with everything that qualifies it kept attached. */
function renderNotice(n: UpdateNotice): string {
  const bits = [
    n.date ?? 'no date deposited',
    n.source ? `source ${n.source}` : 'source not stated',
    n.doi ?? 'no notice DOI deposited',
  ];
  return `${n.label ?? n.type} (${bits.join(', ')})`;
}

/**
 * The DOIs a census found, mapped to the item that holds each one.
 *
 * First entry wins: a library that holds the same DOI twice gets one of them here, which is
 * what a duplicate check is for and not what this is for.
 */
function censusByDoi(census: CensusResult): Map<string, CensusEntry> {
  const map = new Map<string, CensusEntry>();
  for (const e of census.entries) if (e.doi && !map.has(e.doi)) map.set(e.doi, e);
  return map;
}

/** The same census as a plain DOI to item-key map, which is all `markInLibrary` needs. */
function censusDoiMap(census: CensusResult): Map<string, string> {
  return new Map([...censusByDoi(census)].map(([doi, e]) => [doi, e.key]));
}

/** How much of the library a scan actually saw, in the shape the output schema declares. */
function scanBlock(census: CensusResult): Record<string, unknown> {
  return {
    scanned: census.scanned,
    totalResults: census.totalResults,
    complete: census.complete,
  };
}

/** The sentence a truncated library scan has to carry, or nothing when it finished. */
function truncationLine(census: CensusResult): string {
  if (census.complete) return '';
  const of = census.totalResults !== undefined ? ` of ${census.totalResults}` : '';
  return (
    ` The library scan stopped after ${census.scanned}${of} items, so anything past that point ` +
    'was not looked at and is not covered by this answer.'
  );
}

/**
 * The prose for one DOI's notice check.
 *
 * Every branch here exists to keep three different facts apart: records were found, no record
 * was deposited, or a source was not reached. The third must never be written in the voice of
 * the second, which is why the unreached case prints the provider's own note and an explicit
 * refusal to call the result clean.
 */
function noticesSummary(r: NoticeReport): string {
  const cr = r.sources.find((s) => s.name === 'crossref')!;
  const oa = r.sources.find((s) => s.name === 'openalex')!;
  const parts: string[] = [];

  if (!cr.reached || cr.found === false) {
    parts.push(cr.note!);
  } else if (r.notices.length) {
    parts.push(
      `Crossref lists ${r.notices.length} update record${r.notices.length === 1 ? '' : 's'} for ` +
        `${r.doi}: ${r.notices.map(renderNotice).join('; ')}.`,
    );
  } else {
    parts.push(`Crossref lists no update record for ${r.doi}.`);
  }

  if (r.isNoticeFor.length) {
    parts.push(
      `This DOI is itself an update notice: Crossref records it as updating ` +
        `${r.isNoticeFor.map(renderNotice).join('; ')}. A retraction flag on this record describes ` +
        'the notice, not a retracted paper.',
    );
  }

  if (!oa.reached || oa.found === false) {
    parts.push(oa.note!);
  } else if (r.openalex?.isRetracted === true) {
    parts.push(
      `OpenAlex sets is_retracted: true on this record` +
        `${r.openalex.workType ? ` (work type "${r.openalex.workType}")` : ''}. OpenAlex sets that ` +
        'same flag on retraction notices themselves, so read it beside the work type.',
    );
  } else if (r.openalex?.isRetracted === false) {
    parts.push('OpenAlex sets is_retracted: false on this record.');
  } else {
    parts.push('OpenAlex answered but deposited no is_retracted flag on this record.');
  }

  if (r.disagreement) {
    parts.push(
      'The two sources DISAGREE about this DOI: one indicates a retraction and the other does ' +
        'not. Neither is treated as correct here, and the difference is the finding.',
    );
  }

  const unreached = r.sources.filter((s) => !s.reached).map((s) => s.name);
  if (unreached.length) {
    parts.push(
      `This is NOT a "no notices found" answer: ${unreached.join(' and ')} ` +
        `${unreached.length === 1 ? 'was' : 'were'} not reached, so part of the check did not run.`,
    );
  } else if (!r.notices.length && !r.isNoticeFor.length && r.openalex?.isRetracted !== true) {
    // "At either source" is only true when both had a record to check. A source with no
    // record of the DOI answered, but it checked nothing, and when that source is Crossref
    // it is the one where update notices (Retraction Watch's included) are deposited.
    const missing = r.sources.filter((s) => s.found === false).map((s) => s.name);
    if (missing.length === 0) {
      parts.push('No update record is deposited for this DOI at either source.');
    } else if (missing.includes('crossref')) {
      parts.push('Crossref had no record for this DOI, and Crossref is where update notices are deposited, so this check covers OpenAlex’s flag alone.');
    } else {
      parts.push('OpenAlex had no record for this DOI, so this check covers Crossref’s update records alone.');
    }
  }

  if (r.notices.length || r.isNoticeFor.length || r.openalex?.isRetracted === true) parts.push(NOT_A_VERDICT);
  parts.push(COVERAGE);
  return parts.join(' ');
}

/**
 * The sweep's prose, built on the same rule: unchecked is never written as clean.
 *
 * `asked` is how many DOIs went out, which is NOT how many came back: a failed batch leaves
 * its DOIs unanswered. So the opening sentence says "asked about" rather than "checked" the
 * moment any source fell over, and the per-source counts follow it.
 *
 * `unqueryable` counts the DOIs that never went out at all, because they carry a character a
 * query cannot hold. They are part of the same rule: a DOI nobody asked about must not be
 * inside a sentence that says the library was checked.
 *
 * `notices` counts the rows that are themselves update notices about other works. Those rows
 * are here because Crossref records them as updating something, which is the opposite of an
 * accusation, so the prose has to say so rather than leave them under the heading.
 */
function sweepSummary(
  count: number,
  asked: number,
  sources: ProviderStatus[],
  census: CensusResult,
  unqueryable = 0,
  notices = 0,
): string {
  const parts: string[] = [];
  const partial = sources.some((s) => !s.reached) || unqueryable > 0;
  if (count === 0) {
    parts.push(
      partial
        ? 'No update record was found in the part of this check that actually ran.'
        : `No update record was found for any of the ${asked} library DOIs checked against both sources.`,
    );
  } else {
    parts.push(
      `${count} of the ${asked} library DOIs asked about ${count === 1 ? 'has' : 'have'} an update ` +
        `record or a retraction flag against ${count === 1 ? 'it' : 'them'}.`,
    );
  }
  for (const s of sources) if (s.note) parts.push(s.note);
  if (unqueryable > 0) {
    parts.push(
      `${unqueryable} of the ${asked} DOIs carry a character that cannot go into a batch query ` +
        `(a separator, a '#', a '%' or whitespace), so neither source was asked about ` +
        `${unqueryable === 1 ? 'it' : 'them'} and ${unqueryable === 1 ? 'it is' : 'they are'} ` +
        'NOT checked. They are listed in `unqueryable`; check those DOIs one at a time, or fix the field.',
    );
  }
  if (notices > 0) {
    parts.push(
      `${notices} of the rows below ${notices === 1 ? 'is itself an update notice about another work' : 'are themselves update notices about other works'} ` +
        '(`isNoticeFor`). A retraction flag on such a row describes the notice, not a retracted paper.',
    );
  }
  if (partial) {
    parts.push('Because part of the check did not run, this is not a clean result for the DOIs it did not cover.');
  }
  const cut = truncationLine(census);
  if (cut) parts.push(cut.trim());
  if (count) parts.push(NOT_A_VERDICT);
  parts.push(COVERAGE);
  return parts.join(' ');
}

const scholar: ToolDefinition = {
  name: 'zotero_scholar',
  title: 'Scholarly context (references, citations, related)',
  description:
    'Explore the EXTERNAL scholarly graph around a paper (OpenAlex, Crossref fallback). This does NOT search, list, or read your Zotero library: it queries the open web, and results are works from the scholarly web, not your items. To search or inspect YOUR library use zotero_search_items, zotero_semantic_search, zotero_get_item, or zotero_list_tags instead. Provide a `doi` and an `action`: "lookup" (metadata + citation count, plus an `oa` block naming the open-access PDF OpenAlex knows of, when there is one), "references" (works this paper cites), "citations" (works that cite this paper, most-cited first), "related" (similar works), or "notices" (update notices deposited against the paper: retractions, corrections, expressions of concern, errata, withdrawals). "notices" asks Crossref, which redistributes the Retraction Watch database, and OpenAlex side by side and reports what each one says with its source and date; it never emits a verdict, there is no `retracted` field, a source that did not answer is reported as not reached rather than as "nothing found", and when the two sources disagree it says so. Set `include_in_library: true` to additionally flag which results your library already holds and hand back the item key for each (off by default because it scans the library); with action "citations" that key is the way into zotero_get_fulltext, whose `query` returns the passages where a citing paper you already hold discusses this one. Set `library_scan: true` with action "notices" to check the DOIs your library already holds against the same two sources and list only those with a record; it reports how much of the library it saw. `limit` caps results (default 20); every list answer also carries `total`, the size of the list the results were cut from, and `truncated: true` when the limit dropped some, so a review with 150 references never looks like one with 20. Read-only; calls external scholarly APIs. This is a thin citation-graph helper around a single DOI: for full OpenAlex querying (keyword search, filters, paging, `select`) call https://api.openalex.org directly, see the LLM quick reference in the OpenAlex help pages.',
  inputSchema: {
    action: z
      .enum(['lookup', 'references', 'citations', 'related', 'notices'])
      .describe(
        'What to fetch for `doi` from the external scholarly graph: "lookup" (metadata and citation count), "references" (works it cites), "citations" (works citing it, most-cited first), "related" (similar works), or "notices" (update notices deposited against it: retractions, corrections, expressions of concern, errata, withdrawals, reported as records with their source and date, never as a verdict).',
      ),
    doi: z
      .string()
      .optional()
      .describe(
        'The DOI of the paper (with or without the https://doi.org/ prefix). Required for every action except action:"notices" with library_scan:true, which asks about the DOIs your library already holds instead of one you name.',
      ),
    limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20). The answer says how many there were in total.'),
    include_in_library: z.boolean().optional().describe('Also scan the library and flag results already saved, with the item key for each (default false; scanning is expensive).'),
    library_scan: z
      .boolean()
      .optional()
      .describe(
        'action:"notices" only (default false): check the DOIs your library already holds against both sources and return only those with a record. This is an identifier check against the scholarly web, not a content search of your library; to find items by topic use zotero_search_items or zotero_semantic_search. The answer says how many DOIs were actually checked, so a short list never reads as a clean library.',
      ),
  },
  outputSchema: (() => {
    const work = z
      .object({
        title: z.string().optional().describe('Work title.'),
        doi: z.string().optional().describe('DOI, lower-cased, without the https://doi.org/ prefix.'),
        year: z.number().optional().describe('Publication year.'),
        authors: z.array(z.string()).optional().describe('Author names, in order; absent when the provider reported none.'),
        citationCount: z.number().optional().describe('Citations OpenAlex knows of.'),
        openalexId: z.string().optional().describe('OpenAlex work id.'),
        venue: z.string().optional().describe('Journal, conference or repository.'),
        type: z.string().optional().describe('OpenAlex work type, e.g. "article".'),
        inLibrary: z.boolean().optional().describe('Whether your library already holds this DOI; set only with include_in_library.'),
        libraryItemKey: z
          .string()
          .optional()
          .describe(
            'The Zotero item key holding this DOI, set only with include_in_library and only when your library has it. Pass it to zotero_get_item, or to zotero_get_fulltext with a `query` to read the passages where this paper discusses the one you asked about.',
          ),
        openalexIsRetracted: z
          .boolean()
          .optional()
          .describe(
            "OpenAlex's own is_retracted flag for this work, named for its provider because that is all it is. Not a verdict: OpenAlex sets the same flag on retraction NOTICES as on retracted papers, so read it beside `type`. action:\"notices\" is the check that puts it next to Crossref's deposited records.",
          ),
      })
      .passthrough();
    const notice = z
      .object({
        type: z
          .string()
          .describe(
            'Crossref\'s update type, verbatim: "retraction", "correction", "expression_of_concern", "withdrawal", "removal", "erratum", "new_edition", "partial_retraction", or another it may add.',
          ),
        label: z.string().optional().describe("The publisher's own label for the record, e.g. \"Retraction\"; absent when none was deposited."),
        doi: z
          .string()
          .optional()
          .describe('The DOI at the other end of the link: the notice itself under `notices`, or the work being updated under `isNoticeFor`. Open it to read what the notice actually says.'),
        date: z.string().optional().describe('The date on the update record, YYYY-MM-DD or as much of it as was deposited.'),
        source: z.string().optional().describe('Who deposited it: "publisher", or "retraction-watch" for a record from the Retraction Watch database Crossref redistributes.'),
        recordId: z.string().optional().describe("Retraction Watch's own record id, when the record came from there."),
      })
      .passthrough();
    const source = z
      .object({
        name: z.string().describe('Which source this row is about: "crossref" or "openalex".'),
        reached: z.boolean().describe('Whether it answered at all. False means nothing was learned from it, and the answer is not a clean result for what it would have covered.'),
        found: z.boolean().optional().describe('Only meaningful when reached: whether it holds a record for the DOI that was asked.'),
        status: z.number().optional().describe('The HTTP status behind reached:false, or 404 when the source simply has no such record.'),
        note: z.string().optional().describe('One sentence saying what happened, in the words the summary uses.'),
        checked: z.number().optional().describe('library_scan only: how many of the DOIs asked about this source actually answered for.'),
        asked: z.number().optional().describe('library_scan only: how many DOIs it was asked about.'),
      })
      .passthrough();
    const scan = z
      .object({
        scanned: z.number().describe('Library items the scan actually looked at.'),
        totalResults: z.number().optional().describe('Top-level items the library says it holds, when it reported a total.'),
        complete: z.boolean().describe('True only when the scan reached the end of the library. False means part of the library was never looked at, so "nothing found" says nothing about that part.'),
        withDoi: z.number().optional().describe('library_scan only: scanned items that carry a DOI. Items without one cannot be checked at all.'),
        checkedDois: z.number().optional().describe('library_scan only: distinct DOIs actually sent to the sources.'),
        truncatedDois: z.boolean().optional().describe('library_scan only: true when more library DOIs existed than one sweep will query, so some were not checked.'),
      })
      .passthrough();
    return z
      .object({
        action: z.string().describe('The action this answer is for, echoed back.'),
        doi: z.string().optional().describe('The DOI asked about, normalised.'),
        work: work.optional().describe('action:"lookup": the paper itself.'),
        results: z.array(work).optional().describe('The works on the other end of the relation, most-cited first for citations.'),
        count: z.number().optional().describe('Works returned here.'),
        total: z.number().optional().describe('Works in the list they were cut from, so 20 of 150 never reads as the whole list.'),
        truncated: z.boolean().optional().describe('True when `limit` dropped some.'),
        inLibrary: z.number().optional().describe('How many of the results your library already holds; undefined unless include_in_library was set.'),
        openalexRetractionFlags: z
          .number()
          .optional()
          .describe(
            'How many results carry OpenAlex\'s own is_retracted flag; absent when none do. A count of one source\'s flags, not a count of retracted papers: run action:"notices" on a flagged DOI to see what Crossref has actually deposited.',
          ),
        oa: z
          .object({
            url: z.string().describe('Direct link to the open-access PDF.'),
            source: z.string().optional().describe('Who hosts the copy, as OpenAlex names them, e.g. "arXiv" or "PubMed Central".'),
            version: z
              .enum(['published', 'accepted', 'submitted'])
              .optional()
              .describe('Which version this copy is: "published" (the version of record), "accepted" (the reviewed author manuscript) or "submitted" (a preprint). Absent when OpenAlex does not say.'),
            licence: z.string().optional().describe('The licence the host declares, as OpenAlex reports it, e.g. "cc-by". Absent when none is stated.'),
            landingPage: z.string().optional().describe('The human landing page for this copy, when the location has one.'),
            versionCaveat: z.string().optional().describe('Why this copy is not the publisher\u2019s version of record; absent when it is.'),
          })
          .passthrough()
          .optional()
          .describe('action:"lookup": the open-access PDF OpenAlex reports for this work. Absent when it reports none, and also absent when open access was not checked (see oaChecked). Reporting the link is read-only; attaching it is zotero_attach_file with find_oa.'),
        oaChecked: z
          .boolean()
          .optional()
          .describe('action:"lookup": whether open access was actually checked. False when OpenAlex did not answer and the metadata came from Crossref, which has no open-access verdict: a missing `oa` there is silence, not a "no".'),
        mode: z.string().optional().describe('action:"notices": "doi" for one DOI, "library" for a library_scan.'),
        title: z.string().optional().describe('action:"notices": a title for the DOI, from whichever source gave one.'),
        notices: z
          .array(notice)
          .optional()
          .describe(
            'action:"notices": update records deposited AGAINST this DOI (Crossref `updated-by`). An empty array means Crossref deposited none, which is not the same as the paper being sound; check `sources` before reading it as anything.',
          ),
        isNoticeFor: z
          .array(notice)
          .optional()
          .describe(
            'action:"notices": records showing this DOI is itself an update notice about other works (Crossref `update-to`). When this is non-empty, a retraction flag on the same DOI is describing the notice, not a retracted paper.',
          ),
        openalex: z
          .object({
            isRetracted: z.boolean().optional().describe("OpenAlex's own is_retracted flag. One source's flag, not the answer: it is also true on retraction notices themselves."),
            workType: z.string().optional().describe('OpenAlex work type. "retraction" means this record IS a notice.'),
          })
          .passthrough()
          .optional()
          .describe('action:"notices": what OpenAlex says, kept separate from what Crossref says because the two disagree at scale and neither is taken as correct here.'),
        sources: z
          .array(source)
          .optional()
          .describe(
            'action:"notices": one row per source, saying whether it answered. A source with reached:false contributed nothing, and its silence must never be read as "no notices found".',
          ),
        disagreement: z
          .boolean()
          .optional()
          .describe(
            'action:"notices": true when both sources answered with a record, the DOI is not itself a notice, and exactly one of them indicates a retraction. A fact about the two sources, never a reason to prefer one.',
          ),
        items: z
          .array(
            z
              .object({
                itemKey: z.string().describe('The Zotero item key holding this DOI. Pass it to zotero_get_item to see the record.'),
                title: z.string().optional().describe('The item title as your library stores it.'),
                doi: z.string().describe('The DOI, bare and lower-cased.'),
                notices: z.array(notice).describe('Update records deposited against this DOI.'),
                isNoticeFor: z.array(notice).describe('Records showing this item is itself an update notice about other works.'),
                openalexIsRetracted: z.boolean().optional().describe("OpenAlex's own flag for this DOI, when OpenAlex answered for it."),
                openalexType: z.string().optional().describe('OpenAlex work type. "retraction" means the item IS a notice.'),
              })
              .passthrough(),
          )
          .optional()
          .describe(
            'action:"notices" with library_scan: only the library items a source reported something about. An item absent from this list was either checked and had nothing deposited, or never checked at all; `scan` and `sources` are what tell those apart.',
          ),
        scan: z
          .optional(scan)
          .describe('How much of the library a scan actually saw. Present whenever include_in_library or library_scan ran.'),
        unqueryable: z
          .array(z.string())
          .optional()
          .describe(
            'action:"notices" with library_scan: DOIs left out of the batch queries because they carry a character a query cannot hold without changing it (a filter separator, "#", "?", "%", "+" or whitespace). They were NOT checked, and nothing in this answer says anything about them. A DOI field holding a pasted link with a "#fragment" is the usual cause: fix the field, or check those DOIs one at a time.',
          ),
        coverage: z
          .string()
          .optional()
          .describe('action:"notices": what this check can and cannot see, in one paragraph. It ships in the answer because absence of a deposited notice is not evidence that a paper is sound.'),
        checkedAt: z.string().optional().describe('action:"notices": when the sources were asked, ISO 8601. Both change under you.'),
        provenance,
      })
      .passthrough();
  })(),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    const limit = args.limit ?? 20;
    const canMatch = ctx.capabilities.cloud != null || ctx.capabilities.localApi;
    const sweep = args.action === 'notices' && args.library_scan === true;

    if (args.library_scan === true && args.action !== 'notices') {
      return err(
        `library_scan only applies to action:"notices", and this call asked for "${args.action}". ` +
          'Either drop library_scan, or call action:"notices" to check your library\'s DOIs for ' +
          'deposited update notices.',
      );
    }

    // An empty DOI is not a question anyone can answer, and asking it anyway produced a
    // fabricated answer: `works/` with no DOI is OpenAlex's 404 but Crossref's works-LIST
    // route, which answers 200, and that list envelope read as one untitled work with no
    // authors and no citations. Refused here, before either provider is asked.
    const doi = typeof args.doi === 'string' ? args.doi.trim() : '';
    if (!doi && !sweep) {
      return err(
        'A DOI is required, and `doi` was empty. Pass the paper\'s DOI, with or without the ' +
          'https://doi.org/ prefix. (zotero_scholar queries the scholarly web, not your library: ' +
          'to search your own items use zotero_search_items or zotero_semantic_search.)',
      );
    }

    if (sweep) {
      if (!canMatch) {
        return err(
          'library_scan needs a reachable library, and neither the Zotero desktop local API nor ' +
            'a cloud key is configured. Call zotero_whoami to see what this server can reach. ' +
            'A single DOI still works: action:"notices" with a `doi`.',
        );
      }
      const census = await libraryCensusReport(ctx);
      const byDoi = censusByDoi(census);
      const allDois = [...byDoi.keys()];
      const dois = allDois.slice(0, MAX_SWEEP_DOIS);
      const truncatedDois = allDois.length > dois.length;
      if (!dois.length) {
        return okLibraryContent(
          {
            action: args.action,
            mode: 'library',
            items: [],
            count: 0,
            scan: { ...scanBlock(census), withDoi: 0, checkedDois: 0, truncatedDois: false },
            sources: [],
            coverage: COVERAGE,
            checkedAt: new Date().toISOString(),
          },
          `None of the ${census.scanned} library items scanned carries a DOI, so nothing could be ` +
            `checked: both sources are DOI-only.${truncationLine(census)} ${COVERAGE}`,
        );
      }
      const report = await ctx.scholar.noticeSweep(dois);
      const findingsByDoi = new Map(report.findings.map((finding) => [finding.doi, finding]));
      const items = census.entries.flatMap((entry) => {
        const f = entry.doi ? findingsByDoi.get(entry.doi) : undefined;
        if (!f) return [];
        return [{
          itemKey: entry.key,
          title: entry.title,
          doi: f.doi,
          notices: f.notices,
          isNoticeFor: f.isNoticeFor,
          ...(f.openalexIsRetracted !== undefined ? { openalexIsRetracted: f.openalexIsRetracted } : {}),
          ...(f.openalexType !== undefined ? { openalexType: f.openalexType } : {}),
        }];
      });
      // okLibraryContent, not ok: every row here carries a title your library wrote down,
      // which is text this server did not author and must not be read as an instruction.
      return okLibraryContent(
        {
          action: args.action,
          mode: 'library',
          items,
          count: items.length,
          scan: {
            ...scanBlock(census),
            withDoi: census.entries.filter((entry) => entry.doi).length,
            checkedDois: dois.length - report.unqueryable.length,
            truncatedDois,
          },
          sources: report.sources,
          unqueryable: report.unqueryable.length ? report.unqueryable : undefined,
          coverage: COVERAGE,
          checkedAt: report.checkedAt,
        },
        sweepSummary(
          report.findings.length,
          dois.length,
          report.sources,
          census,
          report.unqueryable.length,
          items.filter((i) => i.isNoticeFor.length > 0).length,
        ) +
          (truncatedDois
            ? ` Only the first ${dois.length} of ${allDois.length} library DOIs were checked, so the rest are unchecked, not clean.`
            : ''),
      );
    }

    if (args.action === 'notices') {
      const report: NoticeReport = await ctx.scholar.notices(doi);
      const unreachable = report.sources.filter((s) => !s.reached);
      // Nothing at all was learned. Returning this as a result would put an empty `notices`
      // array in front of a model, and an empty array reads as "clean" however carefully the
      // sources block is worded, so it is an error instead.
      if (unreachable.length === report.sources.length) {
        return err(
          `Neither source answered for DOI ${doi} (` +
            report.sources.map((s) => `${s.name} ${s.status ? `HTTP ${s.status}` : 'no response'}`).join(', ') +
            '). Nothing was checked, so nothing is known either way about update notices for this ' +
            'DOI. Retry shortly.',
        );
      }
      if (report.sources.every((s) => s.reached && s.found === false)) {
        return err(
          `No scholarly record found for DOI ${doi} at Crossref or OpenAlex, so no update notice ` +
            'could be checked. Check the DOI is right; a DOI neither source has registered is not ' +
            'evidence about the paper either way.',
        );
      }
      return ok(
        {
          action: args.action,
          mode: 'doi',
          doi: report.doi,
          title: report.title,
          notices: report.notices,
          isNoticeFor: report.isNoticeFor,
          openalex: report.openalex,
          sources: report.sources,
          disagreement: report.disagreement,
          coverage: COVERAGE,
          checkedAt: report.checkedAt,
        },
        noticesSummary(report),
      );
    }

    if (args.action === 'lookup') {
      const found = await ctx.scholar.lookup(doi);
      if (!found) {
        return err(`No scholarly record found for DOI ${doi}.`);
      }
      // The open-access block rides on the same work object the provider returned; it is
      // lifted out so the documented `work` shape stays the metadata it has always been.
      const { oa, oaChecked, ...rest } = found;
      let primary: ScholarWork = rest;
      let census: CensusResult | undefined;
      if (args.include_in_library === true && canMatch) {
        census = await libraryCensusReport(ctx);
        primary = markInLibrary([primary], censusDoiMap(census))[0]!;
      }
      const caveat = oa ? versionCaveat(oa.version) : undefined;
      // Three different facts, never collapsed into one: there is a free copy, OpenAlex says
      // there is not, or nobody looked.
      const oaLine = oa
        ? ` Open-access PDF at ${oa.url} (${oaQualifier(oa)}).`
        : oaChecked === false
          ? ' Open access was not checked: OpenAlex did not answer and this record came from Crossref.'
          : ' OpenAlex reports no open-access copy.';
      // A pointer, not a claim. The flag is on the record this call already fetched, so
      // staying silent about it would be withholding the one thing that changes what the
      // reader does next; saying more than "OpenAlex sets it" would be a verdict.
      const flagLine =
        primary.openalexIsRetracted === true
          ? ' OpenAlex sets is_retracted on this record. That is one source\'s flag, and it is set on retraction notices as well as on retracted papers: action:"notices" reports what Crossref actually has deposited beside it.'
          : '';
      return ok(
        {
          action: args.action,
          doi,
          work: primary,
          oa: oa ? { ...oa, ...(caveat ? { versionCaveat: caveat } : {}) } : undefined,
          oaChecked,
          scan: census ? scanBlock(census) : undefined,
        },
        `${primary.title ?? doi}: ${primary.citationCount ?? 0} citations.${oaLine}${flagLine}` +
          (census ? truncationLine(census) : ''),
      );
    }

    let list: ScholarList;
    try {
      list =
        args.action === 'references'
          ? await ctx.scholar.references(doi, limit)
          : args.action === 'citations'
            ? await ctx.scholar.citations(doi, limit)
            : await ctx.scholar.related(doi, limit);
    } catch (e) {
      // These three actions reach OpenAlex directly, with no Crossref fallback to swallow
      // the failure, so the raw "OpenAlex 404 for https://api.openalex.org/works/doi:..."
      // used to be the answer where `lookup` gives a clean sentence. A 404 is OpenAlex
      // saying it has no such work; any other status is the service failing, and reporting
      // that as an absent record would be the same lie in the other direction.
      if (e instanceof OpenAlexError) {
        if (e.status === 404) return err(`No scholarly record found for DOI ${doi}.`);
        return err(
          `OpenAlex could not answer for DOI ${doi} (HTTP ${e.status}). That is the provider ` +
            'failing, not evidence that the record is absent. Retry shortly.',
        );
      }
      throw e;
    }
    let results = list.works;

    let census: CensusResult | undefined;
    // Opt-in (default false): the library scan pages every item, so only pay for it
    // when the caller explicitly wants inLibrary flags.
    if (args.include_in_library === true && canMatch) {
      census = await libraryCensusReport(ctx);
      // A Map rather than a Set, so each match carries the item key it matched. That key is
      // what turns "nine of these citing papers are already yours" into something actionable:
      // zotero_get_fulltext with a `query` reads the passages where each of them says it.
      results = markInLibrary(results, censusDoiMap(census));
    }

    // The count the list was cut from rides along with the page, so twenty references out
    // of a hundred and fifty read as exactly that and not as the whole list (#76).
    const truncated = list.total > results.length;
    const shown = truncated ? `${results.length} of ${list.total}` : `${results.length}`;
    const inLib = results.filter((w) => w.inLibrary).length;
    const flagged = results.filter((w) => w.openalexIsRetracted === true).length;
    const held = args.include_in_library === true && canMatch;
    const summary =
      `${shown} ${args.action} for ${doi}` +
      (held ? ` (${inLib} already in your library, ${results.length - inLib} not).` : '.') +
      // The item key is on each held result; saying so once is what makes the next step
      // obvious, and the next step is where citation context actually comes from.
      (held && inLib && args.action === 'citations'
        ? ` Each held result carries libraryItemKey: pass one to zotero_get_fulltext with a \`query\` to read the passages where that paper discusses ${doi}.`
        : '') +
      // Free: the flag is already on every work OpenAlex returned. A count and a pointer,
      // never a claim about any of them by name.
      (flagged
        ? ` ${flagged} of these carr${flagged === 1 ? 'ies' : 'y'} OpenAlex's is_retracted flag; run action:"notices" on ${flagged === 1 ? 'its' : 'their'} DOI to see what Crossref has deposited.`
        : '') +
      (census ? truncationLine(census) : '');
    return ok(
      {
        action: args.action,
        doi,
        results,
        count: results.length,
        total: list.total,
        truncated,
        inLibrary: args.include_in_library === true ? inLib : undefined,
        openalexRetractionFlags: flagged || undefined,
        scan: census ? scanBlock(census) : undefined,
      },
      summary,
    );
  },
};

export default scholar;
