import { DuplicateIndex, type MatchedOn } from '../dedupe/find.js';
import { doiFrom, isbnKeys, surnameKeys, titleKey, type CensusEntry } from '../resolve/library-census.js';
import type { ReviewRecord } from './collection-records.js';
import {
  DECISIONS,
  STAGES,
  isMalformedScreeningTag,
  parseScreeningTag,
  type Decision,
  type ScreeningTag,
  type Stage,
} from './screening-tags.js';

/**
 * What the screening tags on a collection add up to. Pure functions over crawled records, so
 * every rule below is tested without a Zotero.
 *
 * The rules, stated once (docs/screening-and-review-teams.md says the same):
 *
 *   - A stage's OUTCOME for an item is its final tag (no `@reviewer`) when it has one.
 *   - Without a final tag, reviewer tags that all give the same decision are that outcome
 *     (source "reviewers"); reviewer tags that differ are a "conflict"; no tag is "pending".
 *   - `maybe` is an outcome that is not yet a decision: it has its own count in the stage
 *     tallies, and PRISMA counts it as still awaiting screening, never as screened.
 *   - An item is ELIGIBLE for full-text screening when its title-abstract outcome is
 *     `include`, or when it already carries any full-text tag (a team that skipped tagging
 *     the first stage still gets counted).
 */

export type Outcome = Decision | 'conflict' | 'pending';

export interface StageOutcome {
  outcome: Outcome;
  source?: 'final' | 'reviewers';
  reason?: string;
  reviewers: ScreeningTag[];
  final?: ScreeningTag;
}

export function screeningTagsOf(rec: ReviewRecord): ScreeningTag[] {
  return rec.tags.map(parseScreeningTag).filter((t): t is ScreeningTag => !!t);
}

export function stageOutcome(rec: ReviewRecord, stage: Stage): StageOutcome {
  const tags = screeningTagsOf(rec).filter((t) => t.stage === stage);
  const final = tags.find((t) => !t.reviewer);
  const reviewers = tags.filter((t) => t.reviewer);
  if (final) return { outcome: final.decision, source: 'final', reason: final.reason, reviewers, final };
  if (!reviewers.length) return { outcome: 'pending', reviewers };
  const decisions = new Set(reviewers.map((t) => t.decision));
  if (decisions.size > 1) return { outcome: 'conflict', reviewers };
  const reasons = new Set(reviewers.map((t) => t.reason ?? ''));
  return {
    outcome: reviewers[0]!.decision,
    source: 'reviewers',
    reason: reasons.size === 1 ? reviewers[0]!.reason : undefined,
    reviewers,
  };
}

export function fullTextEligible(rec: ReviewRecord): boolean {
  if (stageOutcome(rec, 'title-abstract').outcome === 'include') return true;
  return screeningTagsOf(rec).some((t) => t.stage === 'full-text');
}

/** The records in a stage's population: everything for title-abstract, the eligible ones for full text. */
export function stagePopulation(records: ReviewRecord[], stage: Stage): ReviewRecord[] {
  return stage === 'title-abstract' ? records : records.filter(fullTextEligible);
}

/**
 * Whether `rec` still waits for a decision at `stage`: by `reviewer` when given (no tag of
 * theirs and no final tag), otherwise for the team (no final tag and no reviewer agreement).
 * A conflict waits for the team, never for a reviewer who has already decided.
 */
export function awaitsScreening(rec: ReviewRecord, stage: Stage, reviewer?: string): boolean {
  const o = stageOutcome(rec, stage);
  if (o.final) return false;
  if (reviewer) return !o.reviewers.some((t) => t.reviewer === reviewer);
  return o.outcome === 'pending' || o.outcome === 'conflict';
}

// ---------------------------------------------------------------- status

export interface StageTally {
  records: number;
  include: number;
  exclude: number;
  maybe: number;
  conflict: number;
  pending: number;
  /** Exclusion reasons and how many items carry each; "(none given)" for a bare exclude. */
  reasons: Record<string, number>;
}

