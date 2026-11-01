import { describe, it, expect } from 'vitest';
import { progressLine } from '../../src/features/search/build.js';
import type { IndexBuildStatus } from '../../src/features/search/backend.js';

/**
 * The catch-up phase an update runs after its delta — re-reading the body text Zotero has
 * extracted since the stored cursor — is exactly the phase an outside observer read as a
 * stalled job in #106: `itemsFetched` sits still while the work goes on. The progress line
 * therefore says what the catch-up is doing while the job runs, and says nothing of it
 * once the job has finished.
 */

function status(over: Partial<IndexBuildStatus>): IndexBuildStatus {
  return {
    documents: 100,
    items: 100,
    passages: 300,
    vectors: 300,
    embedder: 'local',
    embedderConfigured: 'local',
    embedderActive: true,
    fulltextEnabled: true,
    state: 'building',
    operation: 'update',
    itemsFetched: 0,
    itemsRemoved: 0,
    itemsTotal: 100,
    itemsAvailable: 100,
    phase: 'metadata',
    fulltextItemsScanned: 0,
    fulltextItemsTotal: 0,
    ...over,
  } as IndexBuildStatus;
}

describe('progressLine: an update running its full-text catch-up (#106)', () => {
  it('says the census is being read while it is', () => {
    const line = progressLine(status({ catchupCensus: true, catchupScanned: 0, catchupTotal: 0 }));
    expect(line).toContain('full-text catch-up reading Zotero');
  });

  it('counts the body texts re-read so far', () => {
    const line = progressLine(status({ catchupScanned: 3, catchupTotal: 10 }));
    expect(line).toContain('full-text catch-up 3 of 10 body texts re-read');
  });

  it('says nothing of the catch-up once the update has finished', () => {
    const line = progressLine(status({ state: 'done', catchupScanned: 3, catchupTotal: 10 }));
    expect(line).not.toContain('catch-up');
  });

  it('leaves the plain update line unchanged when no catch-up is running', () => {
    const line = progressLine(status({}));
    expect(line).not.toContain('catch-up');
  });
});
