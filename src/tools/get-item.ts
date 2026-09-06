import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { ok } from '../registry/registry.js';

const getItem: ToolDefinition = {
  name: 'zotero_get_item',
  title: 'Get a Zotero item',
  description:
    "Fetch one item by its key, returning the full item record (itemType, all bibliographic fields, creators, tags, collections, relations, version). Optionally set `include_children` to also return the item's child notes and attachments. Use `include` to additionally request rendered output: \"bib\" (formatted bibliography entry), \"citation\" (inline citation), or \"csljson\" (CSL-JSON for downstream formatting); combine with `style` (a style name such as \"apa\" or \"chicago author-date\", a CSL style id such as chicago-notes-bibliography, or the URL of a CSL file; unset renders Zotero's default, Chicago shortened notes and bibliography) and `locale`. When the desktop app serves the request, a style it has installed is used as-is and an unknown one is fetched from the Zotero style repository. The returned `version` is required if you later update or delete this item.",
  inputSchema: {
    item_key: z.string().describe('The 8-character Zotero item key.'),
    include_children: z.boolean().optional().describe('Also fetch child notes/attachments.'),
    include: z.string().optional().describe('Extra rendered content: "bib", "citation", or "csljson".'),
    style: z
      .string()
      .optional()
      .describe('Style name, CSL style id or CSL URL for bib/citation (unset: Zotero\'s default Chicago style).'),
    locale: z.string().optional().describe('Locale for bib/citation, e.g. en-US.'),
    library_type: z.enum(['user', 'group']).optional(),
    library_id: z.number().int().optional(),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const library = args.library_id
      ? { type: (args.library_type ?? 'group') as 'user' | 'group', id: args.library_id }
      : undefined;
    // Both were accepted and neither was forwarded, so every style rendered the same (#58).
    // The alias table turns "Chicago" into an id; a bare id or a URL passes through.
    const item = await ctx.router.getItem(args.item_key, {
      include: args.include,
      style: args.style ? ctx.styles.resolveId(args.style) : undefined,
      locale: args.locale,
      library,
    });
    const structured: Record<string, unknown> = { item };
    let summary = `Item ${args.item_key}: ${item?.data?.title ?? item?.title ?? '(no title)'}`;
    if (args.include_children) {
      const children = await ctx.router.getItemChildren(args.item_key, { library });
      structured.children = children.data;
      summary += ` (+${children.data.length} child item(s))`;
    }
    return ok(structured, summary);
  },
};

export default getItem;
