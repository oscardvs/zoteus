import { describe, it, expect, vi } from 'vitest';
import attachFile from '../../src/tools/attach-file.js';

const PDF_BYTES = new Uint8Array([1, 2, 3, 4]);
const PDF_URL = 'https://arxiv.org/pdf/2501.12345v1';

function pdfFetcher() {
  return {
    fetch: vi.fn(
      async () => new Response(PDF_BYTES, { status: 200, headers: { 'content-type': 'application/pdf' } }),
    ),
  };
}

function fakeWeb(over: any = {}) {
  return {
    writeItems: vi.fn(async () => ({
      successful: [{ index: 0, key: 'ATT1', version: 1 }],
      unchanged: [],
      failed: [],
      newLibraryVersion: 1,
    })),
    requestUpload: vi.fn(async () => ({
      url: 'https://s3.example/upload',
      contentType: 'multipart/form-data',
      prefix: 'PRE',
      suffix: 'SUF',
      uploadKey: 'UP1',
    })),
    uploadBytes: vi.fn(async () => undefined),
    registerUpload: vi.fn(async () => undefined),
    ...over,
  };
}

/** Hosted shape: a cloud key and no route to the user's desktop, as on mcp.zoteus.com. */
function makeCtx(over: any = {}): any {
  return {
    config: { local: 'off' },
    capabilities: { cloud: { userID: 19552201, username: 'oscardvs', access: {} }, localApi: false },
    web: fakeWeb(),
    fetcher: pdfFetcher(),
    localWrites: undefined,
    local: undefined,
    router: { defaultLibrary: () => ({ type: 'user', id: 19552201 }) },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ...over,
  };
}

const localWriteResult = {
  successful: [{ index: 0, key: 'LOCALATT', version: 7 }],
  unchanged: [],
  failed: [],
  newLibraryVersion: 7,
};

