import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerPrompts } from '../../src/prompts/index.js';

/** A real MCP client over the real registration path: nothing here is stubbed. */
async function connect(): Promise<Client> {
  const server = new McpServer({ name: 't', version: '0.0.0' }, { capabilities: { prompts: {} } });
  registerPrompts(server);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

async function render(args: Record<string, string>): Promise<string> {
  const client = await connect();
  const res: any = await client.getPrompt({ name: 'zotero-evidence-table', arguments: args });
  expect(res.messages).toHaveLength(1);
  expect(res.messages[0].role).toBe('user');
  return res.messages[0].content.text as string;
}

describe('zotero-evidence-table registration', () => {
  it('is listed alongside the other workflow prompts', async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    const mine = prompts.find((p) => p.name === 'zotero-evidence-table');
    expect(mine, 'zotero-evidence-table is not registered').toBeDefined();
    expect(mine!.title).toBe('Evidence table');
  });

  it('requires only the question, and advertises the other three as optional', async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    const args = prompts.find((p) => p.name === 'zotero-evidence-table')!.arguments ?? [];
    const byName = new Map(args.map((a) => [a.name, a]));
    expect([...byName.keys()].sort()).toEqual(['collection', 'item_keys', 'max_items', 'question']);
    expect(byName.get('question')!.required).toBe(true);
    for (const optional of ['item_keys', 'collection', 'max_items']) {
      expect(byName.get(optional)!.required, optional).toBe(false);
      // prompts/list exposes only name, description and required, so the argument has to
      // explain itself in its own description or the client sees nothing.
      expect(byName.get(optional)!.description, optional).toBeTruthy();
    }
  });
});

describe('zotero-evidence-table rendering', () => {
  it('renders from the question alone, and routes an unscoped search to semantic search', async () => {
    const text = await render({ question: 'Does mindfulness reduce burnout?' });
    expect(text).toContain('Does mindfulness reduce burnout?');
    expect(text).toContain('at most 5 studies');
    expect(text).toContain('zotero_semantic_search');
    expect(text).not.toContain('collectionKey');
  });

  it('names the retrieval tool, the render tool and the published column set', async () => {
    const text = await render({ question: 'Q' });
    expect(text).toContain('zotero_get_fulltext');
    expect(text).toContain('zotero_evidence_table');
    expect(text).toContain('Study, Finding, Quotation, Locator, Coverage and Support');
    expect(text).toContain('zotero_bibliography');
  });

  it('carries the never-invent rule and the passage-before-claims rule', async () => {
    const text = await render({ question: 'Q' });
    expect(text).toContain('VERBATIM');
    expect(text).toContain('Never invent a quotation or a page.');
    expect(text).toMatch(/pageApprox/);
    expect(text).toMatch(/passages\[0\]\.text/);
    // A snippet has no locator and can mix the author's words with the reader's comment.
    expect(text).toContain('Never reuse a zotero_semantic_search snippet as the quotation');
  });

  it('routes a named collection through zotero_search_items, never through semantic search', async () => {
    const text = await render({ question: 'Q', collection: 'Burnout review' });
    expect(text).toContain('Burnout review');
    expect(text).toContain('zotero_list_collections');
    expect(text).toContain('collectionKey');
    expect(text).toContain('top:true');
    // The correction that matters: semantic search takes four arguments and a collection is
    // not one of them, so the prompt must say so rather than let the model try.
    expect(text).toContain('cannot be scoped to a collection');
    expect(text).toMatch(/only q, limit, mode and auto_build/);
  });

  it('uses given item keys and does not send the model searching', async () => {
    const text = await render({ question: 'Q', item_keys: 'AAAA1111,BBBB2222' });
    expect(text).toContain('AAAA1111,BBBB2222');
    expect(text).toContain('Do not search for more.');
    expect(text).not.toContain('zotero_semantic_search, q set to the question');
    expect(text).not.toContain('collectionKey');
  });

  it('honours max_items, and falls back to five when it is blank', async () => {
    expect(await render({ question: 'Q', max_items: '12' })).toContain('at most 12 studies');
    expect(await render({ question: 'Q', max_items: '   ' })).toContain('at most 5 studies');
  });

  it('keeps the save step conditional, because a read-only deployment has no write tool', async () => {
    const text = await render({ question: 'Q' });
    expect(text).toContain('Ask before saving');
    expect(text).toContain('read-only deployment exposes none');
    expect(text).toContain('cloud API key with write access');
  });

  it('tells the model to classify coverage from what the tools returned', async () => {
    const text = await render({ question: 'Q' });
    expect(text).toContain('never from a guess');
    expect(text).toContain('abstractNote');
    expect(text).toContain('found:false');
    expect(text).toContain('"unverified", never blank and never "supported"');
  });
});
