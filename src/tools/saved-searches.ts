import { z } from 'zod';
import type { ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { ok, requireCloudLibrary, resolveLibrary } from '../registry/registry.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const savedSearches: ToolDefinition = {
  name: 'zotero_saved_searches',
  title: 'Manage Zotero saved searches',
  description:
    'List, create, or delete saved-search DEFINITIONS. NOTE: the Zotero cloud Web API stores saved searches but does NOT execute them — to get the items a saved search matches, run an equivalent zotero_search_items query (or use the desktop local API when available). Set `action` to "list" (all saved searches with their conditions), "create" (needs `name` and `conditions`, each `{condition, operator, value}`), or "delete" (needs `search_key`). Writes go to the cloud Web API.',
  inputSchema: {
    action: z.enum(['list', 'create', 'delete']),
    name: z.string().optional().describe('Saved-search name (create).'),
    conditions: z
      .array(z.object({ condition: z.string(), operator: z.string(), value: z.string() }))
      .optional()
      .describe('Search conditions (create).'),
    search_key: z.string().optional().describe('Saved-search key (delete).'),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    if (args.action === 'list') {
      // The caller's library_type/library_id, like every other action here (#74).
      const lib = resolveLibrary(ctx, args);
      const r = await ctx.router.listSearches({ library: lib });
      const searches = r.data.map((s: any) => ({
        key: s.key ?? s.data?.key,
        name: s.data?.name,
        conditions: s.data?.conditions ?? [],
      }));
      return ok({ searches }, `${searches.length} saved search(es). Note: the cloud API does not execute them.`);
    }

    const lib = requireCloudLibrary(ctx, args);

    if (args.action === 'create') {
      if (!args.name || !args.conditions?.length) {
        return err('`name` and at least one `conditions` entry are required for create.');
      }
      const result = await ctx.web.writeSearches(lib, [{ name: args.name, conditions: args.conditions }]);
      if (result.failed.length) return err(`Create failed: ${JSON.stringify(result.failed)}`);
      return ok(
        { created: result.successful.map((s) => s.key), libraryVersion: result.newLibraryVersion },
        `Created saved search "${args.name}".`,
      );
    }

    // delete
    if (!args.search_key) return err('`search_key` is required for delete.');
    const version = await ctx.web.currentLibraryVersion(lib);
    await ctx.web.deleteSearches(lib, [args.search_key], version);
    return ok({ deleted: args.search_key }, `Deleted saved search ${args.search_key}.`);
  },
};

export default savedSearches;
