import { describe, it, expect } from 'vitest';
import whoami from '../../src/tools/whoami.js';

/** Minimal SearchIndex stand-in: healthy local embedder unless overridden. */
function searchStub(over: Partial<Record<string, unknown>> = {}) {
  return {
    embedderConfigured: 'local',
    embedderActive: true,
    embedderName: 'local',
    embedderReason: undefined,
    ...over,
  };
}

function ctxWith(cloud: any, search: any = searchStub()) {
  return {
    router: {
      whoami: () => cloud,
      defaultLibrary: () => ({ type: 'user', id: cloud?.userID ?? 0 }),
    },
    capabilities: { cloud, localApi: true },
    search,
  } as any;
}

describe('zotero_whoami', () => {
  it('returns the resolved identity and access', async () => {
    const res = await whoami.handler(
      {},
      ctxWith({ userID: 19552201, username: 'oscardvs', access: { user: { write: true } } }),
    );
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent?.userID).toBe(19552201);
    expect(res.content[0].text).toMatch(/oscardvs/);
  });

  it('reports local-only mode when no cloud key is configured', async () => {
    const res = await whoami.handler({}, ctxWith(null));
    expect(res.structuredContent?.cloud).toBe(false);
    expect(res.content[0].text).toMatch(/local/i);
  });

  it('surfaces an available update, with the reinstall hint on desktop-extension installs', async () => {
    const ctx = ctxWith(null);
    ctx.config = { dist: 'mcpb' };
    ctx.updates = {
      available: { current: '1.3.1', latest: '1.4.0', url: 'https://github.com/oscardvs/zoteus/releases/tag/v1.4.0' },
    };
    const res = await whoami.handler({}, ctx);
    expect(res.structuredContent?.update).toEqual(ctx.updates.available);
    expect(res.content[0].text).toMatch(/1\.4\.0 is available/);
    expect(res.content[0].text).toMatch(/reinstall/i);
  });

  it('reports a degraded embedder so a keyword-only fallback is visible on the first call', async () => {
    const res = await whoami.handler(
      {},
      ctxWith(null, {
        embedderConfigured: 'local',
        embedderActive: false,
        embedderName: 'none (local requested; @huggingface/transformers is not installed)',
        embedderReason: '@huggingface/transformers is not installed, so semantic ranking is off',
      }),
    );
    expect((res.structuredContent?.embeddings as any).active).toBe(false);
    expect((res.structuredContent?.embeddings as any).configured).toBe('local');
    expect(res.content[0].text).toMatch(/degraded to keyword-only/i);
    expect(res.content[0].text).toMatch(/@huggingface\/transformers/);
  });

  it('stays quiet about embeddings when the configured provider is running', async () => {
    const res = await whoami.handler({}, ctxWith(null));
    expect((res.structuredContent?.embeddings as any).active).toBe(true);
    expect(res.content[0].text).not.toMatch(/degraded/i);
  });

  // #70: citeproc-js's CPAL asks for its Exhibit B attribution when a session begins. The
  // startup log line is once per process, which over HTTP is not once per session, so the
  // "call this first" tool carries it too, whatever the identity turns out to be.
  it('carries the citeproc-js attribution in the summary and the structured answer', async () => {
    for (const ctx of [ctxWith({ userID: 1, username: 'oscardvs' }), ctxWith(null)]) {
      const res = await whoami.handler({}, ctx);
      expect(res.content[0].text).toContain('citeproc-js implements the Citation Style Language');
      expect(res.content[0].text).toContain('(c) Frank Bennett');
      expect(res.content[0].text).toContain('https://citationstyles.org/');
      expect(res.structuredContent?.attribution).toEqual({
        copyright: '(c) Frank Bennett',
        phrase: 'citeproc-js implements the Citation Style Language',
        url: 'https://citationstyles.org/',
        license: 'Common Public Attribution License 1.0',
      });
    }
  });

  it('omits the update notice when no newer release is known', async () => {
    const res = await whoami.handler({}, ctxWith(null));
    expect(res.structuredContent?.update).toBeNull();
    expect(res.content[0].text).not.toMatch(/available \(installed/);
  });
});

// #102: one sentence ("start Zotero and enable the setting") covered every unavailable
// local API. For the user whose Zotero was running with the setting on, and merely took
// longer than the probe's budget to answer, it was wrong twice over. The remedy is now
// chosen by what the probe found, and the finding itself is in the structured answer.
describe('zotero_whoami names why the local API is unavailable (#102)', () => {
  function unavailable(localProbe: any) {
    const ctx = ctxWith(null);
    ctx.capabilities = { cloud: null, localApi: false, localGroupIds: [], ...(localProbe ? { localProbe } : {}) };
    ctx.localStatus = { enabled: true, lastCheckedAt: () => 1_700_000_000_000, ensure: async () => ctx.capabilities.localApi };
    ctx.config = { localPort: 23119 };
    return ctx;
  }

  it('a 403 is Zotero running with its local API switched off', async () => {
    const res = await whoami.handler({}, unavailable({ kind: 'http', status: 403 }));
    expect(res.structuredContent?.localApi).toBe(false);
    expect(res.structuredContent?.localApiProbe).toEqual({ kind: 'http', status: 403 });
    const text = res.content[0].text;
    expect(text).toMatch(/Zotero is running on port 23119 but its local API is switched off/);
    expect(text).toMatch(/Allow other applications/);
    expect(text).not.toMatch(/start Zotero/);
  });

  it('a timeout says what the budget was and what to look at', async () => {
    const res = await whoami.handler({}, unavailable({ kind: 'timeout', budgetMs: 1500 }));
    const text = res.content[0].text;
    expect(text).toMatch(/did not answer the liveness probe within 1500 ms/);
    expect(text).toMatch(/Debug Output Logging/);
    expect(text).toMatch(/collections\?limit=1/);
  });

  it('a refused connection is a Zotero that is not running, or on another port', async () => {
    const res = await whoami.handler({}, unavailable({ kind: 'unreachable' }));
    const text = res.content[0].text;
    expect(text).toMatch(/Nothing is listening on 127\.0\.0\.1:23119/);
    expect(text).toMatch(/ZOTERO_LOCAL_PORT/);
  });

  it('any other status is quoted as it was', async () => {
    const res = await whoami.handler({}, unavailable({ kind: 'http', status: 400 }));
    expect(res.content[0].text).toMatch(/with HTTP 400/);
    expect(res.content[0].text).toMatch(/Host header/);
  });

  it('falls back to the general remedy when no probe outcome was recorded', async () => {
    const res = await whoami.handler({}, unavailable(undefined));
    expect(res.structuredContent?.localApiProbe).toBeUndefined();
    expect(res.content[0].text).toMatch(/not answering on port 23119: start Zotero/);
  });

  it('says nothing about a remedy while the local API is up, whatever the latest probe found', async () => {
    const ctx = ctxWith(null);
    ctx.capabilities = { cloud: null, localApi: true, localGroupIds: [], localProbe: { kind: 'timeout', budgetMs: 1500 } };
    ctx.localStatus = { enabled: true, lastCheckedAt: () => 1_700_000_000_000, ensure: async () => ctx.capabilities.localApi };
    const res = await whoami.handler({}, ctx);
    expect(res.structuredContent?.localApi).toBe(true);
    expect(res.structuredContent?.localApiProbe).toEqual({ kind: 'timeout', budgetMs: 1500 });
    expect(res.content[0].text).not.toMatch(/liveness probe/);
  });
});
