import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { ok } from '../registry/registry.js';
import { COMMON_STYLES } from '../features/citation/styles.js';

const styles: ToolDefinition = {
  name: 'zotero_styles',
  title: 'Resolve CSL citation styles',
  description:
    'Resolve a human citation-style name to a valid CSL style id and confirm it is available, or list common style aliases. `action: "resolve"` maps names like "APA 7th", "IEEE", "Vancouver", "Chicago", "MLA", "Nature" to the correct CSL id (e.g. apa, ieee, modern-language-association) and verifies the style can be fetched; pass the returned `styleId` as the `style` argument to zotero_format_bibliography or zotero_bibliography. `action: "list"` returns the built-in common aliases (any id from the CSL styles repository also works). Dependent styles are resolved to their independent parent automatically when formatting.',
  inputSchema: {
    action: z
      .enum(['list', 'resolve'])
      .describe(
        'What to do: "resolve" maps `name` to a CSL style id and checks it can be fetched; "list" returns the built-in common aliases.',
      ),
    name: z.string().optional().describe('Style name to resolve (e.g. "APA 7th").'),
  },
  outputSchema: z
    .object({
      common: z.array(z.string()).optional().describe('action:"list": the built-in style aliases. Any id from the CSL styles repository also works.'),
      input: z.string().optional().describe('The name that was resolved, echoed back.'),
      styleId: z.string().optional().describe('The CSL style id it maps to, e.g. "apa"; pass it as `style` to the bibliography tools.'),
      available: z.boolean().optional().describe('Whether that style could actually be fetched.'),
    })
    .passthrough(),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    if (args.action === 'list') {
      return ok(
        { common: COMMON_STYLES },
        `Common style aliases: ${COMMON_STYLES.join(', ')}. Any CSL id from the citation-style-language/styles repo also works.`,
      );
    }
    if (!args.name) {
      return { content: [{ type: 'text', text: '`name` is required for resolve.' }], isError: true };
    }
    const styleId = ctx.styles.resolveId(args.name);
    try {
      await ctx.styles.fetchStyle(styleId);
      return ok({ input: args.name, styleId, available: true }, `"${args.name}" → CSL style "${styleId}" (available).`);
    } catch (e) {
      return ok(
        { input: args.name, styleId, available: false },
        `Resolved "${args.name}" → "${styleId}", but it could not be fetched: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  },
};

export default styles;
