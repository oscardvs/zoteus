import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { ok, resolveLibrary } from '../registry/registry.js';
import { ZoteroApiError } from '../api/errors.js';
import { libraryArgs } from './common-args.js';
import { writeTarget } from './common-output.js';
import { mustFallBack, withLibraryWriter, type LibraryWriter } from './library-writer.js';
import { readItem, refusal } from '../features/notes/write-note.js';
import { denormaliseRelations, normaliseRelations } from '../features/dedupe/merge-plan.js';
import { libraryUriBase, recordUserId, relatedKeys, RELATED_PREDICATE } from '../features/related/relations.js';

export const MAX_RELATE_PAIRS = 100;

interface Outcome {
  item_key: string;
  status: 'linked' | 'unchanged' | 'failed';
  added: string[];
  alreadyLinked: string[];
  newVersion?: number;
  error?: string;
}

/**
 * Add `targets` to `key`'s dc:relation, keeping every relation it already has (every
 * predicate, every URI), and PATCH at the version just read. A conflict re-reads and
 * re-applies once, so a link someone else added in between is kept too.
 */
async function linkOne(w: LibraryWriter, key: string, targets: string[], base: string): Promise<Outcome> {
  for (let attempt = 0; ; attempt++) {
    const item = await readItem(w, key);
    if (!item) return { item_key: key, status: 'failed', added: [], alreadyLinked: [], error: 'no such item' };
    const data = item.data ?? item;
    const version = Number(item.version ?? data.version);
    const have = relatedKeys(data.relations, base);
    const relations = normaliseRelations(data.relations);
    const list = (relations[RELATED_PREDICATE] ??= []);
    const added: string[] = [];
    const alreadyLinked: string[] = [];
    for (const t of targets) {
      if (have.has(t)) alreadyLinked.push(t);
      else {
        list.push(`${base}/items/${t}`);
        added.push(t);
      }
    }
    if (!added.length) return { item_key: key, status: 'unchanged', added, alreadyLinked };
    try {
      const newVersion = await w.patchItem(key, { relations: denormaliseRelations(relations) }, version);
      return { item_key: key, status: 'linked', added, alreadyLinked, newVersion };
    } catch (e) {
      if (attempt === 0 && e instanceof ZoteroApiError && e.status === 412) continue;
      throw e;
    }
  }
}

const relateItems: ToolDefinition = {
  name: 'zotero_relate_items',
  title: 'Link items as Related',
  description:
    'Link pairs of library items as "Related", the link Zotero shows in an item\'s Related pane, on BOTH items of each pair, as Zotero itself does. Additive only: every relation an item already has (other Related links, merge records, any other predicate) is kept, and a pair already linked is reported as such and not written again. Both items must be in the same library. Every item is read before anything is written, so an unknown key refuses the whole call. Get candidates from zotero_suggest_related (pairs that cite each other), or pass any pairs you choose. To remove a link, edit `relations` with zotero_update_item. Writes go to the running Zotero desktop app (Zotero 10+) for every library it holds, otherwise to the cloud Web API. A personal library that has never synced to a zotero.org account cannot be linked from here: Zotero names it in the link by a local id neither API exposes.',
  inputSchema: {
    pairs: z
      .array(
        z.object({
          item_key: z.string().describe('One item of the pair.'),
          related_key: z.string().describe('The item to link it to.'),
        }),
      )
      .min(1)
      .max(MAX_RELATE_PAIRS)
      .describe(`Pairs to link, at most ${MAX_RELATE_PAIRS}. Order inside a pair does not matter; both items get the link.`),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      items: z
        .array(
          z
            .object({
              item_key: z.string().describe('The item written (or not).'),
              status: z.string().describe('"linked" (relations patched), "unchanged" (every link already there) or "failed".'),
              added: z.array(z.string()).describe('Keys newly linked from this item.'),
              alreadyLinked: z.array(z.string()).describe('Keys this item already named as Related.'),
              newVersion: z.number().optional().describe('The item\'s version after the write.'),
              error: z.string().optional().describe('Why this item failed. Its partners may still have been linked to it.'),
            })
            .passthrough(),
        )
        .describe('One entry per distinct item.'),
      linked: z.number().describe('Items whose relations were written.'),
      failed: z.number().describe('Items that failed.'),
      target: writeTarget,
    })
    .passthrough(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const pairs = args.pairs as Array<{ item_key: string; related_key: string }>;
    const targets = new Map<string, string[]>();
    for (const p of pairs) {
      if (p.item_key === p.related_key) return refusal(`${p.item_key} cannot be related to itself. Nothing was written.`);
      for (const [a, b] of [
        [p.item_key, p.related_key],
        [p.related_key, p.item_key],
      ] as const) {
        const list = targets.get(a) ?? [];
        if (!list.includes(b)) list.push(b);
        targets.set(a, list);
      }
    }
    const lib = resolveLibrary(ctx, args);
    return withLibraryWriter(ctx, lib, async (w) => {
      const where = lib.type === 'group' ? `group library ${lib.id}` : 'this library';
      const records = new Map<string, any>();
      for (const key of targets.keys()) {
        const item = await readItem(w, key);
        if (!item) return refusal(`No item ${key} in ${where}, so nothing was written. Check the key with zotero_search_items.`);
        const type = (item.data ?? item).itemType;
        if (type === 'annotation') return refusal(`${key} is an annotation, which Zotero does not link as Related. Nothing was written.`);
        records.set(key, item);
      }
      const userId = [...records.values()].map(recordUserId).find((id) => id) ?? ctx.capabilities.cloud?.userID;
      const base = libraryUriBase(lib, userId);
      if (!base) {
        return refusal(
          'This personal library has no zotero.org account id that Zoteus can see, and Zotero names the library by that id inside a Related link, ' +
            'so a link written now would point nowhere. Sign in to sync in Zotero (Settings > Sync) or configure ZOTERO_API_KEY, then retry. Nothing was written.',
        );
      }
      const outcomes: Outcome[] = [];
      for (const [key, list] of targets) {
        try {
          outcomes.push(await linkOne(w, key, list, base));
        } catch (e) {
          if (mustFallBack(e)) throw e;
          outcomes.push({ item_key: key, status: 'failed', added: [], alreadyLinked: [], error: (e as Error).message });
        }
      }
      const linked = outcomes.filter((o) => o.status === 'linked').length;
      const failed = outcomes.filter((o) => o.status === 'failed').length;
      const via = w.target === 'local' ? ' via the Zotero desktop app' : '';
      const summary =
        `Linked ${linked} item(s) as Related${via} for ${pairs.length} pair(s); ` +
        `${outcomes.filter((o) => o.status === 'unchanged').length} already had every link.` +
        (failed
          ? ` ${failed} failed, so some pairs may be linked on one side only: ${outcomes.filter((o) => o.error).map((o) => `${o.item_key} (${o.error})`).join('; ')}.`
          : '');
      const result = ok({ items: outcomes, linked, failed, target: w.target }, summary);
      return failed && !linked ? { ...result, isError: true } : result;
    });
  },
};

export default relateItems;
