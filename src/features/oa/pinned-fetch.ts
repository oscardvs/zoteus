import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import type { FetchLike } from '../../api/http.js';
import { isPrivateOrReservedIp } from '../../lib/cimd.js';

/**
 * Connect directly to the vetted address while authenticating the original HTTPS host.
 * There is no second DNS lookup for an attacker to rebind. A fresh connection for every
 * request also prevents connection reuse from bypassing a redirect's address validation.
 */
export function pinnedHttpsFetch(address: string): FetchLike {
  if (!isIP(address) || isPrivateOrReservedIp(address)) {
    throw new Error('A pinned HTTPS download requires a public IP address.');
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
    return new Promise<Response>((resolve, reject) => {
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
        const noBody = status === 204 || status === 205 || status === 304;
        if (noBody) res.resume();
        resolve(new Response(noBody ? null : Readable.toWeb(res) as ReadableStream<Uint8Array>, {
          status,
          headers: responseHeaders,
        }));
      });
      req.on('error', reject);
      req.end();
    });
  };
}
