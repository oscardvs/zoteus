import { z } from 'zod';
import { newLibraryVersion, writeFailures, writeTarget } from './common-output.js';
import type { ToolDefinition } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import {
  ok,
  resolveLibrary,
  isPersonalLibrary,
  requireCloud,
  isLocalWritesUnavailable,
  ensureLocalApi,
  requireBulkConfirm,
  writeResult,
} from '../registry/registry.js';

function versionOf(item: any): number | undefined {
  return item?.version ?? item?.data?.version;
}

const trashItems: ToolDefinition = {
  name: 'zotero_trash_items',
  title: 'Trash or restore Zotero items',
  description:
    'Move items to the trash (the safe, REVERSIBLE default) or restore them. This sets the `deleted` flag (1=trash, 0=restore) — it is NOT a permanent delete, so trashed items can be recovered here or in the Zotero app. Use this instead of zotero_delete_items unless you truly need irreversible removal. Provide `item_keys` and optional `action` (default "trash"). Writes go to the running Zotero desktop app for your personal library (via its local-API writes where available), otherwise to the cloud Web API. When the server sets a bulk-write threshold (ZOTEUS_CONFIRM_BULK_WRITES, off by default), trashing more items than that in one call also needs `confirm: true`.',
  inputSchema: {
    item_keys: z.array(z.string()).min(1).describe('Item keys to trash or restore.'),
    action: z.enum(['trash', 'restore']).optional().describe('Default "trash".'),
    confirm: z
      .boolean()
      .optional()
      .describe('Required to trash more items in one call than the server\'s bulk-write threshold.'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      updated: z.array(z.string()).describe('Keys of the items trashed or restored.'),
      failed: writeFailures,
      target: writeTarget,
      libraryVersion: newLibraryVersion,
    })
    .passthrough(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    const deleted = args.action === 'restore' ? 0 : 1;
    // Restore puts items back, so only the trashing direction is gated.
    if (deleted) {
      const refusal = requireBulkConfirm(ctx, args.item_keys.length, 'trash', args.confirm);
      if (refusal) return refusal;
    }
    const lib = resolveLibrary(ctx, args);
    // Local-first for the personal library when the desktop app supports writes.
    if (ctx.localWrites && isPersonalLibrary(lib) && (await ensureLocalApi(ctx))) {
      try {
        // Set the `deleted` flag rather than issuing a DELETE: the local API's DELETE,
        // like the Web API's, erases items outright, which is not what "trash" means.
        const result = await ctx.localWrites.setDeleted(args.item_keys, deleted);
        const updated = [...result.successful.map((s) => s.key), ...result.unchanged];
        return writeResult(
          { updated, failed: result.failed, target: 'local' },
          `${deleted ? 'Trashed' : 'Restored'} ${updated.length} item(s) via the Zotero desktop app.`,
          updated.length,
          args.item_keys.length,
          result.failed,
        );
      } catch (e) {
        if (!isLocalWritesUnavailable(e)) throw e;
        ctx.logger.info(`Local-API writes unavailable (${e instanceof Error ? e.message : e}); falling back to the cloud Web API.`);
      }
    }
    requireCloud(ctx, lib);
    const objects: any[] = [];
    for (const key of args.item_keys) {
      const version = versionOf(await ctx.web.getItem(lib, key));
      objects.push({ key, version, deleted });
    }
    const result = await ctx.web.writeItems(lib, objects);
    const verb = deleted ? 'Trashed' : 'Restored';
    const summary =
      `${verb} ${result.successful.length} item(s)` +
      (result.failed.length ? `; ${result.failed.length} failed.` : '.');
    return ok(
      { updated: result.successful.map((s) => s.key), failed: result.failed, libraryVersion: result.newLibraryVersion },
      summary,
    );
  },
};

export default trashItems;
