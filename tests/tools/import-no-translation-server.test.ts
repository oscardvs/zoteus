import { describe, it, expect, vi } from 'vitest';
import importTool from '../../src/tools/import.js';

/**
 * zotero_import with no translation-server, which is every hosted deployment and most local
 * installs.
 *
 * The 2026-10-01 stress test sent a valid ISBN-13 to the hosted server and got "Could not
 * parse as a known identifier": the parser accepted only bare digits, so the hyphenated
 * form fell through to the message for unrecognisable input, and that message listed ISBN
 * among the identifiers it takes. The real cause, that ISBNs need a translation-server and
 * this server has none, was never said. These cases pin the honest answer for every kind
 * of identifier the built-in path cannot resolve, on both deployments, since a hosted caller
 * cannot act on "docker run".
 */
function makeCtx(
  opts: { remote?: boolean; up?: boolean; search?: (id: string) => Promise<any[]> } = {},
): any {
  return {
    config: { translationServerUrl: 'http://127.0.0.1:1969' },
    remoteCaller: opts.remote ?? false,
    translation: {
      isUp: vi.fn(async () => opts.up ?? false),
      search: vi.fn(opts.search ?? (async () => [])),
      web: vi.fn(async () => ({ items: [] })),
    },
    scholar: { lookup: vi.fn(async () => null) },
    fetcher: { fetch: vi.fn(async () => new Response('', { status: 404 })) },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

const text = (res: any): string => res.content[0]!.text;

const UNRESOLVABLE: Array<{ identifier: string; recognisedAs: RegExp; plural: RegExp }> = [
  {
    identifier: '978-0-262-03384-8',
    recognisedAs: /is an ISBN \(read as 9780262033848\)/,
    plural: /resolving ISBNs/,
  },
  { identifier: '9780262033848', recognisedAs: /is an ISBN,/, plural: /resolving ISBNs/ },
  {
    identifier: 'ISBN 0-8044-2957-X',
    recognisedAs: /is an ISBN \(read as 080442957X\)/,
    plural: /resolving ISBNs/,
  },
  {
    identifier: 'PMID: 31452104',
    recognisedAs: /is a PubMed id \(PMID\) \(read as 31452104\)/,
    plural: /resolving PMIDs/,
  },
  {
    identifier: '2019ApJ...882L..24A',
    recognisedAs: /is an ADS bibcode,/,
    plural: /resolving ADS bibcodes/,
  },
];

describe('zotero_import by_identifier without a translation-server, on a local install', () => {
  for (const { identifier, recognisedAs, plural } of UNRESOLVABLE) {
    it(`names "${identifier}" for what it is, and the missing translation-server as the cause`, async () => {
      const ctx = makeCtx();
      const res: any = await importTool.handler({ action: 'by_identifier', identifier }, ctx);
      expect(res.isError).toBe(true);
      const msg = text(res);
      expect(msg).not.toMatch(/Could not parse|not an identifier Zoteus recognises/);
      expect(msg).toMatch(recognisedAs);
      expect(msg).toMatch(plural);
      expect(msg).toMatch(/needs a Zotero translation-server/);
      expect(msg).toMatch(/built-in resolver only for DOIs and arXiv ids/);
      // The local remedy is the command that fixes it, and where this server looked.
      expect(msg).toMatch(/No translation-server answered at http:\/\/127\.0\.0\.1:1969/);
      expect(msg).toMatch(/docker run -d -p 1969:1969 zotero\/translation-server/);
      expect(msg).toMatch(/ZOTEUS_TRANSLATION_SERVER_URL/);
      expect(msg).toMatch(/Add Item by Identifier/);
      expect(msg).toMatch(/Nothing was saved\./);
      // Nothing was looked up on the network: no built-in source exists for these.
      expect(ctx.scholar.lookup).not.toHaveBeenCalled();
      expect(ctx.fetcher.fetch).not.toHaveBeenCalled();
    });
  }

  it('points an ISBN at the DOI route that does work here', async () => {
    const res: any = await importTool.handler(
      { action: 'by_identifier', identifier: '978-0-262-03384-8' },
      makeCtx(),
    );
    expect(text(res)).toMatch(/if the book has a DOI, import that instead/);
  });

  it('keeps the unrecognisable-input message for input that really is not an identifier', async () => {
    const res: any = await importTool.handler(
      { action: 'by_identifier', identifier: 'the role of metadata' },
      makeCtx(),
    );
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(
      /"the role of metadata" is not an identifier Zoteus recognises, so nothing was looked up/,
    );
    // It lists what IS accepted, with the forms that used to fail.
    expect(text(res)).toMatch(/ISBN-10 or ISBN-13 \(hyphens allowed\)/);
    expect(text(res)).toMatch(/2019ApJ\.\.\.882L\.\.24A/);
    expect(text(res)).not.toContain(String.fromCharCode(0x2014));
  });
});

describe('zotero_import by_identifier without a translation-server, on a shared (hosted) server', () => {
  for (const { identifier, recognisedAs } of UNRESOLVABLE) {
    it(`tells a hosted caller about "${identifier}" without sending them to install Docker`, async () => {
      const res: any = await importTool.handler(
        { action: 'by_identifier', identifier },
        makeCtx({ remote: true }),
      );
      expect(res.isError).toBe(true);
      const msg = text(res);
      expect(msg).toMatch(recognisedAs);
      expect(msg).toMatch(/needs a Zotero translation-server/);
      expect(msg).toMatch(
        /This shared Zoteus has no translation-server, and only its operator can attach one \(ZOTEUS_TRANSLATION_SERVER_URL\)/,
      );
      // Neither a command the caller cannot run nor the operator's loopback address.
      expect(msg).not.toMatch(/docker/i);
      expect(msg).not.toMatch(/127\.0\.0\.1/);
      expect(msg).toMatch(/Add Item by Identifier .* once Zotero syncs/);
    });
  }
});

describe('zotero_import by_identifier when the translation-server is up but has no answer', () => {
  const refuses = async (id: string): Promise<any[]> => {
    throw new Error(`No translator could resolve "${id}".`);
  };

  it('falls back to the built-in resolver for a DOI it refused, instead of ending the call', async () => {
    // A 400/501 from /search is a throw, and it used to end the call before the built-in
    // resolver ran, although the code's own comment said it would.
    const ctx = makeCtx({ up: true, search: refuses });
    ctx.scholar.lookup = vi.fn(async () => ({ title: 'Found by OpenAlex', type: 'article' }));
    const res: any = await importTool.handler(
      { action: 'by_identifier', identifier: '10.1234/example' },
      ctx,
    );
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.source).toBe('scholar');
    expect(res.structuredContent.items[0].title).toBe('Found by OpenAlex');
  });

  it('says the translation-server tried, for an ISBN, rather than telling the caller to start one', async () => {
    const ctx = makeCtx({ up: true, search: refuses });
    const res: any = await importTool.handler(
      { action: 'by_identifier', identifier: '978-0-262-03384-8' },
      ctx,
    );
    expect(res.isError).toBe(true);
    const msg = text(res);
    expect(msg).toMatch(
      /is an ISBN \(read as 9780262033848\), and the translation-server could not resolve it \(No translator could resolve/,
    );
    expect(msg).toMatch(/no built-in resolver for ISBNs/);
    expect(msg).not.toMatch(/docker|No translation-server answered/i);
  });

  it('treats an empty answer the same way', async () => {
    const ctx = makeCtx({ up: true, search: async () => [] });
    const res: any = await importTool.handler(
      { action: 'by_identifier', identifier: 'PMID: 31452104' },
      ctx,
    );
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(
      /the translation-server could not resolve it \(it returned no items\)/,
    );
  });
});

describe('zotero_import by_url without a translation-server', () => {
  it('names the missing translation-server on a local install, with the command that starts one', async () => {
    const res: any = await importTool.handler(
      { action: 'by_url', url: 'https://example.com/paper' },
      makeCtx(),
    );
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(
      /No Zotero translation-server reachable at http:\/\/127\.0\.0\.1:1969, and URL scraping has no built-in fallback/,
    );
    expect(text(res)).toMatch(/docker run/);
    expect(text(res)).toMatch(/Zotero Connector/);
  });

  it('names the operator, not Docker, on a shared server', async () => {
    const res: any = await importTool.handler(
      { action: 'by_url', url: 'https://example.com/paper' },
      makeCtx({ remote: true }),
    );
    expect(res.isError).toBe(true);
    const msg = text(res);
    expect(msg).toMatch(
      /URL scraping needs a Zotero translation-server and has no built-in fallback/,
    );
    expect(msg).toMatch(/only its operator can attach one \(ZOTEUS_TRANSLATION_SERVER_URL\)/);
    expect(msg).not.toMatch(/docker|127\.0\.0\.1/i);
  });

  it('hands back the identifier when the URL is a DOI or arXiv link, which resolves without one', async () => {
    const doi: any = await importTool.handler(
      { action: 'by_url', url: 'https://doi.org/10.1038/s41586-021-03819-2' },
      makeCtx({ remote: true }),
    );
    expect(text(doi)).toMatch(
      /That URL is a DOI link, though: action:"by_identifier" with identifier "10\.1038\/s41586-021-03819-2"/,
    );
    const arxiv: any = await importTool.handler(
      { action: 'by_url', url: 'https://arxiv.org/abs/2201.00001' },
      makeCtx(),
    );
    expect(text(arxiv)).toMatch(
      /That URL is an arXiv link, though: action:"by_identifier" with identifier "2201\.00001"/,
    );
  });
});
