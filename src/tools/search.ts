import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { runSearch } from '../features/connector/search-fetch.js';

/**
 * The generic `search` tool ChatGPT's deep research and company knowledge call
 * (https://developers.openai.com/api/docs/mcp). Registered only when
 * ZOTEUS_SEARCH_FETCH_TOOLS is on: see selectActiveTools in src/server.ts.
 */
const search: ToolDefinition = {
  name: 'search',
  title: 'Search the Zotero library',
  description:
    'Search the Zotero library for items matching a query, for ChatGPT deep research and company knowledge. Ranks by meaning over titles, abstracts and full text when a search index has been built (zotero_index), otherwise matches titles, creators and years by keyword. Returns up to 10 results as { results: [{ id, title, url }] }; pass an `id` to `fetch` to read that item. Read-only.',
  inputSchema: {
    query: z.string().min(1).describe('What to look for: words, a topic, an author or a title.'),
  },
  outputSchema: z.object({
    results: z
      .array(
        z.object({
          id: z
            .string()
            .describe('Document id: the Zotero item key, or group:<groupId>:<KEY> in a group library. Pass it to fetch.'),
          title: z.string().describe('Item title.'),
          url: z.string().describe('Where a person can open the item: its zotero.org web library page.'),
        }),
      )
      .describe('Matching items, best first.'),
  }),
  // The same hints as zotero_search_items and zotero_get_item, which read the same data.
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  handler: async (args, ctx) => runSearch(ctx, String(args.query ?? '')),
};

export default search;
