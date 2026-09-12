import { zoteroObject } from './common-output.js';
import { z } from 'zod';
import { resolveCallerPath, CallerPathError } from '../lib/caller-path.js';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { ok, optionalLibrary, requireCloudLibrary } from '../registry/registry.js';
import { uploadFile, downloadFile } from '../api/attachments.js';
import { AttachmentDownloadError, readAttachmentSource, storeCloudAttachment } from '../features/attachments/store.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

const attachment: ToolDefinition = {
  name: 'zotero_attachment',
  title: 'Zotero attachments (files)',
  description:
    "Upload, download, or inspect attachment files. `action`: \"upload\" stores a file as a Zotero attachment using the full File Storage protocol (provide `url` to have Zoteus fetch it, or `file_path` for a file on the machine running Zoteus; optional `parent_item` to attach it under an item, `title`, `content_type`) and returns the new attachment key; \"download\" fetches an attachment's file to a local path (provide `item_key`; optional `save_path`, default under the Zoteus data dir) and returns the path and byte count; \"info\" returns an attachment item's metadata. File bytes are written to / read from disk, never streamed through the conversation. Upload/download use the cloud Web API and your file-storage quota. When Zoteus runs on a different machine than Zotero, `file_path` refers to the server's disk, so use `url` instead.",
  inputSchema: {
    action: z
      .enum(['upload', 'download', 'info'])
      .describe(
        'What to do. "upload" stores a file as an attachment (needs `file_path` or `url`); "download" writes an attachment\'s file to disk (needs `item_key`); "info" returns the attachment item\'s metadata.',
      ),
    file_path: z.string().optional().describe('File to upload, on the machine running Zoteus.'),
    url: z.string().url().optional().describe('URL to download and upload instead of `file_path`; works on remote/hosted servers.'),
    parent_item: z.string().optional().describe('Parent item key to attach under (upload).'),
    title: z.string().optional().describe('Attachment title (upload), e.g. "Full Text PDF"; the filename is used when omitted.'),
    content_type: z.string().optional().describe('MIME type of the uploaded file, e.g. "application/pdf"; inferred from the filename when omitted.'),
    item_key: z.string().optional().describe('Attachment item key (download/info).'),
    save_path: z.string().optional().describe('Where to write the downloaded file.'),
    overwrite: z
      .boolean()
      .optional()
      .describe('Allow `save_path` to replace a file that already exists (default false).'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      attachment: zoteroObject.optional().describe("action:\"info\": the attachment item's full record."),
      key: z.string().optional().describe('action:"upload": key of the attachment item created.'),
      exists: z.boolean().optional().describe('True when Zotero already held these bytes and only the item was created.'),
      filename: z.string().optional().describe('File name stored.'),
      bytes: z.number().optional().describe('Bytes uploaded or written.'),
      savePath: z.string().optional().describe('action:"download": where the file was written.'),
      contentType: z.string().optional().describe('MIME type of the downloaded file.'),
    })
    .passthrough(),
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  handler: async (args, ctx) => {
    // Caller-supplied paths are resolved first, before any library or network work: on a
    // shared deployment they address the operator's disk, not the caller's.
    let uploadPath = args.file_path;
    let savePath: string | undefined;
    try {
      if (uploadPath) {
        uploadPath = await resolveCallerPath(uploadPath, {
          dataDir: ctx.config.dataDir,
          confined: ctx.remoteCaller,
          mode: 'read',
          argName: 'file_path',
          alternative: 'Use `url` instead: Zoteus fetches the bytes itself, which works on every setup.',
        });
      }
      if (args.save_path) {
        savePath = await resolveCallerPath(args.save_path, {
          dataDir: ctx.config.dataDir,
          confined: ctx.remoteCaller,
          mode: 'write',
          argName: 'save_path',
          alternative: 'Omit `save_path` to write to the default location under the data directory.',
        });
        // Only a caller-supplied path is protected: the default location is Zoteus's own
        // cache for this attachment key, and re-downloading over it is the ordinary case.
        if (!args.overwrite && existsSync(savePath)) {
          return err(
            `\`${savePath}\` already exists. Pass \`overwrite: true\` to replace it, or choose another \`save_path\`.`,
          );
        }
      }
    } catch (e) {
      if (e instanceof CallerPathError) return err(e.message);
      throw e;
    }

    if (args.action === 'info') {
      if (!args.item_key) return err('`item_key` is required for info.');
      const library = optionalLibrary(args);
      const item = await ctx.router.getItem(args.item_key, { library });
      return ok({ attachment: item }, `Attachment ${args.item_key}: ${item?.data?.filename ?? item?.data?.title ?? '(unnamed)'}.`);
    }

    const lib = requireCloudLibrary(ctx, args);

    if (args.action === 'upload') {
      if (!args.file_path && !args.url) return err('`file_path` or `url` is required for upload.');
      // A URL is fetched here and uploaded from memory, so the bytes never have to exist
      // on the server's disk; a path still goes through the file reader, which picks up
      // the real mtime.
      if (args.url) {
        let source: Awaited<ReturnType<typeof readAttachmentSource>>;
        try {
          source = await readAttachmentSource(ctx, {
            url: args.url,
            contentType: args.content_type,
            titleHint: args.title,
          });
        } catch (e) {
          if (!(e instanceof AttachmentDownloadError)) throw e;
          return err(e.message);
        }
        const stored = await storeCloudAttachment(ctx, lib, {
          parent: args.parent_item,
          bytes: source.bytes,
          filename: source.filename,
          contentType: source.contentType,
          title: args.title,
          url: args.url,
        });
        return ok(
          { key: stored.key, exists: stored.exists, filename: source.filename, bytes: source.bytes.length },
          stored.exists
            ? `File already in storage; attachment item ${stored.key} created for ${source.filename}.`
            : `Uploaded ${source.filename} (${source.bytes.length} bytes) as attachment ${stored.key}.`,
        );
      }
      const result = await uploadFile(ctx.web, lib, {
        filePath: uploadPath,
        parentItem: args.parent_item,
        title: args.title,
        contentType: args.content_type,
      });
      const msg = result.exists
        ? `File already in storage; attachment item ${result.key} created for ${result.filename}.`
        : `Uploaded ${result.filename} as attachment ${result.key}.`;
      return ok({ key: result.key, exists: result.exists, filename: result.filename }, msg);
    }

    // download
    if (!args.item_key) return err('`item_key` is required for download.');
    savePath ??= join(ctx.config.dataDir, 'attachments', args.item_key);
    await mkdir(dirname(savePath), { recursive: true });
    const r = await downloadFile(ctx.web, lib, args.item_key, savePath);
    return ok(
      { savePath: r.savePath, bytes: r.bytes, contentType: r.contentType },
      `Downloaded ${r.bytes} bytes to ${r.savePath}.`,
    );
  },
};

export default attachment;
