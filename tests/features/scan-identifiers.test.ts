import { describe, it, expect } from 'vitest';
import { hasTextLayer, scanIdentifiers } from '../../src/features/import/scan-identifiers.js';

describe('scanIdentifiers', () => {
  it('finds a DOI introduced by a label and marks it high confidence', () => {
    const [hit] = scanIdentifiers(['Published online. https://doi.org/10.1103/PhysRev.28.1049 (2020)']);
    expect(hit).toMatchObject({
      type: 'doi',
      value: '10.1103/PhysRev.28.1049',
      page: 1,
      confidence: 'high',
    });
    expect(hit!.label.toLowerCase()).toContain('doi.org');
    expect(hit!.context).toContain('Published online');
  });

  it('finds a bare DOI too, and says it is the weaker kind of match', () => {
    const [hit] = scanIdentifiers(['Preprint 10.5555/bare.string in a header']);
    expect(hit).toMatchObject({ type: 'doi', value: '10.5555/bare.string', confidence: 'low', label: '' });
  });

  it('trims the sentence punctuation a DOI collects in running text', () => {
    const [hit] = scanIdentifiers(['see doi:10.1000/xyz123.']);
    expect(hit!.value).toBe('10.1000/xyz123');
  });

  it('ranks a labelled hit above a bare one that came first', () => {
    const hits = scanIdentifiers(['10.9999/bare.one near the top', 'DOI: 10.1234/labelled.two']);
    expect(hits.map((h) => h.value)).toEqual(['10.1234/labelled.two', '10.9999/bare.one']);
    expect(hits[0]!.page).toBe(2);
  });

  it('records which page each hit was on', () => {
    const hits = scanIdentifiers(['nothing here', 'doi: 10.1234/second.page']);
    expect(hits[0]!.page).toBe(2);
  });

  it('finds an arXiv id in each of the forms a stamp uses', () => {
    expect(scanIdentifiers(['arXiv:2301.12345v2 [cs.SE]'])[0]).toMatchObject({
      type: 'arxiv',
      value: '2301.12345v2',
    });
    expect(scanIdentifiers(['https://arxiv.org/abs/2201.00001'])[0]).toMatchObject({
      type: 'arxiv',
      value: '2201.00001',
    });
    expect(scanIdentifiers(['arXiv:math.GT/0309136'])[0]).toMatchObject({
      type: 'arxiv',
      value: 'math.gt/0309136',
    });
  });

  it('collapses the same identifier repeated, keeping the labelled occurrence', () => {
    const hits = scanIdentifiers(['10.1234/same.doi appears bare', 'and as doi:10.1234/same.doi']);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.confidence).toBe('high');
  });

  it('finds nothing in a page with no identifier, rather than inventing one', () => {
    expect(scanIdentifiers(['A page of ordinary prose, with 10 or 20 numbers in it.'])).toEqual([]);
  });

  it('rejects a near-miss that is not a DOI', () => {
    // A DOI prefix is at least four digits after "10."; "10.12/x" is not one.
    expect(scanIdentifiers(['10.12/short and 10.abcd/letters'])).toEqual([]);
  });

  it('reads nothing out of empty pages', () => {
    expect(scanIdentifiers(['', '   '])).toEqual([]);
  });
});

describe('hasTextLayer', () => {
  it('tells a scanned PDF from one that simply has no identifier', () => {
    expect(hasTextLayer(['', '  '])).toBe(false);
    expect(hasTextLayer(['', 'some words'])).toBe(true);
  });
});
