import { callMCPTool } from '../runtime.js';

/**
 * Discover Zotero tools : Discover the available Zotero tools by keyword : useful for progressive disclosure when you do not want to load every tool definition up front (the code-execution-with-MCP pattern). Pass an optional `query` (matched against tool names, titles, and descriptions) and `detail` ("names" or "descriptions", default "descriptions"). Returns the matching `zotero_*` tools so you can pick the right one for a task. With no query, returns the full catalog.
 * Params: query, detail.
 */
export function searchTools(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('search_tools', input);
}
