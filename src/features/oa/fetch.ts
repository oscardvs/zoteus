import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isPrivateOrReservedIp } from '../../lib/cimd.js';
import type { ToolContext } from '../../registry/registry.js';
import { pinnedHttpsFetch } from './pinned-fetch.js';

/**
 * Downloading an open-access PDF from a host a lookup named.
 *
 * This is new egress, and it is not the same as the existing `url` argument on
 * zotero_attach_file. There a person named the host; here a provider's answer did, and on a
 * hosted deployment the request leaves the operator's box. So the fetch is bounded rather
 * than trusting: https only, no hop into private address space, redirects followed by hand
 * so every hop is checked, and a hard byte cap enforced while streaming instead of after
 * buffering.
 *
 * What it deliberately does NOT do is decide whether the bytes are a PDF. That is
 * `detectKind` on the caller's side, on the bytes themselves, right before the write.
 */

/**
 * Ceiling on an automatically fetched PDF. Generous next to a normal article (single-digit
 * MB) and well under what buffering one costs a small host. A legitimate file above this is
 * still attachable by hand through `url` or `path`.
 */
export const MAX_OA_PDF_BYTES = 64 * 1024 * 1024;

/** Hops followed before giving up: DOI resolvers and repositories routinely use two or three. */
const MAX_REDIRECTS = 5;

/**
 * Total budget for the download, retries, redirects and the body read included.
 *
 * It has to cover the body, not just the headers. `RateLimitedFetcher` clears its abort
 * timer the moment a Response is in hand, so its `deadlineMs` bounds time-to-headers and
 * nothing more: a host that answered instantly and then trickled one byte every 50 ms held
 * this call open for as long as it liked, and the 64 MB cap is a bound on size, not on time.
 * So the clock is started once here, each hop gets only what is left of it, and
 * {@link readCapped} is handed the same deadline.
 */
const OA_DEADLINE_MS = 120_000;

/**
 * How long the body may go with no bytes at all before the download is abandoned.
 *
 * Separate from the total budget because the two failures need different sentences: a
 * repository that is merely slow is worth waiting the full budget for, and one that has
 * stopped sending is not worth waiting on at all. Well clear of the pauses a busy repository
 * takes mid-file.
 */
const OA_IDLE_MS = 30_000;

/** A refusal with a sentence already written for the caller to pass straight through. */
export class OaFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OaFetchError';
  }
}

export type HostLookup = (hostname: string) => Promise<string[]>;

async function defaultLookup(hostname: string): Promise<string[]> {
  const res = await dnsLookup(hostname, { all: true });
  return res.map((r) => r.address);
}

let hostLookup: HostLookup = defaultLookup;

/**
 * Replace the DNS resolution the host guard uses. A test seam, in the shape
 * `setArxivMinGapMs` already established: the guard is worth exercising, and exercising it
 * must not put a real DNS query in the test suite.
 */
export function setOaHostLookup(fn: HostLookup | null): void {
  hostLookup = fn ?? defaultLookup;
}

/**
 * Reject a URL that is not https, or whose host is (or resolves to) an address inside the
 * deployment. Return the vetted address so the HTTPS connection uses exactly that address.
 */
async function assertPublicHttps(raw: string): Promise<string> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new OaFetchError(`The open-access link is not a usable URL (${raw}), so nothing was downloaded; open it yourself and attach the file with \`path\`.`);
  }
  if (u.protocol !== 'https:') {
    throw new OaFetchError(
      `The open-access copy is served over ${u.protocol.replace(/:$/, '')} rather than https (${raw}), and Zoteus only fetches over https, so nothing was downloaded; open the link yourself and attach the file with \`path\`.`,
    );
  }
  if (u.username || u.password) throw new OaFetchError('Open-access links with URL credentials are not fetched.');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) {
      throw new OaFetchError(`The open-access link points at a non-public address (${host}), so nothing was downloaded; that is not a repository, and the item's link needs checking.`);
    }
    return host;
  }
  let addrs: string[];
  try {
    addrs = await hostLookup(host);
  } catch {
    throw new OaFetchError(`The host of the open-access link (${host}) could not be resolved, so nothing was downloaded; retry shortly, or open the link yourself and attach the file with \`path\`.`);
  }
  if (addrs.length === 0 || addrs.some((address) => !net.isIP(address) || isPrivateOrReservedIp(address))) {
    throw new OaFetchError(`The host of the open-access link (${host}) resolves to a non-public address, so nothing was downloaded; that is not a repository, and the item's link needs checking.`);
  }
  return addrs[0]!;
}

/** A millisecond budget as whole seconds for a sentence, never rounded down to "0 s". */
function seconds(ms: number): number {
  return Math.max(1, Math.round(ms / 1000));
}

/**
 * Await `p`, or give up after `ms` with the error `onTimeout` builds.
 *
 * The read that lost the race is still in flight and will settle later, possibly by
 * rejecting once the reader is cancelled, so it gets a handler of its own: an abandoned
 * rejection here would surface as an unhandled rejection and take the process down.
 */
