import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { ok, optionalLibrary } from '../registry/registry.js';

const listTags: ToolDefinition = {
  name: 'zotero_list_tags',
  title: 'List Zotero tags (read-only)',
  description:
    'List tags in a Zotero library with their usage count and whether each was auto-applied by Zotero. Optional `q` substring filter and `limit`. Read-only: available even when the connector runs in read-only mode (unlike zotero_manage_tags, which also writes). For taxonomy hygiene use zotero_tag_audit. Served by the running Zotero desktop app for any library it holds, so it needs no cloud API key.',
  inputSchema: {
    q: z.string().optional().describe('Substring filter.'),
    limit: z.number().int().min(1).max(100).optional().describe('Max tags (default 100).'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      tags: z
        .array(
          z
            .object({
              name: z.string().describe('The tag itself; tag names are case-sensitive.'),
              numItems: z.number().optional().describe('Items carrying it, when the backend reports the count.'),
              auto: z.boolean().describe('True when Zotero applied it automatically rather than the reader.'),
            })
            .passthrough(),
        )
        .describe('The tags in the library, filtered by `q` when one was given.'),
      totalResults: z.number().optional().describe('Tags matching in total, not just this page.'),
    })
    .passthrough(),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const lib = optionalLibrary(args) ?? ctx.router.defaultLibrary();
    const r = await ctx.router.listTags({ library: lib, q: args.q, limit: args.limit ?? 100 });
    const tags = r.data.map((t: any) =>
      typeof t === 'string'
        ? { name: t, numItems: undefined, auto: false }
        : { name: t.tag, numItems: t.meta?.numItems, auto: t.meta?.type === 1 }, // Zotero: type 1 = automatic, 0/absent = manual
    );
    return ok({ tags, totalResults: r.totalResults }, `${tags.length} tag(s) returned.`);
  },
};

export default listTags;
