import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Same shape every prompt in this directory returns. Kept local so index.ts stays a two-line edit. */
function userMessage(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

/**
 * The evidence-table workflow: compare N studies on one question, one retrieved passage per
 * study, and render the result through zotero_evidence_table rather than by hand.
 *
 * The step order is the point. A table built from search snippets looks identical to a real
 * one and is not citable: a snippet carries no page locator, and an annotation-sourced
 * snippet can join the author's words to the reader's own comment on them. So the passage
 * step is mandatory and the coverage column is filled from what the tools returned.
 */
export function registerEvidenceTablePrompt(server: McpServer): void {
  server.registerPrompt(
    'zotero-evidence-table',
    {
      title: 'Evidence table',
      description:
        'Compare sources on one question in a table of retrieved passages, page locators and evidence status.',
      argsSchema: {
        question: z.string().describe('The research question the table answers.'),
        item_keys: z
          .string()
          .optional()
          .describe('Comma-separated item keys to compare. Omit to let the search step choose the studies.'),
        collection: z
          .string()
          .optional()
          .describe(
            'Collection name or key to take the studies from. A name is resolved to a key first: only zotero_search_items can be scoped to a collection.',
          ),
        max_items: z
          .string()
          .optional()
          .describe('How many studies to put in the table (default 5). Each study costs one zotero_get_fulltext call.'),
      },
    },
    ({ question, item_keys, collection, max_items }) => {
      const limit = max_items?.trim() || '5';
      const scope = item_keys
        ? `Use exactly these item keys: [${item_keys}]. Call zotero_get_item on each for the title, creators and date. Do not search for more.`
        : collection
          ? `Take the studies from the "${collection}" collection. Resolve that name to a collection key first with zotero_list_collections, then call zotero_search_items with collectionKey set to that key and top:true, so that child notes and attachments do not become rows. Note that zotero_semantic_search accepts only q, limit, mode and auto_build: it cannot be scoped to a collection, and an undeclared argument is refused before anything runs.`
          : `Find the studies with zotero_semantic_search, q set to the question. If meaning search is unavailable, fall back to zotero_search_items with top:true.`;

      return userMessage(
        `Build an evidence table answering "${question}" from my Zotero library, with at most ${limit} studies.\n\n` +
          `Do not skip step 2. A table whose quotations came from search snippets looks the same as a real one and is not citable.\n\n` +
          `1. Choose the studies. ${scope}\n` +
          `2. Retrieve one passage per study: one zotero_get_fulltext call per item key, with \`query\` set to the question, called sequentially rather than in parallel (Zotero rate-limits, and PDF extraction is slow). Take the quotation VERBATIM from passages[0].text. For the locator, passages[].page is a real page and pageApprox is a proportional estimate; pageSource says which this call produced, so carry that distinction into the table. When neither came back, leave the locator empty and say so: an EPUB has no fixed pages, and an item whose Zotero record reports no page count yields no estimate at all. Never invent a quotation or a page. Never reuse a zotero_semantic_search snippet as the quotation: it has no locator, and a snippet whose source is "annotation" can join the author's highlighted words to my own comment on them.\n` +
          `3. Classify coverage from what the tool actually returned, never from a guess: "passage" when the call came back in mode "passages" with at least one passage, "abstract-only" when the full text was not retrievable but zotero_get_item returned an abstractNote, "unavailable" when neither. For a structured check rather than reading an error message, zotero_get_item with include_children:true gives the attachment key and zotero_fulltext action:"get" answers found:false with indexed and total character counts.\n` +
          `4. Finding and support are your judgement and must read as judgement, not as something the source said. Support is one of supported, contradicted, uncertain or unverified. A row with no retrieved passage is "unverified", never blank and never "supported".\n` +
          `5. Render the table with zotero_evidence_table: pass the question, one row per study, and format "markdown" or "csv". The columns are Study, Finding, Quotation, Locator, Coverage and Support. Do not type the table out yourself: the tool counts the coverage summary from the rows and names any row that contradicts its own evidence. Repeat its warnings to me as it gave them, and do not edit a quotation to make a warning go away; fix the row or leave the gap visible. Pass save_path only if I asked for a file.\n` +
          `6. Add the reference list for the same item keys with zotero_bibliography.\n` +
          `7. Ask before saving anything into the library. If I confirm and a write tool is available in this session (a read-only deployment exposes none), zotero_create_items can store the rendered table as a Zotero note; that route needs a Zotero cloud API key with write access, so tell me if there is none rather than appearing to save.`,
      );
    },
  );
}