export interface Disagreement {
  key: string;
  title: string;
  stage: Stage;
  decisions: Array<{ reviewer: string; decision: Decision; reason?: string }>;
  /** True when a final tag settles it. */
  resolved: boolean;
  finalDecision?: Decision;
}

export interface PairAgreement {
  stage: Stage;
  reviewers: [string, string];
  /** Items both reviewers screened at this stage. */
  both: number;
  /** Share of those where they gave the same decision, 0 to 1. */
  percentAgreement: number;
  /** Cohen's kappa over include/exclude/maybe; null when undefined (one category only). */
  kappa: number | null;
}

export interface ScreeningStatus {
  stages: Record<Stage, StageTally>;
  reviewers: Record<string, Record<Stage, Record<Decision, number>>>;
  disagreements: Disagreement[];
  agreement: PairAgreement[];
  malformedTags: Array<{ key: string; tag: string }>;
}

const NO_REASON = '(none given)';

function emptyTally(records: number): StageTally {
  return { records, include: 0, exclude: 0, maybe: 0, conflict: 0, pending: 0, reasons: {} };
}

export function screeningStatus(records: ReviewRecord[]): ScreeningStatus {
  const stages = {} as Record<Stage, StageTally>;
  const reviewers: ScreeningStatus['reviewers'] = {};
  const disagreements: Disagreement[] = [];
  const pairVotes = new Map<string, Array<[Decision, Decision]>>();
  for (const stage of STAGES) {
    const population = stagePopulation(records, stage);
    const tally = emptyTally(population.length);
    for (const rec of population) {
      const o = stageOutcome(rec, stage);
      tally[o.outcome]++;
      if (o.outcome === 'exclude') {
        const reason = o.reason ?? NO_REASON;
        tally.reasons[reason] = (tally.reasons[reason] ?? 0) + 1;
      }
      for (const t of o.reviewers) {
        const r = (reviewers[t.reviewer!] ??= {
          'title-abstract': { include: 0, exclude: 0, maybe: 0 },
          'full-text': { include: 0, exclude: 0, maybe: 0 },
        });
        r[stage][t.decision]++;
      }
      if (new Set(o.reviewers.map((t) => t.decision)).size > 1) {
        disagreements.push({
          key: rec.key,
          title: rec.title,
          stage,
          decisions: o.reviewers.map((t) => ({ reviewer: t.reviewer!, decision: t.decision, ...(t.reason ? { reason: t.reason } : {}) })),
          resolved: !!o.final,
          ...(o.final ? { finalDecision: o.final.decision } : {}),
        });
      }
      const byReviewer = [...o.reviewers].sort((a, b) => a.reviewer!.localeCompare(b.reviewer!));
      for (let i = 0; i < byReviewer.length; i++) {
        for (let j = i + 1; j < byReviewer.length; j++) {
          const a = byReviewer[i]!;
          const b = byReviewer[j]!;
          const id = `${stage}\u0000${a.reviewer}\u0000${b.reviewer}`;
          const list = pairVotes.get(id) ?? [];
          list.push([a.decision, b.decision]);
          pairVotes.set(id, list);
        }
      }
    }
    stages[stage] = tally;
  }
  const agreement: PairAgreement[] = [...pairVotes.entries()].map(([id, votes]) => {
    const [stage, a, b] = id.split('\u0000') as [Stage, string, string];
    return { stage, reviewers: [a, b] as [string, string], both: votes.length, ...agreementOf(votes) };
  });
  const malformedTags = records.flatMap((rec) => rec.tags.filter(isMalformedScreeningTag).map((tag) => ({ key: rec.key, tag })));
  return { stages, reviewers, disagreements, agreement, malformedTags };
}

