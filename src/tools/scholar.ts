import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolHandlerResult } from '../registry/registry.js';
import { ok } from '../registry/registry.js';
import { markInLibrary, type ScholarList } from '../features/scholar/graph.js';
import { OpenAlexError } from '../features/scholar/openalex.js';

const MAX_LIB_ITEMS = 5000;

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

async function libraryDoiSet(ctx: ToolContext): Promise<Set<string>> {
  const set = new Set<string>();
  let start = 0;
  for (;;) {
    const page = await ctx.router.searchItems({ limit: 100, start });
    for (const it of page.data) {
      const doi = (it as any).data?.DOI ?? (it as any).DOI;
      if (doi) set.add(String(doi).toLowerCase());
    }
    start += page.data.length;
    if (!page.data.length || start >= page.totalResults || start >= MAX_LIB_ITEMS) break;
  }
  return set;
}

const scholar: ToolDefinition = {
  name: 'zotero_scholar',
  title: 'Scholarly context (references, citations, related)',
  description:
    'Explore the EXTERNAL scholarly graph around a paper (OpenAlex, Crossref fallback). This does NOT search, list, or read your Zotero library — it queries the open web, and results are works from the scholarly web, not your items. To search or inspect YOUR library use zotero_search_items, zotero_semantic_search, zotero_get_item, or zotero_list_tags instead. Provide a `doi` and an `action`: "lookup" (metadata + citation count), "references" (works this paper cites), "citations" (works that cite this paper, most-cited first), or "related" (similar works). Set `include_in_library: true` to additionally flag which results your library already holds (off by default because it scans the library); otherwise every result is just a web record. `limit` caps results (default 20); every list answer also carries `total`, the size of the list the results were cut from, and `truncated: true` when the limit dropped some, so a review with 150 references never looks like one with 20. Read-only; calls external scholarly APIs. This is a thin citation-graph helper around a single DOI: for full OpenAlex querying (keyword search, filters, paging, `select`) call https://api.openalex.org directly, see the LLM quick reference in the OpenAlex help pages.',
  inputSchema: {
    action: z
      .enum(['lookup', 'references', 'citations', 'related'])
      .describe(
        'What to fetch for `doi` from the external scholarly graph: "lookup" (metadata and citation count), "references" (works it cites), "citations" (works citing it, most-cited first), or "related" (similar works).',
      ),
    doi: z.string().describe('The DOI of the paper (with or without the https://doi.org/ prefix).'),
    limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20). The answer says how many there were in total.'),
    include_in_library: z.boolean().optional().describe('Also scan the library and flag results already saved (default false; scanning is expensive).'),
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
      })
      .passthrough();
  })(),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const limit = args.limit ?? 20;
    // An empty DOI is not a question anyone can answer, and asking it anyway produced a
    // fabricated answer: `works/` with no DOI is OpenAlex's 404 but Crossref's works-LIST
    // route, which answers 200, and that list envelope read as one untitled work with no
    // authors and no citations. Refused here, before either provider is asked.
    const doi = args.doi.trim();
    if (!doi) {
      return err(
        'A DOI is required, and `doi` was empty. Pass the paper\'s DOI, with or without the ' +
          'https://doi.org/ prefix. (zotero_scholar queries the scholarly web, not your library: ' +
          'to search your own items use zotero_search_items or zotero_semantic_search.)',
      );
    }

    if (args.action === 'lookup') {
      let primary = await ctx.scholar.lookup(doi);
      if (!primary) {
        return err(`No scholarly record found for DOI ${doi}.`);
      }
      const canMatch = ctx.capabilities.cloud != null || ctx.capabilities.localApi;
      if (args.include_in_library === true && canMatch) {
        primary = markInLibrary([primary], await libraryDoiSet(ctx))[0]!;
      }
      return ok({ action: args.action, work: primary }, `${primary.title ?? doi}: ${primary.citationCount ?? 0} citations.`);
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

    const canMatch = ctx.capabilities.cloud != null || ctx.capabilities.localApi;
    // Opt-in (default false): the library scan pages every item, so only pay for it
    // when the caller explicitly wants inLibrary flags.
    if (args.include_in_library === true && canMatch) {
      results = markInLibrary(results, await libraryDoiSet(ctx));
    }

    // The count the list was cut from rides along with the page, so twenty references out
    // of a hundred and fifty read as exactly that and not as the whole list (#76).
    const truncated = list.total > results.length;
    const shown = truncated ? `${results.length} of ${list.total}` : `${results.length}`;
    const inLib = results.filter((w) => w.inLibrary).length;
    const summary = `${shown} ${args.action} for ${doi}` +
      (args.include_in_library === true && canMatch ? ` (${inLib} already in your library, ${results.length - inLib} not).` : '.');
    return ok(
      {
        action: args.action,
        doi,
        results,
        count: results.length,
        total: list.total,
        truncated,
        inLibrary: args.include_in_library === true ? inLib : undefined,
      },
      summary,
    );
  },
};

export default scholar;
