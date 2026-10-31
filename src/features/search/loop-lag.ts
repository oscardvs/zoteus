/**
 * How long the event loop went without turning while an index job ran.
 *
 * An index job spends most of its time awaiting HTTP reads and embedding batches, and
 * those hand the loop back between steps. What it cannot hand back is the CPU-bound
 * stretch in between — chunking a large attachment into passages, writing a page of them
 * to the store — and when that stretch runs longer than a client's request timeout, the
 * server answers nothing for all of it (#106): every tool call from every connected client
 * times out, and a job that only *looks* wedged cannot be stopped or even observed,
 * because `action:"status"` and `action:"stop"` ride the same loop.
 *
 * A coarse timer measures that from inside the process: between two timer ticks the loop
 * must have turned, so the drift past the next tick is the length of one uninterrupted
 * busy stretch. Reported on the build status and in the job's closing log line, it turns
 * "the server went dark" from an outside observation into a number with a phase attached,
 * which is what distinguishes a batch of chunking from an embedder that never yielded.
 */
export class LoopLagMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private expected = 0;
  private worstMs = 0;
  private intervalMs = 200;
  private started = false;

  start(intervalMs = 200): void {
    this.stop();
    this.worstMs = 0;
    this.intervalMs = intervalMs;
    const tick = (): void => {
      const now = Date.now();
      const lag = now - this.expected;
      if (lag > this.worstMs) this.worstMs = lag;
      // From the tick that was due, not from `now`: a monitor that resets its baseline
      // after every measured lag would read one long busy stretch as many short ones.
      this.expected = Math.max(now, this.expected + intervalMs);
    };
    this.expected = Date.now() + intervalMs;
    this.timer = setInterval(tick, intervalMs);
    // Never the reason the process stays alive: a monitor on an idle server is not work.
    this.timer.unref?.();
    this.started = true;
  }

  /**
   * Stop measuring and return the longest busy stretch seen, in ms (0 if none).
   *
   * A stretch that ended seconds ago still counts: a job's `finally` runs the moment its
   * last await settles, which can be before the tick that was due during the stretch has
   * run (a tail of immediately-resolved promises never hands the loop a turn). The amount
   * by which the next tick is overdue is therefore measured here too — a tick overdue by
   * more than one interval means the loop has not turned since before it was due, which is
   * exactly the unmeasured stretch, and its length is measured from the last tick that
   * did run.
   */
  stop(): number {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.started) {
      const now = Date.now();
      const overdue = now - this.expected;
      if (overdue > this.intervalMs) {
        // From the last tick that ran (one interval before the one that was due) to now.
        const pending = overdue + this.intervalMs;
        if (pending > this.worstMs) this.worstMs = pending;
      }
      this.started = false;
    }
    return this.worstMs;
  }
}