/** Percent agreement and Cohen's kappa for one pair of reviewers' votes. */
export function agreementOf(votes: Array<[Decision, Decision]>): { percentAgreement: number; kappa: number | null } {
  const n = votes.length;
  if (!n) return { percentAgreement: 0, kappa: null };
  const agree = votes.filter(([a, b]) => a === b).length;
  const po = agree / n;
  let pe = 0;
  for (const d of DECISIONS) {
    const pa = votes.filter(([a]) => a === d).length / n;
    const pb = votes.filter(([, b]) => b === d).length / n;
    pe += pa * pb;
  }
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return { percentAgreement: round(po), kappa: pe === 1 ? null : round((po - pe) / (1 - pe)) };
}

// ---------------------------------------------------------------- duplicates

export interface DuplicateGroup {
  matchedOn: MatchedOn;
  value: string;
  items: Array<{ key: string; title: string; year?: string; itemType: string; dateAdded?: string; children?: number; caveat?: string }>;
  /** The record to keep if merged: most child items (PDFs, notes), then the earliest added. */
  suggestedMaster: string;
}

function censusEntry(rec: ReviewRecord): CensusEntry {
  return {
    key: rec.key,
    title: rec.title || undefined,
    titleKey: titleKey(rec.title || undefined),
    doi: doiFrom(rec.data),
    isbns: isbnKeys(rec.data.ISBN),
    itemType: rec.itemType,
    year: rec.year,
    surnames: surnameKeys(rec.data.creators),
  };
}

/**
 * Duplicate groups INSIDE the given records, using the exact-identifier rules every other
 * duplicate check here uses (DOI, then ISBN, then normalised title plus year). Matches are
 * joined transitively, so three exports of one paper are one group of three.
 */
export function collectionDuplicates(records: ReviewRecord[]): DuplicateGroup[] {
  const entries = records.map(censusEntry);
  const index = new DuplicateIndex({ entries, scanned: entries.length, complete: true });
  const parent = new Map<string, string>(records.map((r) => [r.key, r.key]));
  const find = (k: string): string => {
    let p = parent.get(k)!;
    while (p !== parent.get(p)) p = parent.get(p)!;
    parent.set(k, p);
    return p;
  };
  const how = new Map<string, { matchedOn: MatchedOn; value: string }>();
  const caveats = new Map<string, string>();
  const rank: Record<MatchedOn, number> = { doi: 0, isbn: 1, title: 2 };
  for (const rec of records) {
    const matches = index.matchesFor({
      key: rec.key,
      title: rec.title,
      DOI: rec.data.DOI,
      ISBN: rec.data.ISBN,
      date: rec.data.date,
      itemType: rec.itemType,
      extra: rec.data.extra,
      creators: rec.data.creators,
    });
    for (const m of matches) {
      const a = find(rec.key);
      const b = find(m.item_key);
      if (m.caveat) caveats.set(m.item_key, m.caveat);
      const root = a < b ? a : b;
      const other = root === a ? b : a;
      const prev = [how.get(a), how.get(b)].filter(Boolean) as Array<{ matchedOn: MatchedOn; value: string }>;
      prev.push({ matchedOn: m.matchedOn, value: m.value });
      prev.sort((x, y) => rank[x.matchedOn] - rank[y.matchedOn]);
      parent.set(other, root);
      how.set(root, prev[0]!);
    }
  }
  const groups = new Map<string, ReviewRecord[]>();
  for (const rec of records) {
    const root = find(rec.key);
    const list = groups.get(root) ?? [];
    list.push(rec);
    groups.set(root, list);
  }
  const out: DuplicateGroup[] = [];
  for (const [root, members] of groups) {
    if (members.length < 2) continue;
    const master = [...members].sort(
      (a, b) => (b.numChildren ?? 0) - (a.numChildren ?? 0) || (a.dateAdded ?? '').localeCompare(b.dateAdded ?? '') || a.key.localeCompare(b.key),
    )[0]!;
    const basis = how.get(root)!;
    out.push({
      matchedOn: basis.matchedOn,
      value: basis.value,
      items: members.map((r) => ({
        key: r.key,
        title: r.title,
        ...(r.year ? { year: r.year } : {}),
        itemType: r.itemType,
        ...(r.dateAdded ? { dateAdded: r.dateAdded } : {}),
        ...(r.numChildren != null ? { children: r.numChildren } : {}),
        ...(caveats.has(r.key) ? { caveat: caveats.get(r.key) } : {}),
      })),
      suggestedMaster: master.key,
    });
  }
  return out.sort((a, b) => b.items.length - a.items.length || a.items[0]!.title.localeCompare(b.items[0]!.title));
}

