import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { ok } from '../registry/registry.js';

const schemaTool: ToolDefinition = {
  name: 'zotero_schema',
  title: 'Zotero data model (types & fields)',
  description:
    'Return the Zotero data model so you never hardcode item shapes. With no arguments, returns the schema version and the list of all item type names. With `item_type`, returns the valid fields and creator types for that type (the "primary" creator type is listed first). Use this to validate an item before creating or updating it: notes, attachments, and annotations are item types too but bypass the normal field/creator model.',
  inputSchema: {
    item_type: z.string().optional().describe('If set, return the fields & creator types for this item type.'),
  },
  outputSchema: z
    .object({
      version: z.number().describe('Zotero schema version this answer came from.'),
      itemTypes: z.array(z.string()).optional().describe('Every item type name; returned when no item_type was given.'),
      itemType: z.string().optional().describe('The item type asked about.'),
      fields: z.array(z.string()).optional().describe('Valid field names for that item type.'),
      creatorTypes: z.array(z.string()).optional().describe('Valid creator types for it, primary first.'),
    })
    .passthrough(),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const schema = await ctx.schema.getSchema();
    if (!args.item_type) {
      const itemTypes = schema.itemTypes.map((t) => t.itemType);
      return ok(
        { version: schema.version, itemTypes },
        `Schema v${schema.version}: ${itemTypes.length} item types.`,
      );
    }
    const t = schema.itemTypes.find((x) => x.itemType === args.item_type);
    if (!t) {
      return {
        content: [
          {
            type: 'text',
            text: `Unknown item type "${args.item_type}". Call zotero_schema with no arguments to list valid types.`,
          },
        ],
        isError: true,
      };
    }
    const fields = (t.fields ?? []).map((f) => f.field);
    const creatorTypes = (t.creatorTypes ?? []).map((c) => c.creatorType);
    return ok(
      { itemType: t.itemType, fields, creatorTypes, version: schema.version },
      `${t.itemType}: ${fields.length} fields, ${creatorTypes.length} creator types.`,
    );
  },
};

export default schemaTool;
