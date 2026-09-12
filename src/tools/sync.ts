import { z } from 'zod';
import type { ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { ok, optionalLibrary } from '../registry/registry.js';
import { LocalApiUnsupportedError } from '../api/local-client.js';
import type { VersionBackend } from '../features/search/backend.js';

const SYNC_TYPES = ['items', 'collections', 'searches', 'tags'] as const;

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** What could not be answered, and where the answer does live. */
function remedy(hasCloudKey: boolean): string {
  return (
    (hasCloudKey
      ? 'Only the Zotero Web API serves that; to read this library from the cloud instead, start Zoteus with ZOTEUS_LOCAL=off. '
      : 'Only the Zotero Web API serves that, which needs a cloud API key (ZOTERO_API_KEY). ') +
    'Note that the two APIs number library versions independently, so a `since` taken from one means nothing to the other.'
  );
}

const sync: ToolDefinition = {
  name: 'zotero_sync',
  title: 'Incremental sync delta',
  description:
    'Return what changed in a library since a given version, for efficient incremental sync. Provide `since` (a library version; 0 = everything). Returns, per object type (items/collections/searches/tags), the map of keys→version that changed after `since`, plus the deletion log (keys removed since `since`). This is the version-based delta the Zotero sync algorithm uses: fetch the changed keys, then pull only those with zotero_get_item/zotero_search_items. Follows the library route: a running Zotero desktop app serves the delta for any library it holds, with no cloud API key, and otherwise the cloud Web API does; `backend` says which one answered. The whole delta comes from that one API, because the two number library versions independently. The desktop app serves item and collection versions but no tag versions and no deletion log; those are reported in `unavailable`, naming what is missing and why, and never as an empty result.',
  inputSchema: {
    since: z.number().int().min(0).optional().describe('Library version to diff from (default 0).'),
    types: z.array(z.enum(SYNC_TYPES)).optional().describe('Which object types to check (default all).'),
    include_deleted: z.boolean().optional().describe('Include the deletion log (default true).'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      since: z.number().describe('The version this delta was taken from, echoed back.'),
      backend: z.string().describe('Which API answered: "local" (Zotero desktop app) or "cloud". The two number versions independently.'),
      changed: z
        .record(
          z
            .object({
              count: z.number().describe('How many objects of this type changed.'),
              keys: z.array(z.string()).describe('Their keys; fetch them with zotero_get_item or zotero_search_items.'),
            })
            .passthrough(),
        )
        .describe('Per object type (items/collections/searches/tags), what changed after `since`.'),
      deleted: z
        .record(z.array(z.string()))
        .optional()
        .describe('The deletion log per object type; absent when include_deleted was false or the backend has none.'),
      unavailable: z
        .array(
          z
            .object({
              what: z.string().describe('The part of the delta this backend cannot serve.'),
              reason: z.string().describe('Why, and where the answer does live.'),
            })
            .passthrough(),
        )
        .optional()
        .describe('What was asked for and could not be answered, instead of an empty result.'),
    })
    .passthrough(),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const lib = optionalLibrary(args) ?? ctx.router.defaultLibrary();
    const since = args.since ?? 0;
    const types = (args.types ?? SYNC_TYPES) as readonly (typeof SYNC_TYPES)[number][];

    // One delta, one API. The route is decided once here and pinned on every request that
    // makes it up, because these numbers are only meaningful within a single sequence: a
    // `changed` map from the desktop app spliced with a deletion log from the cloud would
    // be handed back under one `since` that belongs to neither, and letting the rule be
    // re-evaluated per request would splice exactly that way if the app went down midway.
    const backend: VersionBackend = ctx.router.servesLocally(lib) ? 'local' : 'cloud';

    const changed: Record<string, { count: number; keys: string[] }> = {};
    const unavailable: Array<{ what: string; reason: string }> = [];
    for (const type of types) {
      try {
        const map = await ctx.router.versions(type, since, { library: lib, backend });
        const keys = Object.keys(map);
        changed[type] = { count: keys.length, keys };
      } catch (e) {
        if (!(e instanceof LocalApiUnsupportedError)) throw e;
        unavailable.push({ what: e.what, reason: e.message });
      }
    }

    let deleted: Record<string, string[]> | undefined;
    if (args.include_deleted !== false) {
      try {
        deleted = await ctx.router.deleted(since, { library: lib, backend });
      } catch (e) {
        if (!(e instanceof LocalApiUnsupportedError)) throw e;
        unavailable.push({ what: e.what, reason: e.message });
      }
    }

    const gaps = unavailable.map((u) => u.what).join(' and ');
    const hasCloudKey = ctx.router.whoami() != null;
    if (unavailable.length && !Object.keys(changed).length && deleted === undefined) {
      return err(
        `Nothing you asked for can be answered from the Zotero desktop app, which serves this library: ${gaps}. ` +
          unavailable.map((u) => u.reason).join(' ') +
          ' ' +
          remedy(hasCloudKey),
      );
    }

    const structured: Record<string, unknown> = { since, backend, changed };
    if (deleted !== undefined) structured.deleted = deleted;
    if (unavailable.length) structured.unavailable = unavailable;

    const counts = Object.entries(changed)
      .map(([t, v]) => `${v.count} ${t}`)
      .join(', ');
    const source = backend === 'local' ? 'Zotero desktop app' : 'Zotero Web API';
    const summary =
      `Changes since v${since}, from the ${source}: ${counts || 'nothing requested'}.` +
      (unavailable.length ? ` Not available from the ${source}: ${gaps}. ${remedy(hasCloudKey)}` : '');
    return ok(structured, summary);
  },
};

export default sync;
