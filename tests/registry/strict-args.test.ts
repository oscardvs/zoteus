import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAllTools, type AnyToolDefinition, type ToolContext, type ToolDefinition } from '../../src/registry/registry.js';
import { closedArgumentSchema } from '../../src/registry/strict-args.js';
import { tools } from '../../src/tools/index.js';

/** A value the field would accept, so a whole-tool parse fails on nothing but strictness. */
function sample(schema: any, depth = 0): unknown {
  if (depth > 5) return undefined;
  const def = schema?._def;
  switch (def?.typeName) {
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return sample(def.innerType, depth + 1);
    case 'ZodEffects':
      return sample(def.schema, depth + 1);
    case 'ZodString':
      return 'x';
    case 'ZodNumber':
      return 1;
    case 'ZodBoolean':
      return true;
    case 'ZodEnum':
      return def.values[0];
    case 'ZodLiteral':
      return def.value;
    case 'ZodArray':
      return [sample(def.type, depth + 1)];
    case 'ZodUnion':
      return sample(def.options[0], depth + 1);
    case 'ZodRecord':
      return {};
    case 'ZodAny':
    case 'ZodUnknown':
      return 'x';
    case 'ZodObject': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(def.shape() as Record<string, unknown>)) {
        out[k] = sample(v, depth + 1);
      }
      return out;
    }
    default:
      return undefined;
  }
}

function issuesFor(shape: z.ZodRawShape, args: Record<string, unknown>): z.ZodIssue[] {
  const parsed = closedArgumentSchema(shape).safeParse(args);
  return parsed.success ? [] : parsed.error.issues;
}

/** What a handler would have been handed, for the calls that are meant to get through. */
function parsedArgs(shape: z.ZodRawShape, args: Record<string, unknown>): unknown {
  const parsed = closedArgumentSchema(shape).safeParse(args);
  expect(parsed.success, JSON.stringify(parsed.success ? {} : parsed.error.issues)).toBe(true);
  return parsed.success ? parsed.data : undefined;
}

function unknownKeyMessage(shape: z.ZodRawShape, args: Record<string, unknown>): string {
  const issue = issuesFor(shape, args).find((i) => i.code === 'unrecognized_keys');
  return issue?.message ?? '';
}

