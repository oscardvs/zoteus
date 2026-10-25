#!/usr/bin/env node
// Smoke test for the issue fixes: spawn the built server over real stdio.
// Verifies: (a) zotero_get_fulltext exposes `fallback`, (b) zotero_semantic_search
// still accepts the retired `auto_build` and answers an empty index with the zotero_index
// call that builds it, never a build of its own,
// (c) zotero_index reports async build state.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: { ...process.env, ZOTERO_LOCAL: 'off', ZOTEUS_EMBEDDINGS: 'off', ZOTEUS_DATA_DIR: '/tmp/zoteus-smoke-' + process.pid },
});
const client = new Client({ name: 'zoteus-fix-smoke', version: '0.0.0' });
await client.connect(transport);

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
check('tools registered', names.includes('zotero_get_fulltext') && names.includes('zotero_semantic_search') && names.includes('zotero_index'), `${names.length} tools`);

const gf = tools.find((t) => t.name === 'zotero_get_fulltext');
check('get_fulltext has fallback param', Boolean(gf?.inputSchema?.properties?.fallback), JSON.stringify(gf?.inputSchema?.properties?.fallback?.description ?? '').slice(0, 80));

const ss = tools.find((t) => t.name === 'zotero_semantic_search');
check('semantic_search has auto_build param', Boolean(ss?.inputSchema?.properties?.auto_build));

// auto_build:false on an empty, idle index → the bare actionable error (no build started).
const res2 = await client.callTool({ name: 'zotero_semantic_search', arguments: { q: 'anything', auto_build: false } });
const text2 = String(res2.content?.[0]?.text ?? '');
check('auto_build:false returns bare guidance', res2.isError === true && /run zotero_index/i.test(text2), text2.slice(0, 120));

// Empty index, no arguments → the same guidance, and no build: the tool is read-only, so a
// first-use build is zotero_index's to start.
const res = await client.callTool({ name: 'zotero_semantic_search', arguments: { q: 'anything' } });
const text = String(res.content?.[0]?.text ?? '');
check('empty index names the build call', res.isError === true && /run zotero_index/i.test(text), text.slice(0, 120));
const idle = await client.callTool({ name: 'zotero_index', arguments: { action: 'status' } });
check('empty index started no build', idle.structuredContent?.state !== 'building', `state=${idle.structuredContent?.state}`);

// zotero_index status reports the async build state machine.
const st = await client.callTool({ name: 'zotero_index', arguments: { action: 'status' } });
const state = st.structuredContent?.state;
check('zotero_index status reports build state', ['idle', 'building', 'done', 'error'].includes(state), `state=${state}`);

await client.close();
console.log(failures ? 'SMOKE FAILED' : 'SMOKE OK');
process.exit(failures ? 1 : 0);
