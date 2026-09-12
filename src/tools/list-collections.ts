import { collectionRow } from './common-output.js';
import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { ok, optionalLibrary } from '../registry/registry.js';

const listCollections: ToolDefinition = {
  name: 'zotero_list_collections',
  title: 'List Zotero collections (read-only)',
  description:
    'List collections in a Zotero library (key, name, parent collection key, item count). Read-only — available even in read-only mode (unlike zotero_manage_collections, which also writes). Use the keys to scope zotero_search_items (collectionKey) or zotero_tag_audit (scope.collection_keys).',
  inputSchema: {
    top: z.boolean().optional().describe('Only top-level collections.'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      collections: z
        .array(collectionRow)
        .describe('The collections in the library. Use a key to scope zotero_search_items or zotero_tag_audit.'),
    })
    .passthrough(),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const library = optionalLibrary(args);
    const r = await ctx.router.listCollections({ top: args.top, library });
    const collections = r.data.map((c: any) => ({
      key: c.key ?? c.data?.key,
      name: c.data?.name,
      parentCollection: c.data?.parentCollection ?? false,
      numItems: c.meta?.numItems,
    }));
    return ok({ collections }, `${collections.length} collection(s).`);
  },
};

export default listCollections;