describe('closedArgumentSchema', () => {
  it('names the argument the caller meant, when only its spelling was wrong', () => {
    const shape = { q: z.string().optional(), limit: z.number().optional() };
    expect(unknownKeyMessage(shape, { query: 'kalman' })).toContain(
      'unknown argument `query`: this tool spells it `q`.',
    );
    expect(unknownKeyMessage(shape, { query: 'kalman' })).toContain('Nothing ran, because');
  });

  it('lists the arguments when the key resembles none of them', () => {
    const shape = { q: z.string().optional(), limit: z.number().optional() };
    expect(unknownKeyMessage(shape, { filter: 'core' })).toBe(
      'unknown argument `filter`. The arguments are: q, limit. ' +
        'Nothing ran, because the value you sent would have been dropped and the call would have ' +
        'answered a different question.',
    );
  });

  it('lists the arguments when the key resembles two of them at once', () => {
    const shape = {
      include: z.string().optional(),
      include_children: z.boolean().optional(),
    };
    // `include_child` truncates one and extends the other; guessing would be worse.
    expect(unknownKeyMessage(shape, { include_child: true })).toContain('The arguments are:');
  });

  it('points a hoisted key back into the object it belongs to', () => {
    const shape = {
      scope: z.object({ collection_keys: z.array(z.string()).optional() }).optional(),
      limit: z.number().optional(),
    };
    expect(unknownKeyMessage(shape, { collection_keys: ['ABCD1234'] })).toContain(
      'this tool takes it inside `scope`, as `scope.collection_keys`',
    );
  });

  it('sees through the preprocess wrapper the nested fixes use, and through arrays', () => {
    const inner = z.preprocess((v) => v, z.object({ text: z.string(), page_label: z.string().optional() }));
    const shape = { annotations: z.array(inner).optional() };
    expect(unknownKeyMessage(shape, { page_label: '7' })).toContain(
      'this tool takes it inside `annotations`, as `annotations[].page_label`',
    );
  });

  it('accepts a key the protocol reserves, and does not pass it on', () => {
    const shape = { q: z.string().optional() };
    // `_meta` belongs on the request's `params`, not in `arguments`, and nothing here puts it
    // in `arguments`. But a client that ever did would otherwise have every call refused, so
    // an underscore-prefixed key is dropped rather than refused. Dropped, not forwarded: a
    // handler must never read protocol bookkeeping as though a user had sent it.
    expect(issuesFor(shape, { q: 'kalman', _meta: { progressToken: 1 } })).toEqual([]);
    expect(parsedArgs(shape, { q: 'kalman', _meta: { progressToken: 1 } })).toEqual({ q: 'kalman' });
    expect(parsedArgs(shape, { _progressToken: 'abc' })).toEqual({});
  });

  it('does not eat an underscore key a tool actually declares', () => {
    // No tool declares one and none should, but the valve asks the shape rather than trusting
    // that: eating a documented argument is the failure this whole file exists to end.
    const shape = { _internal: z.string().optional(), q: z.string().optional() };
    expect(parsedArgs(shape, { _internal: 'kept', _meta: { x: 1 } })).toEqual({ _internal: 'kept' });
  });

  it('still refuses an ordinary typo sent alongside a protocol key', () => {
    const shape = { q: z.string().optional() };
    expect(unknownKeyMessage(shape, { query: 'kalman', _meta: {} })).toContain(
      'unknown argument `query`: this tool spells it `q`.',
    );
    expect(unknownKeyMessage(shape, { query: 'kalman', _meta: {} })).not.toContain('_meta');
  });

  it('leaves a nested underscore key to the object it was sent to', () => {
    // The valve is top-level only. MCP's `_meta` rides on the request's `params`, one level
    // above `arguments`, so it can only ever land at the top of `arguments`; an underscore key
    // two levels down is an invented one, and the nested matchers in zotero_annotate and
    // zotero_tag_audit answer it the way they answer any other key they do not know.
    const shape = { scope: z.object({ collection_keys: z.array(z.string()).optional() }).optional() };
    const parsed = closedArgumentSchema(shape).safeParse({ scope: { _meta: 1 } });
    expect(parsed.success).toBe(true);
    // A plain nested z.object still strips; what matters here is that the top-level valve did
    // not reach down and rewrite it.
    expect(parsed.success && parsed.data).toEqual({ scope: {} });
  });

  it('names every unknown argument, not just the first', () => {
    const shape = { q: z.string().optional() };
    const message = unknownKeyMessage(shape, { query: 'a', filter: 'b' });
    expect(message).toContain('`query`');
    expect(message).toContain('`filter`');
  });

  it('closes a tool that declares no arguments, and says so without a list', () => {
    const shape = {};
    // zotero_whoami and zotero_groups. The general wording would end "The arguments are: .",
    // and what a dropped key costs them is different: the answer does not change, only what it
    // looks like it means.
    expect(unknownKeyMessage(shape, { library_type: 'group' })).toBe(
      'unknown argument `library_type`: this tool takes no arguments. ' +
        'Nothing ran, because the key would have been dropped and the answer would have read ' +
        'as though it had been honoured. Call this tool with no arguments.',
    );
    expect(issuesFor(shape, {})).toEqual([]);
    // The protocol valve reaches them too, or the hosted risk would just move to these two.
    expect(parsedArgs(shape, { _meta: { progressToken: 1 } })).toEqual({});
  });

  it('names every unknown argument on a tool that declares none', () => {
    const message = unknownKeyMessage({}, { library_type: 'group', library_id: 5678 });
    expect(message).toContain('unknown argument `library_type`: this tool takes no arguments.');
    expect(message).toContain('unknown argument `library_id`: this tool takes no arguments.');
  });

  it('does not close nested objects that are deliberately open', () => {
    // itemDataSchema is `z.object(fields).catchall(z.any())` because Zotero item fields are
    // an open set, and format_bibliography takes CSL-JSON as `z.record(z.any())`.
    const shape = {
      patch: z.object({ title: z.string().optional() }).catchall(z.any()).optional(),
      items: z.array(z.record(z.any())).optional(),
    };
    const schema = closedArgumentSchema(shape) as z.ZodTypeAny;
    expect(schema.safeParse({ patch: { title: 'T', extraZoteroField: 'v' } }).success).toBe(true);
    expect(schema.safeParse({ items: [{ id: 'a', anything: 1 }] }).success).toBe(true);
  });
});

