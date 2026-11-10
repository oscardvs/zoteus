import { describe, it, expect } from 'vitest';
import {
  formatScreeningTag,
  isMalformedScreeningTag,
  parseScreeningTag,
  replaceScreeningTag,
  slug,
} from '../../src/features/review/screening-tags.js';
import {
  agreementOf,
  awaitsScreening,
  collectionDuplicates,
  mergedAway,
  prismaFlow,
  prismaMermaid,
  prismaText,
  screeningStatus,
  stageOutcome,
} from '../../src/features/review/screening.js';
import { toReviewRecord, type ReviewRecord } from '../../src/features/review/collection-records.js';

function rec(key: string, tags: string[], data: Record<string, unknown> = {}): ReviewRecord {
  return toReviewRecord({ key, data: { key, itemType: 'journalArticle', title: `Paper ${key}`, date: '2020', tags: tags.map((tag) => ({ tag })), ...data } })!;
}

describe('screening tag scheme', () => {
  it('parses final and per-reviewer tags, with and without a reason', () => {
    expect(parseScreeningTag('screen/title-abstract/include')).toEqual({ stage: 'title-abstract', decision: 'include' });
    expect(parseScreeningTag('screen/title-abstract/exclude:wrong-population@alice')).toEqual({
      stage: 'title-abstract',
      decision: 'exclude',
      reason: 'wrong-population',
      reviewer: 'alice',
    });
    expect(parseScreeningTag('screen/full-text/maybe@bob.k')).toEqual({ stage: 'full-text', decision: 'maybe', reviewer: 'bob.k' });
  });

  it('refuses shapes outside the scheme', () => {
    expect(parseScreeningTag('screen/abstract/include')).toBeUndefined();
    expect(parseScreeningTag('screen/title-abstract/include:why')).toBeUndefined();
    expect(parseScreeningTag('Screen/title-abstract/include')).toBeUndefined();
    expect(isMalformedScreeningTag('screen/ta/yes')).toBe(true);
    expect(isMalformedScreeningTag('included')).toBe(false);
  });

  it('round-trips through format', () => {
    for (const t of ['screen/full-text/exclude:no-outcome-data@carol', 'screen/title-abstract/maybe']) {
      expect(formatScreeningTag(parseScreeningTag(t)!)).toBe(t);
    }
  });

  it('slugs reasons and reviewers', () => {
    expect(slug('Wrong Population!')).toBe('wrong-population');
    expect(slug('Alice B.', true)).toBe('alice-b');
    expect(slug('Ève')).toBe('eve');
  });

  it('replaces only the same stage and reviewer, keeping every other tag', () => {
    const current = [
      { tag: 'HILDA' },
      { tag: 'screen/title-abstract/include@alice', type: 0 },
      { tag: 'screen/title-abstract/exclude@bob' },
      { tag: 'screen/title-abstract/include' },
      { tag: 'screen/full-text/include@alice' },
      { tag: 'screen/odd' },
    ];
    const out = replaceScreeningTag(current, { stage: 'title-abstract', decision: 'exclude', reason: 'wrong-design', reviewer: 'alice' });
    expect(out.replaced).toEqual(['screen/title-abstract/include@alice']);
    expect(out.tags.map((t) => t.tag)).toEqual([
      'HILDA',
      'screen/title-abstract/exclude@bob',
      'screen/title-abstract/include',
      'screen/full-text/include@alice',
      'screen/odd',
      'screen/title-abstract/exclude:wrong-design@alice',
    ]);
    expect(out.unchanged).toBe(false);
  });

  it('reports a repeated decision as unchanged', () => {
    const out = replaceScreeningTag([{ tag: 'screen/title-abstract/include' }], { stage: 'title-abstract', decision: 'include' });
    expect(out.unchanged).toBe(true);
    expect(out.tags).toHaveLength(1);
  });
});

describe('outcomes and queues', () => {
  it('prefers the final tag, then reviewer agreement, then conflict, then pending', () => {
    expect(stageOutcome(rec('A', ['screen/title-abstract/exclude@a', 'screen/title-abstract/include']), 'title-abstract')).toMatchObject({ outcome: 'include', source: 'final' });
    expect(stageOutcome(rec('B', ['screen/title-abstract/include@a', 'screen/title-abstract/include@b']), 'title-abstract')).toMatchObject({ outcome: 'include', source: 'reviewers' });
    expect(stageOutcome(rec('C', ['screen/title-abstract/include@a', 'screen/title-abstract/exclude@b']), 'title-abstract').outcome).toBe('conflict');
    expect(stageOutcome(rec('D', ['other']), 'title-abstract').outcome).toBe('pending');
  });

  it('a reviewer queue skips what that reviewer decided; the team queue keeps conflicts', () => {
    const r = rec('A', ['screen/title-abstract/include@a', 'screen/title-abstract/exclude@b']);
    expect(awaitsScreening(r, 'title-abstract', 'a')).toBe(false);
    expect(awaitsScreening(r, 'title-abstract', 'c')).toBe(true);
    expect(awaitsScreening(r, 'title-abstract')).toBe(true);
    const done = rec('B', ['screen/title-abstract/include']);
    expect(awaitsScreening(done, 'title-abstract', 'c')).toBe(false);
  });
});

