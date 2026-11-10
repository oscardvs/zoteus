import { z } from 'zod';
import { provenance } from './common-output.js';
import type { ToolDefinition } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { okLibraryContent, resolveLibrary } from '../registry/registry.js';
import { refusal } from '../features/notes/write-note.js';
import { crawlCollection, incompleteCrawlNote } from '../features/review/collection-records.js';
import {
  awaitsScreening,
  collectionDuplicates,
  prismaFlow,
  prismaMermaid,
  prismaText,
  screeningStatus,
  stageOutcome,
  stagePopulation,
} from '../features/review/screening.js';
import { STAGES, slug } from '../features/review/screening-tags.js';

/** The tag scheme in one sentence, shared by the read and the write tool so they never drift. */
export const SCREENING_SCHEME_HELP =
  'Decisions are Zotero tags of the form screen/<stage>/<decision>[:<reason>][@<reviewer>], e.g. "screen/title-abstract/exclude:wrong-population@alice"; stage is title-abstract or full-text, decision is include, exclude or maybe, a reason goes only on exclude, and a tag with no @reviewer is the final (consensus) decision. They sync to the whole group and stay readable in Zotero without Zoteus.';

export const stageArg = z
  .enum(STAGES)
  .describe('Screening stage: "title-abstract" (first pass) or "full-text" (eligibility of the full report).');

const tally = z
  .object({
    records: z.number().describe('Records in this stage: the whole collection for title-abstract, the eligible ones for full-text.'),
    include: z.number().describe('Records whose outcome is include.'),
    exclude: z.number().describe('Records whose outcome is exclude.'),
    maybe: z.number().describe('Records marked maybe.'),
    conflict: z.number().describe('Records where reviewers disagree and no final tag settles it.'),
    pending: z.number().describe('Records with no screening tag for this stage.'),
    reasons: z.record(z.number()).describe('Exclusion reasons and how many records carry each.'),
  })
  .passthrough();