describe('every registered tool', () => {
  it.each(tools.map((t) => [t.name, t] as const))('%s accepts all of its documented arguments', (_name, def) => {
    const shape = def.inputSchema;
    const args = Object.fromEntries(
      Object.entries(shape).map(([k, v]) => [k, sample(v)]),
    ) as Record<string, unknown>;
    // Values are generated, so a value-level issue is possible and uninteresting here; what
    // must never appear is a complaint about the argument NAMES the tool documents.
    expect(issuesFor(shape, args).filter((i) => i.code === 'unrecognized_keys')).toEqual([]);
  });

  it.each(tools.map((t) => [t.name, t] as const))(
    '%s refuses an argument it does not declare',
    (_name, def) => {
      const message = unknownKeyMessage(def.inputSchema, { not_a_real_argument: 1 });
      expect(message).toContain('unknown argument `not_a_real_argument`');
    },
  );

  it.each(tools.map((t) => [t.name, t] as const))('%s tolerates a protocol key', (_name, def) => {
    const shape = def.inputSchema;
    const args = Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, sample(v)]));
    // Alongside the tool's own arguments, so a required one missing cannot be mistaken for the
    // valve failing. Values are generated, so a value-level issue is possible and beside the
    // point; what must never appear is a complaint about `_meta` itself.
    const issues = issuesFor(shape, { ...args, _meta: { progressToken: 1 } });
    expect(issues.filter((i) => i.code === 'unrecognized_keys')).toEqual([]);
    // And it never arrives as data.
    const parsed = closedArgumentSchema(shape).safeParse({ ...args, _meta: { progressToken: 1 } });
    if (parsed.success) expect(Object.keys(parsed.data as object)).not.toContain('_meta');
  });

  it('names the twin for the mistakes measured against the real library', () => {
    const byName = new Map(tools.map((t) => [t.name, t]));
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['zotero_search_items', { query: 'kalman' }, 'this tool spells it `q`'],
      ['zotero_search_items', { itemtype: 'book' }, 'this tool spells it `itemType`'],
      ['zotero_schema', { itemType: 'book' }, 'this tool spells it `item_type`'],
      ['zotero_get_fulltext', { passages: 1 }, 'this tool spells it `max_passages`'],
      ['zotero_list_collections', { top_level: true }, 'this tool spells it `top`'],
      ['search_tools', { q: 'bibliography' }, 'this tool spells it `query`'],
      ['zotero_tag_audit', { include_automatic: true }, 'this tool spells it `include_auto`'],
      [
        'zotero_tag_audit',
        { collection_keys: ['ABCD1234'] },
        'this tool takes it inside `scope`, as `scope.collection_keys`',
      ],
      [
        'zotero_update_item',
        { creators: [] },
        'this tool takes it inside `patch`, as `patch.creators`',
      ],
      [
        'zotero_create_items',
        { itemType: 'book' },
        'this tool takes it inside `items`, as `items[].itemType`',
      ],
      ['zotero_annotate', { text: 'a passage' }, 'as `annotations[].text`'],
    ];
    for (const [tool, args, expected] of cases) {
      const def = byName.get(tool);
      expect(def, tool).toBeDefined();
      expect(unknownKeyMessage(def!.inputSchema, args), tool).toContain(expected);
    }
  });
});

