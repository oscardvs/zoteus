import { z } from 'zod';
import type { ToolDefinition } from '../registry/registry.js';
import { libraryArgs } from './common-args.js';
import { optionalLibrary } from '../registry/registry.js';
import type { LibraryRef } from '../api/web-client.js';

/**
 * How many entries Zotero actually rendered.
 *
 * citeproc emits one `<div class="csl-entry">` per rendered entry inside the `csl-bib-body`
 * wrapper, and that is the markup both transports return. Counting it is the only way to
 * know what came back: a key Zotero cannot render is dropped silently, so the request
 * succeeds with 200 and an empty wrapper rather than reporting the key (measured against
 * Zotero 10's local API for both an unknown key and an attachment key).
 */
function countEntries(xhtml: string): number {
  return xhtml.match(/<div class="csl-entry"/g)?.length ?? 0;
}

function libraryLabel(lib: LibraryRef): string {
  return lib.type === 'user' ? `users/${lib.id}` : `groups/${lib.id}`;
}

const bibliography: ToolDefinition = {
  name: 'zotero_bibliography',
  title: 'Server-rendered bibliography (library items)',
  description:
    'Produce a formatted bibliography for items already in a Zotero library, rendered server-side by Zotero in a CSL style (by the desktop app for a library it serves, so no cloud key is needed there; otherwise by the Web API). Provide `item_keys` and optionally `style` (a name such as "apa" or "chicago author-date", or a CSL id; unset renders Zotero\'s default, chicago-shortened-notes-bibliography), `locale`, and `linkwrap`. Returns XHTML. Note: this endpoint is item-only and capped at 150 items. For arbitrary CSL-JSON or items not in the library, use zotero_format_bibliography instead.',
  inputSchema: {
    item_keys: z.array(z.string()).min(1).max(150).describe('Library item keys (max 150).'),
    style: z.string().optional().describe('Style name or CSL id.'),
    locale: z.string().optional().describe('Locale (e.g. en-US).'),
    linkwrap: z.boolean().optional().describe('Wrap URLs/DOIs in links.'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      style: z.string().describe("The CSL style Zotero rendered in; \"chicago-shortened-notes-bibliography\" is the default when `style` was unset."),
      entryCount: z.number().describe('Entries Zotero actually rendered, counted from the XHTML.'),
      requestedCount: z.number().describe('Keys the call asked for. A key the library does not have, or a child item, renders nothing.'),
      bibliography: z.string().describe('The rendered XHTML.'),
      note: z.string().optional().describe('Present when fewer entries rendered than keys were asked for, and why that happens.'),
    })
    .passthrough(),
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (args, ctx) => {
    const lib = optionalLibrary(args) ?? ctx.router.defaultLibrary();
    const style = args.style ? ctx.styles.resolveId(args.style) : undefined;
    // Routed, not ctx.web: in key-free local mode the default library is users/0, which
    // only the desktop app can answer, and it renders format=bib just as the cloud does.
    const text = await ctx.router.getBibliography(args.item_keys, {
      library: lib,
      style,
      locale: args.locale,
      linkwrap: args.linkwrap,
    });
    // Count the entries rather than the keys asked for. `itemCount: item_keys.length` echoed
    // the request back, so the struct asserted a number the render could never contradict:
    // one bogus key came back as `itemCount: 1` over an empty bibliography, and a caller
    // reading only the struct had no way to tell. The sibling tool
    // (zotero_format_bibliography) already reports `entryCount` from what citeproc produced.
    const entryCount = countEntries(text);
    const requestedCount = args.item_keys.length;
    const missing = requestedCount - entryCount;
    // Which keys rendered nothing is not knowable from the response: Zotero returns the
    // rendered entries, not a per-key outcome. Say how many, and why a key renders nothing,
    // without claiming which one it was.
    const shortfall =
      missing > 0
        ? `Zotero rendered ${entryCount} of the ${requestedCount} requested key(s) from ${libraryLabel(lib)}; ` +
          `${missing} produced no entry. A key renders nothing when that library does not have it, or when it names a ` +
          `child item (an attachment or a note), which has no bibliography entry of its own. Check a key with ` +
          `zotero_get_item, and cite the parent item's key rather than a child's.`
        : undefined;
    return {
      content: [
        { type: 'text', text: entryCount > 0 ? text : '(empty bibliography)' },
        ...(shortfall ? [{ type: 'text' as const, text: shortfall }] : []),
      ],
      // Mirror the rendered text into structuredContent: clients that read only
      // the struct channel (e.g. the claude.ai connector) would otherwise see
      // the summary and none of the actual bibliography. See `ok()` in registry.ts.
      structuredContent: {
        // The Web API's documented default, `chicago-note-bibliography`, is an id the style
        // repository has since renamed; this is what it renders as (#58).
        style: style ?? 'chicago-shortened-notes-bibliography',
        entryCount,
        requestedCount,
        bibliography: text,
        ...(shortfall ? { note: shortfall } : {}),
      },
    };
  },
};

export default bibliography;
