import type { ZoteusConfig } from '../config.js';
import type { LocalApiClient } from '../api/local-client.js';
import type { Logger } from '../lib/logger.js';
import { describeLocalProbe, probeOutcome, type Capabilities } from './capabilities.js';

/**
 * How long a `true` is trusted before it is worth asking again. Long, because the cost of
 * being wrong in this direction is one failed request that says so, and because a desktop
 * app that was up a moment ago almost always still is.
 */
const POSITIVE_TTL_MS = 30_000;

/**
 * How soon a `false` may be re-asked, and the ceiling that repeated failures back off to.
 * Short at the floor because this is the direction #22 is about: someone has just started
 * Zotero and is waiting for the server to notice. A refused connection to loopback costs
 * microseconds, so asking every five seconds is free.
 */
const NEGATIVE_TTL_FLOOR_MS = 5_000;
const NEGATIVE_TTL_CEILING_MS = 30_000;

/**
 * The cadence a port that DROPs rather than refuses settles at. Separate from the ceiling
 * above because the two failures cost different amounts: a refused connection is free to
 * repeat, while a dropped packet burns the whole probe budget every time, and it is the
 * caller's latency it burns. Slower than the ceiling for exactly that reason.
 */
const TIMEOUT_TTL_MS = 60_000;

/**
 * Time budget for one probe. Far below the fetcher's 25 s default: this runs on the way in
 * to a tool call, so it is latency the caller pays, and a desktop app on loopback either
 * answers in milliseconds or is not there.
 */
const PROBE_TIMEOUT_MS = 1_500;

/**
 * Failed probes needed to turn a `true` into a `false`. Deliberately more than one: see
 * the reasoning where it is used.
 */
const FAILURES_BEFORE_DOWN = 2;

export interface LocalApiStatusOptions {
  config: ZoteusConfig;
  client?: LocalApiClient;
  /** The live capability object every consumer already holds; this class keeps it true. */
  capabilities: Capabilities;
  logger: Logger;
  /** Injectable clock, so the TTL and backoff are testable without real time. */
  now?: () => number;
}

/**
 * Whether the desktop local API is reachable, kept live instead of decided once.
 *
 * The startup probe used to be the whole answer, which made the result a function of
 * launch order rather than of anything true: a Zotero started a minute after the MCP
 * server stayed invisible for the life of the process, and the only cure was restarting
 * the host application (#22). This re-asks, lazily, on the way in to a tool call.
 *
 * Three properties keep that from becoming a network round trip per tool call:
 *   - it is a no-op unless a local client exists and ZOTEUS_LOCAL is not `off`, so hosted
 *     per-user contexts never probe at all;
 *   - answers are cached with a TTL, and repeated failures back off toward a minute, so a
 *     machine that will never run Zotero settles at one refused connect per minute;
 *   - concurrent callers share one in-flight probe.
 *
 * It mutates the shared `Capabilities` rather than holding its own copy, because the
 * router reads that object synchronously on every routing decision. Keeping one object
 * live is what makes a newly-available desktop app visible to reads, writes, group
 * routing and `zotero_whoami` at the same moment, with no further plumbing.
 */
export class LocalApiStatus {
  /** False when nothing here can ever apply; every method then costs a boolean test. */
  readonly enabled: boolean;

  private readonly config: ZoteusConfig;
  private readonly client: LocalApiClient | undefined;
  private readonly capabilities: Capabilities;
  private readonly logger: Logger;
  private readonly now: () => number;

  private checkedAt: number;
  private negativeTtlMs = NEGATIVE_TTL_FLOOR_MS;
  private inflight: Promise<boolean> | undefined;
  /** True once the group list has been read successfully for the current up-period. */
  private groupsKnown = false;
  private consecutiveFailures = 0;
  /** When the local API was last seen to go from answering to not answering. */
  private degradedAt: number | undefined;
  private readonly degradedListeners = new Set<(at: number) => void>();

  constructor(opts: LocalApiStatusOptions) {
    this.config = opts.config;
    this.client = opts.client;
    this.capabilities = opts.capabilities;
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
    this.enabled = Boolean(opts.client) && opts.config.local !== 'off';
    // The startup probe fetches the group list whenever it found the app up, so that case
    // needs no re-fetch; where it found it down, there is nothing to trust.
    this.groupsKnown = opts.capabilities.localApi;
    // The startup probe in `probeCapabilities` counts as this object's first answer, so a
    // server that has just booted does not immediately probe again on its first tool call.
    this.checkedAt = this.now();
  }

  /** The cached answer, with no I/O. What the router's synchronous routing reads. */
  current(): boolean {
    return this.capabilities.localApi;
  }

  /** When the answer was last established, for callers that want to say so. */
  lastCheckedAt(): number {
    return this.checkedAt;
  }

  /**
   * When the local API was last seen to stop answering, or undefined if it never has in
   * this process. Not cleared when the app comes back: it is a record of an event, and the
   * thing that wants it (a long-running index build, which is what caused the outage in
   * the first place) is still running long after the app has recovered.
   */
  lastDegradedAt(): number | undefined {
    return this.degradedAt;
  }