const review: ToolDefinition = {
  name: 'zotero_review',
  title: 'Screening status, queue, PRISMA flow and duplicates for a review collection',
  description:
    'Read-only views for a systematic-review team screening a collection (works in group libraries). `action`: "queue" returns the next unscreened records for a `stage` (title, abstract, year, authors; pass `reviewer` for that reviewer\'s own blind queue, which hides the other reviewers\' decisions); "status" counts decisions per stage, exclusion reasons, per-reviewer tallies, inter-rater agreement (percent and Cohen\'s kappa) and the records where reviewers disagree; "prisma" returns the PRISMA 2020 flow numbers with a ready text summary and a Mermaid diagram (pass `records_identified` or `sources` and `duplicates_removed` when you know them from the database exports); "duplicates" lists groups of records in the collection that are the same work by exact DOI, ISBN or normalised title plus year (never fuzzy), with a suggested record to keep, for zotero_merge_items. ' +
    SCREENING_SCHEME_HELP +
    ' Record decisions with zotero_screen_items. Reads go to the running Zotero desktop app when it holds the library, otherwise to the cloud Web API; both answer the same.',
  inputSchema: {
    action: z.enum(['queue', 'status', 'prisma', 'duplicates']).describe('Which view: "queue", "status", "prisma" or "duplicates".'),
    collection_key: z.string().describe('The review collection (from zotero_list_collections). Subcollections are not included.'),
    stage: stageArg.optional().describe('queue only: the stage to screen (default "title-abstract"). The full-text queue holds only records included at title-abstract.'),
    reviewer: z
      .string()
      .optional()
      .describe('queue only: a reviewer name (slugged, e.g. "Alice B." becomes "alice-b"). Returns records this reviewer has not yet decided and that have no final decision. Omit for the team queue: records with no decision at all, plus unresolved conflicts.'),
    limit: z.number().int().min(1).max(100).optional().describe('queue only: records to return (default 25, max 100).'),
    start: z.number().int().min(0).optional().describe('queue only: skip this many queued records. Recording decisions shrinks the queue, so the next batch is usually start 0 again.'),
    records_identified: z.number().int().min(0).optional().describe('prisma only: total records your database searches returned, before deduplication.'),
    sources: z
      .record(z.number().int().min(0))
      .optional()
      .describe('prisma only: records identified per source, e.g. {"PubMed": 412, "Scopus": 380}. Summed when records_identified is not given.'),
    duplicates_removed: z.number().int().min(0).optional().describe('prisma only: duplicates you removed. Otherwise derived from records_identified, or read from the merge records Zotero leaves behind.'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      action: z.string().describe('The view returned.'),
      collection: z
        .object({ key: z.string().describe('Collection key.'), name: z.string().describe('Collection name.') })
        .passthrough()
        .describe('The collection read.'),
      records: z.number().describe('Top-level records in the collection (standalone notes and attachments are not records).'),
      complete: z.boolean().describe('False when the collection was larger than one read covers; every count then covers the part read.'),
      stage: z.string().optional().describe('queue: the stage queued.'),
      reviewer: z.string().optional().describe('queue: the reviewer slug the queue is for.'),
      queue: z
        .array(
          z
            .object({
              key: z.string().describe('Item key, to pass to zotero_screen_items.'),
              title: z.string().describe('Title.'),
              year: z.string().optional().describe('Publication year.'),
              authors: z.array(z.string()).describe('Creators, "Last, First".'),
              abstract: z.string().optional().describe('Abstract, when the record has one.'),
              itemType: z.string().describe('Zotero item type.'),
              conflict: z.boolean().optional().describe('Team queue only: true when reviewers disagree on this record.'),
            })
            .passthrough(),
        )
        .optional()
        .describe('queue: the records awaiting a decision, sorted by title.'),
      queued: z.number().optional().describe('queue: records awaiting a decision in total.'),
      nextStart: z.number().optional().describe('queue: pass as `start` to skip past this page; absent on the last one.'),
      stages: z.record(tally).optional().describe('status: tallies per stage.'),
      reviewers: z.record(z.record(z.record(z.number()))).optional().describe('status: per reviewer, per stage, how many include/exclude/maybe decisions.'),
      agreement: z
        .array(
          z
            .object({
              stage: z.string().describe('Stage.'),
              reviewers: z.array(z.string()).describe('The two reviewers compared.'),
              both: z.number().describe('Records both screened.'),
              percentAgreement: z.number().describe('Share of those with the same decision, 0 to 1.'),
              kappa: z.number().nullable().describe("Cohen's kappa; null when undefined."),
            })
            .passthrough(),
        )
        .optional()
        .describe('status: agreement for each pair of reviewers who screened the same records.'),
      disagreements: z
        .array(
          z
            .object({
              key: z.string().describe('Item key.'),
              title: z.string().describe('Title.'),
              stage: z.string().describe('Stage of the disagreement.'),
              decisions: z
                .array(
                  z
                    .object({
                      reviewer: z.string().describe('Reviewer slug.'),
                      decision: z.string().describe('Their decision.'),
                      reason: z.string().optional().describe('Their exclusion reason.'),
                    })
                    .passthrough(),
                )
                .describe('Each reviewer\'s decision.'),
              resolved: z.boolean().describe('True when a final tag settles it.'),
              finalDecision: z.string().optional().describe('The final decision, when resolved.'),
            })
            .passthrough(),
        )
        .optional()
        .describe('status: records where reviewers disagree (first 100).'),
      disagreementsTotal: z.number().optional().describe('status: records with a disagreement, in total.'),
      malformedTags: z
        .array(z.object({ key: z.string().describe('Item key.'), tag: z.string().describe('The tag.') }).passthrough())
        .optional()
        .describe('status: tags starting with "screen/" that the scheme cannot read, left untouched.'),
      prisma: z.record(z.unknown()).optional().describe('prisma: the flow numbers (recordsIdentified, duplicatesRemoved, recordsScreened, recordsExcluded, reportsSought, reportsAssessed, reportsExcluded, reportsExcludedReasons, studiesIncluded, and what is still open), each with where it came from.'),
      text: z.string().optional().describe('prisma: the flow as plain text, ready to paste.'),
      mermaid: z.string().optional().describe('prisma: the flow as a Mermaid flowchart.'),
      duplicateGroups: z.array(z.record(z.unknown())).optional().describe('duplicates (and prisma): groups of records that are one work: matchedOn, value, items, suggestedMaster.'),
      note: z.string().optional().describe('What the numbers do not cover, when anything.'),
      provenance,
    })
    .passthrough(),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const lib = resolveLibrary(ctx, args);
    const crawl = await crawlCollection(ctx, lib, args.collection_key);
    if ('problem' in crawl) return refusal(crawl.problem);
    const base: Record<string, unknown> = {
      action: args.action,
      collection: { key: args.collection_key, name: crawl.name },
      records: crawl.records.length,
      complete: crawl.complete,
    };
    const note = incompleteCrawlNote(crawl);
    if (note) base.note = note;
    const where = `collection "${crawl.name}"`;

    if (args.action === 'queue') {
      const stage = args.stage ?? 'title-abstract';
      const reviewer = args.reviewer ? slug(args.reviewer, true) : undefined;
      if (args.reviewer && !reviewer) return refusal('`reviewer` has no letters or digits to name a reviewer by.');
      const waiting = stagePopulation(crawl.records, stage)
        .filter((r) => awaitsScreening(r, stage, reviewer))
        .sort((a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key));
      const start = args.start ?? 0;
      const limit = args.limit ?? 25;
      const page = waiting.slice(start, start + limit);
      const queue = page.map((r) => {
        const row: Record<string, unknown> = { key: r.key, title: r.title, authors: r.authors, itemType: r.itemType };
        if (r.year) row.year = r.year;
        if (r.abstract) row.abstract = r.abstract;
        // Blind screening: a reviewer's queue never says what the others decided.
        if (!reviewer && stageOutcome(r, stage).outcome === 'conflict') row.conflict = true;
        return row;
      });
      const structured = { ...base, stage, ...(reviewer ? { reviewer } : {}), queue, queued: waiting.length } as Record<string, unknown>;
      if (start + limit < waiting.length) structured.nextStart = start + limit;
      const who = reviewer ? ` for ${reviewer}` : '';
      return okLibraryContent(
        structured,
        `${waiting.length} record(s) in ${where} await ${stage} screening${who}; returning ${page.length}.`,
      );
    }

    if (args.action === 'status') {
      const s = screeningStatus(crawl.records);
      const ta = s.stages['title-abstract'];
      const ft = s.stages['full-text'];
      return okLibraryContent(
        {
          ...base,
          stages: s.stages,
          reviewers: s.reviewers,
          agreement: s.agreement,
          disagreements: s.disagreements.slice(0, 100),
          disagreementsTotal: s.disagreements.length,
          malformedTags: s.malformedTags,
        },
        `${where}: ${crawl.records.length} record(s). Title-abstract: ${ta.include} include, ${ta.exclude} exclude, ${ta.maybe} maybe, ${ta.conflict} conflict, ${ta.pending} pending. ` +
          `Full-text: ${ft.include} include, ${ft.exclude} exclude, ${ft.maybe} maybe, ${ft.conflict} conflict, ${ft.pending} pending. ` +
          `${s.disagreements.filter((d) => !d.resolved).length} unresolved disagreement(s).`,
      );
    }

    const groups = collectionDuplicates(crawl.records);
    if (args.action === 'duplicates') {
      const extra = groups.reduce((n, g) => n + g.items.length - 1, 0);
      return okLibraryContent(
        { ...base, duplicateGroups: groups },
        groups.length
          ? `${groups.length} duplicate group(s) in ${where}: ${extra} record(s) beyond one per work. Merge each with zotero_merge_items (master_key = suggestedMaster); nothing was merged.`
          : `No duplicates in ${where} by exact DOI, ISBN or title plus year.`,
      );
    }

    const flow = prismaFlow(
      crawl.records,
      { recordsIdentified: args.records_identified, duplicatesRemoved: args.duplicates_removed, sources: args.sources },
      groups,
    );
    return okLibraryContent(
      { ...base, prisma: flow as unknown as Record<string, unknown>, text: prismaText(flow), mermaid: prismaMermaid(flow), duplicateGroups: groups },
      `PRISMA flow for ${where}: ${flow.recordsIdentified} identified, ${flow.duplicatesRemoved ?? 'unknown'} duplicates removed, ` +
        `${flow.recordsScreened} screened, ${flow.recordsExcluded} excluded, ${flow.reportsAssessed} assessed in full text, ${flow.studiesIncluded} included.`,
    );
  },
};

export default review;
