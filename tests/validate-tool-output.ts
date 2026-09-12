import { beforeAll } from 'vitest';
import type { ToolContext } from '../src/registry/registry.js';

/**
 * Every successful tool result a test produces is checked against that tool's
 * `outputSchema`, exactly as the MCP SDK checks it on the wire.
 *
 * The SDK refuses a non-error result whose `structuredContent` does not match the schema
 * the tool advertises, which turns a mismatch into a broken tool rather than a cosmetic
 * documentation bug. The handlers are already driven over every branch by the suite, so
 * wrapping them here is what makes those branches test the schema too, including the write
 * paths that must never be run against a real library.
 *
 * The wrapping happens in `beforeAll` rather than at setup time on purpose: a setup file
 * that imported the tool graph directly would populate the module registry BEFORE a test
 * file's own `vi.mock` calls are registered, and every mock of a module a tool imports
 * (citeproc-engine, for instance) would silently stop taking effect.
 */
const wrapped = Symbol.for('zoteus.outputSchemaChecked');

beforeAll(async () => {
  const { tools } = await import('../src/tools/index.js');
  for (const def of tools) {
    const handler = def.handler as typeof def.handler & { [wrapped]?: true };
    if (handler[wrapped]) continue;
    const inner = handler.bind(def);
    const checked = async (args: unknown, ctx: ToolContext) => {
      const result = await inner(args, ctx);
      if (def.outputSchema && !result?.isError) {
        if (!result?.structuredContent) {
          throw new Error(`${def.name} returned no structuredContent, but advertises an outputSchema.`);
        }
        const parsed = def.outputSchema.safeParse(result.structuredContent);
        if (!parsed.success) {
          throw new Error(
            `${def.name}: structuredContent does not match its outputSchema:\n${JSON.stringify(parsed.error.issues, null, 2)}`,
          );
        }
      }
      return result;
    };
    (checked as { [wrapped]?: true })[wrapped] = true;
    def.handler = checked;
  }
});
