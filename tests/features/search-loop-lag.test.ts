import { describe, it, expect } from 'vitest';
import { LoopLagMonitor } from '../../src/features/search/loop-lag.js';

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
