import { callMCPTool } from '../runtime.js';

/**
 * Resolve CSL citation styles : Resolve a human citation-style name to a valid CSL style id and confirm it is available, or list common style aliases. `action: "resolve"` maps names like "APA 7th", "IEEE", "Vancouver", "Chicago", "MLA", "Nature" to the correct CSL id (e.g. apa, ieee, modern-language-association) and verifies the style can be fetched; pass the returned `styleId` as the `style` argument to zotero_format_bibliography or zotero_bibliography. `action: "list"` returns the built-in common aliases (any id from the CSL styles repository also works). Dependent styles are resolved to their independent parent automatica
 * Params: action, name.
 */
export function styles(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_styles', input);
}
