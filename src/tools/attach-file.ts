import { callerRoot } from './caller-root.js';
import { z } from 'zod';
import { writeTarget } from './common-output.js';
import { resolveCallerPath, CallerPathError } from '../lib/caller-path.js';
import type { ToolContext, ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import type { LibraryRef } from '../api/web-client.js';
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
  bareFilename,
  filenameFromUrl,
  readAttachmentSource,
  storeCloudAttachment,
  storeLocalAttachment,
  withExtensionFor,
} from '../features/attachments/store.js';
import { detectKind } from '../features/attachments/resolve.js';
import { OpenAlexError, type OaPdf } from '../features/scholar/openalex.js';
import { existingPdfAttachment, itemDoi } from '../features/oa/discover.js';
import { OaFetchError, fetchOaPdf } from '../features/oa/fetch.js';
import { oaAttachmentTitle, oaQualifier, versionCaveat } from '../features/oa/provenance.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** A DOI as a bare file name: 10.1038/nature14539 -> 10.1038-nature14539. */
function doiSlug(doi: string): string {
  return doi.replace(/[^A-Za-z0-9.]+/g, '-').replace(/^-+|-+$/g, '') || 'open-access';
}

/**
 * The `find_oa` half: the parent item's DOI, OpenAlex's open-access answer, and bytes that
 * have been checked to actually be a PDF. Either that, or one sentence saying why not.
 *
 * Every refusal here leaves the library byte-for-byte unchanged, and each is a different
 * fact kept deliberately apart. An item with no DOI is not a paywalled paper; an OpenAlex
 * outage is not evidence that no free copy exists; an HTML sign-in page served as
 * `application/pdf` is not a PDF. A tool that collapses those into "not found" teaches its
 * caller that "not found" means "does not exist", which is the failure this whole path is
 * written against.
 */
