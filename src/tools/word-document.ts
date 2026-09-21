import { z } from 'zod';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ToolDefinition, ToolHandlerResult, ToolContext } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { okLibraryContent, optionalLibrary } from '../registry/registry.js';
import { provenance } from './common-output.js';
import { callerRoot } from './caller-root.js';
import { resolveCallerPath, CallerPathError } from '../lib/caller-path.js';
import { renderCitations, type Cluster } from '../features/citation/citeproc-engine.js';
import { buildDocx, type Block, type Piece } from '../features/docx/document.js';
import { collectItemKeys, parseParagraph, type PlaceholderItem } from '../features/docx/placeholders.js';
import { stripIllegalXml } from '../features/docx/xml.js';
import {
  bibliographyFieldCode,
  citationFieldCode,
  CSL_CITATION_SCHEMA,
  documentPrefsXml,
  hasBindableId,
  isNoteStyle,
  itemUri,
  randomFieldId,
  type CitationItemPayload,
  type LibraryIdentity,
} from '../features/docx/zotero-fields.js';

/**
 * Write a .docx carrying live Zotero citation fields.
 *
 * The difference between this and zotero_format_bibliography is the difference between a
 * picture of a citation and a citation: the field codes here are what Zotero's Word plugin
 * reads on Refresh, so changing style or editing the item in Zotero re-renders the document.
 *
 * What is verified and what is not, stated once so the strings below can be honest: the
 * package is a valid .docx (correct CRCs, content types, relationships) and its XML carries
 * correctly-formed Zotero field codes and document preferences, all of which is tested. That
 * Word's Zotero plugin then REFRESHES those fields was never run: no Word and no Zotero Word
 * plugin exist on the machine this was built on. Every user-visible string says so, the
 * description included, and a test asserts it: the description is the one string an
 * assistant reads BEFORE calling anything, so a promise made only there is the one nobody
 * can check. It is also the one string that gets truncated (zotero_search_tools shows the
 * first 220 characters), so the caveat has to sit inside them.
 */

function err(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** A filename stem that is safe on every filesystem and still recognisable. */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'document';
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-');
}

/**
 * Six random hex characters in the default filename.
 *
 * The rest of the stem is derivable by anyone who knows the document title and roughly when it
 * was written: `slugify(title)` plus a wall-clock second. On a shared server that is a name
 * another tenant could guess, and a guessed name is enough to fetch the file
 * (zotero_attachment action:"upload" reads any path it is given). The tenant subtree below is
 * the real boundary; this is what makes a guess at the name useless even to someone inside it.
 */
function nonce(): string {
  return randomBytes(3).toString('hex');
}

/**
 * CSL-JSON for one item key, through the routed read.
 *
 * One request per key, rather than one batched export for all of them, and that is
 * deliberate rather than lazy: a `format=csljson` export carries no item key at all. Its
 * `id` is whatever Zotero's CSL-JSON export puts there (a Better BibTeX citation key on a
 * desktop that has the plugin, a URI elsewhere), so a batched export of five keys gives
 * five records and no sound way to say which belongs to which placeholder. Keys are
 * de-duplicated before this is called, so a paper cited twenty times is fetched once.
 */
async function fetchCslItem(
  ctx: ToolContext,
  library: { type: 'user' | 'group'; id: number },
  itemKey: string,
): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await ctx.router.exportItems({ library, format: 'csljson', itemKey: [itemKey], limit: 1 });
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  // The cloud's csljson export wraps items in { items: [...] }; the desktop app's is a
  // bare array. Both shapes are already handled everywhere else in this repo.
  const list = Array.isArray(parsed) ? parsed : ((parsed as { items?: unknown[] })?.items ?? []);
  const first = Array.isArray(list) ? list[0] : undefined;
  return first && typeof first === 'object' ? (first as Record<string, unknown>) : null;
}

/**
 * The library identity the item URIs are built from.
 *
 * `users/0` is how the desktop app addresses the personal library when no cloud key is
 * configured (src/api/local-client.ts), and `http://zotero.org/users/0/items/KEY` matches
 * nothing in any Zotero. The real numeric id is recoverable without a cloud key: every item
 * record the local API returns carries its own `library` block with the account's real
 * userID in it, so one item read is enough. A group library already carries a real id and
 * is never probed.
 */
