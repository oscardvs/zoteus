import { z } from 'zod';
import { collectionRow } from './common-output.js';
import type { ToolDefinition } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { collectionListing, listingArgs, listingOutput } from './collection-listing.js';

const listCollections: ToolDefinition = {
  name: 'zotero_list_collections',
  title: 'List Zotero collections (read-only)',
  description:
    'List collections in a Zotero library (key, name, parent collection key, item count), sorted by name. Read-only: available even in read-only mode (unlike zotero_manage_collections, which also writes). Every collection in the library is read, then `q` filters by name and `start`/`limit` page the result; `totalResults` says how many there are, so a large library is never mistaken for its first page. Use the keys to scope zotero_search_items (collectionKey) or zotero_tag_audit (scope.collection_keys).',
  inputSchema: {
    top: z.boolean().optional().describe('Only top-level collections.'),
    ...listingArgs,
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      collections: z
        .array(collectionRow)
        .describe('This page of the collections, sorted by name. Use a key to scope zotero_search_items or zotero_tag_audit.'),
      ...listingOutput,
    })
    .passthrough(),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  handler: async (args, ctx) => collectionListing(ctx, args),
};

export default listCollections;
