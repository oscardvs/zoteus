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
