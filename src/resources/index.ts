import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveContext, type ToolContextSource } from '../registry/registry.js';

/** Registers read-only Zotero resources. */
export function registerResources(server: McpServer, source: ToolContextSource): void {
  server.registerResource(
    'zotero-schema',
    'zotero://schema',
    {
      title: 'Zotero data model',
      description: 'Item types, fields, and creator types.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const ctx = await resolveContext(source);
      // Resources route through the same library router as tools, so they need the same
      // live answer about the desktop app; they do not pass through registerAllTools (#22).
      await ctx.localStatus?.ensure();
      const schema = await ctx.schema.getSchema();
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(schema) }],
      };
    },
  );

  server.registerResource(
    'zotero-collections',
    'zotero://collections',
    {
      title: 'Zotero collections',
      description: "The default library's collection tree.",
      mimeType: 'application/json',
    },
    async (uri) => {
      const ctx = await resolveContext(source);
      // Resources route through the same library router as tools, so they need the same
      // live answer about the desktop app; they do not pass through registerAllTools (#22).
      await ctx.localStatus?.ensure();
      // Every page: one listCollections call is the first 25 to 100 and nothing more (#90).
      const result = await ctx.router.listAllCollections({});
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(result.data) },
        ],
      };
    },
  );
}
