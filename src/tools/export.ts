import { z } from 'zod';
import type { ToolDefinition, ToolHandlerResult } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { optionalLibrary } from '../registry/registry.js';
import { BbtClient } from '../api/bbt-client.js';
import { refuseUnknownCollection } from './collection-guard.js';

const EXPORT_FORMATS = [
  'bibtex',
  'biblatex',
  'better-biblatex',
  'ris',
  'csljson',
  'csv',
  'mods',
  'tei',
  'coins',
  'rdf_bibliontology',
  'rdf_dc',
  'rdf_zotero',
  'refer',
  'wikipedia',
  'bookmarks',
] as const;

interface ExportArgs {
  item_keys?: string[];
  collection_key?: string;
  q?: string;
  item_type?: string;
}

/** What the caller narrowed the export to, echoed back when it rendered nothing. */
function describeSelection(args: ExportArgs): string {
  const parts: string[] = [];
  if (args.item_keys?.length) parts.push(`item_keys ${args.item_keys.join(', ')}`);
  if (args.collection_key) parts.push(`collection ${args.collection_key}`);
  if (args.q) parts.push(`q "${args.q}"`);
  if (args.item_type) parts.push(`item_type ${args.item_type}`);
  return parts.length ? parts.join(', ') : 'the whole library';
}

/**
 * An export result that never hands back an empty body as if it were a rendering.
 *
 * A stock export of a key Zotero does not have came back as `"\n\n"` with no summary, no
 * notice and no error, so an export that matched nothing looked exactly like one that
 * worked. The two cases are now told apart the way they differ: named `item_keys` that
 * render not one entry are a selection that cannot have worked, so they are refused and
 * the keys are named; a collection or a `q` that renders nothing is a real answer of "no
 * entries", reported as plainly as zotero_format_bibliography reports "(empty
 * bibliography)". Both say what Zotero did rather than that the items are absent, because
 * a child attachment or note also renders nothing under a top-level export.
 */
function exportResult(
  args: ExportArgs,
  format: string,
  text: string,
  extra: Record<string, unknown> = {},
  notePrefix = '',
): ToolHandlerResult {
  const selection = describeSelection(args);
  if (text.trim() !== '') {
    return {
      content: [{ type: 'text', text: notePrefix + text }],
      // Mirror the raw export into structuredContent so struct-only clients get
      // the payload, not just {format,length}. See `ok()` in registry.ts.
      structuredContent: { format, length: text.length, text, ...extra },
    };
  }
  if (args.item_keys?.length) {
    return {
      content: [
        {
          type: 'text',
          text:
            `Exported nothing: Zotero rendered no ${format} entry for ${selection}. ` +
            'Check the keys with zotero_search_items or zotero_get_item; a key that belongs to a ' +
            'child attachment, note or annotation also exports nothing, since only top-level items ' +
            'are exported.',
        },
      ],
      isError: true,
    };
  }
  // Says what Zotero did, not what the library holds: a collection page that is all child
  // attachments renders nothing while plainly not being empty (measured against a real
  // collection whose first item is an attachment).
  const notice =
    `(empty export: Zotero rendered no ${format} entries for ${selection}. ` +
    'Attachments, notes and annotations render no entry, and the selection may simply have matched none.)';
  return {
    content: [{ type: 'text', text: notePrefix + notice }],
    structuredContent: { format, length: text.length, empty: true, notice, text, ...extra },
  };
}

