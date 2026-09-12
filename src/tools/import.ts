import { z } from 'zod';
import { writeFailures, writeTarget, zoteroObject } from './common-output.js';
import type { ToolDefinition, ToolHandlerResult, ToolContext } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import {
  ok,
  resolveLibrary,
  isPersonalLibrary,
  requireCloud,
  isLocalWritesUnavailable,
  ensureLocalApi,
  writeResult,
} from '../registry/registry.js';
import { arxivItem, fromScholarWork, parseIdentifier, bareDoi, type ResolvedItem } from '../features/resolve/resolve.js';
import {
  AttachmentDownloadError,
  downloadAttachment,
  readAttachmentSource,
  storeCloudAttachment,
  storeLocalAttachment,
} from '../features/attachments/store.js';
import type { LibraryRef } from '../api/web-client.js';

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Built-in resolution fallback used when no translation-server is reachable.
 * Handles arXiv ids (direct Atom fetch) and DOIs (OpenAlex primary, Crossref
 * fallback — the same scholar providers zotero_scholar uses). ISBN/PMID/
 * bibcodes and web URLs cannot be resolved server-side and return a clear error.
 */
async function resolveBuiltin(ctx: ToolContext, id: string): Promise<{ items: ResolvedItem[]; source: string }> {
  const parsed = parseIdentifier(id);
  if (!parsed) {
    throw new Error(
      `Could not parse "${id}" as a known identifier. Try a DOI (10.…), arXiv id (YYMM.NNNNN), ISBN, PMID, or ADS bibcode — or start a translation-server for URL imports.`,
    );
  }
  switch (parsed.type) {
    case 'arxiv': {
      const item = await arxivItem(parsed.value, (url, init) => ctx.fetcher.fetch(url, init, { maxRetries: 0, deadlineMs: 60_000 }));
      if (!item) throw new Error(`arXiv returned no record for "${parsed.value}".`);
      return { items: [item], source: 'arxiv' };
    }
    case 'doi': {
      const doi = bareDoi(parsed.value);
      const work = await ctx.scholar.lookup(doi);
      if (!work) throw new Error(`No scholarly record found for DOI "${doi}".`);
      return { items: [fromScholarWork(work, doi)], source: 'scholar' };
    }
    case 'pmid':
      throw new Error(`PMID resolution requires a translation-server (no built-in source). Start one or set ZOTEUS_TRANSLATION_SERVER_URL, then retry.`);
    case 'isbn':
      throw new Error(`ISBN resolution requires a translation-server (no built-in source). Start one or set ZOTEUS_TRANSLATION_SERVER_URL, then retry.`);
    case 'bibcode':
      throw new Error(`ADS bibcode resolution requires a translation-server (no built-in source). Start one or set ZOTEUS_TRANSLATION_SERVER_URL, then retry.`);
    default:
      throw new Error(`Unsupported identifier type "${parsed.type}".`);
  }
}

