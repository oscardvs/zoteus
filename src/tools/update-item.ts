import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { ok, requireCloudLibrary } from '../registry/registry.js';
import { ZoteroApiError } from '../api/errors.js';
import { itemPatchSchema } from '../schema/item-payload.js';

function versionOf(item: any): number | undefined {
  return item?.version ?? item?.data?.version;
}

/** Deep value equality: order-insensitive for objects, order-sensitive for arrays. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => jsonEqual(x, (b as unknown[])[i]));
  }
  const ak = Object.keys(a as Record<string, unknown>);
  const bk = Object.keys(b as Record<string, unknown>);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const updateItem: ToolDefinition = {
  name: 'zotero_update_item',
  title: 'Update a Zotero item',
  description:
    'Partially update one item (HTTP PATCH — only the fields you supply change; omitted fields are preserved). Provide `item_key` and a `patch` object of the fields to change (e.g. {"title":"New","extra":"note"} or {"tags":[{"tag":"reviewed"}]}). All field values are plain JSON strings/numbers/booleans/arrays — never wrapped in nested objects (e.g. `"title": "New"`, NOT `"title": {"title": "New"}`). Optimistic concurrency is handled for you: if you pass the item\'s `version` it is used; otherwise the current version is fetched first. If the item changed on the server in the meantime (412), the update is automatically re-fetched and retried once. Writes go to the cloud Web API. Set `dry_run:true` to preview the field-level before→after diff without writing (arrays like tags/collections are replaced wholesale by PATCH, not merged; a dry_run call performs no write).',
  inputSchema: {
    item_key: z.string().describe('The 8-character item key.'),
    patch: itemPatchSchema.describe(
      'Object of fields to change (PATCH semantics), e.g. {"title": "New title", "date": "2024-02-01", "tags": [{"tag": "reviewed"}], "collections": ["ABCD1234"]}. Structured fields (creators, tags, collections, relations) must be real JSON arrays/objects, not JSON-encoded strings. Values are plain, never wrapped in nested objects.',
    ),
    version: z.number().int().optional().describe('Known current version; fetched automatically if omitted.'),
    dry_run: z.boolean().optional().describe('Preview the field-level before→after diff without writing.'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      item_key: z.string().describe('The item this call addressed.'),
      newVersion: z.number().optional().describe('Version after the PATCH; absent on a dry run.'),
      retried: z.boolean().optional().describe('True when a version conflict (412) was re-fetched and retried once.'),
      dryRun: z.boolean().optional().describe('True when nothing was written.'),
      version: z.number().nullable().optional().describe('Current version on the server (dry run only).'),
      diff: z
        .record(
          z
            .object({
              before: z.unknown().describe('Value the item carries now.'),
              after: z.unknown().describe('Value the patch would set.'),
            })
            .passthrough(),
        )
        .optional()
        .describe('Field-level before/after for a dry run; only fields the patch would actually change.'),
      arrayReplacements: z
        .array(z.string())
        .optional()
        .describe('Fields in that diff that PATCH replaces wholesale rather than merging, e.g. ["tags"].'),
    })
    .passthrough(),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  handler: async (args, ctx) => {
    const lib = requireCloudLibrary(ctx, args);
    if (args.dry_run) {
      const item = await ctx.web.getItem(lib, args.item_key);
      const before = (item?.data ?? {}) as Record<string, unknown>;
      const version = versionOf(item) ?? null;
      const diff: Record<string, { before: unknown; after: unknown }> = {};
      const arrayReplacements: string[] = [];
      for (const [k, v] of Object.entries(args.patch ?? {})) {
        if (jsonEqual(before[k], v)) continue;
        diff[k] = { before: before[k], after: v };
        if (Array.isArray(v)) arrayReplacements.push(k);
      }
      const n = Object.keys(diff).length;
      return ok(
        { item_key: args.item_key, version, dryRun: true, diff, arrayReplacements },
        n
          ? `Dry run for ${args.item_key}: ${n} field(s) would change` +
            (arrayReplacements.length ? `; arrays replaced wholesale: ${arrayReplacements.join(', ')}.` : '.')
          : `Dry run for ${args.item_key}: no changes.`,
      );
    }
    let version = args.version;
    if (version == null) {
      version = versionOf(await ctx.web.getItem(lib, args.item_key));
    }
    if (version == null) {
      return {
        content: [{ type: 'text', text: `Could not determine the current version of ${args.item_key}.` }],
        isError: true,
      };
    }
    try {
      const newVersion = await ctx.web.patchItem(lib, args.item_key, args.patch, version);
      return ok({ item_key: args.item_key, newVersion }, `Updated ${args.item_key} (now version ${newVersion}).`);
    } catch (err) {
      if (err instanceof ZoteroApiError && err.status === 412) {
        const fresh = versionOf(await ctx.web.getItem(lib, args.item_key));
        if (fresh == null) throw err;
        const newVersion = await ctx.web.patchItem(lib, args.item_key, args.patch, fresh);
        return ok(
          { item_key: args.item_key, newVersion, retried: true },
          `Updated ${args.item_key} after a version conflict (now version ${newVersion}).`,
        );
      }
      throw err;
    }
  },
};

export default updateItem;