async function connect(defs: AnyToolDefinition[], ctx: ToolContext) {
  const server = new McpServer({ name: 't', version: '0.0.0' }, { capabilities: { tools: {} } });
  registerAllTools(server, defs, ctx);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

describe('through the MCP SDK', () => {
  it('advertises every documented argument and closes all thirty-one tools', async () => {
    const client = await connect(tools, {} as ToolContext);
    const { tools: listed } = await client.listTools();
    expect(listed.length).toBe(31);
    for (const t of listed) {
      const def = tools.find((d) => d.name === t.name);
      const declared = Object.keys(def!.inputSchema);
      expect(Object.keys(t.inputSchema.properties ?? {}), t.name).toEqual(declared);
      // The twenty-eight that declare arguments have said this since long before it was
      // enforced. zotero_whoami and zotero_groups never did: an empty raw shape was the one
      // input here that reached the SDK through Zod v4-mini rather than v3, and that dialect
      // emits no additionalProperties line at all. Handing the SDK a built object puts them on
      // the same path as the rest.
      expect(t.inputSchema.additionalProperties, t.name).toBe(false);
    }
  });

  it('publishes the same JSON Schema the plain strict object would', async () => {
    // The protocol valve is a ZodObject subclass precisely so that it is invisible here: the
    // SDK reads _def, and _def is whatever z.object(...).strict() built. Pinned against the
    // SDK's own conversion, tool by tool, so a change to it fails rather than ships.
    const plain = tools.map((t) => ({
      ...t,
      name: `${t.name}__plain`,
      inputSchema: t.inputSchema,
    }));
    const client = await connect(tools, {} as ToolContext);
    const { tools: listed } = await client.listTools();
    const reference = new McpServer({ name: 'r', version: '0.0.0' }, { capabilities: { tools: {} } });
    for (const t of plain) {
      const shape = t.inputSchema;
      reference.registerTool(
        t.name,
        { title: t.title, description: t.description, inputSchema: z.object(shape).strict() },
        async () => ({ content: [] }),
      );
    }
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const refClient = new Client({ name: 'ref', version: '0.0.0' });
    await Promise.all([reference.connect(st), refClient.connect(ct)]);
    const { tools: refListed } = await refClient.listTools();
    for (const t of listed) {
      const ref = refListed.find((r) => r.name === `${t.name}__plain`);
      expect(JSON.stringify(t.inputSchema), t.name).toBe(JSON.stringify(ref!.inputSchema));
    }
  });

  it('lets a protocol key through without handing it to the tool', async () => {
    const handler = vi.fn(async (args: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(args) }],
    }));
    const def: ToolDefinition = {
      name: 'probe',
      title: 'probe',
      description: 'probe',
      inputSchema: { q: z.string().optional() },
      handler,
    };
    const client = await connect([def], {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as ToolContext);

    const r: any = await client.callTool({
      name: 'probe',
      arguments: { q: 'kalman', _meta: { progressToken: 1 } },
    });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toBe('{"q":"kalman"}');
  });

  it('refuses an unknown argument as a tool result, without running the tool', async () => {
    const handler = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ran' }] }));
    const def: ToolDefinition = {
      name: 'probe',
      title: 'probe',
      description: 'probe',
      inputSchema: { q: z.string().optional() },
      handler,
    };
    const metrics = { inc: vi.fn(), observe: vi.fn() };
    const usage = { record: vi.fn() };
    const ctx = {
      metrics,
      usage,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    } as unknown as ToolContext;
    const client = await connect([def], ctx);

    const good: any = await client.callTool({ name: 'probe', arguments: { q: 'kalman' } });
    expect(good.isError).toBeFalsy();
    expect(handler).toHaveBeenCalledTimes(1);

    const bad: any = await client.callTool({ name: 'probe', arguments: { query: 'kalman' } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('this tool spells it `q`');
    expect(handler).toHaveBeenCalledTimes(1);

    // The known cost of refusing at the SDK's validation step, true of every malformed
    // argument since long before this: the refusal never reaches observe(), so it leaves no
    // row in the usage log and no tick on the metrics counters. Recorded here so a change
    // to it is a visible one.
    expect(metrics.inc).toHaveBeenCalledTimes(1);
    expect(usage.record).toHaveBeenCalledTimes(1);
  });
});

/**
 * `arguments` is optional in tools/call. A client omitting it for a tool that needs nothing
 * used to get a JSON-RPC -32602 about the envelope's shape, on all 30 tools.
 */
describe('a tools/call that omits arguments entirely', () => {
  it('is treated as an empty argument object', () => {
    const schema = closedArgumentSchema({});
    const parsed = schema.safeParse(undefined);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual({});
  });

  it('still refuses a tool that needs an argument, naming the field not the envelope', () => {
    const schema = closedArgumentSchema({ action: z.enum(['list', 'resolve']) });
    const parsed = schema.safeParse(undefined);
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0].path).toEqual(['action']);
  });

  it('leaves optional-only shapes usable with nothing supplied', () => {
    const schema = closedArgumentSchema({ q: z.string().optional() });
    expect(schema.safeParse(undefined).success).toBe(true);
  });
});
