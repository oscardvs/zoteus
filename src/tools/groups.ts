import { z } from 'zod';
import type { LocalGroup } from '../api/local-client.js';
import type { KeyInfo } from '../api/web-client.js';
import type { ToolContext, ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { ensureLocalApi, missingWriteAccess, ok } from '../registry/registry.js';
import { canonicalLibraryToken } from '../features/search/backend.js';

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
  'group still does. They carry no `canWrite`: write permission is a property of the cloud ' +
  'API key, and the desktop reports none.';

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

/**
 * Whether this key may write to a group, decided locally from the key's own access map,
 * exactly as a write would decide it a moment before sending the request.
 *
 * Silent when the key reported no access map at all: `missingWriteAccess` treats that as
 * evidence it does not have rather than a refusal, and reporting `canWrite: true` there
 * would turn "unknown" into a promise. A lab discovering from a failed write that it
 * cannot write to its shared library is the case this exists to remove; inventing the
 * opposite answer would only move the surprise.
 */
function writeVerdict(me: KeyInfo, id: number): { canWrite?: boolean; writeBlockedReason?: string } {
  const access = me.access;
  if (!access || typeof access !== 'object' || Object.keys(access).length === 0) return {};
  const why = missingWriteAccess(me, { type: 'group', id });
  return why ? { canWrite: false, writeBlockedReason: why } : { canWrite: true };
}

/**
 * The library this context's search index holds, as the index itself stamps it, or
 * undefined when it records none (nothing built yet, or an index older than the stamp).
 * Read through the public status only: what the store keeps underneath is not this tool's
 * business.
 */
function indexedLibrary(ctx: ToolContext): string | undefined {
  // An index that cannot report itself must not cost the group list: the ids are what a
  // caller came for, and `indexed` is a convenience beside them.
  try {
    return ctx.search?.buildStatus?.().library;
  } catch {
    return undefined;
  }
}

/** `{ indexed }` for one group, or nothing at all when no stamp says which library is held. */
function indexedField(stamp: string | undefined, id: number): { indexed?: boolean } {
  if (stamp === undefined) return {};
  return { indexed: stamp === canonicalLibraryToken({ type: 'group', id }) };
}

/**
 * How to answer `indexed` for each of these groups, decided once for the whole call.
 *
 * From the registry wherever there is one, because the registry is what owns per-library
 * index files now: `zotero_index action:"build" library_type:"group" library_id:N` gives
 * that group an index file of its OWN beside the default library's, and
 * `zotero_semantic_search libraries:["group:N"]` answers from it. Reading the primary
 * index's stamp instead reported every such group as un-indexed, which is the answer the
 * lab checklist reads right after building one, and the schema turned that into the claim
 * that the group is not searchable by meaning.
 *
 * `exists()` and not `list()`: it never opens (and so never creates) a store, so asking
 * about ten groups costs a couple of stat calls each and cannot leave a file behind.
 * Falls back to the primary index's stamp where there is no registry, which is every
 * hand-built test context and the single-index deployments.
 */
async function indexedVerdict(ctx: ToolContext, ids: number[]): Promise<(id: number) => { indexed?: boolean }> {
  const registry = ctx.indexes;
  if (registry) {
    try {
      const known = new Set<number>();
      // A row whose id the API did not give us has no token to ask about, and asking with
      // one would refuse the whole list into the stamp fallback.
      for (const id of new Set(ids.filter((n) => Number.isSafeInteger(n) && n > 0))) {
        if (await registry.exists(canonicalLibraryToken({ type: 'group', id }))) known.add(id);
      }
      return (id) => ({ indexed: known.has(id) });
    } catch {
      // An index store that cannot be read must not cost the group list: the ids are what
      // a caller came for. Fall back to the stamp, exactly as the no-registry case does.
    }
  }
  const stamp = indexedLibrary(ctx);
  return (id) => indexedField(stamp, id);
}

/** "N of M writable", said only where the key actually answered the question. */
function writableSentence(rows: Array<{ canWrite?: boolean }>): string {
  const known = rows.filter((r) => r.canWrite !== undefined);
  if (!known.length) return '';
  const writable = known.filter((r) => r.canWrite).length;
  if (writable === known.length) return ` This API key can write to all ${writable} of them.`;
  return ` This API key can write to ${writable} of ${known.length} of them; each row it cannot write says why in \`writeBlockedReason\`.`;
}

/** The read-only deployment caveat, which outranks anything the key is allowed to do. */
function readOnlySentence(ctx: ToolContext): string {
  return ctx.config?.readOnly
    ? ' This server runs in read-only mode (ZOTEUS_READ_ONLY), so no tool here writes to any library, whatever `canWrite` says about the key.'
    : '';
}

const groups: ToolDefinition = {
  name: 'zotero_groups',
  title: 'List Zotero groups',
  description:
    'List the group libraries this server can reach, with each group\'s id and name. Use a returned group id with the `library_id`/`library_type:"group"` parameters of other tools to operate on that group library; `library_type` alone does not address a group. With a cloud API key each group the key can access is listed with its type, item count, description and edit permissions, plus `canWrite`: whether this key may write to that group, decided from the key\'s own access map without sending a write, and `writeBlockedReason` naming the remedy when it may not. Without a key the list falls back to the group libraries a running Zotero 10+ desktop app holds, which are exactly the groups still readable, key-free, from that app: those rows carry id, name, description and the desktop\'s own item count, and no type, edit permissions or `canWrite`, because the desktop does not store them. Where both are available every row says which it came from, in `source`: "cloud", "local", or "both" for a group the key can see and the desktop also holds. Rows also carry `indexed`: whether this data directory holds a search index for that group, which is what makes it searchable by meaning. Each library gets its own index file, so several rows can be true, and a false row becomes true after zotero_index action:"build" library_type:"group" library_id:<id>. Writing to a group always goes through the cloud, even when the Zotero desktop app holds that group, and needs a key with write access to it; `libraryEditing` says whether the group itself lets ordinary members edit its library.',
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
              canWrite: z
                .boolean()
                .optional()
                .describe(
                  'Whether the configured cloud API key is allowed to write to this group, from the key\'s own access map. Absent on a desktop-only row, and absent when the key reported no access map at all, which means unknown rather than no. A group can separately be configured so only admins may edit its library (see `libraryEditing`), which no key setting overrides, so true is the key\'s permission and not a guarantee the group accepts the write.',
                ),
              writeBlockedReason: z
                .string()
                .optional()
                .describe('Why this key cannot write to this group, and what to change; present only when canWrite is false.'),
              indexed: z
                .boolean()
                .optional()
                .describe(
                  'Whether this data directory holds a search index for this group library, which is what zotero_semantic_search needs to search it by meaning. Each library gets its own index file, so several rows can be true. A false row is still searchable by keyword through the Zotero API, and becomes searchable by meaning after zotero_index action:"build" library_type:"group" library_id:<id> (action:"libraries" lists the ones that exist). Absent only where the answer is unknown: no per-library index registry and an index that records no library.',
                ),
            })
            .passthrough(),
        )
        .describe('The group libraries this server can reach.'),
      note: z.string().optional().describe('What a desktop-served row does and does not say; present only when one is listed.'),
    })
    .passthrough(),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
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
      const localVerdict = await indexedVerdict(ctx, held.map((g) => g.id));
      return ok(
        { groups: held.map((g) => ({ ...localEntry(g), ...localVerdict(g.id) })), note: LOCAL_NOTE },
        `${held.length} group(s) held by the Zotero desktop app, which serves them with no cloud key. Reading them works; writing to a group still needs a key with write access to it.`,
      );
    }

    const r = await ctx.web.listGroups(me.userID);
    // Asked once for every group this answer will carry, cloud-served and desktop-held
    // alike, so one pass over the registry serves the whole list.
    const verdict = await indexedVerdict(ctx, [
      ...r.data.map((g: any) => Number(g.id ?? g.data?.id)),
      ...held.map((g) => g.id),
    ]);
    // The write verdict is taken here, from the key's own access map, because that is where
    // a write would take it (registry.requireCloud) a moment before sending the request.
    // Answering it now is the difference between a lab reading "cannot write, and here is
    // why" and a lab discovering the same thing from a failed write.
    const groupList = r.data.map((g: any) => {
      const id = g.id ?? g.data?.id;
      return {
        id,
        name: g.data?.name,
        type: g.data?.type,
        numItems: g.meta?.numItems,
        description: g.data?.description,
        libraryEditing: g.data?.libraryEditing,
        ...writeVerdict(me, Number(id)),
        ...verdict(Number(id)),
      };
    });
    // Nothing local to fold in: the answer is the cloud's, unchanged down to its wording.
    if (!held.length) {
      return ok(
        { groups: groupList },
        `${groupList.length} accessible group(s).${writableSentence(groupList)}${readOnlySentence(ctx)}`,
      );
    }

    // Both sources. One row per group, keyed by id, with the cloud's fields preferred
    // wherever a group appears in both: they are a superset of the desktop's, and a
    // duplicate row would only invite a caller to pick the poorer one.
    const heldIds = new Set(held.map((g) => g.id));
    const cloudIds = new Set(groupList.map((g: any) => Number(g.id)));
    const localOnly = held.filter((g) => !cloudIds.has(g.id));
    const merged = [
      ...groupList.map((g: any) => ({ ...g, source: heldIds.has(Number(g.id)) ? 'both' : 'cloud' })),
      ...localOnly.map((g) => ({ ...localEntry(g), ...verdict(g.id) })),
    ];
    return ok(
      { groups: merged, ...(localOnly.length ? { note: LOCAL_NOTE } : {}) },
      `${merged.length} group(s): ${groupList.length} the API key can access` +
        (localOnly.length
          ? `, ${localOnly.length} held only by the Zotero desktop app.`
          : `, ${heldIds.size} of them also held by the Zotero desktop app.`) +
        writableSentence(groupList) +
        readOnlySentence(ctx),
    );
  },
};

export default groups;
