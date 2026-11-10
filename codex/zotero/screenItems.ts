import { callMCPTool } from '../runtime.js';

/**
 * Record screening decisions on Zotero items : Record systematic-review screening decisions as Zotero tags on a batch of items, so the whole group library sees them. Decisions are Zotero tags of the form screen/<stage>/<decision>[:<reason>][@<reviewer>], e.g. "screen/title-abstract/exclude:wrong-population@alice"; stage is title-abstract or full-text, decision is include, exclude or maybe, a reason goes only on exclude, and a tag with no @reviewer is the final (consensus) decision. They sync to the whole group and stay readable in Zotero without Zoteus. Pass `reviewer` to record your own independent decision (dual screening); omit it to re
 * Params: stage, reviewer, decisions, confirm, library_type, library_id.
 */
export function screenItems(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_screen_items', input);
}