/**
 * How many records were merged away INTO the given records. Zotero's own merge and
 * zotero_merge_items both leave a `dc:replaces` relation on the record they keep, one per
 * record merged into it, so this is a count of duplicates already removed, readable from
 * the library itself. Merges done some other way (deleting a copy by hand) leave nothing.
 */
export function mergedAway(records: ReviewRecord[]): number {
  let n = 0;
  for (const rec of records) {
    const rel = (rec.data.relations ?? {}) as Record<string, unknown>;
    const v = rel['dc:replaces'];
    n += Array.isArray(v) ? v.length : typeof v === 'string' && v ? 1 : 0;
  }
  return n;
}

// ---------------------------------------------------------------- PRISMA

export interface PrismaInputs {
  recordsIdentified?: number;
  duplicatesRemoved?: number;
  /** Records identified per source database, e.g. {"PubMed": 412}. Summed when recordsIdentified is not given. */
  sources?: Record<string, number>;
}

export interface PrismaFlow {
  recordsIdentified: number;
  identifiedFrom: 'caller' | 'sources' | 'collection';
  sources?: Record<string, number>;
  duplicatesRemoved: number | null;
  duplicatesFrom: 'caller' | 'merge-relations' | 'derived' | 'unknown';
  duplicatesStillInCollection: number;
  recordsScreened: number;
  recordsExcluded: number;
  recordsAwaitingScreening: number;
  reportsSought: number;
  reportsAssessed: number;
  reportsExcluded: number;
  reportsExcludedReasons: Record<string, number>;
  reportsAwaitingAssessment: number;
  studiesIncluded: number;
}

export function prismaFlow(records: ReviewRecord[], inputs: PrismaInputs = {}, duplicateGroups?: DuplicateGroup[]): PrismaFlow {
  const status = screeningStatus(records);
  const ta = status.stages['title-abstract'];
  const ft = status.stages['full-text'];
  const sourcesTotal = inputs.sources ? Object.values(inputs.sources).reduce((a, b) => a + b, 0) : undefined;
  const merged = mergedAway(records);

  let duplicatesRemoved: number | null;
  let duplicatesFrom: PrismaFlow['duplicatesFrom'];
  let recordsIdentified: number;
  let identifiedFrom: PrismaFlow['identifiedFrom'];
  const identifiedGiven = inputs.recordsIdentified ?? sourcesTotal;
  if (inputs.duplicatesRemoved != null) {
    duplicatesRemoved = inputs.duplicatesRemoved;
    duplicatesFrom = 'caller';
  } else if (identifiedGiven != null) {
    duplicatesRemoved = Math.max(0, identifiedGiven - records.length);
    duplicatesFrom = 'derived';
  } else if (merged) {
    duplicatesRemoved = merged;
    duplicatesFrom = 'merge-relations';
  } else {
    duplicatesRemoved = null;
    duplicatesFrom = 'unknown';
  }
  if (identifiedGiven != null) {
    recordsIdentified = identifiedGiven;
    identifiedFrom = inputs.recordsIdentified != null ? 'caller' : 'sources';
  } else {
    recordsIdentified = records.length + (duplicatesRemoved ?? 0);
    identifiedFrom = 'collection';
  }
  const stillDuplicated = (duplicateGroups ?? []).reduce((n, g) => n + g.items.length - 1, 0);
  return {
    recordsIdentified,
    identifiedFrom,
    ...(inputs.sources ? { sources: inputs.sources } : {}),
    duplicatesRemoved,
    duplicatesFrom,
    duplicatesStillInCollection: stillDuplicated,
    recordsScreened: ta.include + ta.exclude,
    recordsExcluded: ta.exclude,
    recordsAwaitingScreening: ta.pending + ta.conflict + ta.maybe,
    reportsSought: ft.records,
    reportsAssessed: ft.include + ft.exclude,
    reportsExcluded: ft.exclude,
    reportsExcludedReasons: ft.reasons,
    reportsAwaitingAssessment: ft.pending + ft.conflict + ft.maybe,
    studiesIncluded: ft.include,
  };
}

