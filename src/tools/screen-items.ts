import { z } from 'zod';
import { writeFailures, writeTarget } from './common-output.js';
import type { ToolDefinition } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { requireBulkConfirm, resolveLibrary, writeResult } from '../registry/registry.js';
import { mustFallBack, withLibraryWriter } from './library-writer.js';
import { refusal } from '../features/notes/write-note.js';
import { DECISIONS, formatScreeningTag, replaceScreeningTag, slug, type ScreeningTag } from '../features/review/screening-tags.js';
import { SCREENING_SCHEME_HELP, stageArg } from './review.js';

const NOT_SCREENABLE = new Set(['note', 'attachment', 'annotation']);

const screenItems: ToolDefinition = {
  name: 'zotero_screen_items',
  title: 'Record screening decisions on Zotero items',
  description:
    'Record systematic-review screening decisions as Zotero tags on a batch of items, so the whole group library sees them. ' +
    SCREENING_SCHEME_HELP +
    ' Pass `reviewer` to record your own independent decision (dual screening); omit it to record the final decision, e.g. after resolving a disagreement. Each item gets exactly one tag for this stage and reviewer: a decision recorded earlier for the same stage and reviewer is replaced, and every other tag (the user\'s own, other stages, other reviewers) is left as it was. Writes go to the running Zotero desktop app (Zotero 10+) for every library it holds, otherwise to the cloud Web API (requires ZOTERO_API_KEY with write access). Read the queue and the tallies with zotero_review.',
  inputSchema: {
    stage: stageArg,
    reviewer: z
      .string()
      .optional()
      .describe('Who is screening, e.g. "alice". Slugged into the tag ("Alice B." becomes "alice-b"). Omit to record the final decision.'),
    decisions: z
      .array(
        z.object({
          item_key: z.string().describe('The record to screen (from zotero_review action:"queue").'),
          decision: z.enum(DECISIONS).describe('"include", "exclude" or "maybe".'),
          reason: z
            .string()
            .optional()
            .describe('exclude only: why, e.g. "wrong population" (stored as the slug wrong-population). Keep a fixed list across the team so the PRISMA reasons add up.'),
        }),
      )
      .min(1)
      .max(100)
      .describe('One entry per item, at most 100 per call.'),
    confirm: z.boolean().optional().describe("Required to tag more items in one call than the server's bulk-write threshold."),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      stage: z.string().describe('The stage recorded.'),
      reviewer: z.string().optional().describe('The reviewer slug, absent for final decisions.'),
      recorded: z
        .array(
          z
            .object({
              key: z.string().describe('Item key.'),
              tag: z.string().describe('The screening tag the item now carries for this stage and reviewer.'),
              replaced: z.array(z.string()).describe('Earlier screening tags for the same stage and reviewer that this one replaced.'),
              unchanged: z.boolean().describe('True when the item already carried exactly this decision, so nothing was written.'),
            })
            .passthrough(),
        )
        .describe('The items that now carry the decision.'),
      failed: writeFailures,
      target: writeTarget,
    })
    .passthrough(),
  // Destructive in the sense client directories mean it: changing a decision replaces the tag
  // that recorded the earlier one, and that earlier decision is then gone from the library.
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const reviewer = args.reviewer ? slug(args.reviewer, true) : undefined;
    if (args.reviewer && !reviewer) return refusal('`reviewer` has no letters or digits to name a reviewer by.');
    const problems: string[] = [];
    const planned: Array<{ key: string; tag: ScreeningTag }> = [];
    const seen = new Set<string>();
    for (const d of args.decisions as Array<{ item_key: string; decision: ScreeningTag['decision']; reason?: string }>) {
      if (seen.has(d.item_key)) problems.push(`${d.item_key} appears twice; give one decision per item.`);
      seen.add(d.item_key);
      if (d.reason && d.decision !== 'exclude') problems.push(`${d.item_key}: a reason goes only with "exclude".`);
      const reason = d.reason ? slug(d.reason) : undefined;
      if (d.reason && !reason) problems.push(`${d.item_key}: the reason "${d.reason}" has no letters or digits.`);
      planned.push({ key: d.item_key, tag: { stage: args.stage, decision: d.decision, ...(reason ? { reason } : {}), ...(reviewer ? { reviewer } : {}) } });
    }
    if (problems.length) return refusal(`Nothing was written:\n- ${problems.join('\n- ')}`);
    const gate = requireBulkConfirm(ctx, planned.length, 'tag', args.confirm);
    if (gate) return gate;

    return withLibraryWriter(ctx, resolveLibrary(ctx, args), async (w) => {
      const recorded: Array<{ key: string; tag: string; replaced: string[]; unchanged: boolean }> = [];
      const failed: Array<{ key: string; message: string }> = [];
      for (const { key, tag } of planned) {
        try {
          const item = await w.getItem(key);
          const data = item?.data ?? item;
          if (!data || typeof data !== 'object') throw new Error(`No item ${key}.`);
          if (NOT_SCREENABLE.has(String(data.itemType))) {
            throw new Error(`${key} is a ${data.itemType}, not a record to screen.`);
          }
          const current: Array<{ tag: string; type?: number }> = Array.isArray(data.tags) ? data.tags : [];
          const next = replaceScreeningTag(current, tag);
          if (!next.unchanged) await w.patchItem(key, { tags: next.tags }, item?.version ?? data.version);
          recorded.push({ key, tag: formatScreeningTag(tag), replaced: next.replaced, unchanged: next.unchanged });
        } catch (e) {
          if (mustFallBack(e)) throw e;
          failed.push({ key, message: e instanceof Error ? e.message : String(e) });
        }
      }
      const via = w.target === 'local' ? ' via the Zotero desktop app' : '';
      return writeResult(
        { stage: args.stage, ...(reviewer ? { reviewer } : {}), recorded, failed, target: w.target },
        `Recorded ${args.stage} decision(s)${reviewer ? ` for ${reviewer}` : ' (final)'} on ${recorded.length} item(s)${via}.`,
        recorded.length,
        planned.length,
        failed,
      );
    });
  },
};

export default screenItems;
