import { callMCPTool } from '../runtime.js';

/**
 * Audit tags against a controlled vocabulary : Audit a library against a controlled tag vocabulary with priority tiers. Provide the vocabulary inline as `vocabulary` (or a JSON file via `vocabulary_path`): { tags:[{name,tier?}], tiers?:[{name,required?}] }. Reports (1) off-taxonomy tags (library tags not in the vocabulary; Zotero auto-applied tags are bucketed separately unless include_auto), (2) items missing a tag from each required tier, and (3) optional per-collection coverage when `scope.collection_keys` is given. A key that none of these objects knows is refused and named, never dropped: a dropped `scope`, `tier` or `required` would
 * Params: vocabulary, vocabulary_path, scope, include_auto, limit, library_type, library_id.
 */
export function tagAudit(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_tag_audit', input);
}
