// Client ID Metadata Document (CIMD) support: resolve a URL `client_id` to a registered
// client by fetching + validating a metadata document, without Dynamic Client Registration.
// Used by directory-scale connectors (one shared app) instead of per-connection DCR.
//
// SECURITY: the client_id is an attacker-influenced URL fetched server-side, reached
// unauthenticated via the SDK's /authorize handler (Phase 1, before consent). To prevent
// SSRF we (a) allow only https, (b) optionally restrict to an operator host allowlist,
// (c) reject hosts that are — or resolve to — private/loopback/link-local/reserved IPs,
// (d) refuse redirects, and (e) cap the response size while streaming (not after buffering).
// Residual: without an allowlist, a hostname could rebind between our DNS check and the
// fetch (TOCTOU). Operators serving a directory connector should set an allowlist.
import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export interface CimdFetchOptions {
  maxBytes: number;
  allowedRedirectSchemes: string[];
  /** Operator host allowlist (exact host or `.suffix` match). Empty = any public host. */
  allowedHosts?: string[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Resolve a hostname to its IP addresses. Injectable for tests; defaults to DNS. */
  lookupImpl?: (hostname: string) => Promise<string[]>;
}

/** A client_id is a CIMD reference iff it is a well-formed https URL. */
export function isClientIdMetadataUrl(clientId: string): boolean {
  let u: URL;
  try {
    u = new URL(clientId);
  } catch {
    return false;
  }
  return u.protocol === 'https:';
}

const LOOPBACK_REDIRECT_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A native client's loopback redirect (RFC 8252 sections 7.3 and 8.3): plain http to the
 * machine the browser runs on, on a port the client picks per session. Claude Code's own
 * metadata document declares exactly `http://localhost/callback` and
 * `http://127.0.0.1/callback`, so an https-only scheme list would refuse it outright. The
 * SDK's /authorize handler then matches these without the port. Accepted whatever
 * `allowedRedirectSchemes` says, because no remote host is ever involved.
 */
function isLoopbackHttp(u: URL): boolean {
  return u.protocol === 'http:' && LOOPBACK_REDIRECT_HOSTS.has(u.hostname.toLowerCase());
}

/** True for loopback / private / link-local / CGNAT / multicast / reserved / malformed addresses. */
export function isPrivateOrReservedIp(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const a = parts[0]!;
    const b = parts[1]!;
    if (a === 0 || a === 10 || a === 127) return true; // "this" / private / loopback
    if (a === 169 && b === 254) return true; // link-local + cloud IMDS (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (fam === 6) {
    const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (lower === '::1' || lower === '::') return true; // loopback / unspecified
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique-local fc00::/7
    if (/^fe[89ab]/.test(lower)) return true; // link-local fe80::/10
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // IPv4-mapped
    if (mapped) return isPrivateOrReservedIp(mapped[1]!);
    return false;
  }
  return true; // not a valid IP literal → reject defensively
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const res = await dnsLookup(hostname, { all: true });
  return res.map((r) => r.address);
}

/** Reject the target host unless it passes the allowlist and resolves only to public addresses. */
async function assertHostAllowed(u: URL, opts: CimdFetchOptions): Promise<void> {
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  const allow = (opts.allowedHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (allow.length > 0) {
    const ok = allow.some((h) => host === h || host.endsWith(`.${h}`));
    if (!ok) throw new Error(`CIMD client_id host not allowed: ${host}`);
  }
  if (net.isIP(host)) {
    if (isPrivateOrReservedIp(host)) throw new Error('CIMD client_id host is not a public address');
    return;
  }
  const lookup = opts.lookupImpl ?? defaultLookup;
  const addrs = await lookup(host);
  if (addrs.length === 0 || addrs.some(isPrivateOrReservedIp)) {
    throw new Error('CIMD client_id host resolves to a non-public address');
  }
}

/** Read the response body as text, enforcing the byte cap *while streaming* (never buffers more). */
async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('CIMD document too large');
  }
  const body = res.body;
  if (!body) {
    const t = await res.text();
    if (Buffer.byteLength(t, 'utf8') > maxBytes) throw new Error('CIMD document too large');
    return t;
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('CIMD document too large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Fetch and validate a client-metadata document. Enforces: https-only URL, host allowlist /
 * private-IP rejection (SSRF guard), no redirects, a streamed byte cap, JSON parse,
 * `client_id` === the document URL, and allowed redirect_uri schemes. Returns a client record
 * built from a whitelist of fields (never trusts a remote `client_secret`).
 */
export async function fetchClientMetadata(
  clientId: string,
  opts: CimdFetchOptions,
): Promise<OAuthClientInformationFull> {
  if (!isClientIdMetadataUrl(clientId)) {
    throw new Error('CIMD client_id must be an https URL');
  }
  const url = new URL(clientId);
  await assertHostAllowed(url, opts);

  const doFetch = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5000);
  let text: string;
  try {
    const res = await doFetch(clientId, {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`CIMD fetch failed: status ${res.status}`);
    text = await readCappedText(res, opts.maxBytes);
  } finally {
    clearTimeout(t);
  }
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('CIMD document is not valid JSON');
  }
  if (doc.client_id !== clientId) {
    throw new Error('CIMD client_id must equal the document URL');
  }
  const redirectUris = Array.isArray(doc.redirect_uris) ? (doc.redirect_uris as unknown[]) : [];
  if (redirectUris.length === 0) {
    throw new Error('CIMD document has no redirect_uris');
  }
  for (const r of redirectUris) {
    let redirect: URL;
    try {
      redirect = new URL(String(r));
    } catch {
      throw new Error('CIMD redirect_uri is not a valid URL');
    }
    const scheme = redirect.protocol.replace(/:$/, '');
    if (!opts.allowedRedirectSchemes.includes(scheme) && !isLoopbackHttp(redirect)) {
      throw new Error(`CIMD redirect_uri scheme not allowed: ${scheme}`);
    }
  }
  // Build from a whitelist — never copy a remote-declared client_secret (would flip a public
  // client into a confidential one and break token exchange / honor unintended fields).
  const client: OAuthClientInformationFull = {
    client_id: clientId,
    redirect_uris: redirectUris.map(String),
    token_endpoint_auth_method:
      typeof doc.token_endpoint_auth_method === 'string' ? doc.token_endpoint_auth_method : 'none',
  };
  if (typeof doc.client_name === 'string') client.client_name = doc.client_name;
  if (typeof doc.client_uri === 'string') client.client_uri = doc.client_uri;
  if (typeof doc.scope === 'string') client.scope = doc.scope;
  if (Array.isArray(doc.grant_types)) client.grant_types = (doc.grant_types as unknown[]).map(String);
  if (Array.isArray(doc.response_types)) client.response_types = (doc.response_types as unknown[]).map(String);
  return client;
}

/** TTL cache for resolved CIMD clients (keyed by the URL client_id). */
export class InMemoryCimdCache {
  private readonly entries = new Map<string, { at: number; value: OAuthClientInformationFull }>();
  /** Overridable clock (tests). */
  now: () => number = () => Date.now();
  constructor(private readonly ttlMs: number) {}

  async getOrLoad(
    key: string,
    loader: () => Promise<OAuthClientInformationFull>,
  ): Promise<OAuthClientInformationFull> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    const value = await loader();
    this.entries.set(key, { at: this.now(), value });
    return value;
  }
}
