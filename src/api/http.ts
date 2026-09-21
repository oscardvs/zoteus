import { Semaphore } from '../lib/semaphore.js';
import { ZoteroApiError } from './errors.js';
import type { Logger } from '../lib/logger.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RateLimitedFetcherOptions {
  maxConcurrency?: number;
  fetchImpl?: FetchLike;
  logger?: Logger;
  defaultDeadlineMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Per-request time budget (covers the whole retry/backoff loop). Bounded so a stuck or
 * rate-limited request fails fast with actionable guidance instead of hanging until the
 * MCP connector's own per-call timeout fires (which surfaces to the model as an opaque
 * error). A single request rarely needs this long; the budget mainly caps retry/backoff
 * accumulation, so it leaves healthy batch requests (each fast) untouched. */
const DEFAULT_DEADLINE_MS = 25_000;

/**
 * The origin a URL belongs to. A URL that will not parse is keyed on its own string: that is
 * a bucket of one, which is exactly as much sharing as it deserves.
 */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Whether this origin is Zotero: the Web API, or the desktop app on loopback.
 *
 * The budget messages name Zotero and tell the caller how to behave towards Zotero. This
 * fetcher is shared, and some of its callers reach hosts nobody here vouches for (the
 * open-access download, the `url` argument of zotero_attach_file, OpenAlex and Crossref), so
 * a stall on one of those must not be reported in Zotero's name and must not be answered
 * with advice about Zotero batching.
 */
function isZoteroOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return (
      host === 'zotero.org' ||
      host.endsWith('.zotero.org') ||
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1'
    );
  } catch {
    return false;
  }
}

/**
 * Wraps fetch with the behavior every Zotero client must follow:
 *  - cap concurrent requests (default 4),
 *  - honor the `Backoff` header (applies to all subsequent requests to the SAME origin),
 *  - retry on 429/503 honoring `Retry-After`, with exponential fallback,
 *  - bound total time per request so it fails fast (not hang) past `deadlineMs`.
 */
export class RateLimitedFetcher {
  private readonly sem: Semaphore;
  private readonly fetchImpl: FetchLike;
  private readonly logger?: Logger;
  private readonly defaultDeadlineMs: number;
  /**
   * When each origin asked to be left alone until, keyed by origin.
   *
   * Keyed, not global. This fetcher is shared with the open-access download and with the
   * `url` argument of zotero_attach_file, so a `Backoff` header can arrive from any host on
   * the web, chosen by a provider's answer rather than by a person. While the state was
   * process-wide, one repository answering `Backoff: 3600` stalled every subsequent Zotero
   * request for an hour and the failure was reported to the user as Zotero throttling them.
   * A host can now only slow down traffic to itself.
   */
  private readonly backoffUntil = new Map<string, number>();

  constructor(opts: RateLimitedFetcherOptions = {}) {
    this.sem = new Semaphore(opts.maxConcurrency ?? 4);
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
    this.logger = opts.logger;
    this.defaultDeadlineMs = opts.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS;
  }

