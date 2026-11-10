import { callMCPTool } from '../runtime.js';

/**
 * Screening status, queue, PRISMA flow and duplicates for a review collection : Read-only views for a systematic-review team screening a collection (works in group libraries). `action`: "queue" returns the next unscreened records for a `stage` (title, abstract, year, authors; pass `reviewer` for that reviewer's own blind queue, which hides the other reviewers' decisions); "status" counts decisions per stage, exclusion reasons, per-reviewer tallies, inter-rater agreement (percent and Cohen's kappa) and the records where reviewers disagree; "prisma" returns the PRISMA 2020 flow numbers with a ready text summary and a Mermaid diagram (pass `records_identified` or `sources` a
 * Params: action, collection_key, stage, reviewer, limit, start, records_identified, sources, duplicates_removed, library_type, library_id.
 */
export function review(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_review', input);
}
