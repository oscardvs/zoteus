import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isPrivateOrReservedIp } from '../../lib/cimd.js';
import type { ToolContext } from '../../registry/registry.js';
import { PinnedConnectionError, pinnedHttpsFetch } from './pinned-fetch.js';

/**
 * Downloading a file from a host that was named to a hosted Zoteus.
 *
 * This is egress that leaves the operator's box on someone else's say-so. The first case was
 * an open-access PDF at a URL a provider's lookup named; the second is the `url` argument of
 * zotero_attach_file and zotero_import when the caller is a tenant of a hosted deployment
 * rather than the person running the process. Either way the fetch is bounded rather than
 * trusting: https only, no hop into private address space, redirects followed by hand so
 * every hop is checked, and a hard byte cap enforced while streaming instead of after
 * buffering.
 *
 * What it deliberately does NOT do is decide whether the bytes are a PDF. That is
 * `detectKind` on the caller's side, on the bytes themselves, right before the write.
 */

/**
 * Ceiling on an automatically fetched file. Generous next to a normal article (single-digit
 * MB) and well under what buffering one costs a small host. A legitimate file above this is
 * still attachable by hand through `path` on a local install, or through Zotero itself.
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

/**
 * A refusal with a sentence already written for the caller to pass straight through.
 *
 * `status` is set only when the refusal is an HTTP answer (a 404, a 500), for callers that
 * report statuses separately from every other reason a download did not happen.
 */
export class OaFetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OaFetchError';
  }
}

/**
 * The sentences a bounded download speaks in. The mechanics are the same whether the URL
 * came from an open-access lookup or from a tenant's `url` argument, but the sentences are
 * not: "the open-access link" is the wrong subject for a link the caller typed, and "attach
 * it with `path`" is the wrong remedy on a deployment where `path` cannot reach the caller's
 * disk. Each builder gets what its sentence needs and nothing else.
 */
export interface EgressWording {
  notUrl(raw: string): string;
  notHttps(raw: string, scheme: string): string;
  credentials(raw: string): string;
  privateAddress(raw: string, host: string): string;
  unresolvable(raw: string, host: string): string;
  resolvesPrivate(raw: string, host: string): string;
  /** `tried` is already a phrase: "its one address was" / "all 6 of its addresses were". */
  unreachable(url: string, host: string, code: string, tried: string): string;
  noLocation(url: string, status: number): string;
  httpStatus(url: string, status: number): string;
  tooManyRedirects(url: string, max: number): string;
  outOfTime(url: string, seconds: number): string;
  tooLarge(url: string, megabytes: number): string;
  tooSlow(url: string, seconds: number): string;
  wentQuiet(url: string, seconds: number): string;
}

/** The sentences for a link an open-access lookup named. */
export const OA_WORDING: EgressWording = {
  notUrl: (raw) =>
    `The open-access link is not a usable URL (${raw}), so nothing was downloaded; open it yourself and attach the file with \`path\`.`,
  notHttps: (raw, scheme) =>
    `The open-access copy is served over ${scheme} rather than https (${raw}), and Zoteus only fetches over https, so nothing was downloaded; open the link yourself and attach the file with \`path\`.`,
  credentials: () => 'Open-access links with URL credentials are not fetched.',
  privateAddress: (_raw, host) =>
    `The open-access link points at a non-public address (${host}), so nothing was downloaded; that is not a repository, and the item's link needs checking.`,
  unresolvable: (_raw, host) =>
    `The host of the open-access link (${host}) could not be resolved, so nothing was downloaded; retry shortly, or open the link yourself and attach the file with \`path\`.`,
  resolvesPrivate: (_raw, host) =>
    `The host of the open-access link (${host}) resolves to a non-public address, so nothing was downloaded; that is not a repository, and the item's link needs checking.`,
  unreachable: (url, host, code, tried) =>
    `The host of the open-access link (${host}) could not be connected to (${code}, ${tried} tried), so nothing was downloaded; retry shortly, or open ${url} yourself and attach the file with \`path\`.`,
  noLocation: (url, status) =>
    `${url} answered ${status} with no destination, so nothing was downloaded; open the link yourself and attach the file with \`path\`.`,
  httpStatus: (url, status) =>
    `The open-access copy at ${url} answered HTTP ${status}, so nothing was attached; the link may have moved, so open it yourself and attach the file with \`path\`.`,
  tooManyRedirects: (url, max) =>
    `The open-access link redirected more than ${max} times without arriving at a file, so nothing was downloaded; open ${url} yourself and attach the file with \`path\`.`,
  outOfTime: (url, seconds) =>
    `Downloading the open-access copy of ${url} took longer than the ${seconds} s Zoteus allows for one automatic download, so nothing was attached; download it yourself and attach it with \`path\`.`,
  tooLarge: (url, megabytes) =>
    `The open-access copy at ${url} is larger than the ${megabytes} MB Zoteus downloads automatically, so nothing was attached; download it yourself and attach it with \`path\`.`,
  tooSlow: (url, seconds) =>
    `The open-access copy at ${url} was still arriving after the ${seconds} s Zoteus allows for one automatic download, so nothing was attached; download it yourself and attach it with \`path\`.`,
  wentQuiet: (url, seconds) =>
    `The open-access copy at ${url} stopped arriving: ${seconds} s passed with no further bytes, so nothing was attached; retry shortly, or download it yourself and attach it with \`path\`.`,
};

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
 * deployment. Return every vetted address, in lookup order, so the HTTPS connection uses
 * exactly those addresses and can move to the next one when the first does not answer.
 */
