import { z } from 'zod';
import type { LocalGroup } from '../api/local-client.js';
import type { ToolContext, ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { ensureLocalApi, ok } from '../registry/registry.js';

/**
 * What a caller has to know about a row that came from the desktop rather than the cloud.
 * Emitted only when at least one such row is present, so the cloud-only answer is exactly
 * what it always was.
 */
const LOCAL_NOTE =
  'Rows with source "local" come from the Zotero desktop app, which serves a group\'s id, ' +
  'name and description only: their `type` and `libraryEditing` are unknown here, not ' +
  'absent from the group. Their `numItems` is the desktop\'s own count of every row in the ' +
  'group library, child attachments, notes and trashed items included, so it is not the ' +
  'same figure the cloud reports. Reading such a group needs no cloud key; writing to any ' +
  'group still does.';

/**
 * Group libraries the running desktop app holds, or [] when there is no desktop to ask.
 *
 * The list is fetched live rather than read off `capabilities.localGroupIds`, for two
 * reasons: that field carries ids alone, with none of the metadata this tool reports, and
 * it is a startup snapshot, so a Zotero started (or a group joined) after the server would
 * not be in it. Refreshing it here also makes the ids this call hands out usable in the
 * same session, since the router serves a group locally only when it appears in that list.
 *
 * An empty answer is deliberately NOT published over a non-empty list: a desktop that is
 * up but still opening its database answers this call with a failure, which
 * `listLocalGroups` reports as [], and recording that as authoritative would strand every
 * group the desktop holds on a cloud API a keyless user cannot use. That is the same
 * reasoning `LocalApiStatus` applies to its own group refresh.
 */
async function locallyHeldGroups(ctx: ToolContext): Promise<LocalGroup[]> {
  if (!ctx.local?.listLocalGroups || ctx.config.local === 'off') return [];
  if (!(await ensureLocalApi(ctx))) return [];
  const groups = await ctx.local.listLocalGroups().catch(() => []);
  if (groups.length) ctx.capabilities.localGroupIds = groups.map((g) => g.id);
  return groups;
}

/** A desktop-held group as this tool reports it: the local API's fields, and no others. */
function localEntry(g: LocalGroup) {
  return {
    id: g.id,
    name: g.name,
    numItems: g.numItems,
    description: g.description,
    source: 'local' as const,
  };
}

const groups: ToolDefinition = {
  name: 'zotero_groups',
  title: 'List Zotero groups',
  description:
    'List the group libraries this server can reach, with each group\'s id and name. Use a returned group id with the `library_id`/`library_type:"group"` parameters of other tools to operate on that group library; `library_type` alone does not address a group. With a cloud API key each group the key can access is listed with its type, item count, description and edit permissions. Without a key the list falls back to the group libraries a running Zotero 10+ desktop app holds, which are exactly the groups still readable, key-free, from that app: those rows carry id, name, description and the desktop\'s own item count, and no type or edit permissions, because the desktop does not store them. Where both are available every row says which it came from, in `source`: "cloud", "local", or "both" for a group the key can see and the desktop also holds. Writing to a group always goes through the cloud, even when the Zotero desktop app holds that group, and needs a key with write access to it; `libraryEditing` says whether the group itself lets ordinary members edit its library.',
  inputSchema: {},
  outputSchema: z
    .object({
      groups: z
        .array(
          z
            .object({
              id: z.number().describe('Group id; pass it as library_id together with library_type:"group".'),
              name: z.string().optional().describe('Group name.'),
              type: z.string().optional().describe('Zotero group type, e.g. "Private" or "PublicClosed"; absent on a desktop-only row.'),
              numItems: z.number().optional().describe("Item count. A desktop row counts every row it holds, so it differs from the cloud's figure."),
              description: z.string().optional().describe('Group description.'),
              libraryEditing: z.string().optional().describe('Who may edit the group library, e.g. "members" or "admins"; absent on a desktop-only row.'),
              source: z.string().optional().describe('Where the row came from: "cloud", "local", or "both".'),
            })
            .passthrough(),
        )
        .describe('The group libraries this server can reach.'),
      note: z.string().optional().describe('What a desktop-served row does and does not say; present only when one is listed.'),
    })
    .passthrough(),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (_args, ctx): Promise<ToolHandlerResult> => {
    const me = ctx.router.whoami();
    const held = await locallyHeldGroups(ctx);

    if (!me) {
      // A keyless local-only user is not locked out: the desktop holds groups and the
      // router already reads them locally, so the only thing missing was ever a way to
      // learn their ids. The refusal survives for the case where there genuinely is
      // nothing to list, and then it names the source that was missing instead of
      // sending someone after a cloud key they do not need in order to read.
      if (!held.length) {
        // `whoami` is null for a key that was never set AND for one the cloud refused, and
        // telling the second user to set ZOTERO_API_KEY would send them looking at the one
        // thing they had already done.
        const cloud = ctx.web.hasKey
          ? 'the configured cloud API key (ZOTERO_API_KEY) did not identify a Zotero user'
          : 'there is no cloud API key (ZOTERO_API_KEY)';
        const desktop = ctx.capabilities.localApi
          ? 'the running Zotero desktop app holds no group libraries'
          : 'no Zotero desktop app is answering locally, and one running Zotero 10 or newer with its local API enabled would list the groups it holds';
        return {
          content: [{ type: 'text', text: `No groups to list: ${cloud}, and ${desktop}.` }],
          isError: true,
        };
      }
      return ok(
        { groups: held.map(localEntry), note: LOCAL_NOTE },
        `${held.length} group(s) held by the Zotero desktop app, which serves them with no cloud key. Reading them works; writing to a group still needs a key with write access to it.`,
      );
    }

    const r = await ctx.web.listGroups(me.userID);
    const groupList = r.data.map((g: any) => ({
      id: g.id ?? g.data?.id,
      name: g.data?.name,
      type: g.data?.type,
      numItems: g.meta?.numItems,
      description: g.data?.description,
      libraryEditing: g.data?.libraryEditing,
    }));
    // Nothing local to fold in: the answer is the cloud's, unchanged down to its wording.
    if (!held.length) return ok({ groups: groupList }, `${groupList.length} accessible group(s).`);

    // Both sources. One row per group, keyed by id, with the cloud's fields preferred
    // wherever a group appears in both: they are a superset of the desktop's, and a
    // duplicate row would only invite a caller to pick the poorer one.
    const heldIds = new Set(held.map((g) => g.id));
    const cloudIds = new Set(groupList.map((g: any) => Number(g.id)));
    const localOnly = held.filter((g) => !cloudIds.has(g.id));
    const merged = [
      ...groupList.map((g: any) => ({ ...g, source: heldIds.has(Number(g.id)) ? 'both' : 'cloud' })),
      ...localOnly.map(localEntry),
    ];
    return ok(
      { groups: merged, ...(localOnly.length ? { note: LOCAL_NOTE } : {}) },
      `${merged.length} group(s): ${groupList.length} the API key can access` +
        (localOnly.length
          ? `, ${localOnly.length} held only by the Zotero desktop app.`
          : `, ${heldIds.size} of them also held by the Zotero desktop app.`),
    );
  },
};

export default groups;