const importTool: ToolDefinition = {
  name: 'zotero_import',
  title: 'Import items by identifier or URL',
  description:
    'Resolve bibliographic metadata to Zotero item-data and optionally save it to your library. `action: "by_identifier"` resolves a DOI, ISBN, PMID, arXiv id, or ADS bibcode (set `identifier`); `action: "by_url"` scrapes a web page (set `url`) and may return multiple choices to pick from. Set `save_to_library:true` (and optionally `collection_key`) to persist the resolved items — saved into the running Zotero desktop app when available, otherwise via the cloud Web API (requires ZOTERO_API_KEY); otherwise the resolved metadata is returned without saving. When a Zotero translation-server is reachable (ZOTEUS_TRANSLATION_SERVER_URL, default http://127.0.0.1:1969) it is the primary path; if none is running, DOI and arXiv ids fall back to built-in resolution (OpenAlex/Crossref and the arXiv API respectively) — the result then carries a `source` field ("scholar" or "arxiv"). ISBN/PMID/bibcode and web URLs require a translation-server.',
  inputSchema: {
    action: z
      .enum(['by_identifier', 'by_url'])
      .describe(
        'What to resolve: "by_identifier" takes `identifier` (DOI, ISBN, PMID, arXiv id, ADS bibcode); "by_url" scrapes `url` and needs a translation-server.',
      ),
    identifier: z.string().optional().describe('DOI (10.…), arXiv id (YYMM.NNNNN), ISBN, PMID, or ADS bibcode.'),
    url: z.string().optional().describe('Web page URL to scrape (needs a translation-server).'),
    save_to_library: z.boolean().optional().describe('Persist the resolved items — into the running Zotero desktop app when available, otherwise the cloud Web API (needs a cloud key).'),
    collection_key: z.string().optional().describe('Collection to add saved items to: an 8-char collection key or a Zotero treeViewID like "C20".'),
    attach_url: z.string().url().optional().describe('File URL (e.g. an arXiv PDF) to download and attach as a stored attachment to the (single) imported item. Works on every save path: the desktop app when one is reachable, otherwise the cloud Web API.'),
    attach_title: z.string().optional().describe('Title for the attached file, e.g. "Full Text PDF".'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      source: z.string().optional().describe('What resolved the metadata: "translation-server", "scholar" or "arxiv".'),
      items: z.array(zoteroObject).optional().describe('The resolved item-data objects, returned when save_to_library was not set.'),
      count: z.number().optional().describe('How many were resolved.'),
      saved: z.boolean().optional().describe('False when nothing was written to the library.'),
      resolved: z.number().optional().describe('How many items the save was asked to write.'),
      created: z
        .array(z.string())
        .optional()
        .describe('Keys of the items written to the library.'),
      failed: writeFailures,
      target: writeTarget,
      sessionID: z.string().optional().describe('Connector save session, when the desktop app took the write.'),
      placedIn: z.string().optional().describe('The collection the saved items were filed in.'),
      attached: z
        .object({
          key: z.string().optional().describe('Key of the attachment item created.'),
          bytes: z.number().optional().describe('Size of the downloaded file.'),
          contentType: z.string().optional().describe('Its MIME type.'),
          filename: z.string().optional().describe('File name stored.'),
          alreadyInStorage: z.boolean().optional().describe('True when Zotero already held those bytes.'),
        })
        .passthrough()
        .optional()
        .describe('The file attached from attach_url, when one was asked for and landed.'),
      warning: z.string().optional().describe('The items were saved, but something after that did not work (a failed attachment, a collection that could not be set).'),
      note: z.string().optional().describe('Set when fewer items could be matched back than were sent.'),
      multiple: z
        .record(z.unknown())
        .optional()
        .describe('action:"by_url" on a page offering several items: the choices, as key to label. Re-run with a more specific URL.'),
    })
    .passthrough(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    // Check what the caller sent before probing the translation-server. An empty
    // `identifier` used to fall through the guard below (a missing identifier and a blank
    // one are both falsy) and was reported as "no translation-server reachable", which sent
    // the caller off to install Docker for a request that named nothing to resolve.
    if (args.action === 'by_identifier' && !args.identifier?.trim()) {
      return err(
        '`identifier` is empty; action:"by_identifier" has nothing to resolve. Pass a DOI (10.1109/…), an arXiv id ' +
          '(2301.12345), an ISBN, a PMID, or an ADS bibcode. To import a web page instead, use action:"by_url" with `url`.',
      );
    }
    if (args.action === 'by_url' && !args.url?.trim()) {
      return err(
        '`url` is empty; action:"by_url" has nothing to scrape. Pass the page URL (https://…). To import a known ' +
          'identifier instead, use action:"by_identifier" with `identifier`.',
      );
    }
    const tsUp = await ctx.translation.isUp();
    // A URL with no translation-server is unresolvable server-side; say so plainly. An
    // identifier is not in that position: DOIs and arXiv ids have built-in fallbacks below,
    // and the ones that do not (ISBN/PMID/bibcode) are named as such by resolveBuiltin.
    if (!tsUp && args.action === 'by_url') {
      return err(
        `No Zotero translation-server reachable at ${ctx.config.translationServerUrl}, and URL scraping has no built-in fallback. Start one with \`docker run -d -p 1969:1969 zotero/translation-server\` (or set ZOTEUS_TRANSLATION_SERVER_URL), then retry.`,
      );
    }
    if (args.action === 'by_identifier') {
      if (tsUp) {
        const items = await ctx.translation.search(args.identifier);
        if (items.length) return await maybeSave(ctx, args, items, 'translation-server');
      }
      // translation-server down (or the identifier failed): try the built-in path.
      try {
        const { items, source } = await resolveBuiltin(ctx, args.identifier);
        return await maybeSave(ctx, args, items, source);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    }
    // by_url
    if (!args.url) return err('`url` is required for by_url.');
    const result = await ctx.translation.web(args.url);
    if (result.multiple) {
      return ok(
        { multiple: result.multiple },
        `The page offers multiple items. Inspect "multiple.items" (key->label) and re-run with a more specific URL, or save a chosen item.`,
      );
    }
    const items = result.items ?? [];
    if (!items.length) return err(`No items found at ${args.url}.`);
    return await maybeSave(ctx, args, items, 'translation-server');
  },
};

/** Save resolved items, tagging the resolution source for provenance. */
async function maybeSave(ctx: ToolContext, args: any, items: any[], source: string): Promise<ToolHandlerResult> {
  const tagged = items.map((it) => ({
    ...it,
    extra: [it?.extra, `resolved:${source}`].filter(Boolean).join('\n'),
  }));
  const payload = tagged;
  if (!args.save_to_library) {
    return ok(
      { items: payload, count: payload.length, saved: false, source },
      `Resolved ${payload.length} item(s) via ${source} (not saved to library).`,
    );
  }
  const lib = resolveLibrary(ctx, args);
  const personal = isPersonalLibrary(lib);
  // Prefer the desktop app for the personal library (no cloud key needed);
  // fall back to the cloud Web API otherwise.
  if (personal && (await ensureLocalApi(ctx)) && ctx.localWrites) {
    try {
      if (args.collection_key) {
        for (const it of payload) it.collections = [...(it.collections ?? []), args.collection_key];
      }
      const result = await ctx.localWrites.writeItems(payload);
      const created = result.successful.map((s) => s.key);
      // The connector path streams attach_url into its save session; the local API has
      // no such session, so the file is stored as a child attachment right after the
      // save. As on the connector path, a failure here degrades to a warning — the
      // items are already in the library and re-running would duplicate them.
      let attached: { key: string; bytes: number; contentType: string; filename: string } | undefined;
      let warning: string | undefined;
      if (args.attach_url) {
        if (!created[0]) {
          warning = `No item key came back from the save, so ${args.attach_url} was not attached.`;
        } else {
          try {
            attached = await attachUrlLocally(ctx, created[0], args.attach_url, args.attach_title);
          } catch (e) {
            const why = e instanceof Error ? e.message : String(e);
            ctx.logger.warn(`Attaching ${args.attach_url} to ${created[0]} failed: ${why}`);
            warning = `Item saved, but attaching ${args.attach_url} failed: ${why}`;
          }
        }
      }
      return writeResult(
        { created, failed: result.failed, resolved: payload.length, source, target: 'local', attached, warning },
        `Imported ${result.successful.length} of ${payload.length} resolved item(s) via ${source} into the library (Zotero desktop)` +
          (attached ? `, with ${attached.bytes}-byte ${attached.filename} attached` : '') +
          '.' +
          (warning ? ` ${warning}` : ''),
        result.successful.length,
        payload.length,
        result.failed,
      );
    } catch (e) {
      if (!isLocalWritesUnavailable(e)) throw e;
      ctx.logger.info(`Local-API writes unavailable (${e instanceof Error ? e.message : e}); using the connector protocol.`);
    }
  }
  if (personal && ctx.connectorWrites && (await ensureLocalApi(ctx))) {
    // Connector protocol: collections are targeted by treeViewID via updateSession,
    // not by the collections array, so strip it from the payload.
    const stripped = payload.map(({ collections: _c, ...rest }) => rest);
    const { sessionID, connectorIds } = await ctx.connectorWrites.saveItems(stripped, {
      uri: 'zotero://zoteus/import',
    });
    let placedIn: string | undefined;
    if (args.collection_key) {
      try {
        const target = await resolveTreeViewId(ctx, args.collection_key);
        if (target) {
          await ctx.connectorWrites.updateSession(sessionID, { target });
          placedIn = target;
        }
      } catch (e) {
        return ok(
          { sessionID, resolved: stripped.length, source, target: 'desktop', warning: String(e) },
          `Saved ${stripped.length} item(s) via ${source}, but could not place them in "${args.collection_key}": ${e}`,
        );
      }
    }
    let attached: { bytes: number; contentType: string } | undefined;
    if (args.attach_url && connectorIds[0]) {
      let file: { bytes: Uint8Array; contentType?: string };
      try {
        file = await downloadAttachment(ctx, args.attach_url);
      } catch (e) {
        if (!(e instanceof AttachmentDownloadError)) throw e;
        return ok(
          { sessionID, resolved: stripped.length, source, target: 'desktop', warning: `File download failed (${e.status}) for ${args.attach_url}` },
          `Saved ${stripped.length} item(s) via ${source}; attachment download failed (${e.status}).`,
        );
      }
      const contentType = file.contentType ?? 'application/pdf';
      const bytes = file.bytes;
      await ctx.connectorWrites.saveAttachment({
        sessionID,
        parentConnectorId: connectorIds[0],
        url: args.attach_url,
        title: args.attach_title ?? 'Full Text PDF',
        bytes,
        contentType,
      });
      attached = { bytes: bytes.length, contentType };
    }
    const created = await pollImportedItems(ctx, stripped);
    return ok(
      {
        sessionID,
        created,
        resolved: stripped.length,
        source,
        target: 'desktop',
        placedIn,
        attached,
        note: created.length < stripped.length
          ? 'Some items could not be matched back yet; they may still appear in Zotero.'
          : undefined,
      },
      `Imported ${created.length}/${stripped.length} resolved item(s) via ${source} into the running Zotero desktop app` +
        (placedIn ? ` (collection ${placedIn})` : '') +
        (attached ? `, with ${attached.bytes}-byte PDF attached` : '') + '.',
    );
  }
  if (args.collection_key) {
    for (const it of payload) it.collections = [...(it.collections ?? []), args.collection_key];
  }
  try {
    requireCloud(ctx, lib);
  } catch (e) {
    return {
      content: [{
        type: 'text',
        text: `${e instanceof Error ? e.message : e} Tip: with the Zotero desktop app running, saving needs no cloud key — start the app (or set ZOTEUS_LOCAL=on) and retry.`,
      }],
      isError: true,
    };
  }
  const result = await ctx.web.writeItems(lib, payload);
  const created = result.successful.map((s) => s.key);
  // The cloud has its own file-storage upload, so attach_url is not desktop-only: the
  // bytes are fetched here and pushed to Zotero storage. As on the desktop paths, a
  // failure degrades to a warning, since the items are already saved and re-running
  // would duplicate them.
  let attached: { key: string; bytes: number; contentType: string; filename: string; alreadyInStorage: boolean } | undefined;
  let warning: string | undefined;
  if (args.attach_url) {
    if (!created[0]) {
      warning = `No item key came back from the save, so ${args.attach_url} was not attached.`;
    } else {
      try {
        attached = await attachUrlToCloud(ctx, lib, created[0], args.attach_url, args.attach_title);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        ctx.logger.warn(`Attaching ${args.attach_url} to ${created[0]} failed: ${why}`);
        warning = `Item saved, but attaching ${args.attach_url} failed: ${why}`;
      }
    }
  }
  return writeResult(
    {
      created,
      failed: result.failed,
      resolved: payload.length,
      source,
      target: 'cloud',
      attached,
      warning,
    },
    `Imported ${result.successful.length} of ${payload.length} resolved item(s) via ${source} into the library` +
      (attached ? `, with ${attached.bytes}-byte ${attached.filename} attached` : '') +
      '.' +
      (warning ? ` ${warning}` : ''),
    result.successful.length,
    payload.length,
    result.failed,
  );
}

export default importTool;

/**
 * Fetch `attach_url` the way both non-connector save paths need it. attach_url is
 * documented as a full-text file (typically a PDF), so that is the content type assumed
 * when neither the server nor the URL says what it is, and `attach_title` names the file
 * when the URL yields nothing usable.
 */
function fetchAttachUrl(ctx: ToolContext, url: string, title?: string) {
  return readAttachmentSource(ctx, { url, titleHint: title, fallbackType: 'application/pdf' });
}

/**
 * Local-API equivalent of the connector protocol's in-session saveAttachment: download
 * `attach_url` and store it as an `imported_file` child of the item just saved.
 */
async function attachUrlLocally(
  ctx: ToolContext,
  parent: string,
  url: string,
  title?: string,
): Promise<{ key: string; bytes: number; contentType: string; filename: string }> {
  const { bytes, filename, contentType } = await fetchAttachUrl(ctx, url, title);
  const key = await storeLocalAttachment(ctx, {
    parent,
    bytes,
    filename,
    contentType,
    title: title ?? 'Full Text PDF',
    url,
  });
  return { key, bytes: bytes.length, contentType, filename };
}

/**
 * Cloud equivalent of the same step, for saves that did not go through the desktop app:
 * push the downloaded bytes into Zotero file storage under the item just created. This
 * is the only attach path a remote/hosted Zoteus has, since it cannot reach the desktop.
 */
async function attachUrlToCloud(
  ctx: ToolContext,
  lib: LibraryRef,
  parent: string,
  url: string,
  title?: string,
): Promise<{ key: string; bytes: number; contentType: string; filename: string; alreadyInStorage: boolean }> {
  const { bytes, filename, contentType } = await fetchAttachUrl(ctx, url, title);
  const stored = await storeCloudAttachment(ctx, lib, {
    parent,
    bytes,
    filename,
    contentType,
    title: title ?? 'Full Text PDF',
    url,
  });
  return { key: stored.key, bytes: bytes.length, contentType, filename, alreadyInStorage: stored.exists };
}


/**
 * Resolve a caller-supplied collection to the connector protocol's treeViewID
 * ("L1" for My Library, "C<id>" for collections). Accepts a treeViewID directly,
 * or an 8-char collection key that is matched by name against the app's target list.
 */
async function resolveTreeViewId(ctx: ToolContext, collectionKey: string): Promise<string | undefined> {
  if (/^[CL]\d+$/.test(collectionKey)) return collectionKey;
  const collections = await ctx.router.listCollections({ limit: 1000 });
  const match = collections.data
    .map((c: any) => c?.data ?? c)
    .find((c: any) => c?.key === collectionKey);
  if (!match) throw new Error(`Collection key ${collectionKey} not found in the library.`);
  const { targets } = await ctx.connectorWrites!.getSelectedCollection();
  const byName = targets.filter((t) => t.name === match.name);
  if (!byName.length) return undefined;
  if (byName.length > 1) {
    throw new Error(
      `Multiple collections named "${match.name}" exist (${byName.map((t) => t.id).join(', ')}); pass an explicit treeViewID instead.`,
    );
  }
  return byName[0]?.id;
}

/** Recover the keys of items just saved through the connector protocol (no payload). */
async function pollImportedItems(ctx: ToolContext, sent: Record<string, unknown>[]): Promise<string[]> {
  const found: string[] = [];
  const deadline = Date.now() + 15_000;
  const wanted = new Set(sent.map((it) => String(it.title ?? '')));
  while (wanted.size && Date.now() < deadline) {
    try {
      const res = await ctx.local!.listItems({ sort: 'dateAdded', direction: 'desc', limit: 25 } as any);
      for (const item of res.data) {
        const d = item?.data ?? item;
        const title = String(d?.title ?? '');
        if (wanted.has(title)) {
          wanted.delete(title);
          found.push(d.key);
        }
      }
    } catch {
      // Keep polling until the deadline.
    }
    if (wanted.size) await new Promise((r) => setTimeout(r, 750));
  }
  return found;
}
