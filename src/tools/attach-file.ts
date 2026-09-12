import { writeTarget } from './common-output.js';
import { z } from 'zod';
import { resolveCallerPath, CallerPathError } from '../lib/caller-path.js';
import type { ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import {
  ok,
  ensureLocalApi,
  isLocalWritesUnavailable,
  isPersonalLibrary,
  requireCloud,
  resolveLibrary,
} from '../registry/registry.js';
import {
  AttachmentDownloadError,
  AttachmentUploadError,
  readAttachmentSource,
  storeCloudAttachment,
  storeLocalAttachment,
} from '../features/attachments/store.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Attach a file (local path or URL) to an item as a stored attachment.
 *
 * Two backends, chosen per call: the Zotero desktop app's local API when it is reachable
 * (Zotero 10+, key-free, no storage quota), otherwise the cloud Web API's File Storage
 * protocol. The cloud path matters most for remote deployments, where the desktop app is
 * on the user's loopback and structurally out of reach; there, `url` is the way in, since
 * the server downloads the bytes itself and never needs a file on its own disk.
 */
const attachFile: ToolDefinition = {
  name: 'zotero_attach_file',
  title: 'Attach a file (PDF, snapshot) to an item',
  description:
    'Add a stored file attachment (e.g. a PDF full text) under an existing item. Give `parent` (the item key) and either `url` (Zoteus downloads it, then stores it) or `path` (a file on the machine running Zoteus). `filename` and `content_type` are inferred when omitted. Saves through the Zotero desktop app when one is reachable (Zotero 10+ local API; you may be asked once to allow Zoteus write access, choose "Always Allow"), and otherwise through the cloud Web API, which needs ZOTERO_API_KEY with file access and uses your Zotero file-storage quota. `url` works on every setup including a remote/hosted Zoteus that cannot see your desktop, so prefer it over `path` unless the file really is on the server. Returns the new attachment key.',
  inputSchema: {
    parent: z.string().describe('Key of the parent item to attach the file to.'),
    path: z.string().optional().describe('Filesystem path to the file, on the machine running Zoteus.'),
    url: z.string().url().optional().describe('URL to download the file from; works on remote/hosted servers.'),
    filename: z.string().optional().describe('File name to store; inferred from path/url if omitted.'),
    content_type: z.string().optional().describe('MIME type; inferred from the extension if omitted (pdf -> application/pdf).'),
    title: z.string().optional().describe('Attachment title, e.g. "Full Text PDF".'),
    ...libraryArgs,
    library_id: libraryArgs.library_id.describe('Group library to attach the file in (from zotero_groups); forces the cloud path instead of the desktop app.'),
  },
  outputSchema: z
    .object({
      attachment: z.string().describe('Key of the attachment item created.'),
      parent: z.string().describe('The item it hangs off.'),
      filename: z.string().describe('File name stored.'),
      bytes: z.number().describe('Size of the stored file.'),
      contentType: z.string().describe('MIME type stored, e.g. "application/pdf".'),
      target: writeTarget,
      alreadyInStorage: z.boolean().optional().describe('True when Zotero already held these bytes and only the item was created (cloud path).'),
    })
    .passthrough(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    if (!args.path && !args.url) {
      return err('Provide `path` or `url`.');
    }
    let localPath = args.path;
    if (localPath) {
      try {
        localPath = await resolveCallerPath(localPath, {
          dataDir: ctx.config.dataDir,
          confined: ctx.remoteCaller,
          mode: 'read',
          argName: 'path',
          alternative: 'Use `url` instead: Zoteus downloads the bytes itself, which works on every setup.',
        });
      } catch (e) {
        if (e instanceof CallerPathError) return err(e.message);
        throw e;
      }
    }
    // Desktop first for the personal library: no cloud key, no quota, bytes never leave
    // the machine. Group libraries the app may not have are cloud-only either way.
    const lib = resolveLibrary(ctx, args);
    const personal = isPersonalLibrary(lib);
    const useLocal = personal && Boolean(ctx.localWrites) && (await ensureLocalApi(ctx));
    // A group with no cloud key fails here, before any bytes are fetched.
    if (!personal) requireCloud(ctx, lib);
    if (!useLocal && !ctx.capabilities.cloud) {
      return err(
        'Storing a file needs one of two write paths, and neither is available: the Zotero desktop app (Zotero 10+ with the local API enabled, granted once when Zotero asks), or a cloud API key with file access (ZOTERO_API_KEY). ' +
          'If Zoteus is running on a different machine than Zotero, only the cloud key can work, since the desktop local API listens on your own loopback address.',
      );
    }

    let source: Awaited<ReturnType<typeof readAttachmentSource>>;
    try {
      source = await readAttachmentSource(ctx, {
        path: localPath,
        url: args.url,
        filename: args.filename,
        contentType: args.content_type,
        titleHint: args.title,
      });
    } catch (e) {
      if (!(e instanceof AttachmentDownloadError)) throw e;
      return err(e.message);
    }
    const { bytes, filename, contentType } = source;

    if (useLocal) {
      try {
        const attachmentKey = await storeLocalAttachment(ctx, {
          parent: args.parent,
          bytes,
          filename,
          contentType,
          title: args.title,
          url: args.url,
        });
        return ok(
          { attachment: attachmentKey, parent: args.parent, filename, bytes: bytes.length, contentType, target: 'local' },
          `Attached ${filename} (${bytes.length} bytes) to item ${args.parent} as ${attachmentKey}.`,
        );
      } catch (e) {
        // Zotero 9 and earlier answer the write endpoints with 404/501. That fails before
        // anything is created, so with a cloud key the same bytes can still go up the Web
        // API instead of dead-ending. A failure after the item exists must not retry:
        // a second attempt would leave the empty first attachment behind.
        if (e instanceof AttachmentUploadError || !isLocalWritesUnavailable(e) || !ctx.capabilities.cloud) throw e;
        ctx.logger.info(
          `Local-API attachment writes unavailable (${e instanceof Error ? e.message : e}); using the cloud Web API.`,
        );
      }
    }

    const result = await storeCloudAttachment(ctx, lib, {
      parent: args.parent,
      bytes,
      filename,
      contentType,
      title: args.title,
      url: args.url,
    });
    return ok(
      {
        attachment: result.key,
        parent: args.parent,
        filename,
        bytes: bytes.length,
        contentType,
        target: 'cloud',
        alreadyInStorage: result.exists,
      },
      result.exists
        ? `${filename} was already in Zotero file storage; attached to item ${args.parent} as ${result.key}.`
        : `Uploaded ${filename} (${bytes.length} bytes) to Zotero file storage and attached it to item ${args.parent} as ${result.key}.`,
    );
  },
};

export default attachFile;