describe('status', () => {
  const records = [
    rec('A', ['screen/title-abstract/include@alice', 'screen/title-abstract/include@bob', 'screen/full-text/exclude:wrong-outcome']),
    rec('B', ['screen/title-abstract/include@alice', 'screen/title-abstract/exclude:wrong-population@bob']),
    rec('C', ['screen/title-abstract/exclude:wrong-population']),
    rec('D', ['screen/title-abstract/include', 'screen/full-text/include']),
    rec('E', ['screen/nonsense']),
  ];
  const s = screeningStatus(records);

  it('tallies each stage over its own population', () => {
    expect(s.stages['title-abstract']).toMatchObject({ records: 5, include: 2, exclude: 1, conflict: 1, pending: 1 });
    expect(s.stages['title-abstract'].reasons).toEqual({ 'wrong-population': 1 });
    expect(s.stages['full-text']).toMatchObject({ records: 2, include: 1, exclude: 1, pending: 0 });
    expect(s.stages['full-text'].reasons).toEqual({ 'wrong-outcome': 1 });
  });

  it('lists disagreements, per-reviewer counts and malformed tags', () => {
    expect(s.disagreements).toEqual([
      {
        key: 'B',
        title: 'Paper B',
        stage: 'title-abstract',
        decisions: [
          { reviewer: 'alice', decision: 'include' },
          { reviewer: 'bob', decision: 'exclude', reason: 'wrong-population' },
        ],
        resolved: false,
      },
    ]);
    expect(s.reviewers.alice?.['title-abstract']).toEqual({ include: 2, exclude: 0, maybe: 0 });
    expect(s.malformedTags).toEqual([{ key: 'E', tag: 'screen/nonsense' }]);
    expect(s.agreement).toEqual([{ stage: 'title-abstract', reviewers: ['alice', 'bob'], both: 2, percentAgreement: 0.5, kappa: 0 }]);
  });

  it("computes Cohen's kappa", () => {
    // 10 votes: 4 both include, 4 both exclude, 2 split. po = 0.8, pe = 0.5, kappa = 0.6.
    const votes: Array<['include' | 'exclude', 'include' | 'exclude']> = [
      ...Array(4).fill(['include', 'include']),
      ...Array(4).fill(['exclude', 'exclude']),
      ['include', 'exclude'],
      ['exclude', 'include'],
    ];
    expect(agreementOf(votes)).toEqual({ percentAgreement: 0.8, kappa: 0.6 });
    expect(agreementOf([['include', 'include']]).kappa).toBeNull();
  });
});

describe('duplicates inside a collection', () => {
  it('groups by DOI and title, transitively, and suggests the record with most children', () => {
    const records = [
      toReviewRecord({ key: 'P1', meta: { numChildren: 0 }, data: { key: 'P1', itemType: 'journalArticle', title: 'Deep learning', DOI: '10.1/X', date: '2015', dateAdded: '2026-01-01T00:00:00Z' } })!,
      toReviewRecord({ key: 'P2', meta: { numChildren: 2 }, data: { key: 'P2', itemType: 'journalArticle', title: 'Deep Learning.', DOI: 'https://doi.org/10.1/x', date: '2015', dateAdded: '2026-01-02T00:00:00Z' } })!,
      toReviewRecord({ key: 'P3', data: { key: 'P3', itemType: 'journalArticle', title: 'Deep learning', date: '2016' } })!,
      toReviewRecord({ key: 'P4', data: { key: 'P4', itemType: 'journalArticle', title: 'Something else', date: '2016' } })!,
    ];
    const groups = collectionDuplicates(records);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((i) => i.key).sort()).toEqual(['P1', 'P2', 'P3']);
    expect(groups[0]!.matchedOn).toBe('doi');
    expect(groups[0]!.suggestedMaster).toBe('P2');
  });

  it('counts records already merged away from dc:replaces relations', () => {
    expect(mergedAway([rec('A', [], { relations: { 'dc:replaces': ['u/1', 'u/2'] } }), rec('B', [], { relations: { 'dc:replaces': 'u/3' } })])).toBe(3);
  });
});

describe('PRISMA flow', () => {
  const records = [
    rec('A', ['screen/title-abstract/include', 'screen/full-text/include']),
    rec('B', ['screen/title-abstract/include', 'screen/full-text/exclude:wrong-outcome']),
    rec('C', ['screen/title-abstract/exclude:wrong-population']),
    rec('D', ['screen/title-abstract/include']),
    rec('E', []),
  ];

  it('derives duplicates from the identified total the caller gives', () => {
    const f = prismaFlow(records, { sources: { PubMed: 6, Scopus: 2 } });
    expect(f).toMatchObject({
      recordsIdentified: 8,
      identifiedFrom: 'sources',
      duplicatesRemoved: 3,
      duplicatesFrom: 'derived',
      recordsScreened: 4,
      recordsExcluded: 1,
      recordsAwaitingScreening: 1,
      reportsSought: 3,
      reportsAssessed: 2,
      reportsExcluded: 1,
      reportsExcludedReasons: { 'wrong-outcome': 1 },
      reportsAwaitingAssessment: 1,
      studiesIncluded: 1,
    });
    expect(prismaText(f)).toContain('Records identified: n = 8 (PubMed: 6; Scopus: 2)');
    expect(prismaText(f)).toContain('wrong outcome (n = 1)');
    expect(prismaMermaid(f)).toMatch(/^flowchart TD/);
    expect(prismaMermaid(f)).toContain('Studies included in review (n = 1)');
  });

  it('says duplicates are unknown when nothing tells it', () => {
    const f = prismaFlow(records);
    expect(f.duplicatesRemoved).toBeNull();
    expect(f.recordsIdentified).toBe(5);
    expect(prismaText(f)).toContain('Duplicate records removed: n = unknown');
  });

  it('reads merges from relations when the caller gives nothing', () => {
    const f = prismaFlow([...records, rec('F', [], { relations: { 'dc:replaces': ['x'] } })]);
    expect(f).toMatchObject({ duplicatesRemoved: 1, duplicatesFrom: 'merge-relations', recordsIdentified: 7 });
  });
});
