import { describe, it, expect, vi } from 'vitest';
import { probeCapabilities } from '../../src/router/capabilities.js';
import { loadConfig } from '../../src/config.js';
import { createLogger } from '../../src/lib/logger.js';

const logger = createLogger('error');

describe('probeCapabilities', () => {
  it('resolves cloud key info and local availability', async () => {
    const cfg = loadConfig({ ZOTERO_API_KEY: 'KEY', ZOTEUS_LOCAL: 'auto' } as any);
    const web = {
      hasKey: true,
      keysCurrent: vi.fn(async () => ({ userID: 19552201, username: 'oscardvs', access: {} })),
    };
    const local = { ping: vi.fn(async () => true) };
    const caps = await probeCapabilities(cfg, { web: web as any, local: local as any, logger });
    expect(caps.cloud?.userID).toBe(19552201);
    expect(caps.localApi).toBe(true);
  });

  it('treats an invalid key as no cloud access without throwing', async () => {
    const cfg = loadConfig({ ZOTERO_API_KEY: 'BAD', ZOTEUS_LOCAL: 'off' } as any);
    const web = {
      hasKey: true,
      keysCurrent: vi.fn(async () => {
        throw new Error('403');
      }),
    };
    const local = { ping: vi.fn(async () => false) };
    const caps = await probeCapabilities(cfg, { web: web as any, local: local as any, logger });
    expect(caps.cloud).toBeNull();
    expect(caps.localApi).toBe(false);
  });

  it('skips the local probe when ZOTEUS_LOCAL=off', async () => {
    const cfg = loadConfig({ ZOTEUS_LOCAL: 'off' } as any);
    const local = { ping: vi.fn(async () => true) };
    const caps = await probeCapabilities(cfg, {
      web: { hasKey: false } as any,
      local: local as any,
      logger,
    });
    expect(local.ping).not.toHaveBeenCalled();
    expect(caps.localApi).toBe(false);
  });

  it('records the group libraries the desktop app is serving', async () => {
    const cfg = loadConfig({ ZOTEUS_LOCAL: 'auto' } as any);
    const local = {
      ping: vi.fn(async () => true),
      listLocalGroupIds: vi.fn(async () => [4321, 8765]),
    };
    const caps = await probeCapabilities(cfg, {
      web: { hasKey: false } as any,
      local: local as any,
      logger,
    });
    expect(caps.localApi).toBe(true);
    expect(caps.localGroupIds).toEqual([4321, 8765]);
    expect(local.listLocalGroupIds).toHaveBeenCalledTimes(1);
  });

  it('degrades to no local groups when the group probe fails', async () => {
    // A pre-Zotero-10 app has no /groups endpoint; that must not sink the whole probe.
    const cfg = loadConfig({ ZOTEUS_LOCAL: 'auto' } as any);
    const local = {
      ping: vi.fn(async () => true),
      listLocalGroupIds: vi.fn(async () => {
        throw new Error('No endpoint found');
      }),
    };
    const caps = await probeCapabilities(cfg, {
      web: { hasKey: false } as any,
      local: local as any,
      logger,
    });
    expect(caps.localApi).toBe(true);
    expect(caps.localGroupIds).toEqual([]);
  });
});

// #102: "localApi=false" on its own is the one line every bug report quotes, and it has
// been read as a Zoteus bug, a Zotero bug and a firewall. The startup answer now says why.
describe('probeCapabilities records why the desktop app was not available (#102)', () => {
  const cfg = loadConfig({ ZOTEUS_LOCAL: 'auto' } as any);
  const web = { hasKey: false } as any;

  it('an HTTP status, so a local API switched off in Zotero is not reported as an absent Zotero', async () => {
    const local = { ping: vi.fn(), probe: vi.fn(async () => ({ up: false, timedOut: false, status: 403 })) };
    const caps = await probeCapabilities(cfg, { web, local: local as any, logger });
    expect(caps.localApi).toBe(false);
    expect(caps.localProbe).toEqual({ kind: 'http', status: 403 });
  });

  it('a timeout with its budget, which is what a large library used to look like', async () => {
    const local = { ping: vi.fn(), probe: vi.fn(async () => ({ up: false, timedOut: true })) };
    const caps = await probeCapabilities(cfg, { web, local: local as any, logger });
    expect(caps.localProbe).toEqual({ kind: 'timeout', budgetMs: 2000 });
  });

  it('nothing listening, when the connection was refused', async () => {
    const local = { ping: vi.fn(), probe: vi.fn(async () => ({ up: false, timedOut: false })) };
    const caps = await probeCapabilities(cfg, { web, local: local as any, logger });
    expect(caps.localProbe).toEqual({ kind: 'unreachable' });
  });

  it('the last attempt, not the first: a Zotero still loading its library ends up as up', async () => {
    let calls = 0;
    const local = {
      ping: vi.fn(),
      probe: vi.fn(async () => (++calls < 2 ? { up: false, timedOut: true } : { up: true, timedOut: false, status: 200 })),
      listLocalGroupIds: vi.fn(async () => []),
    };
    const caps = await probeCapabilities(cfg, { web, local: local as any, logger });
    expect(caps.localApi).toBe(true);
    expect(caps.localProbe).toEqual({ kind: 'up' });
  });

  it('records nothing when no probe ran at all', async () => {
    const caps = await probeCapabilities(loadConfig({ ZOTEUS_LOCAL: 'off' } as any), { web, logger });
    expect(caps.localProbe).toBeUndefined();
  });
});
