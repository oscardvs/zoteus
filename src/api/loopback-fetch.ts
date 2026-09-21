import { Agent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import type { FetchLike } from './http.js';

/**
 * The transport for the Zotero desktop app: plain HTTP on loopback over node:http, not
 * over the undici behind the global fetch.
 *
 * Why not fetch. The desktop app's server answers and then closes the connection; it never
 * keeps one alive. undici's HTTP/1 parser pauses under body backpressure until the consumer
 * reads, and when the FIN arrives while it is paused, `onHttpSocketEnd` calls
 * `parser.finish()`, whose `assert(!this.paused)` throws from a socket event handler. That
 * is not the fetch() promise rejecting: no caller can catch it, and the process exits. The
 * FIN is handled on a nextTick that runs before the microtask continuing after
 * `await fetch()`, so reading the body promptly does not avoid it either. On Node 24.20.0,
 * which bundles undici 7.29.0, this killed Zoteus at boot, during the capability probe
 * (#85, nodejs/undici#5360). Node 24.21.0 bundles undici 7.29.1 and does not, but the
 * desktop app is the one peer every local install speaks to at every start, and a transport
 * whose failure mode is "the process is gone" is the wrong one for it. node:http's client
 * has handled a peer that closes after its response for as long as Node has existed, and a
 * paused socket there is just a paused socket: nothing in it throws from an event handler.
 *
 * Scope. Only the clients that speak to the desktop app go through here: the local API
 * reads and their liveness probe, the local-API and connector writes, Better BibTeX. The
 * cloud Web API, OpenAlex, Crossref and the open-access download keep the platform fetch,
 * whose pool and TLS they want and whose peers keep connections alive.
 *
 * Contract. The subset of fetch those clients use, and no more:
 *  - method; headers as a `Headers`, a record or an array of pairs; a body that is a string,
 *    a `Uint8Array`/`Buffer`, an `ArrayBuffer` or a `URLSearchParams` (anything else is
 *    refused with a TypeError that names it, rather than sent as something it is not);
 *  - `signal`: an aborted signal rejects, before the request or during the response, and
 *    the response body errors out if the abort comes while it is being read;
 *  - a standard `Response` whose body is streamed, so `.json()`, `.text()`,
 *    `.arrayBuffer()` and `body.cancel()` all work, and a cancelled body destroys the
 *    socket; null body for 204, 205, 304 and HEAD; headers copied as they came, repeated
 *    ones included;
 *  - NO redirect following: `downloadFileBytes` relies on seeing the 302 whose Location is
 *    a `file://` URL, and the local API is not expected to redirect anywhere else;
 *  - a connection failure rejects with `TypeError('fetch failed')` carrying the original
 *    error as `cause`, the shape undici gives it, so a message matcher and a code walker
 *    (`connectFailureCode` in embeddings.ts) both keep working;
 *  - `Connection: close` on every request, and a URL that is not `http:` is not the desktop
 *    app and goes to the platform fetch untouched.
 *
 * The test seam. Twelve suites simulate the desktop app by replacing `globalThis.fetch`
 * before the server is built. This module captures the platform fetch when it loads and, at
 * call time, when `globalThis.fetch` is no longer that function, hands the call to the
 * current one instead of node:http. Whoever replaced the global fetch did so to see or shape
 * the traffic this process makes, and a loopback client that went around them would be
 * lying to them; that is as true of an interceptor in production as of a test double. The
 * suites that hand a `fetchImpl` to a RateLimitedFetcher never reach this module at all.
 */

/**
 * The fetch this process started with, compared by identity on every call. See the module
 * comment for what a different function there means.
 */
const platformFetch = globalThis.fetch as FetchLike;

/**
 * No keep-alive: the desktop app closes the connection after every response, and a pool
 * that tried to reuse one would only ever find it gone. Node's global agent has kept
 * connections alive by default since Node 19, so it cannot be used as it is.
 */
const agent = new Agent({ keepAlive: false });

export const loopbackFetch: FetchLike = async (url, init) => {
  const current = globalThis.fetch as FetchLike | undefined;
  if (typeof current === 'function' && current !== platformFetch) return current(url, init);
  return overNodeHttp(url, init ?? {});
};

async function overNodeHttp(url: string, init: RequestInit): Promise<Response> {
  const target = new URL(url);
  if (target.protocol !== 'http:') return platformFetch(url, init);
  const signal = init.signal ?? undefined;
  if (signal?.aborted) throw abortReason(signal);
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  const body = encodeBody(init.body, headers);
  headers.set('connection', 'close');
  if (body !== undefined) headers.set('content-length', String(body.byteLength));
  const outgoing: Record<string, string> = {};
  headers.forEach((value, name) => {
    outgoing[name] = value;
  });

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let incoming: IncomingMessage | undefined;
    const req = httpRequest(target, { method, agent, headers: outgoing }, (res) => {
      incoming = res;
      // A destroyed response emits 'error'. Once its body is a web stream that error reaches
      // the reader through `finished`; before that, and on the bodiless path, nobody else is
      // listening, and an unheard 'error' thrown from an event handler is the very thing
      // this module exists to keep out of the process.
      res.on('error', () => {});
      try {
        const response = toResponse(res, method);
        settled = true;
        resolve(response);
      } catch (e) {
        res.destroy();
        settled = true;
        reject(new TypeError('fetch failed', { cause: e }));
      }
    });
    const onAbort = () => {
      const reason = abortReason(signal!);
      incoming?.destroy(reason as Error);
      req.destroy(reason as Error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    req.once('close', () => signal?.removeEventListener('abort', onAbort));
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(signal?.aborted ? abortReason(signal) : new TypeError('fetch failed', { cause: err }));
    });
    req.end(body);
  });
}