const exportTool: ToolDefinition = {
  name: 'zotero_export',
  title: 'Export Zotero items',
  description:
    'Export items in a bibliographic format and return the raw text. Choose `format` (bibtex, biblatex, better-biblatex, ris, csljson, csv, mods, tei, coins, rdf_*, refer, wikipedia, bookmarks). Stock formats are rendered by Zotero itself: by the desktop app when it serves the selected library (no cloud key needed), by the Web API otherwise. `biblatex` is Zotero\'s STOCK translator; BBT-specific options (citation-key generation, sentence-case, biblatexExtendedNameFormat, unicode→LaTeX) are NOT available there. `better-biblatex` uses the local desktop Better BibTeX plugin (your configured BBT export options apply) and is only available when desktop Zotero + BBT are running; it degrades to built-in `biblatex` otherwise. Narrow with `item_keys`, `collection_key`, `q`, or `item_type`. A `limit` (default 50) is always applied. An export that renders no entries says so instead of returning a blank body: named `item_keys` that render none are an error, and any other selection that renders none comes back with `empty: true`. For styled human bibliographies use the bibliography tools.',
  inputSchema: {
    format: z
      .enum(EXPORT_FORMATS)
      .describe(
        'Export format to render, e.g. "bibtex", "biblatex", "better-biblatex", "ris", "csljson", "csv". "better-biblatex" needs the desktop Better BibTeX plugin and degrades to "biblatex" without it.',
      ),
    item_keys: z.array(z.string()).optional().describe('Restrict to these 8-character item keys. Keys that render no entry are an error rather than a blank body.'),
    collection_key: z
      .string()
      .optional()
      .describe(
        'Restrict to a collection by key. A key this library does not have is refused, never answered with the whole library.',
      ),
    q: z.string().optional().describe('Quick-search string to narrow the export (title/creator/year).'),
    item_type: z.string().optional().describe('Boolean itemType filter, e.g. "journalArticle || book" or "-attachment".'),
    limit: z.number().int().min(1).max(100).optional().describe('Max items to export (default 50, max 100).'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      format: z.string().describe('The format actually rendered; "biblatex" when better-biblatex degraded to the built-in translator.'),
      length: z.number().describe('Characters of exported text.'),
      text: z.string().describe('The raw export, the same bytes as the text block.'),
      empty: z.boolean().optional().describe('True when Zotero rendered no entries at all for the selection.'),
      notice: z.string().optional().describe('Why an empty export is empty.'),
      source: z.string().optional().describe('Set to "local-bbt" when the desktop Better BibTeX plugin rendered it.'),
      degradedToBuiltIn: z.boolean().optional().describe("True when better-biblatex was asked for and Zotero's built-in biblatex answered."),
    })
    .passthrough(),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const lib = optionalLibrary(args) ?? ctx.router.defaultLibrary();
    // A collection key this library does not have would otherwise be exported as the whole
    // library by the desktop app. Checked only when a key was given.
    const unknownCollection = await refuseUnknownCollection(ctx, args.collection_key, lib, 'exported');
    if (unknownCollection) return unknownCollection;
    // Routed like every other library read (#64, #75): a library the desktop app serves
    // exports with no cloud key, and the Web API answers for everything else. Before this,
    // both stock calls below went to api.zotero.org unconditionally, which in key-free local
    // mode is users/0 and a refusal.
    const stockExport = (format: string) =>
      ctx.router.exportItems({
        library: lib,
        format,
        itemKey: args.item_keys,
        collectionKey: args.collection_key,
        q: args.q,
        itemType: args.item_type,
        limit: args.limit ?? 50,
      });

    if (args.format === 'better-biblatex') {
      const bbt = ctx.local ? new BbtClient({ port: ctx.config.localPort }) : undefined;
      if (bbt && (await bbt.ping())) {
        try {
          if (!args.item_keys?.length) {
            // BBT export needs item selection; fall back to built-in for whole-library/q exports.
            throw new Error('better-biblatex requires explicit item_keys');
          }
          const citekeys = await bbt.citationKeys(args.item_keys);
          if (citekeys.length) {
            const text = await bbt.exportItems({ citekeys, translator: 'better-biblatex' });
            return exportResult(args, 'better-biblatex', text, { source: 'local-bbt' });
          }
        } catch (e) {
          ctx.logger?.warn?.(`Better BibTeX export failed; using built-in biblatex. ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // Degrade to Zotero's stock biblatex translator, wherever the library is served from.
      const text = await stockExport('biblatex');
      return exportResult(
        args,
        'biblatex',
        text,
        { degradedToBuiltIn: true },
        `[Better BibTeX unavailable: returned Zotero's built-in biblatex instead. Run desktop Zotero with the Better BibTeX plugin for BBT-specific formatting.]\n\n`,
      );
    }

    const text = await stockExport(args.format);
    return exportResult(args, args.format, text);
  },
};

export default exportTool;
