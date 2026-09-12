import { z } from 'zod';
import { writeFailures } from './common-output.js';
import type { ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { ok, requireCloudLibrary, resolveLibrary, requireBulkConfirm } from '../registry/registry.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const manageTags: ToolDefinition = {
  name: 'zotero_manage_tags',
  title: 'Manage Zotero tags',
  description:
    'List tags, or add/remove tags on items. Set `action` to "list" (returns library tags; supports `q` substring filter), "add" (add `tags` to each of `item_keys`), or "remove" (remove `tags` from each of `item_keys`). Tags are stored on the parent item\'s tag array, so add/remove edits the items (cloud Web API). Tag names are case-sensitive. When the server sets a bulk-write threshold (ZOTEUS_CONFIRM_BULK_WRITES, off by default), editing more items than that in one call also needs `confirm: true`.',
  inputSchema: {
    action: z
      .enum(['list', 'add', 'remove'])
      .describe(
        'What to do. "list" returns the library\'s tags (filter with `q`); "add" and "remove" edit `tags` on each of `item_keys`.',
      ),
    tags: z.array(z.string()).optional().describe('Tag names to add or remove.'),
    item_keys: z.array(z.string()).optional().describe('Items to modify (add/remove).'),
    q: z.string().optional().describe('Substring filter for list.'),
    confirm: z
      .boolean()
      .optional()
      .describe("Required to edit more items in one call than the server's bulk-write threshold."),
    limit: z.number().int().min(1).max(100).optional().describe('Max tags to return for action:"list" (default 100, max 100).'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      tags: z.array(z.string()).optional().describe('Tag names in the library (action:"list").'),
      totalResults: z.number().optional().describe('Tags matching the filter in total, not just this page.'),
      updated: z.array(z.string()).optional().describe('Item keys whose tags were changed (add/remove).'),
      failed: writeFailures,
    })
    .passthrough(),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args, ctx) => {
    if (args.action === 'list') {
      // The caller's library_type/library_id, like every other action here: listing the
      // personal library's tags for a call that named a group is a wrong answer, not a
      // default (#74).
      const lib = resolveLibrary(ctx, args);
      // Routed, not `ctx.web`: on a desktop-only setup the cloud call goes to
      // api.zotero.org as users/0 and comes back "Invalid user ID", so listing tags here
      // was unreachable for exactly the users whose desktop was serving them all along.
      // Same cause as zotero_list_tags and zotero_sync (#64, #26, #67).
      const r = await ctx.router.listTags({ library: lib, q: args.q, limit: args.limit ?? 100 });
      const tags = r.data.map((t: any) => (typeof t === 'string' ? t : t.tag));
      return ok({ tags, totalResults: r.totalResults }, `${tags.length} tag(s) returned.`);
    }

    if (!args.tags?.length || !args.item_keys?.length) {
      return err('`tags` and `item_keys` are required for add/remove.');
    }
    const refusal = requireBulkConfirm(
      ctx,
      args.item_keys.length,
      `${args.action === 'add' ? 'add tags to' : 'remove tags from'}`,
      args.confirm,
    );
    if (refusal) return refusal;
    const lib = requireCloudLibrary(ctx, args);
    const updated: string[] = [];
    const failed: Array<{ key: string; message: string }> = [];
    for (const key of args.item_keys) {
      const item = await ctx.web.getItem(lib, key);
      const version = item?.version ?? item?.data?.version;
      const current: Array<{ tag: string; type?: number }> = Array.isArray(item?.data?.tags)
        ? [...item.data.tags]
        : [];
      let next: Array<{ tag: string; type?: number }>;
      if (args.action === 'add') {
        const have = new Set(current.map((t) => t.tag));
        next = [...current, ...args.tags.filter((t: string) => !have.has(t)).map((t: string) => ({ tag: t }))];
      } else {
        const remove = new Set(args.tags);
        next = current.filter((t) => !remove.has(t.tag));
      }
      try {
        await ctx.web.patchItem(lib, key, { tags: next }, version);
        updated.push(key);
      } catch (e) {
        failed.push({ key, message: e instanceof Error ? e.message : String(e) });
      }
    }
    return ok(
      { updated, failed },
      `${args.action === 'add' ? 'Added' : 'Removed'} tags on ${updated.length} item(s).`,
    );
  },
};

export default manageTags;
