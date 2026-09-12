# Code execution with MCP

Zoteus implements the pattern from Anthropic's [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp): instead of loading every tool definition into the model's context and round-tripping large intermediate results, an agent can **write code** that imports typed wrappers and calls Zotero from a sandbox.

## Two pieces

### 1. `search_tools` — progressive disclosure
Rather than presenting all 31 tools up front, an agent can call `search_tools` (the only non-namespaced tool) to discover the right `zotero_*` tools for a task by keyword, at `names` or `descriptions` detail. This keeps the working context small.

### 2. Generated TypeScript wrappers (`/codex`)
`npm run gen:codex` generates, from the single tool registry, one typed wrapper per tool under [`codex/zotero/`](../codex/zotero), plus `codex/runtime.ts` and a barrel `codex/zotero/mod.ts`. Each wrapper is a thin function that forwards to the MCP tool:

```ts
// codex/zotero/searchItems.ts
import { callMCPTool } from '../runtime.js';
export function searchItems(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_search_items', input);
}
```

An agent in a code-execution sandbox:
1. lists `codex/zotero/` and reads only the wrappers it needs (progressive disclosure),
2. bridges them to the live MCP connection once via `setMCPCaller(...)`,
3. composes them in real code — looping, filtering, and aggregating **in the sandbox** so only a small result reaches the model:

```ts
import { setMCPCaller } from './codex/runtime.js';
import { searchItems } from './codex/zotero/searchItems.js';
import { manageCollections } from './codex/zotero/manageCollections.js';

setMCPCaller((name, input) => mcpClient.callTool({ name, arguments: input }));

// "Find 2024 'to-read' papers and move them to Reviewed" — one script, not 50 tool calls.
const { items } = (await searchItems({ tag: 'to-read', response_format: 'detailed', limit: 100 })).structuredContent;
const recent = items.filter((i) => Number(i.date?.slice(0, 4)) >= 2024);
await manageCollections({ action: 'add_items', collection_key: 'REVIEWED1', item_keys: recent.map((i) => i.key) });
console.log(`Moved ${recent.length} papers.`);
```

The wrappers are generated from the registry, so they never drift from the live tools — regenerate with `npm run gen:codex`.

## Why this matters for Zotero
Researcher workflows are exactly the "fetch a lot → filter → act on a subset" shape this optimizes: a 10k-item export, a full-text dump, or a large CSL-JSON list stays in the sandbox; the model sees only the few results it asked for.