async function resolveIdentity(
  ctx: ToolContext,
  library: { type: 'user' | 'group'; id: number },
  probeKey: string | undefined,
): Promise<LibraryIdentity> {
  if (library.type !== 'user' || library.id > 0) return library;
  const cloudId = ctx.capabilities?.cloud?.userID;
  if (Number.isInteger(cloudId) && (cloudId as number) > 0) return { type: 'user', id: cloudId as number };
  if (!probeKey) return library;
  try {
    const item = await ctx.router.getItem(probeKey, { library });
    const id = Number(item?.library?.id);
    const type = item?.library?.type === 'group' ? 'group' : 'user';
    if (Number.isInteger(id) && id > 0) return { type, id };
  } catch {
    // A library whose id cannot be read is the documented degraded case, not an error.
  }
  return library;
}

const wordDocument: ToolDefinition = {
  name: 'zotero_word_document',
  title: 'Write a Word document with live Zotero citations',
  description:
    'Write a .docx whose citations are LIVE Zotero fields, not plain text: Zotero\'s Word plugin is meant to refresh, restyle and add to them (never run here, so check your first document). Give `body` as paragraphs containing `[[cite:ITEMKEY]]` or `[[cite:ITEMKEY,p. 12]]` placeholders; `[[cite:KEY1;KEY2]]` puts several works in one field, which is how "(Wu, 2026; Devos, 2026)" is written. Each placeholder becomes a Word field carrying the item\'s CSL data, with the formatted citation as its visible text. A bibliography field is appended by default. For plain formatted references with no live fields use zotero_bibliography or zotero_format_bibliography instead. The file is written to disk and the path is returned; on a shared deployment it is confined to the server data directory. Refreshing needs Microsoft Word with the Zotero word-processor plugin, and Zotero running: nothing else re-renders the fields. What is verified is the package and the field codes, by unpacking the .docx and checking its XML; a refresh in Word has never been run, and LibreOffice\'s Zotero extension uses ReferenceMarks rather than Word fields, so whether it adopts this document is untested as well. This writes paragraphs and citation fields and nothing else: no headings beyond `title`, no tables, no images, and no footnotes, so a note style renders its notes inline in the body.',
  inputSchema: {
    body: z
      .array(z.string())
      .min(1)
      .describe('Paragraphs of the document, in order. Each may contain [[cite:ITEMKEY]] or [[cite:ITEMKEY,locator]] placeholders.'),
    title: z.string().optional().describe('Document title, written as a heading and into the file metadata.'),
    style: z.string().optional().describe('Citation style id or name, e.g. "apa" or "Chicago Manual of Style 17th edition" (default APA). Resolved with zotero_styles.'),
    locale: z.string().optional().describe('CSL locale for the rendered citations, e.g. "en-US" (default "en-US").'),
    bibliography: z.boolean().optional().describe('Append a live Zotero bibliography field after the body (default true).'),
    save_path: z
      .string()
      .optional()
      .describe('Where to write the .docx. Defaults to a file under the server data directory; confined to it on a shared deployment.'),
    overwrite: z
      .boolean()
      .optional()
      .describe('Allow `save_path` to replace a file that already exists (default false). A .docx at a path you chose is usually a document you have been editing.'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      savedTo: z.string().describe('Absolute path of the .docx that was written.'),
      bytes: z.number().describe('Size of the file on disk.'),
      citations: z
        .array(
          z
            .object({
              item_key: z.string().describe('Item the field cites; the first one when the field cites several.'),
              item_keys: z.array(z.string()).describe('Every item key carried by this field, in order.'),
              locator: z.string().optional().describe('Page or other locator carried in the field.'),
              rendered: z.string().describe('The visible citation text Word shows before a refresh.'),
            })
            .passthrough(),
        )
        .describe('One entry per live citation field written, in document order.'),
      style: z.string().describe('Citation style the fields were rendered and stamped with.'),
      locale: z.string().describe('CSL locale stamped into the document preferences.'),
      bibliography: z.boolean().describe('Whether a live bibliography field was written.'),
      missing: z
        .array(z.string())
        .optional()
        .describe('Placeholder item keys that could not be resolved in the library; their placeholders were left as plain text rather than faked.'),
      linked: z
        .boolean()
        .describe('Whether the fields carry Zotero item URIs. False means they carry the item data but are not linked to library items, so Zotero treats them as embedded references.'),
      warnings: z
        .array(z.string())
        .optional()
        .describe('Things about this document the caller should repeat to the user, e.g. unresolved items or a note style rendered inline.'),
      refreshNote: z
        .string()
        .describe('What is needed for the fields to refresh, stated plainly so the caller does not promise more than the file can do.'),
      provenance,
    })
    .passthrough(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    const now = new Date();
    const wantBibliography = args.bibliography !== false;

    // Caller-supplied paths are resolved before any library or network work: on a shared
    // deployment they address the operator's disk, not the caller's.
    //
    // The escape is CONFINED, not refused, and that difference is the whole feature on a
    // hosted server. zotero_pdf_images can refuse `save` outright because it has an inline
    // channel to fall back on; a .docx has none (ToolContent is text or image only), so
    // refusing would leave every hosted caller with nothing at all. Instead the bad path is
    // dropped, the document is written to the default location inside the data directory,
    // and the result says so loudly enough that nobody goes looking in the wrong place.
    //
    // The default location, and the confinement root, are the CALLER's subtree of the data
    // directory rather than the data directory itself (see callerRoot): a hosted deployment
    // has one data directory and many tenants, and a document is one tenant's own prose.
    const root = await callerRoot(ctx);
    const defaultPath = join(
      root,
      'documents',
      // The default name carries a timestamp so two runs never silently overwrite each
      // other: unlike an attachment cache file, a document is not re-fetchable.
      `${slugify((args.title as string | undefined) ?? 'zotero-document')}-${stamp(now)}-${nonce()}.docx`,
    );
    let savedTo = defaultPath;
    let pathWarning: string | undefined;
    if (args.save_path) {
      let resolved: string | undefined;
      try {
        resolved = await resolveCallerPath(args.save_path as string, {
          dataDir: root,
          confined: ctx.remoteCaller,
          mode: 'write',
          argName: 'save_path',
          alternative: 'Omit `save_path` to write to the default location under the data directory.',
        });
      } catch (e) {
        if (!(e instanceof CallerPathError)) throw e;
        pathWarning =
          `\`save_path\` was not used: it points outside the directory this server keeps your files in, ` +
          `and Zoteus is running as a shared server here, so that path is the operator's disk or another ` +
          `user's rather than yours. ` +
          `The document was written to ${defaultPath} instead. To get it off this server, attach it to a ` +
          `Zotero item with zotero_attachment (action:"upload", file_path:"${defaultPath}").`;
      }
      if (resolved) {
        if (!args.overwrite && existsSync(resolved)) {
          return err(
            `\`${resolved}\` already exists. Pass \`overwrite: true\` to replace it, or choose another \`save_path\`. Nothing was written.`,
          );
        }
        savedTo = resolved;
      }
    }

    const paragraphs: string[] = args.body;
    const keys = collectItemKeys(paragraphs);

    let library: { type: 'user' | 'group'; id: number };
    try {
      library = optionalLibrary(args, ctx) ?? ctx.router.defaultLibrary();
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }

    // Style first: an unknown style is a refusal, and refusing before the item reads keeps
    // a typo from costing a round of library requests.
    const styleId = ctx.styles.resolveId(args.style ?? 'apa');
    const locale = (args.locale as string | undefined) ?? 'en-US';
    let styleXml: string;
    let localeXml: string;
    try {
      [styleXml, localeXml] = await Promise.all([ctx.styles.fetchStyle(styleId), ctx.styles.fetchLocale(locale)]);
    } catch (e) {
      return err(
        `Could not load the citation style "${styleId}": ${e instanceof Error ? e.message : String(e)}. ` +
          'Call zotero_styles to see the names this server resolves. Nothing was written.',
      );
    }

    const cslByKey = new Map<string, Record<string, unknown>>();
    const missing: string[] = [];
    for (const key of keys) {
      const item = await fetchCslItem(ctx, library, key);
      if (item) cslByKey.set(key, { ...item, id: key });
      else missing.push(key);
    }

    // Probed with a key that actually resolved, so a typo at the top of the document cannot
    // cost the whole document its item URIs.
    const identity = await resolveIdentity(ctx, library, [...cslByKey.keys()][0]);

    // Walk the paragraphs once to build the clusters, then render them all on one engine so
    // numbering and author-date disambiguation are consistent across the whole document.
    interface PendingField {
      cluster: Cluster;
      items: Array<{ placeholder: PlaceholderItem; csl: Record<string, unknown> }>;
    }
    const fields: PendingField[] = [];
    interface PendingBlock {
      style?: string;
      pieces: Array<{ type: 'text'; text: string } | { type: 'field'; index: number }>;
    }
    const pending: PendingBlock[] = [];

    if (args.title) pending.push({ style: 'Title', pieces: [{ type: 'text', text: args.title as string }] });

    for (const paragraph of paragraphs) {
      const pieces: PendingBlock['pieces'] = [];
      for (const segment of parseParagraph(paragraph)) {
        if (segment.type === 'text') {
          pieces.push({ type: 'text', text: segment.text });
          continue;
        }
        const resolved = segment.cite.items.filter((item) => cslByKey.has(item.itemKey));
        const unresolved = segment.cite.items.filter((item) => !cslByKey.has(item.itemKey));
        if (resolved.length) {
          pieces.push({ type: 'field', index: fields.length });
          fields.push({
            cluster: {
              id: randomFieldId(),
              items: resolved.map((item) => ({
                id: item.itemKey,
                locator: item.locator,
                label: item.label,
              })),
            },
            items: resolved.map((item) => ({ placeholder: item, csl: cslByKey.get(item.itemKey)! })),
          });
        }
        if (unresolved.length) {
          // Preserve the original locator text so an unresolved citation can be repaired.
          // In a mixed cluster, keep only the unresolved source fragments beside the field.
          const unresolvedKeys = new Set(unresolved.map((item) => item.itemKey));
          const rawParts = segment.cite.raw.slice('[[cite:'.length, -2).split(';');
          const unresolvedParts = rawParts.filter((part) => {
            const parsed = parseParagraph(`[[cite:${part}]]`)[0];
            return parsed?.type === 'cite' && unresolvedKeys.has(parsed.cite.items[0]!.itemKey);
          });
          pieces.push({ type: 'text', text: `[[cite:${unresolvedParts.join(';')}]]` });
        }
      }
      pending.push({ pieces });
    }

    const rendered = renderCitations({
      items: [...cslByKey.values()],
      styleXml,
      localeXml,
      clusters: fields.map((f) => f.cluster),
      bibliography: wantBibliography,
      format: 'text',
    });

    // citeproc renders whatever the library holds, and a Zotero record can carry a form feed
    // or a stray control byte from a broken PDF extractor. XML cannot represent those at all,
    // so the emitter drops them from the visible run while JSON.stringify would keep them as
    // `\f` inside the field code: the field would then claim a cached text the document does
    // not contain, and Zotero's refresh would call every such citation hand-edited. Normalising
    // here, once, before the string forks, keeps the text this tool reports, the text the
    // document shows and the text cached in the field the same string.
    const citations = rendered.citations.map(stripIllegalXml);
    const entries = rendered.entries.map(stripIllegalXml);

    const linked = hasBindableId(identity);
    const blocks: Block[] = pending.map((block) => ({
      kind: 'paragraph' as const,
      style: block.style,
      pieces: block.pieces.map((piece): Piece => {
        if (piece.type === 'text') return { type: 'text', text: piece.text };
        const field = fields[piece.index]!;
        const text = citations[piece.index] ?? '';
        const citationItems: CitationItemPayload[] = field.items.map(({ placeholder, csl }) => {
          const uri = itemUri(identity, placeholder.itemKey);
          const out: CitationItemPayload = {
            id: placeholder.itemKey,
            // Always an array, even empty: Zotero's own fallback for an item it cannot
            // find reads `citationItem.uris.length`, so an absent array throws inside the
            // plugin instead of falling back to the embedded item data.
            uris: uri ? [uri] : [],
            itemData: csl,
          };
          if (placeholder.locator) out.locator = placeholder.locator;
          if (placeholder.label) out.label = placeholder.label;
          return out;
        });
        return {
          type: 'field',
          // formattedCitation and plainCitation must equal the visible run exactly: Zotero
          // compares them on refresh and prompts "this citation was modified" otherwise.
          instruction: citationFieldCode({
            citationID: field.cluster.id,
            properties: { formattedCitation: text, plainCitation: text, noteIndex: 0 },
            citationItems,
            schema: CSL_CITATION_SCHEMA,
          }),
          text,
        };
      }),
    }));

    const wroteBibliography = wantBibliography && fields.length > 0;
    if (wroteBibliography) {
      blocks.push({
        kind: 'spanningField',
        instruction: bibliographyFieldCode(),
        paragraphs: entries,
        style: 'Bibliography',
      });
    }

    const prefs = documentPrefsXml({
      // The id the caller asked for, not the independent parent fetchStyle collapsed it
      // onto: this URL is what Word re-binds to on every later refresh, and stamping the
      // parent would silently move the document to a style nobody chose. A caller who
      // passed a style URL outright keeps it.
      styleId: /^https?:\/\//i.test(styleId) ? styleId : `http://www.zotero.org/styles/${styleId}`,
      locale,
      hasBibliography: wroteBibliography,
      sessionId: randomFieldId(),
    });

    const bytes = buildDocx({ blocks, prefs, title: args.title as string | undefined, now });
    await mkdir(dirname(savedTo), { recursive: true });
    try {
      // Exclusive creation keeps overwrite:false safe if another call wins after the preview.
      await writeFile(savedTo, bytes, { flag: args.overwrite === true ? 'w' : 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        return err(`\`${savedTo}\` already exists. Pass \`overwrite: true\` to replace it, or choose another \`save_path\`. Nothing was written.`);
      }
      throw e;
    }
    const written = await stat(savedTo).then((s) => s.size).catch(() => bytes.byteLength);

    const warnings: string[] = [];
    if (pathWarning) warnings.push(pathWarning);
    if (missing.length) {
      warnings.push(
        `${missing.length} item key(s) could not be read from the library (${missing.join(', ')}). ` +
          'Their placeholders were left in the document as literal text rather than cited with invented data.',
      );
    }
    if (!linked && fields.length) {
      warnings.push(
        'The citation fields carry full item data but no Zotero item URIs, because this server could not ' +
          'determine the library\'s real numeric id (that happens when Zotero has never synced with zotero.org). ' +
          'Zotero will treat them as embedded references rather than as links to your library items.',
      );
    }
    if (isNoteStyle(styleXml)) {
      warnings.push(
        `"${styleId}" is a note style, whose citations belong in footnotes. This document writes citations ` +
          'inline in the body; it does not create footnotes, so the note text appears in the running text.',
      );
    }
    for (const message of rendered.errors) warnings.push(`citeproc: ${message}`);

    const refreshNote =
      'These are real Zotero fields (ADDIN ZOTERO_ITEM / ZOTERO_BIBL, plus the ZOTERO_PREF document ' +
      'preferences Zotero reads). To refresh them you need Microsoft Word with the Zotero word-processor ' +
      'plugin installed and Zotero running: open the file, then use Refresh in the Zotero tab. Until ' +
      'something refreshes them, Word shows the citation text cached in each field, which is what is in ' +
      'the file now. Not verified against Word: this build was tested by unpacking the .docx and checking ' +
      'the XML, because no Word and no Zotero word-processor plugin were available to run a refresh.' +
      (linked ? '' : ' The fields are not linked to library items; see `warnings`.');

    const structured: Record<string, unknown> = {
      savedTo,
      bytes: written,
      citations: fields.map((field, i) => {
        const keysHere = field.items.map((item) => item.placeholder.itemKey);
        const locator = field.items.find((item) => item.placeholder.locator)?.placeholder.locator;
        return {
          item_key: keysHere[0]!,
          item_keys: keysHere,
          ...(locator ? { locator } : {}),
          rendered: citations[i] ?? '',
        };
      }),
      style: styleId,
      locale,
      bibliography: wroteBibliography,
      linked,
      refreshNote,
    };
    if (missing.length) structured.missing = missing;
    if (warnings.length) structured.warnings = warnings;

    const summary =
      `Wrote ${written} bytes to ${savedTo}: ${fields.length} live Zotero citation field(s)` +
      (wroteBibliography ? ` and a bibliography field of ${entries.length} entr(ies)` : '') +
      `, style ${styleId}, locale ${locale}.` +
      (warnings.length ? ` ${warnings.length} warning(s); see the payload.` : '');
    return okLibraryContent(structured, summary);
  },
};

export default wordDocument;