describe('zotero_attach_file', () => {
  it('requires a path or a url', async () => {
    const res = await attachFile.handler({ parent: 'ITEM1' }, makeCtx());
    expect(res.isError).toBe(true);
  });

  it('stores a url through the cloud Web API when no desktop app is reachable', async () => {
    const ctx = makeCtx();
    const res = await attachFile.handler({ parent: 'ITEM1', url: PDF_URL }, ctx);

    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as any;
    expect(sc).toMatchObject({
      attachment: 'ATT1',
      parent: 'ITEM1',
      target: 'cloud',
      contentType: 'application/pdf',
      bytes: 4,
      alreadyInStorage: false,
    });
    // arXiv PDF urls carry no extension; one is added from the served type.
    expect(sc.filename).toBe('2501.12345v1.pdf');
    // A downloaded file is an imported_url, and keeps its source on the attachment.
    expect(ctx.web.writeItems.mock.calls[0][1][0]).toMatchObject({
      itemType: 'attachment',
      parentItem: 'ITEM1',
      linkMode: 'imported_url',
      contentType: 'application/pdf',
      filename: '2501.12345v1.pdf',
      url: PDF_URL,
    });
    // ...and the bytes actually go up: authorize, POST, register.
    expect(ctx.web.requestUpload).toHaveBeenCalledTimes(1);
    expect(ctx.web.uploadBytes).toHaveBeenCalledTimes(1);
    expect(ctx.web.registerUpload).toHaveBeenCalledWith({ type: 'user', id: 19552201 }, 'ATT1', 'UP1');
  });

  it('reports a storage hit without re-uploading the bytes', async () => {
    const ctx = makeCtx({ web: fakeWeb({ requestUpload: vi.fn(async () => ({ exists: 1 })) }) });
    const res = await attachFile.handler({ parent: 'ITEM1', url: PDF_URL }, ctx);
    expect((res.structuredContent as any).alreadyInStorage).toBe(true);
    expect(ctx.web.uploadBytes).not.toHaveBeenCalled();
  });

  it('prefers the desktop app when it is reachable, leaving the cloud untouched', async () => {
    const writeItems = vi.fn(async () => localWriteResult);
    const uploadFile = vi.fn(async () => {});
    const ctx = makeCtx({
      capabilities: { cloud: { userID: 19552201, access: {} }, localApi: true },
      localWrites: { hasStoredKey: () => true, writeItems, uploadFile },
    });
    const res = await attachFile.handler({ parent: 'ITEM1', url: PDF_URL }, ctx);

    expect((res.structuredContent as any).target).toBe('local');
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
  });

  it('falls back to the cloud when the desktop local API has no write endpoints (Zotero 9)', async () => {
    const writeItems = vi.fn(async () => {
      throw new Error('Local API local write failed (404): No endpoint found');
    });
    const ctx = makeCtx({
      capabilities: { cloud: { userID: 19552201, access: {} }, localApi: true },
      localWrites: { hasStoredKey: () => true, writeItems, uploadFile: vi.fn() },
    });
    const res = await attachFile.handler({ parent: 'ITEM1', url: PDF_URL }, ctx);

    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as any).target).toBe('cloud');
    expect(ctx.web.uploadBytes).toHaveBeenCalledTimes(1);
  });

  it('does not retry on the cloud once the local attachment item exists', async () => {
    // Retrying here would leave the empty local attachment behind and create a second one.
    const ctx = makeCtx({
      capabilities: { cloud: { userID: 19552201, access: {} }, localApi: true },
      localWrites: {
        hasStoredKey: () => true,
        writeItems: vi.fn(async () => localWriteResult),
        uploadFile: vi.fn(async () => {
          throw new Error('Local API file-bytes upload failed (404): gone');
        }),
      },
    });
    await expect(attachFile.handler({ parent: 'ITEM1', url: PDF_URL }, ctx)).rejects.toThrow(/LOCALATT/);
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
  });

  it('follows a configured group default past the desktop app to the cloud (#61)', async () => {
    const writeItems = vi.fn(async () => localWriteResult);
    const uploadFile = vi.fn(async () => {});
    const ctx = makeCtx({
      capabilities: { cloud: { userID: 19552201, access: {} }, localApi: true },
      localWrites: { hasStoredKey: () => true, writeItems, uploadFile },
      router: { defaultLibrary: () => ({ type: 'group', id: 456 }) },
    });
    const res = await attachFile.handler({ parent: 'ITEM1', url: PDF_URL }, ctx);

    expect((res.structuredContent as any).target).toBe('cloud');
    expect(writeItems).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(ctx.web.writeItems).toHaveBeenCalledWith({ type: 'group', id: 456 }, expect.any(Array));
  });

  it('refuses a group target with no cloud key before downloading anything (#61)', async () => {
    const ctx = makeCtx({
      capabilities: { cloud: null, localApi: true },
      localWrites: { hasStoredKey: () => true, writeItems: vi.fn(), uploadFile: vi.fn() },
      router: { defaultLibrary: () => ({ type: 'group', id: 456 }) },
    });
    await expect(attachFile.handler({ parent: 'ITEM1', url: PDF_URL }, ctx)).rejects.toThrow(
      /cloud API key/,
    );
    expect(ctx.fetcher.fetch).not.toHaveBeenCalled();
    expect(ctx.localWrites.writeItems).not.toHaveBeenCalled();
  });

  it('explains both write paths when neither is available, before downloading anything', async () => {
    const ctx = makeCtx({ capabilities: { cloud: null, localApi: false } });
    const res = await attachFile.handler({ parent: 'ITEM1', url: PDF_URL }, ctx);

    expect(res.isError).toBe(true);
    const text = res.content.map((c: { text: string }) => c.text).join('\n');
    expect(text).toMatch(/ZOTERO_API_KEY/);
    expect(text).toMatch(/desktop/i);
    expect(ctx.fetcher.fetch).not.toHaveBeenCalled();
  });

  it('surfaces a failed download as a tool error, not an empty attachment', async () => {
    const ctx = makeCtx({ fetcher: { fetch: vi.fn(async () => new Response('nope', { status: 404 })) } });
    const res = await attachFile.handler({ parent: 'ITEM1', url: PDF_URL }, ctx);

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/404/);
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
  });

  /**
   * On a hosted deployment `url` is a tenant naming a host to the operator's box. The bytes
   * of the cloud metadata service, or of a loopback service, must not land in a library,
   * and the refusal has to come before any request and read as a sentence, not a stack.
   */
  it('refuses a hosted tenant a url into the deployment, before any request and without any write', async () => {
    const ctx = makeCtx({ remoteCaller: true });
    const res = await attachFile.handler({ parent: 'ITEM1', url: 'http://169.254.169.254/latest/meta-data/' }, ctx);

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/hosted Zoteus fetches only over https from public hosts/);
    expect(ctx.fetcher.fetch).not.toHaveBeenCalled();
    expect(ctx.web.writeItems).not.toHaveBeenCalled();
  });
});
