import { z } from 'zod';
import { writeTarget } from './common-output.js';
import type { ToolDefinition } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import {
  ok,
  resolveLibrary,
  isPersonalLibrary,
  requireCloud,
  isLocalWritesUnavailable,
  ensureLocalApi,
} from '../registry/registry.js';

const deleteItems: ToolDefinition = {
  name: 'zotero_delete_items',
  title: 'Permanently delete Zotero items',
  description:
    'PERMANENTLY and IRREVERSIBLY delete items by key (this purges them — it is NOT the trash). Prefer zotero_trash_items, which is reversible. This tool is disabled unless the server is started with ZOTEUS_ALLOW_DELETE=true, and additionally requires `confirm: true` on every call. For the personal library it goes through the running Zotero desktop app when that app supports local-API writes, otherwise the cloud Web API. The current library version is used as a precondition; the operation auto-chunks to 50 keys per request.',
  inputSchema: {
    item_keys: z.array(z.string()).min(1).describe('Item keys to permanently delete.'),
    confirm: z.boolean().optional().describe('Must be true to proceed with permanent deletion.'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      deleted: z.array(z.string()).describe('Keys purged from the library; this is not the trash and cannot be undone.'),
      count: z.number().describe('How many were purged.'),
      target: writeTarget,
    })
    .passthrough(),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    if (!ctx.config.allowDelete) {
      return {
        content: [
          {
            type: 'text',
            text: 'Permanent delete is disabled. Start Zoteus with ZOTEUS_ALLOW_DELETE=true to enable it, or use zotero_trash_items (reversible).',
          },
        ],
        isError: true,
      };
    }
    if (!args.confirm) {
      return {
        content: [
          {
            type: 'text',
            text: `Refusing to permanently delete ${args.item_keys.length} item(s) without confirmation. Re-call with confirm:true if you are sure (this cannot be undone).`,
          },
        ],
        isError: true,
      };
    }
    const lib = resolveLibrary(ctx, args);
    // Local-first for the personal library: Zotero 10's local API implements the same
    // multi-DELETE (with the library-version precondition), so no cloud key is needed.
    if (ctx.localWrites && isPersonalLibrary(lib) && (await ensureLocalApi(ctx))) {
      try {
        await ctx.localWrites.deleteItems(args.item_keys);
        return ok(
          { deleted: args.item_keys, count: args.item_keys.length, target: 'local' },
          `Permanently deleted ${args.item_keys.length} item(s) via the Zotero desktop app.`,
        );
      } catch (e) {
        if (!isLocalWritesUnavailable(e)) throw e;
        ctx.logger.info(`Local-API writes unavailable (${e instanceof Error ? e.message : e}); falling back to the cloud Web API.`);
      }
    }
    requireCloud(ctx, lib);
    const version = await ctx.web.currentLibraryVersion(lib);
    await ctx.web.deleteItems(lib, args.item_keys, version);
    return ok(
      { deleted: args.item_keys, count: args.item_keys.length },
      `Permanently deleted ${args.item_keys.length} item(s).`,
    );
  },
};

export default deleteItems;
