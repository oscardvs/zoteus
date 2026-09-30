import { describe, it, expect, vi } from 'vitest';
import { LocalApiStatus } from '../../src/router/local-status.js';
import { loadConfig } from '../../src/config.js';
import type { Capabilities } from '../../src/router/capabilities.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * The startup probe used to be the only answer, so `localApi` was a function of whether
 * Zotero happened to be running at the moment the MCP host launched, and stayed that way
 * for the life of the process. Restarting Claude Desktop was the only cure (#22).
 */
function makeStatus(opts: {
  localApi?: boolean;
  up?: boolean | (() => { up: boolean; timedOut: boolean });
  groups?: number[];
  local?: 'auto' | 'off';
  client?: boolean;
}) {
  let clock = 1_000_000;
  const probe = vi.fn(async () => {
    if (typeof opts.up === 'function') return opts.up();
    return { up: Boolean(opts.up), timedOut: false };
  });
  const listLocalGroupIds = vi.fn(async () => opts.groups ?? []);
  const capabilities: Capabilities = {
    cloud: null,
    localApi: opts.localApi ?? false,
    localGroupIds: [],
  };
  const status = new LocalApiStatus({
    config: loadConfig({ ZOTEUS_LOCAL: opts.local ?? 'auto' } as any),
    client: opts.client === false ? undefined : ({ probe, listLocalGroupIds } as any),
    capabilities,
    logger: silentLogger,
    now: () => clock,
  });
  return { status, capabilities, probe, listLocalGroupIds, advance: (ms: number) => (clock += ms) };
}

describe('LocalApiStatus', () => {
  it('does nothing at all, and never probes, when no desktop app can apply', async () => {
    // The hosted case. Per-user tenants are built with no local client, and an operator who
    // set ZOTEUS_LOCAL=off asked for the same. Probing there would be a loopback connect on
    // a machine that will never run Zotero, repeated for the life of the process.
    for (const opts of [{ client: false }, { local: 'off' as const }]) {
      const { status, probe } = makeStatus(opts);
      expect(status.enabled).toBe(false);
      expect(await status.ensure({ force: true })).toBe(false);
      expect(probe).not.toHaveBeenCalled();
    }
  });

  it('notices a desktop app that started after the server, without a restart', async () => {
    const { status, capabilities, listLocalGroupIds, advance } = makeStatus({
      localApi: false,
      up: true,
      groups: [4321],
    });
    advance(10_000);
    expect(await status.ensure()).toBe(true);
    expect(capabilities.localApi).toBe(true);
    // The startup probe skips the group list whenever the app was down, so without this a
    // keyless local-only user could never reach a group the desktop was holding all along.
    expect(capabilities.localGroupIds).toEqual([4321]);
    expect(listLocalGroupIds).toHaveBeenCalledTimes(1);
  });

  it('notices a desktop app that went away', async () => {
    const { status, capabilities, advance } = makeStatus({ localApi: true, up: false, groups: [7] });
    capabilities.localGroupIds = [7];
    // Two failures, because one is not enough to call a running Zotero gone: see below.
    advance(60_000);
    await status.ensure({ force: true });
    advance(60_000);
    expect(await status.ensure({ force: true })).toBe(false);
    expect(capabilities.localApi).toBe(false);
    // A group only the desktop served has to go back to the cloud route with it.
    expect(capabilities.localGroupIds).toEqual([]);
  });

  it('re-fetches the group list only on the transition, not on every refresh', async () => {
    const { status, listLocalGroupIds, advance } = makeStatus({ localApi: false, up: true, groups: [1] });
    advance(10_000);
    await status.ensure();
    advance(10 * 60_000);
    await status.ensure({ force: true });
    expect(listLocalGroupIds).toHaveBeenCalledTimes(1);
  });

  it('answers from cache while it is fresh, so a tool call is not a network round trip', async () => {
    const { status, probe, advance } = makeStatus({ localApi: false, up: false });
    advance(10_000);
    await status.ensure();
    expect(probe).toHaveBeenCalledTimes(1);
    advance(1_000);
    await status.ensure();
    await status.ensure();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('backs off while the answer stays no, and resets once it is yes', async () => {
    let up = false;
    const { status, probe, advance } = makeStatus({ up: () => ({ up, timedOut: false }) });
    // Floor is 5s and it doubles: 5, 10, 20, then the 30s ceiling.
    for (const wait of [5_000, 10_000, 20_000, 30_000, 30_000]) {
      advance(wait);
      await status.ensure();
    }
    expect(probe).toHaveBeenCalledTimes(5);
    // Inside the ceiling window nothing is asked again...
    advance(20_000);
    await status.ensure();
    expect(probe).toHaveBeenCalledTimes(5);
    // ...and once the app answers, the cadence returns to the floor.
    up = true;
    advance(30_000);
    expect(await status.ensure()).toBe(true);
  });

  it('asks far less often when the port drops packets rather than refusing them', async () => {
    // A refused connection is free to repeat; a dropped one costs the whole probe budget,
    // and it is the caller's latency it costs. So one failure is enough to slow right down.
    const { status, probe, advance } = makeStatus({ up: () => ({ up: false, timedOut: true }) });
    advance(10_000);
    await status.ensure();
    advance(30_000);
    await status.ensure();
    expect(probe).toHaveBeenCalledTimes(1);
    advance(31_000);
    await status.ensure();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('shares one probe between callers that arrive together', async () => {
    const { status, probe, advance } = makeStatus({ up: false });
    advance(10_000);
    await Promise.all(Array.from({ length: 10 }, () => status.ensure()));
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('returns a stale yes at once and refreshes behind the caller', async () => {
    // The caller is on its way to use the local API anyway and would learn of a failure
    // there; making every one of them wait on a probe first buys nothing.
    const { status, probe, advance } = makeStatus({ localApi: true, up: true });
    advance(60_000);
    expect(await status.ensure()).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('does not turn a running desktop app off on one failed probe', async () => {
    // The probe's budget is wall clock measured across an event loop this same process
    // blocks for seconds at a time, so a single abort can be our own stall rather than the
    // app's absence — and going down costs a keyless user their whole library.
    let up = true;
    const { status, capabilities, advance } = makeStatus({ localApi: true, up: () => ({ up, timedOut: false }) });
    up = false;
    advance(60_000);
    expect(await status.ensure({ force: true })).toBe(true);
    expect(capabilities.localApi).toBe(true);
    advance(60_000);
    expect(await status.ensure({ force: true })).toBe(false);
    expect(capabilities.localApi).toBe(false);
  });

  it('publishes the down edge, once, to whoever is listening for it (#39)', async () => {
    let up = true;
    const { status, advance } = makeStatus({ localApi: true, up: () => ({ up, timedOut: false }) });
    const seen: number[] = [];
    const off = status.onDegraded((at) => seen.push(at));

    expect(status.lastDegradedAt()).toBeUndefined();
    up = false;
    advance(60_000);
    await status.ensure({ force: true }); // one failure is not yet an outage
    expect(seen).toEqual([]);
    advance(60_000);
    await status.ensure({ force: true });
    expect(seen).toHaveLength(1);
    expect(status.lastDegradedAt()).toBe(seen[0]);

    // Still down on the next probe: that is the same outage, not a second one.
    advance(60_000);
    await status.ensure({ force: true });
    expect(seen).toHaveLength(1);

    // Back up and down again is a new edge, and an unsubscribed listener hears none of it.
    off();
    up = true;
    advance(60_000);
    await status.ensure({ force: true });
    up = false;
    advance(60_000);
    await status.ensure({ force: true });
    advance(60_000);
    await status.ensure({ force: true });
    expect(seen).toHaveLength(1);
    expect(status.lastDegradedAt()).toBeGreaterThan(seen[0]!);
  });

  it('keeps why the latest probe failed on the live capability object (#102)', async () => {
    let answer: { up: boolean; timedOut: boolean; status?: number } = { up: false, timedOut: false, status: 403 };
    const { status, capabilities, advance } = makeStatus({ up: () => answer });
    advance(10_000);
    expect(await status.ensure()).toBe(false);
    expect(capabilities.localProbe).toEqual({ kind: 'http', status: 403 });
    // A timeout carries the budget it ran out of, which is the number a user needs to
    // compare against how long their Zotero really takes.
    answer = { up: false, timedOut: true };
    advance(60_000);
    await status.ensure();
    expect(capabilities.localProbe).toEqual({ kind: 'timeout', budgetMs: 1500 });
    answer = { up: true, timedOut: false, status: 200 };
    advance(60_000);
    expect(await status.ensure()).toBe(true);
    expect(capabilities.localProbe).toEqual({ kind: 'up' });
  });

  it('records a failed probe even while the two-strikes rule keeps the app up', async () => {
    let up = true;
    const { status, capabilities, advance } = makeStatus({ localApi: true, up: () => ({ up, timedOut: true }) });
    up = false;
    advance(60_000);
    expect(await status.ensure({ force: true })).toBe(true);
    expect(capabilities.localApi).toBe(true);
    expect(capabilities.localProbe).toEqual({ kind: 'timeout', budgetMs: 1500 });
  });

  it('never lets a listener that throws take the probe down with it', async () => {
    let up = true;
    const { status, capabilities, advance } = makeStatus({ localApi: true, up: () => ({ up, timedOut: false }) });
    status.onDegraded(() => {
      throw new Error('listener exploded');
    });
    up = false;
    advance(60_000);
    await status.ensure({ force: true });
    advance(60_000);
    await expect(status.ensure({ force: true })).resolves.toBe(false);
    expect(capabilities.localApi).toBe(false);
  });
});
