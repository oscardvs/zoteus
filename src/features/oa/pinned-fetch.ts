import { request } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { checkServerIdentity } from 'node:tls';
import { isIP } from 'node:net';
import type { FetchLike } from '../../api/http.js';
import { isPrivateOrReservedIp } from '../../lib/cimd.js';

/**
 * The response body as a web stream whose controller is never touched after the consumer
 * has let go of it.
 *
 * `Readable.toWeb` is not usable here. Its first `pull()` calls `res.resume()`, which
 * schedules the drain of whatever the socket has already buffered on process.nextTick. A
 * consumer that cancels the body from a promise continuation (every non-2xx path in
 * `fetchOaPdf` does, and so does the content-length check in `readCapped`) closes the
 * controller and destroys `res`, but destroy does not empty the readable buffer, and the
 * pending tick then pushes it through 'data' into `controller.enqueue()` on a closed
 * controller. That throws inside an event emitter, so nothing catches it and it takes the
 * process down. The `open` flag is the whole fix: once the stream is closed, cancelled or
 * errored, whatever `res` still emits is dropped.
 */
function bodyStream(res: IncomingMessage): ReadableStream<Uint8Array> {
  let open = true;
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        res.on('data', (chunk: Buffer) => {
          if (!open) return;
          controller.enqueue(new Uint8Array(chunk));
          if ((controller.desiredSize ?? 0) <= 0) res.pause();
        });
        res.once('end', () => {
          if (!open) return;
          open = false;
          controller.close();
        });
        res.once('error', (e) => {
          if (!open) return;
          open = false;
          controller.error(e);
        });
        // A socket that goes away mid-body normally errors first; this is the fallback for
        // the case where it only closes, so the reader is not left waiting on a dead socket.
        res.once('close', () => {
          if (!open) return;
          open = false;
          controller.error(new Error('The connection closed before the response body ended.'));
        });
        // Attaching the 'data' listener switched `res` to flowing; hold it until the consumer
        // asks, so backpressure applies from the first chunk rather than after the first burst.
        res.pause();
      },
      pull() {
        res.resume();
      },
      cancel() {
        open = false;
        res.destroy();
      },
    },
    { highWaterMark: res.readableHighWaterMark, size: (chunk) => chunk.byteLength },
  );
}

/** The `code` a socket or TLS error carries (ECONNREFUSED, CERT_HAS_EXPIRED, ...), or its name. */
function errorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code) return code;
  return e instanceof Error && e.name ? e.name : 'unknown error';
}

/**
 * No address of the host took the connection. Raised only after every vetted address has
 * been tried, and carries what the caller's sentence needs: the host, how many addresses
 * were tried, and the code of the last failure. The raw socket error is kept as `cause`.
 */
export class PinnedConnectionError extends Error {
  constructor(
    readonly host: string,
    readonly tried: number,
    readonly code: string,
    cause: unknown,
  ) {
    super(`Could not connect to ${host} (${code}) after trying ${tried} address${tried === 1 ? '' : 'es'}.`, { cause });
    this.name = 'PinnedConnectionError';
  }
}

/**
 * Connect directly to a vetted address while authenticating the original HTTPS host.
 * There is no second DNS lookup for an attacker to rebind. A fresh connection for every
 * request also prevents connection reuse from bypassing a redirect's address validation.
 *
 * Every address is one the host guard already validated, so they are tried in order: a
 * dual-stack host whose lookup lists an AAAA first on a v4-only deployment, or one dead A
 * record among several, is a reason to move to the next address, not to fail. Only an
 * error before any response counts; once headers are in hand the response is the answer.
 * When none of them connect, the rejection is a {@link PinnedConnectionError} rather than
 * whatever the last socket said, so the caller can turn it into a sentence.
 */
export function pinnedHttpsFetch(addresses: readonly string[]): FetchLike {
  if (addresses.length === 0) {
    throw new Error('A pinned HTTPS download requires at least one public IP address.');
  }
  for (const address of addresses) {
    if (!isIP(address) || isPrivateOrReservedIp(address)) {
      throw new Error('A pinned HTTPS download requires public IP addresses only.');
    }
  }
  return async (raw, init) => {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new Error('A pinned download requires HTTPS without URL credentials.');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    // Native HTTPS does not transparently decompress like fetch. Request identity so the
    // capped stream is the PDF itself, and never buffer an unbounded compressed response.
    headers['accept-encoding'] = 'identity';
    headers.host = url.host;

    const connect = (address: string) =>
      new Promise<Response>((resolve, reject) => {
        const req = request({
          protocol: 'https:',
          hostname: address,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: 'GET',
          headers,
          agent: false,
          servername: isIP(host) ? '' : host,
          rejectUnauthorized: true,
          checkServerIdentity: (_name, cert) => checkServerIdentity(host, cert),
          signal: init?.signal ?? undefined,
        }, (res) => {
          const responseHeaders = new Headers();
          for (let i = 0; i < res.rawHeaders.length; i += 2) {
            responseHeaders.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
          }
          const status = res.statusCode ?? 502;
          // 204 and 205 may not carry a body at all, and a redirect's body is never read: this
          // transport only serves `redirect: 'manual'` callers, which take the Location header
          // and move on. Draining here means no stream is ever created for it, so there is
          // nothing to cancel and nothing to enqueue into.
          const noBody = status === 204 || status === 205 || (status >= 300 && status < 400);
          if (noBody) res.resume();
          resolve(new Response(noBody ? null : bodyStream(res), {
            status,
            headers: responseHeaders,
          }));
        });
        // Before the response this is the connection failing; after it, the promise is
        // already settled and the body stream reports the socket's fate on its own.
        req.on('error', reject);
        req.end();
      });

    let last: unknown;
    for (const address of addresses) {
      try {
        return await connect(address);
      } catch (e) {
        // The caller's clock ran out: that is its error to report, not a reason to try on.
        if (init?.signal?.aborted) throw e;
        last = e;
      }
    }
    throw new PinnedConnectionError(host, addresses.length, errorCode(last), last);
  };
}
