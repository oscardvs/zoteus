import { describe, it, expect, afterEach } from 'vitest';
import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Server } from 'node:http';
import { startHttp } from '../../src/transports/http.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { registerAllTools, type ToolContext } from '../../src/registry/registry.js';
import { dropToolSchemaDialects } from '../../src/registry/schema-dialect.js';
import { tools } from '../../src/tools/index.js';

/**
 * What the wire carries, not what the Zod object says.
 *
 * tests/tools/schema-metadata.test.ts checks the Zod schemas, and every one of them passed
 * while v1.20.0 was unusable in Claude Desktop: the dialect that broke it is stamped on
 * during the SDK's conversion, so it exists only in the emitted JSON Schema (#83). These
 * tests therefore go through a real client and read what it was actually sent.
 *
 * `validateFormats: false` on the validators below keeps them about dialects. An unknown
 * format is a separate complaint, it needs ajv-formats to answer, and it is not what any
 * of this is measuring.
 */

/** Every path inside a schema that declares a dialect. Empty is the whole invariant. */
function dialectsIn(node: unknown, path = ''): string[] {
  if (Array.isArray(node)) return node.flatMap((child, i) => dialectsIn(child, `${path}[${i}]`));
  if (!node || typeof node !== 'object') return [];
  const obj = node as Record<string, unknown>;
  const here = '$schema' in obj ? [`${path}.$schema = ${String(obj.$schema)}`] : [];
  return [...here, ...Object.entries(obj).flatMap(([k, v]) => dialectsIn(v, `${path}.${k}`))];
}

let httpServer: Server | undefined;
afterEach(() => {
  httpServer?.close();
  httpServer = undefined;
});

async function listedTools(client?: Client) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerAllTools(server, tools, {} as ToolContext);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const c = client ?? new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), c.connect(clientT)]);
  return { client: c, listed: (await c.listTools()).tools };
}

describe('the JSON Schema dialect on the wire', () => {
  it('is declared nowhere, on any tool, in either schema', async () => {
    const { listed } = await listedTools();
    expect(listed.length).toBe(tools.length);
    for (const tool of listed) {
      expect(dialectsIn(tool.inputSchema), tool.name).toEqual([]);
      expect(dialectsIn(tool.outputSchema), tool.name).toEqual([]);
    }
  });

  it('still advertises an output schema for every tool', async () => {
    // The other way to answer #83 is to stop advertising output schemas at all. This is
    // here so that doing it silently, as a side effect of something else, fails a test.
    const { listed } = await listedTools();
    for (const tool of listed) expect(tool.outputSchema, tool.name).toBeDefined();
  });

  it('leaves every schema compilable by a 2020-12 validator and by a draft-07 one', async () => {
    const { listed } = await listedTools();
    for (const tool of listed) {
      for (const [which, schema] of [
        ['inputSchema', tool.inputSchema],
        ['outputSchema', tool.outputSchema],
      ] as const) {
        if (!schema) continue;
        for (const [dialect, make] of [
          ['2020-12', () => new Ajv2020({ strict: false, validateFormats: false })],
          ['draft-07', () => new Ajv({ strict: false, validateFormats: false })],
        ] as const) {
          expect(
            () => make().compile(schema),
            `${tool.name}.${which} under ${dialect}`,
          ).not.toThrow();
        }
      }
    }
  });

  it('is accepted by a client that understands 2020-12 only', async () => {
    // The reported failure, reproduced: the client compiles each advertised outputSchema
    // as it lists the tools, and a draft-07 declaration it cannot resolve took down the
    // whole server before a single call left the client.
    const client = new Client(
      { name: 'ajv2020-client', version: '0.0.0' },
      {
        jsonSchemaValidator: new AjvJsonSchemaValidator(
          new Ajv2020({ strict: false, validateFormats: false, allErrors: true }),
        ),
      },
    );
    const { listed } = await listedTools(client);
    expect(listed.some((t) => t.name === 'zotero_whoami')).toBe(true);

    // And the call goes through. It fails on the empty context, which is a tool error and
    // not the client refusing to invoke a tool it could not validate.
    const result = await client.callTool({ name: 'zotero_whoami', arguments: {} });
    expect(result.isError).toBe(true);
  });

  it('holds over HTTP, which is the transport the hosted server runs on', async () => {
    // The strip happens on the way out, so it is a property of the transport rather than of
    // one client harness. Hosted Zoteus would stay broken if this held only over stdio.
    const server = new McpServer({ name: 'test', version: '0.0.0' }, { capabilities: { tools: {} } });
    registerAllTools(server, tools, {} as ToolContext);
    httpServer = await startHttp(server, { port: 0, host: '127.0.0.1' });
    const address = httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const client = new Client(
      { name: 'ajv2020-client', version: '0.0.0' },
      {
        jsonSchemaValidator: new AjvJsonSchemaValidator(
          new Ajv2020({ strict: false, validateFormats: false }),
        ),
      },
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const { tools: listed } = await client.listTools();
    expect(listed.length).toBe(tools.length);
    for (const tool of listed) {
      expect(dialectsIn(tool.inputSchema), tool.name).toEqual([]);
      expect(dialectsIn(tool.outputSchema), tool.name).toEqual([]);
    }
    await client.close();
  }, 20_000);
});

describe('dropToolSchemaDialects', () => {
  it('strips a nested declaration and leaves everything else in place', () => {
    const message = {
      jsonrpc: '2.0',
      id: 1,
      result: {
        tools: [
          {
            name: 'zotero_whoami',
            inputSchema: { type: 'object', $schema: 'http://json-schema.org/draft-07/schema#' },
            outputSchema: {
              type: 'object',
              $schema: 'http://json-schema.org/draft-07/schema#',
              definitions: { nested: { $schema: 'http://json-schema.org/draft-07/schema#' } },
            },
          },
        ],
      },
    };
    dropToolSchemaDialects(message);
    expect(dialectsIn(message.result.tools)).toEqual([]);
    expect(message.result.tools[0]!.inputSchema.type).toBe('object');
    expect(message.result.tools[0]!.outputSchema.definitions.nested).toEqual({});
  });

  it('ignores a message that carries no tool list', () => {
    const message = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'hi' }] } };
    expect(() => dropToolSchemaDialects(message)).not.toThrow();
    expect(message.result.content[0]!.text).toBe('hi');
  });
});
