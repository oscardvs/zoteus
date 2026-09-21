import { describe, it, expect } from 'vitest';
import { tools } from '../src/tools/index.js';

// Mirrors the read-only filter in src/server.ts.
const readOnlyTools = tools.filter(
  (t) => t.annotations?.readOnlyHint === true || t.name === 'zotero_index',
);
const names = readOnlyTools.map((t) => t.name);

describe('read-only mode tool set', () => {
  it('keeps the read/discovery tools', () => {
    for (const t of [
      'zotero_whoami',
      'zotero_search_items',
      'zotero_get_item',
      'zotero_schema',
      'zotero_bibliography',
      'zotero_scholar',
      'zotero_semantic_search',
      'search_tools',
      'zotero_list_tags',
      'zotero_list_collections',
      'zotero_get_fulltext',
      'zotero_pdf_images',
      'zotero_tag_audit',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('excludes every library-mutating tool', () => {
    for (const t of [
      'zotero_create_items',
      'zotero_update_item',
      'zotero_trash_items',
      'zotero_delete_items',
      'zotero_manage_collections',
      'zotero_manage_tags',
      'zotero_saved_searches',
      'zotero_attachment',
      'zotero_import',
    ]) {
      expect(names).not.toContain(t);
    }
  });
});

/**
 * OpenAI's plugin review rejects a submission when any tool leaves one of the three
 * hints undeclared: "Every MCP tool must set readOnlyHint, openWorldHint,
 * destructiveHint to true or false." Eighteen read-only tools declared only two of
 * them and the scan failed. Inferring the third from readOnlyHint is not enough,
 * because the reviewer reads what the tool actually sends.
 */
describe('tool annotations', () => {
  it('declares readOnlyHint, openWorldHint and destructiveHint on every tool', () => {
    const undeclared = tools.flatMap((t) =>
      (['readOnlyHint', 'openWorldHint', 'destructiveHint'] as const)
        .filter((hint) => typeof t.annotations?.[hint] !== 'boolean')
        .map((hint) => `${t.name} is missing ${hint}`),
    );
    expect(undeclared).toEqual([]);
  });

  it('never marks a read-only tool destructive', () => {
    const contradictory = tools
      .filter((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === true)
      .map((t) => t.name);
    expect(contradictory).toEqual([]);
  });

  it('never marks a tool that writes to disk read-only, whatever it does to the library', () => {
    // Clients auto-approve on readOnlyHint. zotero_evidence_table declared it while writing
    // `save_path` (and replacing a file with overwrite:true); zotero_word_document is the
    // precedent for saying no.
    const diskWriters = tools.filter((t) => ['zotero_evidence_table', 'zotero_word_document'].includes(t.name));
    expect(diskWriters.map((t) => t.name).sort()).toEqual(['zotero_evidence_table', 'zotero_word_document']);
    for (const t of diskWriters) expect(t.annotations?.readOnlyHint).toBe(false);
  });
});
