import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { FETCH_MAX_CHARS, runFetch } from '../features/connector/search-fetch.js';

/**
 * The generic `fetch` tool ChatGPT's deep research and company knowledge call
 * (https://developers.openai.com/api/docs/mcp). Registered only when
 * ZOTEUS_SEARCH_FETCH_TOOLS is on: see selectActiveTools in src/server.ts.
 */
const fetchTool: ToolDefinition = {
  name: 'fetch',
  title: 'Read a Zotero item',
  description: `Read one Zotero item by the \`id\` that \`search\` returned: its metadata (title, creators, date, venue, DOI, abstract) followed by as much of its full text as Zotero or the attached PDF/EPUB gives (up to ${FETCH_MAX_CHARS.toLocaleString('en-US')} characters). Returns { id, title, text, url, metadata }. Read-only.`,
  inputSchema: {
    id: z.string().min(1).describe('A document id from search: the Zotero item key, or group:<groupId>:<KEY>.'),
  },
  outputSchema: z.object({
    id: z.string().describe('The document id, as search returned it.'),
    title: z.string().describe('Item title.'),
    text: z.string().describe('Metadata header, then the full text when there is any.'),
    url: z.string().describe('Where a person can open the item: its zotero.org web library page.'),
    metadata: z
      .record(z.unknown())
      .optional()
      .describe("Item type, key, date, creators, DOI, the item's own URL, and where the text came from (`fulltext`)."),
  }),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  handler: async (args, ctx) => runFetch(ctx, String(args.id ?? '')),
};

export default fetchTool;
