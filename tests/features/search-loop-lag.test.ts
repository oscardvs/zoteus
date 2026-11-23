import { describe, it, expect } from 'vitest';
import { LoopLagMonitor, runSteps, runStepsSliced } from '../../src/features/search/loop-lag.js';

/**
 * The monitor that answers #106's "how dark did the server actually go": between two
 * timer ticks the loop must have turned, so drift past the next tick is one uninterrupted
 * busy stretch. Measured with a deliberate synchronous block (`Atomics.wait` parks the
 * thread without turning the loop, which is exactly the shape of a long chunking or
 * persisting stretch), because nothing asynchronous can prove the negative.
 */

function blockFor(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

describe('LoopLagMonitor', () => {
  it('measures a deliberate synchronous block as one long stall', async () => {
    const m = new LoopLagMonitor();
    m.start(50);
    // Let one clean tick through first, so the measurement is of the block and not of
    // the monitor's own startup.
    await new Promise((r) => setTimeout(r, 120));
    blockFor(300);
    // The tick that measures the block is due the moment it ends; give the loop the turn
    // that lets it run before reading the result.
    await new Promise((r) => setTimeout(r, 10));
    const stall = m.stop();
    expect(stall).toBeGreaterThanOrEqual(250);
    expect(stall).toBeLessThan(2000);
  });

  it('reports no stall while the loop turns freely', async () => {
    const m = new LoopLagMonitor();
    m.start(50);
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 60));
    const stall = m.stop();
    expect(stall).toBeLessThan(200);
  });

  it('restarts with a clean baseline', async () => {
    const m = new LoopLagMonitor();
    m.start(50);
    blockFor(300);
    await new Promise((r) => setTimeout(r, 10));
    expect(m.stop()).toBeGreaterThanOrEqual(250);
    m.start(50);
    await new Promise((r) => setTimeout(r, 120));
    expect(m.stop()).toBeLessThan(200);
  });

  it('stops cleanly when never started', () => {
    const m = new LoopLagMonitor();
    expect(m.stop()).toBe(0);
    m.stop(); // idempotent
  });
});

/**
 * A stepped job that costs about `ms` of synchronous work per step: the shape of a scan
 * over an index, where every row is a little CPU and, on a small cloud disk, a read.
 */
function* busySteps(steps: number, ms: number): Generator<void, number, void> {
  for (let i = 0; i < steps; i++) {
    blockFor(ms);
    yield;
  }
  return steps;
}

/** Count the ticks of a 5 ms timer, and the longest gap between two, while `job` runs. */
async function watch<T>(job: () => Promise<T> | T): Promise<{ value: T; ticks: number; maxGap: number; elapsed: number }> {
  let ticks = 0;
  let last = performance.now();
  let maxGap = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks++;
  }, 5);
  const started = performance.now();
  const value = await job();
  const elapsed = performance.now() - started;
  maxGap = Math.max(maxGap, performance.now() - last);
  clearInterval(timer);
  return { value, ticks, maxGap, elapsed };
}

describe('stepped jobs', () => {
  it('runStepsSliced hands the loop back while a long job runs, and returns its value', async () => {
    const r = await watch(() => runStepsSliced(busySteps(60, 5), 20));
    expect(r.value).toBe(60);
    // About 300 ms of work in slices of about 20 ms: the timer must have run many times,
    // and no gap between its ticks can be much longer than a slice.
    expect(r.ticks).toBeGreaterThanOrEqual(5);
    expect(r.maxGap).toBeLessThan(r.elapsed / 3);
  });

  it('runSteps runs the same steps in one go, which is the stall the sliced runner exists to avoid', async () => {
    const r = await watch(() => runSteps(busySteps(60, 5)));
    expect(r.value).toBe(60);
    expect(r.ticks).toBe(0);
    expect(r.maxGap).toBeGreaterThanOrEqual(250);
  });
});