  async fetch(
    url: string,
    init?: RequestInit,
    opts?: { maxRetries?: number; deadlineMs?: number; fetchImpl?: FetchLike },
  ): Promise<Response> {
    const maxRetries = opts?.maxRetries ?? 4;
    const deadlineMs = opts?.deadlineMs ?? this.defaultDeadlineMs;
    const origin = originOf(url);
    return this.sem.run(async () => {
      // The clock starts HERE, once a permit is held, not when the call was made. The
      // budget is a statement about Zotero (its error says so in as many words), and time
      // spent queued behind this process's own other requests is not Zotero being slow. A
      // busy fetcher used to spend a request's whole budget in the queue and then report a
      // desktop app answering in under a second as a hung one (#78).
      //
      // What this costs is tail latency: a request that used to fail while queued now runs,
      // so on a saturated fetcher the time a caller waits can grow by the queue wait on top
      // of the budget. Nothing waits longer per request, and the semaphore is what bounds
      // the queue.
      const start = Date.now();
      const remaining = () => deadlineMs - (Date.now() - start);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(0, remaining()));
      (timer as { unref?: () => void }).unref?.();
      // Did Zotero actually signal rate-limiting (429/503 or a Backoff header) during THIS
      // request? Used to attribute a budget overrun correctly: a slow single response with no
      // such signal is an expensive query, not throttling — and they want opposite remedies.
      let sawRateLimit = false;
      try {
        let attempt = 0;
        for (;;) {
          // Honor any backoff this origin asked for, but never sleep past our deadline.
          const backoffWait = (this.backoffUntil.get(origin) ?? 0) - Date.now();
          if (backoffWait > 0) {
            sawRateLimit = true;
            if (backoffWait >= remaining()) throw this.timeoutError(deadlineMs, sawRateLimit, origin);
            await sleep(backoffWait);
          }
          if (remaining() <= 0) throw this.timeoutError(deadlineMs, sawRateLimit, origin);

          let res: Response;
          try {
            res = await (opts?.fetchImpl ?? this.fetchImpl)(url, { ...init, signal: controller.signal });
          } catch (e) {
            if (controller.signal.aborted) throw this.timeoutError(deadlineMs, sawRateLimit, origin);
            throw e;
          }
          this.observeBackoff(res, origin);
          if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
            sawRateLimit = true;
            const wait = this.retryDelayMs(res, attempt);
            // Fail fast rather than sleep past the budget into a connector timeout.
            if (wait >= remaining()) throw this.timeoutError(deadlineMs, sawRateLimit, origin);
            this.logger?.warn(
              `Zotero ${res.status}; retrying in ${wait}ms (attempt ${attempt + 1}/${maxRetries})`,
            );
            await sleep(wait);
            attempt++;
            continue;
          }
          return res;
        }
      } finally {
        clearTimeout(timer);
      }
    });
  }

  /**
   * Build the budget-exceeded error. Two distinct causes need opposite remedies, so the
   * message must not conflate them:
   *  - `rateLimited` (saw a 429/503/Backoff): Zotero throttled us; back off and serialize.
   *  - otherwise: a single upstream response was simply slow (e.g. a full-text
   *    qmode=everything scan on a large library); narrowing the query is the fix, and
   *    "avoid parallel batches" would be misleading for one request.
   *
   * And a third distinction on top of those two: whose fault it was. Neither sentence is
   * true when the request went to a repository, a provider or a caller-named URL, so those
   * name the host that actually stalled rather than telling the user to serialize Zotero
   * calls Zotero was never unhappy about.
   */
  private timeoutError(deadlineMs: number, rateLimited: boolean, origin: string): ZoteroApiError {
    const secs = Math.max(1, Math.round(deadlineMs / 1000));
    if (!isZoteroOrigin(origin)) {
      return new ZoteroApiError({
        status: 408,
        message: rateLimited
          ? `${origin} asked for a back-off longer than the ${secs}s budget this request had, so it was not completed. ` +
            'That host is throttling, not Zotero, and your library was not involved: retry it later.'
          : `${origin} took longer than the ${secs}s budget to answer, with no throttling signal. ` +
            'That is the host being slow, not Zotero: retry it later, or fetch what you wanted from it yourself.',
      });
    }
    const message = rateLimited
      ? `Zotero rate-limited this request and the required back-off exceeded the ${secs}s budget. ` +
        'Retry sequentially — avoid parallel batches — and keep responses concise.'
      : `Zotero took longer than the ${secs}s budget to answer a single request, with no throttling/back-off signal. ` +
        'This is usually an expensive query — e.g. a full-text search (qmode=everything) over a large library. ' +
        'Narrow the query, lower the limit, or retry.';
    return new ZoteroApiError({ status: 408, message });
  }

  private observeBackoff(res: Response, origin: string): void {
    const backoff = res.headers.get('backoff');
    if (backoff) {
      const secs = Number(backoff);
      if (Number.isFinite(secs) && secs > 0) {
        const now = Date.now();
        this.backoffUntil.set(origin, Math.max(this.backoffUntil.get(origin) ?? 0, now + secs * 1000));
        // An expired entry is of no interest to anyone, and a long-lived process can speak to
        // a great many repositories, so they go rather than accumulate.
        for (const [k, until] of this.backoffUntil) if (k !== origin && until <= now) this.backoffUntil.delete(k);
      }
    }
  }

  private retryDelayMs(res: Response, attempt: number): number {
    const ra = res.headers.get('retry-after');
    if (ra) {
      const secs = Number(ra);
      if (Number.isFinite(secs)) return secs * 1000;
    }
    return Math.min(2 ** attempt * 500, 30_000);
  }
}