export async function assertPublicHttps(raw: string, wording: EgressWording = OA_WORDING): Promise<string[]> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new OaFetchError(wording.notUrl(raw));
  }
  if (u.protocol !== 'https:') {
    throw new OaFetchError(wording.notHttps(raw, u.protocol.replace(/:$/, '')));
  }
  if (u.username || u.password) throw new OaFetchError(wording.credentials(raw));
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) throw new OaFetchError(wording.privateAddress(raw, host));
    return [host];
  }
  let addrs: string[];
  try {
    addrs = await hostLookup(host);
  } catch {
    throw new OaFetchError(wording.unresolvable(raw, host));
  }
  if (addrs.length === 0 || addrs.some((address) => !net.isIP(address) || isPrivateOrReservedIp(address))) {
    throw new OaFetchError(wording.resolvesPrivate(raw, host));
  }
  return addrs;
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
export async function readCapped(
  res: Response,
  url: string,
  maxBytes: number,
  budget: { deadlineAt: number; totalMs: number; idleMs: number },
  wording: EgressWording = OA_WORDING,
): Promise<Uint8Array> {
  const { deadlineAt, totalMs, idleMs } = budget;
  const tooLarge = () => new OaFetchError(wording.tooLarge(url, Math.round(maxBytes / (1024 * 1024))));
  const tooSlow = () => new OaFetchError(wording.tooSlow(url, seconds(totalMs)));
  const wentQuiet = () => new OaFetchError(wording.wentQuiet(url, seconds(idleMs)));
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

export interface EgressOptions {
  maxBytes?: number;
  deadlineMs?: number;
  idleMs?: number;
  /** Which sentences the refusals speak in; the open-access ones unless told otherwise. */
  wording?: EgressWording;
}

/**
 * Fetch the bytes at a public https URL, or throw an `OaFetchError` whose message is
 * already the sentence to show. Redirects are followed by hand (`redirect: 'manual'`) so the
 * host guard runs on every hop rather than only on the one that was named, and every hop
 * connects to the addresses the guard vetted and to nothing else.
 */
export async function fetchPublicHttps(
  ctx: Pick<ToolContext, 'fetcher'>,
  url: string,
  opts: EgressOptions = {},
): Promise<OaFetchResult> {
  const wording = opts.wording ?? OA_WORDING;
  const maxBytes = opts.maxBytes ?? MAX_OA_PDF_BYTES;
  const totalMs = opts.deadlineMs ?? OA_DEADLINE_MS;
  const idleMs = opts.idleMs ?? OA_IDLE_MS;
  // One clock for the whole call, started before the first hop. Handing each hop its own
  // full budget would make the real ceiling six times what is promised here, and would leave
  // the body read outside any budget at all.
  const deadlineAt = Date.now() + totalMs;
  const outOfTime = () => new OaFetchError(wording.outOfTime(url, seconds(totalMs)));
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const addresses = await within(assertPublicHttps(current, wording), deadlineAt - Date.now(), outOfTime);
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw outOfTime();
    let res: Response;
    try {
      res = await ctx.fetcher.fetch(
        current,
        { method: 'GET', redirect: 'manual', headers: { accept: 'application/pdf,*/*' } },
        { maxRetries: 2, deadlineMs: remaining, fetchImpl: pinnedHttpsFetch(addresses) },
      );
    } catch (e) {
      // Every vetted address was tried and none took the connection. A bare ENETUNREACH or
      // CERT_HAS_EXPIRED is not the sentence this tool promises, so it becomes one here,
      // with the host and the code kept so the reader knows what to look at.
      if (e instanceof PinnedConnectionError) {
        const tried = e.tried === 1 ? 'its one address was' : `all ${e.tried} of its addresses were`;
        throw new OaFetchError(wording.unreachable(current, e.host, e.code, tried));
      }
      throw e;
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!location) throw new OaFetchError(wording.noLocation(current, res.status), res.status);
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new OaFetchError(wording.httpStatus(current, res.status), res.status);
    }
    return {
      bytes: await readCapped(res, current, maxBytes, { deadlineAt, totalMs, idleMs }, wording),
      servedType: res.headers.get('content-type')?.split(';')[0]?.trim() || undefined,
      url: current,
    };
  }
  throw new OaFetchError(wording.tooManyRedirects(url, MAX_REDIRECTS));
}

/**
 * Fetch the bytes at an open-access PDF URL, or throw an `OaFetchError` whose message is
 * already the sentence to show: {@link fetchPublicHttps} in the open-access voice.
 */
export function fetchOaPdf(
  ctx: Pick<ToolContext, 'fetcher'>,
  url: string,
  opts: Omit<EgressOptions, 'wording'> = {},
): Promise<OaFetchResult> {
  return fetchPublicHttps(ctx, url, { ...opts, wording: OA_WORDING });
}
