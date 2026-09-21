import { describe, it, expect, vi } from 'vitest';

/**
 * One entry that cannot be read must lose that entry, not the file.
 *
 * `parseBibliography`'s own docstring promises "a file whose entries are malformed comes
 * back with whatever could be read and a warning for each entry that could not", and it was
 * not true: the per-entry mapping ran inside a bare `.map`, so anything it threw (a title
 * nesting accent groups deep enough to exhaust the stack was the one that happened) failed
 * all 200 entries with an internal message that named neither the entry nor a remedy. The
 * decoder is bounded now, so the throw is forced here instead of waiting for the next value
 * that can produce one.
 */
vi.mock('../../src/features/import/latex.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/features/import/latex.js')>();
  return {
    ...actual,
    decodeLatex: (raw: string): string => {
      if (raw.includes('EXPLODE')) throw new RangeError('Maximum call stack size exceeded');
      return actual.decodeLatex(raw);
    },
  };
});

const { bibtexToRecords } = await import('../../src/features/import/bibtex.js');

describe('an entry whose mapping throws', () => {
  const file = '@article{good1, title = {First}}\n\n@article{bad, title = {EXPLODE}}\n\n@article{good2, title = {Second}}\n';

  it('skips only that entry and keeps the rest of the file', () => {
    const { records } = bibtexToRecords(file);
    expect(records.map((r) => r.label)).toEqual(['good1', 'good2']);
    expect(records[1]!.fields.title).toBe('Second');
  });

  it('names the entry it skipped and why', () => {
    const { warnings } = bibtexToRecords(file);
    expect(warnings.join(' ')).toMatch(/bad: this entry could not be read and was skipped \(Maximum call stack size exceeded\)/);
  });
});
