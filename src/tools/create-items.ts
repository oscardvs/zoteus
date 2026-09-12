import { z } from 'zod';
import { newLibraryVersion, writeFailures } from './common-output.js';
import type { ToolDefinition } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { ok, requireCloudLibrary } from '../registry/registry.js';
import { itemsArraySchema } from '../schema/item-payload.js';

const itemDataExample: Record<string, unknown> = {
  itemType: 'journalArticle',
  title: 'The Role of Metadata in Machine Learning',
  creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' }],
  date: '2024-01-15',
  DOI: '10.1234/example.5678',
  tags: [{ tag: 'ml' }],
  collections: ['ABCD1234'],
};

const createItems: ToolDefinition = {
  name: 'zotero_create_items',
  title: 'Create or update Zotero items',
  description:
    'Create new items or update existing ones in a single batch (the server auto-chunks into groups of 50). `items` is an ARRAY of item-data objects; each object has `itemType` as a **plain string** (e.g. "journalArticle", "book", "preprint", "report") plus its valid fields, `creators` (each `{creatorType, firstName, lastName}` or `{creatorType, name}`), `tags` (`[{tag}]`), and `collections` (array of 8-char collection keys). To UPDATE an existing item, also include its `key` and current `version`; to CREATE, omit both. Every item is validated against the Zotero schema before anything is sent — if any item is invalid, nothing is written and the problems are returned. Use zotero_schema to discover valid fields/creator types for an itemType. Writes go to the cloud Web API (requires ZOTERO_API_KEY). To write to a GROUP library, pass its numeric `library_id` (from zotero_groups) together with `library_type:"group"`. `library_type` alone is not enough, and the key needs write access to that group. Collection keys are per-library, so take them from zotero_list_collections with the same `library_id`.\n\nExample:\n```json\n{"items": [{"itemType": "journalArticle", "title": "The Role of Metadata in Machine Learning", "creators": [{"creatorType": "author", "firstName": "Ada", "lastName": "Lovelace"}], "date": "2024-01-15", "DOI": "10.1234/example.5678", "tags": [{"tag": "ml"}], "collections": ["ABCD1234"]}]}\n```',
  inputSchema: {
    items: itemsArraySchema.describe(
      `Array of Zotero item-data objects (itemType + fields; include key+version to update). Example: ${JSON.stringify({ items: [itemDataExample] })}`,
    ),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      created: z
        .array(
          z
            .object({
              key: z.string().describe('Key of the item written.'),
              version: z.number().optional().describe('Its version after the write.'),
            })
            .passthrough(),
        )
        .describe('One entry per item Zotero accepted, created or updated.'),
      failed: writeFailures,
      libraryVersion: newLibraryVersion,
    })
    .passthrough(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const lib = requireCloudLibrary(ctx, args);
    const problems: string[] = [];
    for (let i = 0; i < args.items.length; i++) {
      const v = await ctx.schema.validateItem(args.items[i]);
      if (!v.valid) problems.push(`items[${i}]: ${v.errors.join('; ')}`);
    }
    if (problems.length) {
      return {
        content: [{ type: 'text', text: `Validation failed; nothing was written:\n- ${problems.join('\n- ')}` }],
        isError: true,
      };
    }
    const result = await ctx.web.writeItems(lib, args.items);
    const created = result.successful.map((s) => ({ key: s.key, version: s.version }));
    const summary =
      `Wrote ${result.successful.length} item(s)` +
      (result.failed.length ? `; ${result.failed.length} failed.` : '.');
    return ok(
      { created, failed: result.failed, libraryVersion: result.newLibraryVersion },
      summary,
    );
  },
};

export default createItems;
