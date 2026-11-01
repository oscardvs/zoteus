import { describe, it, expect, vi } from 'vitest';
import {
  isClientIdMetadataUrl,
  isPrivateOrReservedIp,
  fetchClientMetadata,
  InMemoryCimdCache,
} from '../../src/lib/cimd.js';

// Public-IP stub so the SSRF host check passes for reserved-TLD test hosts without real DNS.
const PUBLIC_LOOKUP = async () => ['93.184.216.34'];
const OPTS = { maxBytes: 16384, allowedRedirectSchemes: ['https'], lookupImpl: PUBLIC_LOOKUP };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('isClientIdMetadataUrl', () => {
  it('accepts https URLs, rejects opaque ids and non-https', () => {
    expect(isClientIdMetadataUrl('https://app.example/cimd.json')).toBe(true);
    expect(isClientIdMetadataUrl('http://app.example/cimd.json')).toBe(false);
    expect(isClientIdMetadataUrl('a1b2c3-uuid')).toBe(false);
    expect(isClientIdMetadataUrl('not a url')).toBe(false);
  });
});

describe('isPrivateOrReservedIp', () => {
  it('flags loopback / private / link-local / reserved', () => {
    for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1']) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
  });
  it('passes public addresses', () => {
    for (const ip of ['8.8.8.8', '93.184.216.34', '1.1.1.1', '2606:4700::1111']) {
      expect(isPrivateOrReservedIp(ip)).toBe(false);
    }
  });
});