function reasonLines(reasons: Record<string, number>): string[] {
  return Object.entries(reasons)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([r, n]) => `${r.replace(/-/g, ' ')} (n = ${n})`);
}

export function prismaText(f: PrismaFlow): string {
  const dup = f.duplicatesRemoved == null ? 'unknown' : String(f.duplicatesRemoved);
  const lines = [
    `Records identified: n = ${f.recordsIdentified}` +
      (f.sources ? ` (${Object.entries(f.sources).map(([s, n]) => `${s}: ${n}`).join('; ')})` : ''),
    `Duplicate records removed: n = ${dup}`,
    `Records screened (title and abstract): n = ${f.recordsScreened}`,
    `Records excluded: n = ${f.recordsExcluded}`,
    `Reports sought for retrieval: n = ${f.reportsSought}`,
    `Reports assessed for eligibility (full text): n = ${f.reportsAssessed}`,
    `Reports excluded: n = ${f.reportsExcluded}`,
    ...reasonLines(f.reportsExcludedReasons).map((l) => `  ${l}`),
    `Studies included in review: n = ${f.studiesIncluded}`,
  ];
  const open = [
    f.recordsAwaitingScreening ? `${f.recordsAwaitingScreening} record(s) still await title and abstract screening` : '',
    f.reportsAwaitingAssessment ? `${f.reportsAwaitingAssessment} report(s) still await full-text assessment` : '',
    f.duplicatesStillInCollection ? `${f.duplicatesStillInCollection} duplicate record(s) are still in the collection` : '',
  ].filter(Boolean);
  if (open.length) lines.push(`Not final: ${open.join('; ')}.`);
  return lines.join('\n');
}

export function prismaMermaid(f: PrismaFlow): string {
  const q = (s: string) => `"${s.replace(/"/g, "'")}"`;
  const dup = f.duplicatesRemoved == null ? 'unknown' : String(f.duplicatesRemoved);
  const reasons = reasonLines(f.reportsExcludedReasons);
  const sources = f.sources ? `<br/>${Object.entries(f.sources).map(([s, n]) => `${s} (n = ${n})`).join('<br/>')}` : '';
  return [
    'flowchart TD',
    `  id1[${q(`Records identified (n = ${f.recordsIdentified})${sources}`)}] --> id2[${q(`Duplicate records removed (n = ${dup})`)}]`,
    `  id1 --> s1[${q(`Records screened (n = ${f.recordsScreened})`)}]`,
    `  s1 --> x1[${q(`Records excluded (n = ${f.recordsExcluded})`)}]`,
    `  s1 --> r1[${q(`Reports sought for retrieval (n = ${f.reportsSought})`)}]`,
    `  r1 --> a1[${q(`Reports assessed for eligibility (n = ${f.reportsAssessed})`)}]`,
    `  a1 --> x2[${q(`Reports excluded (n = ${f.reportsExcluded})${reasons.length ? `<br/>${reasons.join('<br/>')}` : ''}`)}]`,
    `  a1 --> i1[${q(`Studies included in review (n = ${f.studiesIncluded})`)}]`,
  ].join('\n');
}
