import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AnyToolDefinition } from '../registry/registry.js';

const RESERVED = new Set([
  'import', 'export', 'default', 'function', 'class', 'return', 'new', 'delete', 'void', 'in', 'do', 'if',
]);

/** zotero_search_items -> searchItems ; search_tools -> searchTools ; zotero_import -> importTool (reserved) */
export function camelName(name: string): string {
  const base = name.replace(/^zotero_/, '').replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return RESERVED.has(base) ? `${base}Tool` : base;
}

function sanitize(desc: string): string {
  return desc.replace(/\s+/g, ' ').replace(/\*\//g, '* /').trim().slice(0, 600);
}

function wrapperSource(def: AnyToolDefinition): string {
  const fn = camelName(def.name);
  const params = Object.keys(def.inputSchema ?? {});
  const paramLine = params.length ? `\n * Params: ${params.join(', ')}.` : '\n * Takes no parameters.';
  return (
    `import { callMCPTool } from '../runtime.js';\n\n` +
    `/**\n * ${def.title} — ${sanitize(def.description)}${paramLine}\n */\n` +
    `export function ${fn}(input: Record<string, unknown> = {}): Promise<any> {\n` +
    `  return callMCPTool('${def.name}', input);\n}\n`
  );
}

const RUNTIME = `// Zoteus code-execution runtime bridge.
//
// In Anthropic's "code execution with MCP" pattern, the agent imports these
// typed wrappers and calls them from a sandbox instead of issuing many direct
// tool calls. Large intermediate results stay in the sandbox; only what you
// log/return reaches the model's context.
//
// Inject your sandbox's MCP bridge once at startup with setMCPCaller(...).
type Caller = (name: string, input: unknown) => Promise<any>;

let caller: Caller | null = null;

export function setMCPCaller(fn: Caller): void {
  caller = fn;
}

export async function callMCPTool(name: string, input: unknown): Promise<any> {
  if (!caller) {
    throw new Error(
      'No MCP caller configured. Call setMCPCaller(fn) with your sandbox bridge before using the Zotero wrappers.',
    );
  }
  return caller(name, input);
}
`;

function readme(defs: AnyToolDefinition[]): string {
  const rows = defs
    .map((d) => `| \`${camelName(d.name)}()\` | \`${d.name}\` | ${d.title} |`)
    .join('\n');
  return `# Zoteus — code-execution wrappers

Generated TypeScript wrappers for the Zoteus MCP tools, for use with Anthropic's
[code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) pattern.

Instead of loading every tool definition into the model context, an agent can
**progressively disclose** tools: list this directory, read only the few files it
needs, and call them from a code-execution sandbox. Large intermediate data
(full text, big exports, thousands of items) is filtered/aggregated in code and
never round-trips through the model.

## Usage

\`\`\`ts
import { setMCPCaller } from './runtime.js';
import { searchItems } from './zotero/searchItems.js';
import { formatBibliography } from './zotero/formatBibliography.js';

// 1. Bridge the wrappers to your live MCP connection once.
setMCPCaller((name, input) => myMcpClient.callTool({ name, arguments: input }));

// 2. Compose freely in code — only the small result is logged.
const { items } = (await searchItems({ tag: 'to-read', itemType: 'journalArticle', response_format: 'detailed' })).structuredContent;
const recent = items.filter((i) => Number(i.date?.slice(0, 4)) >= 2024);
console.log(await formatBibliography({ item_keys: recent.map((i) => i.key), style: 'IEEE' }));
\`\`\`

These files are generated from the tool registry — regenerate with \`npm run gen:codex\`.

## Available wrappers

| Function | MCP tool | Purpose |
|---|---|---|
${rows}
`;
}

/** Generate the code-execution wrapper tree under `outDir`. */
export async function generateCodex(defs: AnyToolDefinition[], outDir: string): Promise<void> {
  await mkdir(join(outDir, 'zotero'), { recursive: true });
  await writeFile(join(outDir, 'runtime.ts'), RUNTIME);
  const names: string[] = [];
  for (const def of defs) {
    const fn = camelName(def.name);
    names.push(fn);
    await writeFile(join(outDir, 'zotero', `${fn}.ts`), wrapperSource(def));
  }
  // Barrel is named mod.ts to avoid colliding with the zotero_index wrapper (index.ts).
  const barrel = names.map((n) => `export { ${n} } from './${n}.js';`).join('\n') + '\n';
  await writeFile(join(outDir, 'zotero', 'mod.ts'), barrel);
  await writeFile(join(outDir, 'README.md'), readme(defs));
}
