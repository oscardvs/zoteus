import { callerRoot } from './caller-root.js';
import { z } from 'zod';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { provenance, writeFailures, writeTarget, zoteroObject } from './common-output.js';
import type { ToolDefinition, ToolHandlerResult, ToolContext } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import {
  LIBRARY_CONTENT_PROVENANCE,
  ok,
  resolveLibrary,
  isPersonalLibrary,
  requireBulkConfirm,
  requireCloud,
  isLocalWritesUnavailable,
  ensureLocalApi,
  writeResult,
} from '../registry/registry.js';
import { CallerPathError, resolveCallerPath } from '../lib/caller-path.js';
import { arxivItem, fromScholarWork, parseIdentifier, bareDoi, type ResolvedItem } from '../features/resolve/resolve.js';
import { detectKind, fetchAttachmentBytes, resolveAttachment, SOURCE_LABEL } from '../features/attachments/resolve.js';
import { DEFAULT_PRECISE_MAX_BYTES, extractPdfPages } from '../features/fulltext/pdf-pages.js';
import { loadPdfjs, pdfjsUnavailableReason } from '../features/fulltext/pdfjs-loader.js';
import { mappingTables, toZoteroItems } from '../features/import/mapping.js';
import { parseBibliography, sniffFormat, type ImportFormat } from '../features/import/parse.js';
import { hasTextLayer, scanIdentifiers, type IdentifierHit } from '../features/import/scan-identifiers.js';
import { validateItem } from '../schema/validate.js';
import type { ZoteroSchema } from '../schema/schema-service.js';
import {
  duplicateIndexFor,
  findDuplicates,
  incompleteScanNote,
  type DuplicateMatch,
} from '../features/dedupe/find.js';
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
  title: 'Import items by identifier, URL, bibliography file or PDF',
  description:
    'Resolve bibliographic metadata to Zotero item-data and optionally save it to your library. ' +
    '`action: "by_identifier"` resolves a DOI, ISBN, PMID, arXiv id, or ADS bibcode (set `identifier`). ' +
    '`action: "by_url"` scrapes a web page (set `url`) and may return multiple choices to pick from. ' +
    '`action: "by_file"` imports a BibTeX, RIS or CSL-JSON bibliography: set `text` with the contents or `path` with a local file. ' +
    'Those three formats are parsed by Zoteus itself, so they need no translation-server, no Docker and no network; a reachable ' +
    'translation-server is used first when there is one, because it covers more formats (EndNote XML, MODS, RDF). ' +
    '`action: "by_pdf"` recovers metadata for a PDF: set `path` for a file on the machine running Zoteus, or `attachment_key` for a PDF ' +
    'already in the library (the only variant a hosted server can reach). It extracts the text of the first pages, looks for a DOI or an ' +
    'arXiv id, and resolves that; the result says which page the identifier was on, what introduced it, and whether the match was a ' +
    'labelled one or a bare string, because a first page often carries DOIs belonging to other works. It does not read scanned pages ' +
    '(no text layer means no identifier) and it never invents metadata: when nothing is found it says so. ' +
    'Set `save_to_library:true` (and optionally `collection_key`) to persist the resolved items, saved into the running Zotero desktop app ' +
    'when available and otherwise via the cloud Web API (requires ZOTERO_API_KEY); without it the metadata is returned and nothing is ' +
    'written, which makes a file import a free preview of what would be created. ' +
    'When a Zotero translation-server is reachable (ZOTEUS_TRANSLATION_SERVER_URL, default http://127.0.0.1:1969) it is the primary path ' +
    'for identifiers and URLs; with none running, DOI and arXiv ids fall back to built-in resolution (OpenAlex/Crossref and the arXiv API), ' +
    'and the result then carries a `source` field ("scholar" or "arxiv"). ISBN/PMID/bibcode and web URLs require a translation-server. ' +
    'Set `check_duplicates:true` to compare what was resolved against your library first: matching items are reported under `duplicates` ' +
    '(matched on normalised DOI, then ISBN, then normalised title plus year, all exact comparisons rather than similarity), and a save that ' +
    'would add a second copy is refused unless you also pass `allow_duplicate:true`. The scan stops at 5000 top-level items; when it stopped ' +
    'early it saves and says so in the answer rather than refusing, so read `duplicateScan.complete` before treating "no match" as "no". ' +
    'To fold an existing pair of records together instead, ' +
    'call zotero_merge_items.',
  inputSchema: {
    action: z
      .enum(['by_identifier', 'by_url', 'by_file', 'by_pdf'])
      .describe(
        'What to resolve: "by_identifier" takes `identifier` (DOI, ISBN, PMID, arXiv id, ADS bibcode); "by_url" scrapes `url` and needs a translation-server; "by_file" parses a BibTeX/RIS/CSL-JSON bibliography from `text` or `path`; "by_pdf" reads a PDF at `path` or `attachment_key` and resolves the DOI or arXiv id printed in it.',
      ),
    identifier: z.string().optional().describe('DOI (10.…), arXiv id (YYMM.NNNNN), ISBN, PMID, or ADS bibcode.'),
    url: z.string().optional().describe('Web page URL to scrape (needs a translation-server).'),
    text: z
      .string()
      .optional()
      .describe(
        'action:"by_file": the bibliography itself, as text (the contents of a .bib, .ris or CSL-JSON file). Use this instead of `path` when Zoteus runs somewhere the file is not, which includes every hosted deployment.',
      ),
    path: z
      .string()
      .optional()
      .describe(
        'A file on the machine running Zoteus: the bibliography for action:"by_file", the PDF for action:"by_pdf". Refused on a shared/hosted server, where a path would name the operator\'s disk rather than yours; send `text` (by_file) or `attachment_key` (by_pdf) there instead.',
      ),
    format: z
      .enum(['auto', 'bibtex', 'ris', 'csljson'])
      .optional()
      .describe(
        'action:"by_file": what the payload is. Default "auto", which recognises BibTeX by its "@type{" entries, RIS by its "XX  - " tag lines, and CSL-JSON by being JSON. Set it explicitly only when the guess is wrong.',
      ),
    attachment_key: z
      .string()
      .optional()
      .describe(
        'action:"by_pdf": the key of a PDF already in the library (an attachment key, or a parent item whose best PDF attachment is used). This is the only by_pdf route that works on a hosted server, since it needs no filesystem path.',
      ),
    scan_pages: z
      .number()
      .int()
      .optional()
      .describe(
        'action:"by_pdf": how many leading pages to search for an identifier. Default 2. More pages find more, and also find more DOIs that belong to the works this paper CITES rather than to the paper itself.',
      ),
    confirm: z
      .boolean()
      .optional()
      .describe('Required to save more items in one call than ZOTEUS_CONFIRM_BULK_WRITES allows; off by default, so usually unnecessary.'),
    save_to_library: z.boolean().optional().describe('Persist the resolved items: into the running Zotero desktop app when available, otherwise the cloud Web API (needs a cloud key).'),
    collection_key: z.string().optional().describe('Collection to add saved items to: an 8-char collection key or a Zotero treeViewID like "C20".'),
    attach_url: z.string().url().optional().describe('File URL (e.g. an arXiv PDF) to download and attach as a stored attachment to the (single) imported item. Works on every save path: the desktop app when one is reachable, otherwise the cloud Web API.'),
    attach_title: z.string().optional().describe('Title for the attached file, e.g. "Full Text PDF".'),
    check_duplicates: z
      .boolean()
      .optional()
      .describe(
        'Scan the library first and report items that already hold this work, matched by normalised DOI, then ISBN, then normalised title plus year. Default false. With save_to_library, a match REFUSES the save unless allow_duplicate is also set. The scan crawls up to 5000 top-level items (one request per 100), which is why it is opt-in.',
      ),
    allow_duplicate: z
      .boolean()
      .optional()
      .describe('Save even though check_duplicates found a match, or could not run at all. A scan that ran but stopped at its 5000-item cap does not refuse the save on its own: it saves and says how far it looked, so read `duplicateScan.complete`. Only read when check_duplicates is set.'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      source: z
        .string()
        .optional()
        .describe(
          'What resolved the metadata, and what is stamped into each item\'s Extra as `resolved:<source>`: "translation-server", "scholar", "arxiv", "bibtex", "ris", "csljson", "translation-server-import", or "pdf:<identifier type>:<resolver>" for action:"by_pdf".',
        ),
      format: z
        .string()
        .optional()
        .describe('action:"by_file": which parser read the payload ("bibtex", "ris", "csljson", or "translation-server" when one took it).'),
      parsed: z.number().optional().describe('action:"by_file": how many entries the payload held.'),
      mapping: z
        .string()
        .optional()
        .describe(
          'action:"by_file", built-in parsers only: where the CSL-to-Zotero tables came from. "schema" is the live Zotero schema, which also places each field on the right type-specific field; "snapshot" is the offline copy, used when the schema could not be fetched, which places fields less well.',
        ),
      skipped: z
        .array(
          z
            .object({
              entry: z.string().describe('The entry, named by its citation key or its position in the file.'),
              reason: z.string().describe('Why it was not imported.'),
            })
            .passthrough(),
        )
        .optional()
        .describe('Entries the file held that were NOT turned into items, and why. They are not saved and not returned.'),
      warnings: z
        .array(z.string())
        .optional()
        .describe('What the import could not do exactly: an entry type with no Zotero equivalent, a crossref that was not followed, a creator role the item type does not allow.'),
      identifierFound: z
        .object({
          type: z.string().describe('"doi" or "arxiv".'),
          value: z.string().describe('The identifier, canonicalised.'),
          page: z.number().describe('1-based page of the PDF it was found on.'),
          label: z.string().describe('What introduced it in the text ("doi:", "https://doi.org/", "arXiv:"), or empty for a bare match.'),
          context: z.string().describe('The words around it on the page, so the claim can be checked.'),
          confidence: z.string().describe('"high" when a label introduced it, "low" for a bare match that may belong to another work.'),
        })
        .passthrough()
        .optional()
        .describe('action:"by_pdf": the identifier that was resolved, and where in the PDF it came from.'),
      identifierCandidates: z
        .array(z.record(z.unknown()))
        .optional()
        .describe('action:"by_pdf": every identifier found in the scanned pages, strongest first. A first page often carries DOIs belonging to cited works, so this is worth reading before saving.'),
      pagesScanned: z.number().optional().describe('action:"by_pdf": how many pages were searched.'),
      textLayer: z
        .boolean()
        .optional()
        .describe('action:"by_pdf": false when the scanned pages carried no text at all, i.e. the PDF is a scan. No identifier can be found in one, and there is no OCR here.'),
      pdfSource: z
        .string()
        .optional()
        .describe('action:"by_pdf": where the bytes came from ("path", or the attachment source: the running desktop app, the local storage folder, or Zotero cloud storage).'),
      provenance,
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
      note: z
        .string()
        .optional()
        .describe('Something the caller should know about the result: fewer items matched back than were sent, or a PDF scan that found no identifier.'),
      multiple: z
        .record(z.unknown())
        .optional()
        .describe('action:"by_url" on a page offering several items: the choices, as key to label. Re-run with a more specific URL.'),
      duplicates: z
        .array(
          z
            .object({
              item_key: z.string().describe('Key of the library item that already holds this work.'),
              title: z.string().optional().describe('Its title, as the library holds it.'),
              itemType: z.string().optional().describe('Its Zotero item type.'),
              year: z.string().optional().describe('The year in its date field, when it has one.'),
              matchedOn: z.string().describe('Which identifier matched: "doi", "isbn" or "title".'),
              value: z.string().describe('The normalised value both records share.'),
              candidate: z.string().optional().describe('Title of the resolved item this library item matched.'),
            })
            .passthrough(),
        )
        .optional()
        .describe('Items already in the library that match what was resolved; present only when check_duplicates was set.'),
      duplicateScan: z
        .object({
          scanned: z.number().describe('Top-level items compared.'),
          complete: z.boolean().describe('False when the scan stopped at its cap, which makes "no match" unreliable.'),
          totalResults: z.number().optional().describe('Top-level items the library reports holding.'),
          note: z.string().optional().describe('What the scan could not cover, when it did not cover everything.'),
        })
        .passthrough()
        .optional()
        .describe('How much of the library the duplicate check actually compared.'),
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
    // The two new actions probe for a translation-server on their own terms (by_file uses
    // one when it is there, by_pdf never needs one), so they branch before the probe below.
    if (args.action === 'by_file') return await importFromFile(ctx, args);
    if (args.action === 'by_pdf') return await importFromPdf(ctx, args);
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

/**
 * Save resolved items, tagging the resolution source for provenance, after the optional
 * duplicate check has had its say.
 *
 * The check lives here rather than in the three save branches below because this is the one
 * place every save passes through, and a preflight that only guarded two of the three would
 * be worse than none: the branch it missed is chosen by whether the desktop app happens to
 * be running.
 */
async function maybeSave(ctx: ToolContext, args: any, items: any[], source: string): Promise<ToolHandlerResult> {
  const payload = items.map((it) => ({
    ...it,
    extra: [it?.extra, `resolved:${source}`].filter(Boolean).join('\n'),
  }));
  const preflight = await duplicatePreflight(ctx, args, payload);
  if (preflight.refusal) return preflight.refusal;
  return withExtraFields(await saveResolved(ctx, args, payload, source), preflight.report);
}

/** What a duplicate check found, and the save it refuses because of it. */
interface DuplicatePreflight {
  refusal?: ToolHandlerResult;
  report: Record<string, unknown>;
}

/**
 * Scan the library for items that already hold what was just resolved.
 *
 * Four rules, and they are the whole feature:
 *  - it runs only when the caller asks for it, so no existing call changes behaviour;
 *  - a match refuses a SAVE, never a resolution: reporting is always allowed;
 *  - a check that could not RUN refuses the save too, because "I did not find one" from a
 *    scan that never happened is not evidence of anything. `allow_duplicate` is the way past
 *    both;
 *  - a check that ran but stopped at MAX_CENSUS_ITEMS does NOT refuse the save, because
 *    every library above the cap would then be unimportable without `allow_duplicate`, and
 *    that flag also switches off the refusal for the matches the scan DID find, i.e. it
 *    would trade a reliable protection for an unreliable one. Instead the answer says how
 *    far the scan looked, in the prose as well as in `duplicateScan`, so "no match" from a
 *    truncated crawl is never read as a clean one. See {@link withExtraFields}.
 */
async function duplicatePreflight(ctx: ToolContext, args: any, payload: any[]): Promise<DuplicatePreflight> {
  if (!args.check_duplicates) return { report: {} };
  const lib = resolveLibrary(ctx, args);
  let index;
  try {
    index = await duplicateIndexFor(ctx, lib);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    if (!args.save_to_library || args.allow_duplicate) {
      return { report: { duplicateScan: { scanned: 0, complete: false, note: `The duplicate check failed: ${why}` } } };
    }
    return {
      report: {},
      refusal: err(
        `The duplicate check could not be completed (${why}), so nothing was saved: a save was asked for on the ` +
          'condition that it is not a duplicate, and that condition could not be evaluated. Retry, or pass ' +
          'allow_duplicate:true to save without the check.',
      ),
    };
  }
  const found = findDuplicates(index, payload);
  const duplicates = found.flatMap((c) =>
    c.matches.map((m: DuplicateMatch) => ({ ...m, candidate: c.candidateTitle })),
  );
  const note = incompleteScanNote(index);
  const report: Record<string, unknown> = {
    duplicates,
    duplicateScan: {
      scanned: index.scanned,
      complete: index.complete,
      totalResults: index.totalResults,
      note,
    },
  };
  if (!duplicates.length || !args.save_to_library || args.allow_duplicate) return { report };
  const listed = duplicates
    .map((d) => `${d.item_key} (${d.matchedOn}: ${d.value})${d.title ? ` "${d.title}"` : ''}`)
    .join('; ');
  return {
    report,
    refusal: err(
      `Refusing to save: your library already holds ${duplicates.length} matching item(s): ${listed}. ` +
        'This is an exact comparison of normalised identifiers (DOI, then ISBN, then title plus year), not a ' +
        'similarity judgement, so check the item before deciding. To save anyway, re-run with ' +
        'allow_duplicate:true; to fold the records together instead, call zotero_merge_items ' +
        '(it previews by default).',
    ),
  };
}

/**
 * Add fields to a save result without disturbing what it already says: the duplicate
 * report, and whatever the new file/PDF actions learned on the way in.
 *
 * `ok()` and `writeResult()` both return exactly two blocks, the summary and the JSON mirror
 * of the same object, and many clients read only the text, so the mirror has to be rebuilt
 * rather than left behind.
 */
function withExtraFields(res: ToolHandlerResult, report: Record<string, unknown>): ToolHandlerResult {
  if (!Object.keys(report).length || !res.structuredContent || res.content.length !== 2) return res;
  const structured = { ...res.structuredContent, ...report };
  // A duplicate check that stopped at its cap still lets the save through, so its caveat has
  // to ride the SUMMARY and not only the mirror: "Imported 1 of 1 item(s)" on its own reads
  // as a clean result, and a "no match" from a crawl that covered half the library is the
  // one answer this check must never present as clean.
  const scanNote = (report.duplicateScan as { note?: unknown } | undefined)?.note;
  const first = res.content[0]!;
  const summary =
    typeof scanNote === 'string' && scanNote && !first.text.includes(scanNote)
      ? { type: 'text' as const, text: `${first.text} ${scanNote}` }
      : first;
  return {
    ...res,
    content: [summary, { type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

async function saveResolved(ctx: ToolContext, args: any, payload: any[], source: string): Promise<ToolHandlerResult> {
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

/* ------------------------------------------------------------------ *
 * action:"by_file": a bibliography handed over as text or as a file.
 * ------------------------------------------------------------------ */

/**
 * The most text one call may hand over.
 *
 * Two megabytes is roughly a ten-thousand-entry .bib, which is far above the entry cap that
 * will refuse it a moment later; the byte cap exists so that a payload which is not a
 * bibliography at all (a PDF pasted as text, a database dump) is refused before it is parsed
 * rather than after.
 */
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

const megabytes = (bytes: number): string => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** The head of a payload, for a message that has to say what was actually received. */
function preview(text: string): string {
  const head = text.replace(/\s+/g, ' ').trim().slice(0, 80);
  return head.length < text.trim().length ? `${head}…` : head;
}

/** Warnings are for reading, not for scrolling: past this many, the rest is summarised. */
const MAX_REPORTED_WARNINGS = 40;

function capWarnings(warnings: string[]): string[] {
  if (warnings.length <= MAX_REPORTED_WARNINGS) return warnings;
  return [
    ...warnings.slice(0, MAX_REPORTED_WARNINGS),
    `(${warnings.length - MAX_REPORTED_WARNINGS} further warnings of the same kinds are not listed.)`,
  ];
}

/**
 * The live Zotero schema, or undefined when it could not be fetched.
 *
 * Undefined is a working state, not a failure: the mapper falls back to a frozen copy of the
 * schema's CSL tables, which is how importing a local .bib into a running Zotero desktop app
 * keeps working on a machine with no network. The result says which was used.
 */
async function loadSchema(ctx: ToolContext): Promise<ZoteroSchema | undefined> {
  try {
    return await ctx.schema?.getSchema();
  } catch (e) {
    ctx.logger?.info?.(
      `The Zotero schema could not be fetched (${e instanceof Error ? e.message : String(e)}); ` +
        'mapping from the offline snapshot instead.',
    );
    return undefined;
  }
}

/** Refuse a payload with more entries than the operator allows in one call. */
function overEntryCap(ctx: ToolContext, count: number): ToolHandlerResult | undefined {
  const cap = ctx.config?.importMaxEntries ?? 200;
  if (count <= cap) return undefined;
  return err(
    `This payload holds ${count} entries, which is over this server's import cap of ${cap} ` +
      '(ZOTEUS_IMPORT_MAX_ENTRIES). Nothing was written, and the entries are not returned either: a file this ' +
      'size is exactly where an accidental bulk write costs the most, and a result that large is not readable ' +
      'anyway. Split the file into smaller ones, or raise ZOTEUS_IMPORT_MAX_ENTRIES.',
  );
}

/** The payload itself, from `text` or from a file the caller is allowed to name. */
async function readBibliographyPayload(
  ctx: ToolContext,
  args: any,
): Promise<{ text: string } | { error: string }> {
  const hasText = typeof args.text === 'string' && args.text.trim().length > 0;
  const hasPath = typeof args.path === 'string' && args.path.trim().length > 0;
  if (hasText && hasPath) {
    return {
      error:
        'Pass either `text` (the bibliography itself) or `path` (a file on this machine), not both. ' +
        'Nothing was read, because which of the two you meant decides what gets imported.',
    };
  }
  if (hasText) {
    const size = Buffer.byteLength(args.text, 'utf8');
    if (size > MAX_PAYLOAD_BYTES) {
      return {
        error: `\`text\` is ${megabytes(size)}, over the ${megabytes(MAX_PAYLOAD_BYTES)} payload cap. Nothing was parsed. Split it.`,
      };
    }
    return { text: args.text as string };
  }
  if (!hasPath) {
    return {
      error:
        'action:"by_file" needs the bibliography: set `text` to its contents, or `path` to a .bib/.ris/.json file ' +
        'on the machine running Zoteus. To import a single known identifier instead, use action:"by_identifier".',
    };
  }
  let resolved: string;
  try {
    resolved = await resolveCallerPath(args.path, {
      dataDir: await callerRoot(ctx),
      confined: ctx.remoteCaller,
      mode: 'read',
      argName: 'path',
      alternative: 'Paste the file contents into `text` instead: that works on every deployment.',
    });
  } catch (e) {
    if (e instanceof CallerPathError) return { error: e.message };
    throw e;
  }
  try {
    const info = await stat(resolved);
    if (info.size > MAX_PAYLOAD_BYTES) {
      return {
        error: `${args.path} is ${megabytes(info.size)}, over the ${megabytes(MAX_PAYLOAD_BYTES)} payload cap. Nothing was read. Split the file.`,
      };
    }
  } catch (e) {
    return { error: `${args.path} could not be opened: ${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    return { text: await readFile(resolved, 'utf8') };
  } catch (e) {
    return { error: `${args.path} could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * The translation-server's own import translators, when one happens to be running.
 *
 * Returns undefined for every reason a caller should not care about (no server, no method,
 * no translator matched, the request failed), because the built-in parsers are behind it and
 * they are the path most installs take. This is an upgrade, never a requirement.
 */
async function importViaTranslationServer(ctx: ToolContext, text: string): Promise<any[] | undefined> {
  const client = ctx.translation as { isUp?: () => Promise<boolean>; import?: (payload: string) => Promise<any[]> };
  if (typeof client?.isUp !== 'function' || typeof client.import !== 'function') return undefined;
  try {
    if (!(await client.isUp())) return undefined;
    const items = await client.import(text);
    return items?.length ? items : undefined;
  } catch (e) {
    ctx.logger?.info?.(
      `The translation-server did not take this payload (${e instanceof Error ? e.message : String(e)}); ` +
        'using the built-in parser.',
    );
    return undefined;
  }
}

interface FileImportMeta {
  source: string;
  format: string;
  parsed: number;
  mapping?: string;
  warnings: string[];
  skipped: Array<{ entry: string; reason: string }>;
}

/** Gate the bulk write, save (or not), and attach everything learned on the way in. */
async function finishFileImport(
  ctx: ToolContext,
  args: any,
  items: any[],
  meta: FileImportMeta,
): Promise<ToolHandlerResult> {
  if (args.save_to_library) {
    const refusal = requireBulkConfirm(ctx, items.length, 'import', args.confirm);
    if (refusal) return refusal;
  }
  const saved = await maybeSave(ctx, args, items, meta.source);
  return withExtraFields(saved, {
    format: meta.format,
    parsed: meta.parsed,
    ...(meta.mapping ? { mapping: meta.mapping } : {}),
    ...(meta.warnings.length ? { warnings: capWarnings(meta.warnings) } : {}),
    ...(meta.skipped.length ? { skipped: meta.skipped } : {}),
    provenance: LIBRARY_CONTENT_PROVENANCE,
  });
}

async function importFromFile(ctx: ToolContext, args: any): Promise<ToolHandlerResult> {
  const payload = await readBibliographyPayload(ctx, args);
  if ('error' in payload) return err(payload.error);
  const { text } = payload;

  const viaServer = await importViaTranslationServer(ctx, text);
  if (viaServer) {
    const capped = overEntryCap(ctx, viaServer.length);
    if (capped) return capped;
    // Translator output is Zotero-JSON already, so there is nothing here to map and nothing
    // for the schema tables to do. It is also not validated, exactly as the by_identifier
    // and by_url paths do not validate it: per-entry refusals surface in `failed`.
    return await finishFileImport(ctx, args, viaServer, {
      source: 'translation-server-import',
      format: 'translation-server',
      parsed: viaServer.length,
      warnings: [],
      skipped: [],
    });
  }

  const requested: ImportFormat | undefined =
    args.format && args.format !== 'auto' ? (args.format as ImportFormat) : undefined;
  const format = requested ?? sniffFormat(text);
  if (!format) {
    return err(
      'Could not tell what format this payload is, so nothing was parsed. Zoteus reads BibTeX (entries opening ' +
        '"@article{"), RIS (lines like "TY  - JOUR") and CSL-JSON (a JSON array of item objects). What arrived ' +
        `starts: "${preview(text)}". Set \`format\` explicitly if it is one of those three, or convert the file first.`,
    );
  }

  let parsed;
  try {
    parsed = parseBibliography(text, format);
  } catch (e) {
    return err(`This payload could not be read as ${format}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!parsed.records.length) {
    return err(
      `No entries could be read from this ${format} payload, so nothing was imported.` +
        (parsed.warnings.length ? ` ${parsed.warnings.join(' ')}` : '') +
        ` What arrived starts: "${preview(text)}".`,
    );
  }
  const capped = overEntryCap(ctx, parsed.records.length);
  if (capped) return capped;

  const schema = await loadSchema(ctx);
  const tables = mappingTables(schema);
  const mapped = toZoteroItems(parsed.records, tables);
  const labels = parsed.records.map((r) => r.label);

  // Validated before the write, not after: #77's `Imported 0 of 1` came from Zotero refusing
  // one item with no error of its own, and a file import multiplies that by the entry count.
  const items: any[] = [];
  const skipped: Array<{ entry: string; reason: string }> = [];
  mapped.items.forEach((item, index) => {
    const problems = schema ? validateItem(schema, item).errors : [];
    if (problems.length) skipped.push({ entry: labels[index] ?? `entry ${index + 1}`, reason: problems.join(' ') });
    else items.push(item);
  });
  if (!items.length) {
    return err(
      `All ${mapped.items.length} entries in this ${format} payload were refused by Zotero's schema, so nothing ` +
        `was imported: ${skipped.slice(0, 5).map((s) => `${s.entry} (${s.reason})`).join('; ')}`,
    );
  }

  return await finishFileImport(ctx, args, items, {
    source: format,
    format,
    parsed: parsed.records.length,
    mapping: tables.origin,
    warnings: [...parsed.warnings, ...mapped.warnings],
    skipped,
  });
}

/* ------------------------------------------------------------------ *
 * action:"by_pdf": metadata recovery from the PDF itself.
 * ------------------------------------------------------------------ */

const DEFAULT_SCAN_PAGES = 2;
const MAX_SCAN_PAGES = 10;

interface PdfBytes {
  bytes: Uint8Array;
  filename?: string;
  contentType?: string;
  /** Where the bytes came from, for the result. */
  source: string;
  /** How to name the file in a message. */
  label: string;
}

/** The PDF, from a path the caller may name or from an attachment already in the library. */
async function readPdfBytes(ctx: ToolContext, args: any): Promise<PdfBytes | { error: string }> {
  const hasPath = typeof args.path === 'string' && args.path.trim().length > 0;
  const hasKey = typeof args.attachment_key === 'string' && args.attachment_key.trim().length > 0;
  if (hasPath && hasKey) {
    return {
      error:
        'Pass either `path` (a PDF on this machine) or `attachment_key` (a PDF already in the library), not both. ' +
        'Nothing was read.',
    };
  }
  if (hasKey) {
    const lib = resolveLibrary(ctx, args);
    const key = (args.attachment_key as string).trim();
    const resolved = await resolveAttachment(ctx, key, lib);
    if ('error' in resolved) return { error: resolved.error };
    const fetched = await fetchAttachmentBytes(ctx, resolved, lib);
    if (fetched.tooLarge) {
      return {
        error:
          `Attachment ${resolved.attachmentKey} is over the ${megabytes(DEFAULT_PRECISE_MAX_BYTES)} parsing cap, so it ` +
          'was not read. The cap exists because the PDF parser needs several times the file size in memory.',
      };
    }
    if (!fetched.bytes) {
      return {
        error:
          `The bytes of attachment ${resolved.attachmentKey} could not be read: ` +
          `${fetched.reasons.join('; ') || 'no source could produce them'}.`,
      };
    }
    return {
      bytes: fetched.bytes,
      filename: resolved.filename,
      contentType: resolved.contentType,
      source: fetched.source ? SOURCE_LABEL[fetched.source] : 'unknown',
      label: `attachment ${resolved.attachmentKey}`,
    };
  }
  if (!hasPath) {
    return {
      error:
        'action:"by_pdf" needs a PDF: set `path` to a file on the machine running Zoteus, or `attachment_key` to a ' +
        'PDF already in your library. On a hosted server only `attachment_key` can work, since a path there would ' +
        "name the operator's disk.",
    };
  }
  let resolvedPath: string;
  try {
    resolvedPath = await resolveCallerPath(args.path, {
      dataDir: await callerRoot(ctx),
      confined: ctx.remoteCaller,
      mode: 'read',
      argName: 'path',
      alternative:
        'Add the PDF to Zotero and pass its `attachment_key` instead: that reaches the file through the library ' +
        'rather than through the filesystem, and works on every deployment.',
    });
  } catch (e) {
    if (e instanceof CallerPathError) return { error: e.message };
    throw e;
  }
  try {
    const info = await stat(resolvedPath);
    if (info.size > DEFAULT_PRECISE_MAX_BYTES) {
      return {
        error:
          `${args.path} is ${megabytes(info.size)}, over the ${megabytes(DEFAULT_PRECISE_MAX_BYTES)} parsing cap, so it ` +
          'was not read. The cap exists because the PDF parser needs several times the file size in memory.',
      };
    }
  } catch (e) {
    return { error: `${args.path} could not be opened: ${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    const bytes = new Uint8Array(await readFile(resolvedPath));
    return { bytes, filename: basename(resolvedPath), source: 'path', label: args.path as string };
  } catch (e) {
    return { error: `${args.path} could not be read: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Resolve a scraped identifier the same way action:"by_identifier" resolves a typed one. */
async function resolvePdfIdentifier(ctx: ToolContext, id: string): Promise<{ items: any[]; source: string }> {
  const client = ctx.translation as { isUp?: () => Promise<boolean>; search?: (id: string) => Promise<any[]> };
  if (typeof client?.isUp === 'function' && typeof client.search === 'function' && (await client.isUp())) {
    try {
      const items = await client.search(id);
      if (items?.length) return { items, source: 'translation-server' };
    } catch {
      // The built-in resolver is behind this and covers DOIs and arXiv ids, which is what a
      // PDF scan produces; a translation-server miss is not the end of the call.
    }
  }
  return await resolveBuiltin(ctx, id);
}

/** How a hit reads in a sentence, so a caller can judge it without opening the payload. */
function describeHit(hit: IdentifierHit): string {
  const what = hit.type === 'doi' ? 'DOI' : 'arXiv id';
  const how = hit.label
    ? `introduced by "${hit.label}"`
    : 'a bare match, with nothing introducing it, so it may belong to a work this one cites';
  return `${what} ${hit.value} on page ${hit.page} (${how})`;
}

async function importFromPdf(ctx: ToolContext, args: any): Promise<ToolHandlerResult> {
  const file = await readPdfBytes(ctx, args);
  if ('error' in file) return err(file.error);

  const kind = detectKind(file.bytes, file.contentType, file.filename);
  if (kind !== 'pdf') {
    return err(
      `${file.label} is not a PDF (the bytes look like ${kind === 'epub' ? 'an EPUB' : 'neither a PDF nor an EPUB'}), ` +
        'so nothing was read from it. action:"by_pdf" reads PDFs only.',
    );
  }
  // Through the shared loader, which masks process.type so the parser also loads inside
  // Claude Desktop's Electron. Asked separately from the extraction so that "the parser is
  // not available here" is never reported as "this PDF is corrupt".
  if (!(await loadPdfjs())) {
    return err(
      `${file.label} could not be read because ${pdfjsUnavailableReason()}. Metadata recovery needs the PDF's text. ` +
        'Use action:"by_identifier" with a DOI you read off the page instead.',
    );
  }
  const pages = await extractPdfPages(file.bytes);
  if (!pages) {
    return err(
      `${file.label} could not be parsed as a PDF. It is most likely damaged or encrypted; nothing was read from it ` +
        'and nothing was saved.',
    );
  }

  const requestedPages = Number.isFinite(args.scan_pages) ? Number(args.scan_pages) : DEFAULT_SCAN_PAGES;
  const wanted = Math.min(Math.max(1, Math.trunc(requestedPages)), MAX_SCAN_PAGES);
  const scanned = pages.slice(0, wanted);
  const candidates = scanIdentifiers(scanned);
  const textLayer = hasTextLayer(scanned);
  const base = {
    pagesScanned: scanned.length,
    textLayer,
    pdfSource: file.source,
    identifierCandidates: candidates as unknown as Record<string, unknown>[],
    provenance: LIBRARY_CONTENT_PROVENANCE,
  };

  if (!candidates.length) {
    const why = textLayer
      ? `${scanned.length} page(s) of text were read and none carried a DOI or an arXiv id.`
      : `The ${scanned.length} page(s) read carry no text at all, so this file is a scan. There is nothing to ` +
        'search in it. Metadata recovery does not run OCR; for a PDF already in Zotero, use ' +
        'zotero_get_fulltext with its item_key and ocr:true where OCR is enabled, then import the identifier you read.';
    return ok(
      { ...base, saved: false, count: 0, note: `${why} No metadata was invented and nothing was saved.` },
      `No identifier found in ${file.label}. ${why} Next: read page 1 as an image with zotero_pdf_images and pass ` +
        'the DOI you can see to zotero_import action:"by_identifier", or raise `scan_pages`.',
    );
  }

  const chosen = candidates[0]!;
  let resolved: { items: any[]; source: string };
  try {
    resolved = await resolvePdfIdentifier(ctx, chosen.value);
  } catch (e) {
    return err(
      `Found ${describeHit(chosen)} in ${file.label}, but it could not be resolved to a record: ` +
        `${e instanceof Error ? e.message : String(e)} Nothing was saved and no metadata was invented. ` +
        (candidates.length > 1
          ? `Other identifiers on those pages: ${candidates.slice(1, 4).map((c) => c.value).join(', ')}.`
          : ''),
    );
  }

  const saved = await maybeSave(ctx, args, resolved.items, `pdf:${chosen.type}:${resolved.source}`);
  return withExtraFields(saved, { ...base, identifierFound: chosen as unknown as Record<string, unknown> });
}
