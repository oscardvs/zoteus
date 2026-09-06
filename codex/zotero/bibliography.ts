import { callMCPTool } from '../runtime.js';

/**
 * Server-rendered bibliography (library items) — Produce a formatted bibliography for items already in a Zotero library, rendered server-side by Zotero in a CSL style. Provide `item_keys` and optionally `style` (a name such as "apa" or "chicago author-date", or a CSL id; unset renders Zotero's default, chicago-shortened-notes-bibliography), `locale`, and `linkwrap`. Returns XHTML. Note: this endpoint is item-only and capped at 150 items. For arbitrary CSL-JSON or items not in the library, use zotero_format_bibliography instead.
 * Params: item_keys, style, locale, linkwrap, library_type, library_id.
 */
export function bibliography(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_bibliography', input);
}