  /**
   * Be told when the local API goes from answering to not answering. Returns a function
   * that unsubscribes.
   *
   * Only the DOWN edge, and only once per outage: a probe that finds the app still absent
   * is the same outage, not a second one. The listener exists because that transition is
   * not merely informational to a running index build. The build is usually its cause, it
   * is the one thing on the machine that can ease off, and it is the one thing whose
   * status the user is actually watching (#39).
   */
  onDegraded(listener: (at: number) => void): () => void {
    this.degradedListeners.add(listener);
    return () => this.degradedListeners.delete(listener);
  }

  /**
   * Bring the answer up to date if it has gone stale, and return it.
   *
   * Asymmetric on purpose. A stale `false` is awaited, because that is the case someone is
   * actively waiting on and the probe is a refused connection to loopback. A stale `true`
   * is refreshed in the background and the cached answer returned at once, because the
   * caller is on its way to use the local API anyway and would learn of a failure there.
   */
  async ensure(opts: { force?: boolean } = {}): Promise<boolean> {
    if (!this.enabled) return false;
    const age = this.now() - this.checkedAt;
    const ttl = this.current() ? POSITIVE_TTL_MS : this.negativeTtlMs;
    if (!opts.force && age < ttl) return this.current();
    const probe = this.probeOnce();
    if (!opts.force && this.current()) {
      // Stale but positive: refresh behind the caller rather than in front of them.
      void probe.catch(() => {});
      return true;
    }
    return probe;
  }

  /** One probe, shared by every caller that arrives while it is in flight. */
  private probeOnce(): Promise<boolean> {
    this.inflight ??= this.runProbe().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async runProbe(): Promise<boolean> {
    const client = this.client;
    if (!client) return false;
    const was = this.capabilities.localApi;
    const result = await client.probe(PROBE_TIMEOUT_MS).catch(() => ({ up: false, timedOut: false }));
    const { up, timedOut } = result;
    this.checkedAt = this.now();
    // Recorded before the flag is decided, so that a failure the two-strikes rule below
    // does not yet act on is still visible as what it was: zotero_whoami then shows a
    // local API that is up and a latest probe that was not answered, which is the truth.
    this.capabilities.localProbe = probeOutcome(result, PROBE_TIMEOUT_MS);

    if (up) {
      this.negativeTtlMs = NEGATIVE_TTL_FLOOR_MS;
      this.consecutiveFailures = 0;
      // Fetched whenever the list is not known to be good, not merely on the up-edge. The
      // startup probe skips it entirely whenever the app was down, and a desktop still
      // opening its database can answer the ping and fail this call moments later — and a
      // failure recorded as an authoritative empty list would strand every group the
      // desktop holds on a cloud API a local-only user has no key for, for good.
      if (!this.groupsKnown) {
        const groups = await client.listLocalGroupIds().then(
          (ids) => ({ ids, ok: true }),
          () => ({ ids: [] as number[], ok: false }),
        );
        this.groupsKnown = groups.ok;
        // Published together with the flag rather than before it: `Capabilities` is the
        // live object the router reads synchronously, so a window where it says "up" while
        // the group list is still the stale [] from when it was down routes group reads to
        // the cloud for no reason.
        this.capabilities.localApi = true;
        if (groups.ok) this.capabilities.localGroupIds = groups.ids;
        if (!was) {
          this.logger.info(
            `Zotero's local API is now reachable on port ${this.config.localPort}` +
              `${groups.ids.length ? `, serving ${groups.ids.length} group(s)` : ''}.`,
          );
        }
      } else {
        this.capabilities.localApi = true;
      }
      return true;
    }

    // A port that DROPs rather than refuses costs the whole budget on every attempt, so it
    // goes straight to the slowest cadence instead of climbing there one probe at a time.
    this.negativeTtlMs = timedOut
      ? TIMEOUT_TTL_MS
      : Math.min(this.negativeTtlMs * 2, NEGATIVE_TTL_CEILING_MS);
    this.consecutiveFailures++;
    // One failed probe is not enough to declare a running Zotero gone. The budget is wall
    // clock measured across an event loop this same process blocks for seconds at a time
    // (a JSON index persists with one synchronous stringify; embedding batches are
    // CPU-bound), so a single abort can be our own stall rather than the app's absence.
    // Going down costs real capability — a keyless user loses their library — so it takes
    // two in a row, which is also what the startup probe's retry loop concluded.
    if (was && this.consecutiveFailures < FAILURES_BEFORE_DOWN) return true;
    this.capabilities.localApi = false;
    if (was) {
      this.groupsKnown = false;
      this.capabilities.localGroupIds = [];
      this.logger.info(
        `Zotero's local API stopped answering on port ${this.config.localPort} ` +
          `(${describeLocalProbe(this.capabilities.localProbe, this.config.localPort)}); ` +
          'reads and writes fall back to the Zotero Web API.',
      );
      this.degradedAt = this.checkedAt;
      // A listener is somebody else's code on this process's probe path, and a probe that
      // throws is a local API wrongly reported as reachable. Each one is isolated.
      for (const listener of this.degradedListeners) {
        try {
          listener(this.degradedAt);
        } catch (e) {
          this.logger.debug(`local-API degradation listener failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    return false;
  }
}
