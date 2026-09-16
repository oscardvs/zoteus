import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/**
 * Sending tool schemas that declare no JSON Schema dialect, at the one place they all go out.
 *
 * A tool hands `registerTool` a Zod schema and the SDK converts it for the wire itself. On
 * the Zod 3 path (zod 3.25.76 with SDK 1.29/1.30, which is what this repo pins) that
 * conversion is `zod-to-json-schema`, and it stamps every schema it produces with
 * `"$schema": "http://json-schema.org/draft-07/schema#"`. There is no option on
 * `registerTool` to turn that off or to pick another target.
 *
 * The stamp was harmless while it only rode on `inputSchema`. v1.20.0 advertised an
 * `outputSchema` on every tool for the first time, and clients treat the two differently:
 * one that compiles the advertised output schema with an Ajv configured for 2020-12 (and
 * with meta-schema validation left on, which is Ajv's default) cannot resolve the draft-07
 * meta-schema, so it rejects the tool at definition time. The tool is listed and then never
 * runs. Claude Desktop does exactly this, which made every Zoteus tool fail there with
 * "invalid outputSchema: JSON Schema declares an unsupported dialect" before any request
 * left the client (#83).
 *
 * Why the declaration is dropped rather than rewritten to 2020-12. Measured, compiling one
 * generated schema under both validators with meta-schema validation on:
 *
 *   |                 | Ajv (draft-07, the MCP SDK client's own default) | Ajv 2020 |
 *   | draft-07 stamp  | compiles                                         | REJECTED |
 *   | 2020-12 stamp   | REJECTED                                         | compiles |
 *   | no stamp        | compiles                                         | compiles |
 *
 * So rewriting the stamp would only move the outage to the other half of the ecosystem: the
 * SDK's own `AjvJsonSchemaValidator` builds a plain draft-07 Ajv. Declaring nothing lets each
 * client apply its own default dialect, which is the one answer both accept. Nothing is lost
 * by it: the bodies these tools emit (`type`, `properties`, `required`, `enum`, `items`,
 * `additionalProperties`, `anyOf`) mean the same thing in both dialects, and `$schema` tells
 * a client nothing it needs in order to read one.
 *
 * `inputSchema` is stripped along with it. It has carried the same stamp since long before
 * v1.20.0 and no client has rejected it yet, but it is the same latent trap, and a server
 * that declares no dialect anywhere cannot be tripped by a client that starts checking.
 *
 * The strip happens on the way out because that is the only seam the SDK leaves: it builds
 * the JSON Schema inside its own `tools/list` handler, so there is nothing to intercept
 * earlier. Wrapping `Transport.send` is a public interface and holds whatever the SDK's
 * conversion does next.
 */
export function stripSchemaDialect(server: McpServer): void {
  const connect = server.connect.bind(server);
  server.connect = async (transport: Transport): Promise<void> => {
    const send = transport.send.bind(transport);
    transport.send = (message, options) => {
      dropToolSchemaDialects(message);
      return send(message, options);
    };
    return connect(transport);
  };
}

/** Strip the dialect from the schemas in a `tools/list` result; leave anything else alone. */
export function dropToolSchemaDialects(message: unknown): void {
  const tools = (message as { result?: { tools?: unknown } } | null)?.result?.tools;
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const { inputSchema, outputSchema } = tool as { inputSchema?: unknown; outputSchema?: unknown };
    dropDialect(inputSchema);
    dropDialect(outputSchema);
  }
}

/**
 * Recursive rather than root-only: today's converter writes `$schema` at the root and
 * nowhere else, but a nested one would be just as unresolvable to the client, and this
 * walks a schema that was generated a few microseconds ago.
 */
function dropDialect(node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) dropDialect(child);
    return;
  }
  if (!node || typeof node !== 'object') return;
  delete (node as { $schema?: unknown }).$schema;
  for (const child of Object.values(node)) dropDialect(child);
}