async function within<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  void p.catch(() => {});
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), Math.max(0, ms));
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the body with the cap applied WHILE streaming, so an oversized file is never
 * buffered, and with a clock on it, so a host that trickles or stalls cannot hold the call
 * open. Both limits end the same way: the reader is cancelled and an `OaFetchError` says
 * which limit was hit and what to do instead.
 */
async function readCapped(
  res: Response,
  url: string,
  maxBytes: number,
  budget: { deadlineAt: number; totalMs: number; idleMs: number },
): Promise<Uint8Array> {
  const { deadlineAt, totalMs, idleMs } = budget;
  const tooLarge = () =>
    new OaFetchError(
      `The open-access copy at ${url} is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB Zoteus downloads automatically, so nothing was attached; download it yourself and attach it with \`path\`.`,
    );
  const tooSlow = () =>
    new OaFetchError(
      `The open-access copy at ${url} was still arriving after the ${seconds(totalMs)} s Zoteus allows for one automatic download, so nothing was attached; download it yourself and attach it with \`path\`.`,
    );
  const wentQuiet = () =>
    new OaFetchError(
      `The open-access copy at ${url} stopped arriving: ${seconds(idleMs)} s passed with no further bytes, so nothing was attached; retry shortly, or download it yourself and attach it with \`path\`.`,
    );
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const body = res.body;
  if (!body) {
    // No stream to meter, so the whole body is one await: bound it by what is left of the
    // budget rather than letting it run unwatched.
    const buf = new Uint8Array(await within(res.arrayBuffer(), deadlineAt - Date.now(), tooSlow));
    if (buf.length > maxBytes) throw tooLarge();
    return buf;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // Whichever runs out first: the budget for the whole download, or the patience for one
    // silent stretch of it. The shorter of the two is what this read waits for, and which
    // one it was decides the sentence.
    const left = deadlineAt - Date.now();
    const wait = Math.min(idleMs, left);
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await within(reader.read(), wait, left <= idleMs ? tooSlow : wentQuiet);
    } catch (e) {
      await reader.cancel().catch(() => {});
      throw e;
    }
    const { done, value } = chunk;
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export interface OaFetchResult {
  bytes: Uint8Array;
  /** The content type the last hop served, when it served one. Reported, never trusted. */
  servedType?: string;
  /** The URL the bytes actually came from, after any redirects. */
  url: string;
}

/**
 * Fetch the bytes at an open-access PDF URL, or throw an `OaFetchError` whose message is
 * already the sentence to show. Redirects are followed by hand (`redirect: 'manual'`) so the
 * host guard runs on every hop rather than only on the one the provider named.
 */
export async function fetchOaPdf(
  ctx: Pick<ToolContext, 'fetcher'>,
  url: string,
  opts: { maxBytes?: number; deadlineMs?: number; idleMs?: number } = {},
): Promise<OaFetchResult> {
  const maxBytes = opts.maxBytes ?? MAX_OA_PDF_BYTES;
  const totalMs = opts.deadlineMs ?? OA_DEADLINE_MS;
  const idleMs = opts.idleMs ?? OA_IDLE_MS;
  // One clock for the whole call, started before the first hop. Handing each hop its own
  // full budget would make the real ceiling six times what is promised here, and would leave
  // the body read outside any budget at all.
  const deadlineAt = Date.now() + totalMs;
  const outOfTime = () =>
    new OaFetchError(
      `Downloading the open-access copy of ${url} took longer than the ${seconds(totalMs)} s Zoteus allows for one automatic download, so nothing was attached; download it yourself and attach it with \`path\`.`,
    );
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const address = await within(assertPublicHttps(current), deadlineAt - Date.now(), outOfTime);
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw outOfTime();
    const res = await ctx.fetcher.fetch(
      current,
      { method: 'GET', redirect: 'manual', headers: { accept: 'application/pdf,*/*' } },
      { maxRetries: 2, deadlineMs: remaining, fetchImpl: pinnedHttpsFetch(address) },
    );
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!location) {
        throw new OaFetchError(`${current} answered ${res.status} with no destination, so nothing was downloaded; open the link yourself and attach the file with \`path\`.`);
      }
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new OaFetchError(`The open-access copy at ${current} answered HTTP ${res.status}, so nothing was attached; the link may have moved, so open it yourself and attach the file with \`path\`.`);
    }
    return {
      bytes: await readCapped(res, current, maxBytes, { deadlineAt, totalMs, idleMs }),
      servedType: res.headers.get('content-type')?.split(';')[0]?.trim() || undefined,
      url: current,
    };
  }
  throw new OaFetchError(`The open-access link redirected more than ${MAX_REDIRECTS} times without arriving at a file, so nothing was downloaded; open ${url} yourself and attach the file with \`path\`.`);
}
