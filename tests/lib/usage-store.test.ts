import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeSqliteAvailable } from '../../src/features/search/factory.js';
import { openUsage } from '../../src/lib/usage/index.js';
import type { UsageEvent } from '../../src/lib/usage/event.js';

const sqliteIt = nodeSqliteAvailable() ? it : it.skip;
const dirs: string[] = [];
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'zoteus-usage-'));
  dirs.push(d);
  return d;
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const DAY = 86_400_000;
const call = (ts: number, over: Partial<UsageEvent> = {}): UsageEvent => ({
  ts,
  kind: 'tool',
  name: 'zotero_search_items',
  userId: 777,
  ok: true,
  ms: 100,
  ...over,
});

async function open(dir: string, over: Partial<Parameters<typeof openUsage>[0]> = {}) {
  const handle = await openUsage({
    enabled: true,
    path: join(dir, 'usage.sqlite'),
    retentionDays: 30,
    identify: 'user',
    maintenanceIntervalMs: 3_600_000,
    ...over,
  });
  if (!handle) throw new Error('usage log did not open');
  return handle;
}

describe('usage store', () => {
  it('records nothing at all when disabled', async () => {
    expect(
      await openUsage({
        enabled: false,
        path: join(tempDir(), 'usage.sqlite'),
        retentionDays: 30,
        identify: 'user',
      }),
    ).toBeUndefined();
  });

  sqliteIt('rolls a day of calls up per tool and per user', async () => {
    const dir = tempDir();
    const h = await open(dir);
    // Today at noon UTC, not a fixed date: dailyRows() only folds the last two days in on
    // a read and leaves older days to maintain(), so a fixed date silently aged out of that
    // window (this test went red on 2026-09-06 with events dated 2026-09-03).
    const today = new Date();
    const now = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12);
    const day = new Date(now).toISOString().slice(0, 10);
    h.recorder.record(call(now, { ms: 100 }));
    h.recorder.record(call(now, { ms: 300 }));
    h.recorder.record(call(now, { ms: 900, ok: false, errorKind: 'zotero_4xx' }));
    h.recorder.record(call(now, { name: 'zotero_get_item', userId: 42, ms: 20 }));
    await h.recorder.flush();

    const rows = h.store.dailyRows();
    const search = rows.find((r) => r.name === 'zotero_search_items' && r.userId === 777)!;
    expect(search).toMatchObject({ day, calls: 3, errors: 1, msMax: 900 });
    expect(search.msP50).toBe(300);
    expect(search.msP95).toBe(900);
    // Per-user grain: the second user is a row of their own, not folded into the first.
    expect(rows.find((r) => r.userId === 42)).toMatchObject({ name: 'zotero_get_item', calls: 1 });
    h.stop();
    await h.recorder.close();
  });

  sqliteIt('recomputing a day replaces it rather than doubling it', async () => {
    const dir = tempDir();
    const h = await open(dir);
    const now = Date.now();
    h.recorder.record(call(now));
    expect(h.store.dailyRows()[0]!.calls).toBe(1);
    h.recorder.record(call(now));
    expect(h.store.dailyRows()[0]!.calls).toBe(2);
    h.stop();
    await h.recorder.close();
  });

  sqliteIt('prunes raw events past retention but keeps their rollup forever', async () => {
    const dir = tempDir();
    const h = await open(dir, { retentionDays: 7 });
    const now = Date.now();
    h.recorder.record(call(now - 30 * DAY));
    h.recorder.record(call(now));
    h.store.rollup(now);
    expect(h.store.counts().events).toBe(2);

    h.store.prune(now);
    expect(h.store.counts().events).toBe(1);
    // The old day survives as a rollup, which is the whole point of the arrangement.
    const days = h.store.dailyRows().map((r) => r.day);
    expect(new Set(days).size).toBe(2);
    h.stop();
    await h.recorder.close();
  });

  sqliteIt('survives a restart, and catches up the days it was down for', async () => {
    const dir = tempDir();
    const first = await open(dir);
    first.recorder.record(call(Date.now() - DAY));
    first.stop();
    await first.recorder.close();

    const second = await open(dir);
    expect(second.store.counts().events).toBe(1);
    expect(second.store.dailyRows()).toHaveLength(1);
    second.stop();
    await second.recorder.close();
  });

  sqliteIt('moves an unreadable database aside and starts a new one', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'usage.sqlite'), 'this is not a database');
    const h = await open(dir);
    h.recorder.record(call(Date.now()));
    await h.recorder.flush();
    expect(h.store.counts().events).toBe(1);
    // Sidelined, not deleted: the operator keeps whatever was in there.
    expect(readdirSync(dir).some((f) => f.includes('.corrupt-'))).toBe(true);
    h.stop();
    await h.recorder.close();
  });

  sqliteIt('hashes the user id under identify=hash, and drops it under none', async () => {
    const dir = tempDir();
    const hashed = await open(dir, { identify: 'hash' });
    hashed.recorder.record(call(Date.now()));
    await hashed.recorder.flush();
    const id = hashed.store.dailyRows()[0]!.userId;
    expect(id).not.toBe(777);
    expect(typeof id).toBe('number');
    // Stable across events, or every retention number computed on it would be wrong.
    hashed.recorder.record(call(Date.now()));
    await hashed.recorder.flush();
    expect(hashed.store.dailyRows()).toHaveLength(1);
    hashed.stop();
    await hashed.recorder.close();

    const anon = await open(tempDir(), { identify: 'none' });
    anon.recorder.record(call(Date.now(), { sessionId: 'sess-1' }));
    await anon.recorder.flush();
    expect(anon.store.dailyRows()[0]!.userId).toBeNull();
    anon.stop();
    await anon.recorder.close();
  });
});