describe('fetchClientMetadata', () => {
  it('accepts a valid doc whose client_id equals the URL', async () => {
    const url = 'https://app.example/cimd.json';
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ client_id: url, redirect_uris: ['https://app.example/cb'], token_endpoint_auth_method: 'none' }),
    ) as unknown as typeof fetch;
    const client = await fetchClientMetadata(url, { ...OPTS, fetchImpl });
    expect(client.client_id).toBe(url);
    expect(client.redirect_uris).toEqual(['https://app.example/cb']);
  });

  it('rejects a non-https URL', async () => {
    await expect(fetchClientMetadata('http://app.example/cimd.json', OPTS)).rejects.toThrow(/https/i);
  });

  it('rejects when client_id does not equal the document URL', async () => {
    const url = 'https://app.example/cimd.json';
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ client_id: 'https://evil.example/x', redirect_uris: ['https://app.example/cb'] }),
    ) as unknown as typeof fetch;
    await expect(fetchClientMetadata(url, { ...OPTS, fetchImpl })).rejects.toThrow(/client_id/i);
  });

  it('rejects an oversized document (streamed, before fully buffering)', async () => {
    const url = 'https://app.example/cimd.json';
    const big = 'x'.repeat(64);
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ client_id: url, redirect_uris: [`https://app.example/${big}`], padding: big.repeat(1000) }),
    ) as unknown as typeof fetch;
    await expect(
      fetchClientMetadata(url, { maxBytes: 256, allowedRedirectSchemes: ['https'], lookupImpl: PUBLIC_LOOKUP, fetchImpl }),
    ).rejects.toThrow(/too large/i);
  });

  it('rejects an oversized document by Content-Length without reading the body', async () => {
    const url = 'https://app.example/cimd.json';
    const readBody = vi.fn();
    const res = {
      ok: true,
      headers: new Headers({ 'content-length': String(1024 * 1024) }),
      body: { getReader: readBody },
      text: readBody,
    } as unknown as Response;
    const fetchImpl = vi.fn(async () => res) as unknown as typeof fetch;
    await expect(
      fetchClientMetadata(url, { maxBytes: 256, allowedRedirectSchemes: ['https'], lookupImpl: PUBLIC_LOOKUP, fetchImpl }),
    ).rejects.toThrow(/too large/i);
    expect(readBody).not.toHaveBeenCalled();
  });

  it('rejects a redirect_uri with a disallowed scheme', async () => {
    const url = 'https://app.example/cimd.json';
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ client_id: url, redirect_uris: ['http://app.example/cb'] }),
    ) as unknown as typeof fetch;
    await expect(fetchClientMetadata(url, { ...OPTS, fetchImpl })).rejects.toThrow(/redirect/i);
  });

  it('accepts loopback http redirects under an https-only scheme list (Claude Code)', async () => {
    const url = 'https://claude.ai/oauth/claude-code-client-metadata';
    const doc = {
      client_id: url,
      client_name: 'Claude Code',
      redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback', 'http://[::1]/callback'],
      token_endpoint_auth_method: 'none',
    };
    const fetchImpl = vi.fn(async () => jsonResponse(doc)) as unknown as typeof fetch;
    const client = await fetchClientMetadata(url, { ...OPTS, fetchImpl });
    expect(client.redirect_uris).toEqual(doc.redirect_uris);
    expect(client.token_endpoint_auth_method).toBe('none');
  });

  it('still rejects http to a loopback look-alike or any other host', async () => {
    const url = 'https://app.example/cimd.json';
    for (const redirect of ['http://localhost.evil.example/cb', 'http://127.0.0.1.nip.io/cb', 'http://10.0.0.1/cb']) {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ client_id: url, redirect_uris: ['https://app.example/cb', redirect] }),
      ) as unknown as typeof fetch;
      await expect(fetchClientMetadata(url, { ...OPTS, fetchImpl })).rejects.toThrow(/scheme not allowed/);
    }
  });

  it('rejects a malformed (non-JSON) body', async () => {
    const url = 'https://app.example/cimd.json';
    const fetchImpl = vi.fn(async () => new Response('<<not json>>', { status: 200 })) as unknown as typeof fetch;
    await expect(fetchClientMetadata(url, { ...OPTS, fetchImpl })).rejects.toThrow();
  });

  it('does not copy a remote-declared client_secret (whitelist only)', async () => {
    const url = 'https://app.example/cimd.json';
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        client_id: url,
        redirect_uris: ['https://app.example/cb'],
        client_secret: 'attacker-injected',
        client_secret_expires_at: 0,
        client_name: 'App',
      }),
    ) as unknown as typeof fetch;
    const client = await fetchClientMetadata(url, { ...OPTS, fetchImpl });
    expect((client as Record<string, unknown>).client_secret).toBeUndefined();
    expect((client as Record<string, unknown>).client_secret_expires_at).toBeUndefined();
    expect(client.client_name).toBe('App');
  });

  describe('SSRF guard', () => {
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;

    it('rejects a literal private/loopback/link-local IP host without fetching', async () => {
      for (const url of ['https://169.254.169.254/cimd', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://[::1]/x']) {
        await expect(fetchClientMetadata(url, { ...OPTS, fetchImpl })).rejects.toThrow(/public address/i);
      }
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('rejects a hostname that resolves to a private IP (DNS-rebinding defense)', async () => {
      await expect(
        fetchClientMetadata('https://internal.example/cimd', {
          maxBytes: 16384,
          allowedRedirectSchemes: ['https'],
          lookupImpl: async () => ['10.0.0.7'],
          fetchImpl,
        }),
      ).rejects.toThrow(/non-public address/i);
    });

    it('enforces an operator host allowlist', async () => {
      const url = 'https://claude.ai/.well-known/oauth-client';
      const ok = vi.fn(async () =>
        jsonResponse({ client_id: url, redirect_uris: ['https://claude.ai/cb'] }),
      ) as unknown as typeof fetch;
      // host not in allowlist → rejected
      await expect(
        fetchClientMetadata('https://evil.example/x', { ...OPTS, allowedHosts: ['claude.ai'], fetchImpl }),
      ).rejects.toThrow(/not allowed/i);
      // host in allowlist → resolved
      const client = await fetchClientMetadata(url, { ...OPTS, allowedHosts: ['claude.ai'], fetchImpl: ok });
      expect(client.client_id).toBe(url);
    });
  });
});

describe('InMemoryCimdCache', () => {
  it('caches within TTL and re-fetches after expiry', async () => {
    let calls = 0;
    const loader = async () => {
      calls++;
      return { client_id: 'https://app.example/cimd.json', redirect_uris: ['https://app.example/cb'] };
    };
    const cache = new InMemoryCimdCache(1000);
    const k = 'https://app.example/cimd.json';
    await cache.getOrLoad(k, loader);
    await cache.getOrLoad(k, loader);
    expect(calls).toBe(1);
    cache.now = () => Date.now() + 2000; // jump past TTL
    await cache.getOrLoad(k, loader);
    expect(calls).toBe(2);
  });
});