async function discoverOaPdf(
  args: { parent: string; filename?: string },
  ctx: ToolContext,
  lib: LibraryRef,
): Promise<{ oa: OaPdf; source: { bytes: Uint8Array; filename: string; contentType: string } } | { error: string }> {
  const item = await ctx.router.getItem(args.parent, { library: lib });
  const doi = itemDoi(item);
  if (!doi) {
    return {
      error:
        `Item ${args.parent} records no DOI, and the open-access lookup has nothing else to search by, so nothing was downloaded; ` +
        'attach the PDF with `url` or `path`, or put the DOI on the item first (for item types with no DOI field, a `DOI: 10.…` line in Extra counts).',
    };
  }
  // Asked before OpenAlex is, because the cheapest request is the one never made and a
  // second copy of a file the user already has is worse than no answer.
  const existing = await existingPdfAttachment(ctx, args.parent, lib);
  if (existing) {
    return {
      error: `Item ${args.parent} already has a PDF attached (${existing}), so nothing was downloaded; delete that attachment first if you meant to replace it, or pass \`url\` to add a second file deliberately.`,
    };
  }

  let oa: OaPdf | null;
  try {
    oa = await ctx.scholar.oaPdf(doi);
  } catch (e) {
    if (e instanceof OpenAlexError) {
      if (e.status === 404) {
        return {
          error: `OpenAlex has no record of DOI ${doi}, so it cannot say whether an open-access copy exists; check the DOI on the item, or attach the PDF with \`url\` or \`path\`.`,
        };
      }
      return {
        error:
          `OpenAlex could not answer for DOI ${doi} (HTTP ${e.status}). That is the provider failing, not evidence that there is no open-access copy: ` +
          'retry shortly, or attach the PDF with `url` or `path`.',
      };
    }
    throw e;
  }
  if (!oa) {
    return {
      error: `OpenAlex reports no open-access copy of DOI ${doi}, and Zoteus has no way past a paywall, so nothing was downloaded; get the PDF through your institution and attach it with \`url\` or \`path\`.`,
    };
  }
  // The operator's egress control. Discovery still reports what it found, because knowing
  // the link exists is useful even where fetching it from an arbitrary host is not allowed.
  if (!ctx.config.oaFetch) {
    return {
      error:
        `Found an open-access PDF for DOI ${doi} at ${oa.url} (${oaQualifier(oa)}), but ZOTEUS_OA_FETCH is off on this deployment, so Zoteus did not download it; ` +
        'set ZOTEUS_OA_FETCH=true to allow the download, or fetch that link yourself and attach the file with `url` or `path`.',
    };
  }

  let fetched: Awaited<ReturnType<typeof fetchOaPdf>>;
  try {
    fetched = await fetchOaPdf(ctx, oa.url);
  } catch (e) {
    if (e instanceof OaFetchError) return { error: e.message };
    throw e;
  }
  // The bytes decide, and only the bytes: `detectKind` is called with no content type and no
  // file name, so nothing but a real `%PDF-` header can answer "pdf". A paywall interstitial
  // served as application/pdf is exactly what this catches, and it is caught here, before
  // any item is created.
  if (detectKind(fetched.bytes) !== 'pdf') {
    return {
      error:
        `What ${fetched.url} served is not a PDF (${fetched.bytes.length} bytes, sent as ${fetched.servedType ?? 'no content type'}, no PDF header), so nothing was attached. ` +
        'That is usually a sign-in or "verify you are human" page: open the link yourself and attach the real file with `url` or `path`.',
    };
  }
  const name = bareFilename(args.filename ?? filenameFromUrl(oa.url, doiSlug(doi)), doiSlug(doi));
  return {
    oa,
    // Typed from the bytes, not from the header: the header has just been shown to be
    // unreliable, and these bytes have been shown to be a PDF.
    source: { bytes: fetched.bytes, filename: withExtensionFor(name, 'application/pdf'), contentType: 'application/pdf' },
  };
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
    'Add a stored file attachment (e.g. a PDF full text) under an existing item. Give `parent` (the item key) and one of `url` (Zoteus downloads it, then stores it), `path` (a file on the machine running Zoteus), or `find_oa: true` (Zoteus looks the parent item\'s DOI up in OpenAlex and attaches the open-access PDF, if there is one). `find_oa` finds only copies OpenAlex already knows about, which is arXiv, PubMed Central, DOAJ journals and institutional repositories: it is not a way past a paywall, and it says so plainly when there is no free copy. The copy it finds is often the author\'s accepted or submitted manuscript rather than the published version, so the source, the version and the licence come back in the result and go into the attachment\'s title. `filename` and `content_type` are inferred when omitted. Saves through the Zotero desktop app when one is reachable (Zotero 10+ local API; you may be asked once to allow Zoteus write access, choose "Always Allow"), and otherwise through the cloud Web API, which needs ZOTERO_API_KEY with file access and uses your Zotero file-storage quota. `url` works on every setup including a remote/hosted Zoteus that cannot see your desktop, so prefer it over `path` unless the file really is on the server. Returns the new attachment key.',
  inputSchema: {
    parent: z.string().describe('Key of the parent item to attach the file to.'),
    path: z.string().optional().describe('Filesystem path to the file, on the machine running Zoteus.'),
    url: z.string().url().optional().describe('URL to download the file from; works on remote/hosted servers, where it must be an https link to a public host (no private or loopback addresses, 64 MB at most).'),
    find_oa: z
      .boolean()
      .optional()
      .describe(
        "Find the open-access PDF for the parent item by its DOI (OpenAlex) and attach it. Use instead of `url`/`path`, not alongside them. Refuses, saying why, when the item has no DOI, when OpenAlex reports no open-access copy, when the item already has a PDF, or when what the link serves is not a PDF.",
      ),
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
      oa: z
        .object({
          url: z.string().describe('The open-access PDF link OpenAlex reported, and where these bytes came from.'),
          source: z.string().optional().describe('Who hosts the copy, as OpenAlex names them, e.g. "arXiv" or "PubMed Central".'),
          version: z
            .enum(['published', 'accepted', 'submitted'])
            .optional()
            .describe('Which version this copy is: "published" (the version of record), "accepted" (the reviewed author manuscript) or "submitted" (a preprint). Absent when OpenAlex does not say.'),
          licence: z.string().optional().describe('The licence the host declares, as OpenAlex reports it, e.g. "cc-by". Absent when none is stated.'),
          landingPage: z.string().optional().describe('The human landing page for this copy, when the location has one.'),
          versionCaveat: z.string().optional().describe('Why this copy is not the publisher\u2019s version of record; absent when it is.'),
        })
        .passthrough()
        .optional()
        .describe('Where an automatically discovered open-access PDF came from, and what version it is. Present only for find_oa.'),
    })
    .passthrough(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    if (!args.path && !args.url && !args.find_oa) {
      return err('Provide `path`, `url`, or `find_oa: true` to look for an open-access PDF by the parent item\'s DOI.');
    }
    if (args.find_oa && (args.path || args.url)) {
      return err('Pass either `find_oa: true` or an explicit `url`/`path`, not both: drop one and call again, since which file gets attached should not be a coin toss.');
    }
    let localPath = args.path;
    if (localPath) {
      try {
        localPath = await resolveCallerPath(localPath, {
          dataDir: await callerRoot(ctx),
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

    let source: { bytes: Uint8Array; filename: string; contentType: string };
    let oa: OaPdf | undefined;
    if (args.find_oa) {
      const found = await discoverOaPdf(args, ctx, lib);
      if ('error' in found) return err(found.error);
      ({ oa, source } = found);
    } else {
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
    }
    const { bytes, filename, contentType } = source;
    // The file's provenance travels with it onto the attachment: the URL it came from, and,
    // for a discovered copy, which version of the paper it is. A green open-access manuscript
    // stored as a nameless "Full Text PDF" is the failure this feature has to avoid.
    const fileUrl = args.url ?? oa?.url;
    const attachTitle = args.title ?? (oa ? oaAttachmentTitle(oa) : undefined);
    const oaOut = oa ? { ...oa, ...(versionCaveat(oa.version) ? { versionCaveat: versionCaveat(oa.version) } : {}) } : undefined;
    const oaLine = oa ? ` Open access via ${oaQualifier(oa)}; ${versionCaveat(oa.version) ?? 'this is the publisher\u2019s version of record.'}` : '';

    if (useLocal) {
      try {
        const attachmentKey = await storeLocalAttachment(ctx, {
          parent: args.parent,
          bytes,
          filename,
          contentType,
          title: attachTitle,
          url: fileUrl,
        });
        return ok(
          { attachment: attachmentKey, parent: args.parent, filename, bytes: bytes.length, contentType, target: 'local', oa: oaOut },
          `Attached ${filename} (${bytes.length} bytes) to item ${args.parent} as ${attachmentKey}.${oaLine}`,
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
      title: attachTitle,
      url: fileUrl,
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
        oa: oaOut,
      },
      (result.exists
        ? `${filename} was already in Zotero file storage; attached to item ${args.parent} as ${result.key}.`
        : `Uploaded ${filename} (${bytes.length} bytes) to Zotero file storage and attached it to item ${args.parent} as ${result.key}.`) + oaLine,
    );
  },
};

export default attachFile;