function toResponse(res: IncomingMessage, method: string): Response {
  const status = res.statusCode ?? 0;
  const headers = new Headers();
  const raw = res.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i];
    const value = raw[i + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  const init = { status, statusText: res.statusMessage ?? '', headers };
  if (method === 'HEAD' || status === 204 || status === 205 || status === 304) {
    // `new Response` refuses a body here, and there is none to read; drain what the parser
    // may still hold so the socket can close.
    res.resume();
    return new Response(null, init);
  }
  return new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, init);
}

function encodeBody(body: RequestInit['body'], headers: Headers): Buffer | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') {
    if (!headers.has('content-type')) headers.set('content-type', 'text/plain;charset=UTF-8');
    return Buffer.from(body, 'utf8');
  }
  if (body instanceof URLSearchParams) {
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
    }
    return Buffer.from(body.toString(), 'utf8');
  }
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const kind = (body as { constructor?: { name?: string } }).constructor?.name ?? typeof body;
  throw new TypeError(
    `loopback fetch: a ${kind} request body is not supported; the desktop clients send a string, ` +
      'a URLSearchParams, a Uint8Array, a Buffer or an ArrayBuffer',
  );
}

/** What an aborted signal rejects with: its own reason, as fetch does, or an AbortError. */
function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const err = new Error('This operation was aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * The bundled undici builds known to carry the parser assertion, by the string Node reports
 * in `process.versions.undici`. Exactly one entry, because this is a list of what was
 * verified, not a guess at a range: 7.29.0 is what Node 24.19.0 and 24.20.0 ship
 * (deps/undici/src/package.json at those tags), and Node 24.20.0 is the combination the
 * crash was reported and reproduced on (#85). Node 24.21.0 moved to 7.29.1
 * (nodejs/node#65789) and the same install boots cleanly on it. Upstream
 * (nodejs/undici#5360) also names 8.3.0, but no Node release bundling it was checked, and a
 * user on such a Node would be told to "upgrade" to an older one, so it is not listed.
 */
const UNDICI_WITH_PARSER_ASSERTION: ReadonlySet<string> = new Set(['7.29.0']);

/**
 * One line for the startup log when this process's own fetch is a build that can take it
 * down, so an operator reading the log knows what is routed around it here and what is not,
 * and which Node to move to. Undefined on every other build.
 */
export function undiciParserAssertionAdvisory(
  versions: { node?: string; undici?: string } = process.versions,
): string | undefined {
  const { undici, node } = versions;
  if (!undici || !UNDICI_WITH_PARSER_ASSERTION.has(undici)) return undefined;
  return (
    `Node ${node ?? '(unknown)'} bundles undici ${undici}, whose HTTP parser can end this process with an ` +
    'uncatchable assertion when a server closes the connection while a response body is still unread ' +
    '(nodejs/undici#5360). Traffic to the Zotero desktop app is routed around it here, over node:http; ' +
    'requests to other hosts (api.zotero.org, OpenAlex, Crossref, open-access downloads) are not. ' +
    'Upgrade to Node 24.21.0 or newer, which bundles undici 7.29.1 and does not have it.'
  );
}
