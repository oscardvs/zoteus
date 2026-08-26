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
      const result = await ctx.router.listCollections({});
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(result.data) },
        ],
      };
    },
  );
}
