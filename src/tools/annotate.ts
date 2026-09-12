import { writeFailures, writeTarget } from './common-output.js';
import { z } from 'zod';
import type { LibraryRef } from '../api/web-client.js';
import type { ToolContext, ToolDefinition } from '../registry/registry.js';
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
import { locatePassages, pageHeights, type PassageAnchor } from '../features/fulltext/pdf-locate.js';
import { DEFAULT_PRECISE_MAX_BYTES } from '../features/fulltext/pdf-pages.js';
import { loadAttachmentBytes } from '../features/attachments/bytes.js';
import { pdfjsUnavailableReason } from '../features/fulltext/pdfjs-loader.js';

/** Zotero's stored placement for one annotation. */
export interface Position {
  pageIndex: number;
  rects: number[][];
}

/**
 * What a caller's `position` came to: the placement to store, or why it cannot be used.
 *
 * The two are kept apart because "no position was given" and "a position was given and is
 * unusable" call for opposite answers, and collapsing them is what let a malformed rect be
 * dropped on the floor: the annotation was then placed by locating its text instead, at
 * coordinates the caller never asked for, and reported as a success.
 */
export interface NormalizedPosition {
  /** The placement to store, or null when the caller gave none at all. */
  position: Position | null;
  /** Why a position that WAS given cannot be used, in terms the caller can act on. */
  problem?: string;
}

const RECT_SHAPE = 'a rect is [x1, y1, x2, y2] in PDF points, origin at the bottom-left of the page';

/** A value as the caller would recognise it, including the ones JSON cannot carry. */
function show(value: unknown): string {
  if (typeof value === 'number') return String(value); // NaN and Infinity stringify as null
  return JSON.stringify(value) ?? String(value);
}

/** Why a rect is not one Zotero can draw, or null when it is four finite numbers. */
function rectProblem(rect: unknown): string | null {
  if (!Array.isArray(rect)) return `is ${show(rect)}, not an array`;
  if (rect.length !== 4) return `has ${rect.length} value(s), not 4`;
  const bad = rect.findIndex((n) => typeof n !== 'number' || !Number.isFinite(n));
  if (bad !== -1) return `has ${show(rect[bad])} at index ${bad}, which is not a finite number`;
  return null;
}

/** The caller's rects, or the first one that is not four finite numbers. */
function normalizeRects(rects: unknown): { rects: number[][] } | { problem: string } {
  if (rects == null) return { rects: [] };
  if (!Array.isArray(rects)) return { problem: `\`position.rects\` is not an array (${RECT_SHAPE}).` };
  const out: number[][] = [];
  for (let i = 0; i < rects.length; i++) {
    const problem = rectProblem(rects[i]);
    if (problem) return { problem: `\`position.rects[${i}]\` ${problem} (${RECT_SHAPE}).` };
    out.push(rects[i] as number[]);
  }
  return { rects: out };
}

/** Why a page index is not one, or null when it is a whole page number. */
function pageIndexProblem(pageIndex: unknown, field: string): string | null {
  if (typeof pageIndex !== 'number' || !Number.isInteger(pageIndex) || pageIndex < 0) {
    return `\`${field}\` is ${show(pageIndex)}, not a 0-based page index.`;
  }
  return null;
}

/**
 * Normalize a caller-supplied position into Zotero's stored form:
 *   {"pageIndex": <0-based page>, "rects": [[x1, y1, x2, y2], ...]}
 * Points, origin at the BOTTOM-LEFT of the page (native PDF coordinate space, y
 * increasing upward). Accepts
 * either that object directly (or its JSON string) or the shorthand
 * [pageIndex, [x1, y1, x2, y2]].
 *
 * A position that was given and cannot be read comes back as a `problem` rather than as
 * nothing: it is a caller error, and the caller is the only one who can fix it.
 */
export function normalizePosition(position: unknown, page?: number): NormalizedPosition {
  if (position == null) {
    return { position: page != null ? { pageIndex: page, rects: [] } : null };
  }
  if (typeof position === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(position);
    } catch {
      return {
        position: null,
        problem: '`position` was given as a string that is not JSON. Send the object itself, or its JSON text.',
      };
    }
    return normalizePosition(parsed, page);
  }
  if (Array.isArray(position)) {
    // Shorthand: [pageIndex, [x1, y1, x2, y2]].
    const shape = 'The array shorthand is [pageIndex, [x1, y1, x2, y2]]; the long form is {"pageIndex": N, "rects": [[x1, y1, x2, y2], ...]}.';
    if (position.length !== 2) {
      return { position: null, problem: `\`position\` is an array of ${position.length} value(s). ${shape}` };
    }
    const pageProblem = pageIndexProblem(position[0], 'position[0]');
    if (pageProblem) return { position: null, problem: `${pageProblem} ${shape}` };
    const problem = rectProblem(position[1]);
    if (problem) return { position: null, problem: `\`position[1]\` ${problem} (${RECT_SHAPE}).` };
    return { position: { pageIndex: position[0] as number, rects: [position[1] as number[]] } };
  }
  if (typeof position !== 'object') {
    return { position: null, problem: `\`position\` is a ${typeof position}, not a position object.` };
  }
  const p = position as { pageIndex?: unknown; rects?: unknown };
  if (p.pageIndex === undefined && p.rects === undefined) {
    return {
      position: null,
      problem: '`position` has neither `pageIndex` nor `rects`. It is {"pageIndex": N, "rects": [[x1, y1, x2, y2], ...]}.',
    };
  }
  const pageProblem = pageIndexProblem(p.pageIndex, 'position.pageIndex');
  if (pageProblem) return { position: null, problem: pageProblem };
  const rects = normalizeRects(p.rects);
  if ('problem' in rects) return { position: null, problem: rects.problem };
  return { position: { pageIndex: p.pageIndex as number, rects: rects.rects } };
}

/**
 * Replicates the PDF reader's sort-index scheme so annotations order correctly in
 * the sidebar: `PPPPP|OOOOOO|TTTTT` (5-digit page | 6-digit char offset | 5-digit
 * distance of the topmost rect from the page bottom). Callers that extracted the
 * highlight from the PDF itself can pass the exact offset; otherwise offset 0 with
 * the rect-derived `top` still keeps same-page highlights in reading order.
 *
 * That last part holds ONLY when `pageHeight` is known, because `top` is a distance from
 * the page bottom and there is nothing to measure it against without one. With no height
 * every rect on the page reduces to `00000` and the annotations all sort as if they sat at
 * the very top of it, which is what a caller who supplied `position` used to get: their
 * placement skips the anchoring pass that reports the height. The handler now reads it out
 * of the PDF for that path too, and says so when it could not.
 */
export function buildSortIndex(
  pageIndex: number,
  rects: number[][],
  opts: { offset?: number; pageHeight?: number } = {},
): string {
  const pad = (n: number, w: number) => String(Math.max(0, Math.floor(n))).slice(0, w).padStart(w, '0');
  let top = 0;
  if (rects.length && opts.pageHeight) {
    // Topmost rect: the reader sorts rects by their third coordinate descending
    // and takes the first; mirror that exactly.
    const topRect = rects.slice().sort((a, b) => (b[2] ?? 0) - (a[2] ?? 0))[0] ?? [0, 0, 0, 0];
    top = Math.max(0, opts.pageHeight - (topRect[3] ?? 0));
  }
  return `${pad(pageIndex, 5)}|${pad(opts.offset ?? 0, 6)}|${pad(Math.floor(top), 5)}`;
}

const annotationShape = {
  type: z.enum(['highlight', 'note', 'underline', 'image']).optional()
    .describe('Annotation type; default "highlight".'),
  text: z.string().optional()
    .describe('The highlighted/underlined passage itself (required for highlight/underline). For notes, goes in annotationText of an extracted-text style note or leave to `comment`.'),
  comment: z.string().optional().describe('Comment attached to the annotation (markdown-ish plain text).'),
  color: z.string().optional().describe('Hex color, e.g. "#ffd400" (highlight default) or "#26a69a".'),
  page: z.number().int().optional().describe('0-based PDF page index (annotationPageLabel uses page+1 when unset).'),
  page_label: z.string().optional().describe('Explicit page label (overrides page+1).'),
  position: z.union([z.string(), z.any()]).optional()
    .describe('Zotero position: {"pageIndex": N, "rects": [[x1,y1,x2,y2],...]} (points, bottom-left origin), its JSON string, or shorthand [N, [x1,y1,x2,y2]]. Optional: when omitted, the passage in `text` is located in the PDF and its coordinates are computed for you.'),
  occurrence: z.number().int().min(1).optional()
    .describe('Which occurrence of `text` to anchor when the passage appears more than once (1-based, in reading order). Only needed when a first attempt reports an ambiguous passage.'),
  sort_index: z.string().optional().describe('Explicit annotationSortIndex; computed from position when omitted.'),
  char_offset: z.number().int().optional().describe('Reading-order character offset of the passage start on the page (refines sort_index).'),
  page_height: z.number().optional().describe('Page height in points (refines sort_index, e.g. 841.89 for A4).'),
  tags: z.array(z.string()).optional().describe('Tags to attach to the annotation.'),
};

const ANNOTATION_FIELDS = Object.keys(annotationShape);

/**
 * `pageLabel`, `page-label`, `annotationPageLabel` and `page_label` all reduce to
 * `pagelabel`, which is what lets a misspelled key be paired with the one it meant. The
 * `annotation` prefix is stripped because Zotero's own data model spells these fields
 * `annotationSortIndex`, `annotationComment` and so on, and a caller reading that is the
 * likeliest one to type them here.
 */
const foldFieldName = (key: string): string =>
  key.replace(/^annotation/i, '').toLowerCase().replace(/[^a-z0-9]/g, '');

const FIELD_BY_FOLDED_NAME = new Map(ANNOTATION_FIELDS.map((f) => [foldFieldName(f), f]));

/** Names the key that was not understood and, where only its spelling was wrong, the one that was meant. */
function unknownFieldProblem(key: string): string {
  const twin = FIELD_BY_FOLDED_NAME.get(foldFieldName(key));
  return twin
    ? `unknown field \`${key}\`: this tool spells it \`${twin}\`. Nothing was written, because the value you sent would have been ignored.`
    : `unknown field \`${key}\`. The fields are: ${ANNOTATION_FIELDS.join(', ')}.`;
}

/**
 * An annotation carrying a key this tool does not know is refused, not quietly stripped.
 *
 * `z.object` drops what it does not recognise before a handler ever sees it, so
 * `pageLabel: "xx"` and `sortIndex: "09999|000999|00999"` (Zotero's own camelCase
 * spellings) produced a cheerful success over an annotation stored with a page label of
 * "1" and a computed sort index. A test harness had been writing exactly that for a while
 * and reading the success as proof it worked. An argument that is silently discarded is
 * the one failure a caller cannot detect, so it fails here instead, naming the key.
 *
 * `preprocess` rather than `.strict()` because the useful part of the message is the twin,
 * which Zod's own "Unrecognized key(s) in object" cannot offer; the object underneath stays
 * a plain one, so the JSON Schema this tool advertises still says additionalProperties:false.
 */
const annotationSchema = z.preprocess((value, ctx) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  for (const key of Object.keys(value)) {
    if (key in annotationShape) continue;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: unknownFieldProblem(key) });
  }
  return value;
}, z.object(annotationShape));

const annotateTool: ToolDefinition = {
  name: 'zotero_annotate',
  title: 'Annotate a PDF (highlights, notes)',
  description:
    'Add or delete Zotero PDF annotations (highlights, underlines, notes), the same objects you create in the Zotero PDF reader. `action:"add"` needs `parent` (a regular item key OR a PDF attachment key) and `annotations`: each with `type` (highlight|note|underline, default highlight), `text` (the exact passage to highlight), optional `comment`, `color`, `page` (0-based page index). **You do not need page coordinates**: give the passage in `text` and it is located in the PDF and anchored to the exact lines it occupies, so quoting a passage is enough to highlight it. Pass `page` to disambiguate a passage that repeats, or `occurrence` to pick among repeats; pass `position` ({"pageIndex":N,"rects":[[x1,y1,x2,y2],...]} in PDF points, bottom-left origin) only to place a highlight yourself. `action:"delete"` trashes the annotations in `annotation_keys`. Writes go to the running Zotero desktop app for your personal library (via its connector protocol, or its local-API writes where available), otherwise to the cloud Web API.',
  inputSchema: {
    action: z.enum(['add', 'delete']).optional().describe('Default "add".'),
    parent: z.string().optional().describe('Item key or PDF attachment key to annotate.'),
    annotations: z.array(annotationSchema).optional()
      .describe('Annotations to add. Field names are snake_case (`page_label`, `sort_index`, `char_offset`, `page_height`); a key this tool does not know is refused, never ignored.'),
    annotation_keys: z.array(z.string()).optional().describe('Annotation keys to trash (action:"delete").'),
    ...libraryArgs,
  },
  outputSchema: z
    .object({
      target: writeTarget,
      attachment: z.string().optional().describe('The PDF attachment the annotations were written to.'),
      anchoredFromText: z.number().optional().describe('How many annotations had their coordinates computed from the passage in `text`.'),
      created: z
        .array(
          z
            .object({
              key: z.string().describe('Key of the annotation created.'),
              type: z.unknown().optional().describe('Its annotation type, e.g. "highlight".'),
              text: z.unknown().optional().describe('The highlighted passage, as stored.'),
              comment: z.unknown().optional().describe('The comment, as stored.'),
            })
            .passthrough(),
        )
        .optional()
        .describe('action:"add": the annotations that landed.'),
      trashed: z.array(z.string()).optional().describe('action:"delete": annotation keys moved to the trash (reversible).'),
      sessionID: z.string().optional().describe('Connector save session, when the desktop app took the write.'),
      note: z.string().optional().describe('Set when fewer annotations could be matched back than were sent.'),
      failed: writeFailures,
    })
    .passthrough(),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  handler: async (args, ctx) => {
    const action = args.action ?? 'add';
    // Decided once, so the parent and children reads, the PDF bytes and the write all name
    // the same library; the desktop shortcuts below apply only to the personal one (#61).
    const lib = resolveLibrary(ctx, args);
    const personal = isPersonalLibrary(lib);

    if (action === 'delete') {
      const keys: string[] = args.annotation_keys ?? [];
      if (!keys.length) {
        return { content: [{ type: 'text', text: '`annotation_keys` is required for action:"delete".' }], isError: true };
      }
      if (personal && (await ensureLocalApi(ctx)) && ctx.localWrites) {
        try {
          // `deleted: 1` (reversible trash), not DELETE — the local API's DELETE erases.
          const result = await ctx.localWrites.setDeleted(keys, 1);
          const trashed = [...result.successful.map((s) => s.key), ...result.unchanged];
          return writeResult(
            { trashed, failed: result.failed, target: 'local' },
            `Trashed ${trashed.length} annotation(s) via the Zotero desktop app.`,
            trashed.length,
            keys.length,
            result.failed,
          );
        } catch (e) {
          if (!isLocalWritesUnavailable(e)) throw e;
          // Running Zotero has no local-API writes; fall through to cloud/guidance.
        }
      }
      if (ctx.capabilities.cloud) {
        const objects: any[] = [];
        for (const key of keys) {
          const item = await ctx.web.getItem(lib, key);
          objects.push({ key, version: item?.version ?? item?.data?.version, deleted: 1 });
        }
        const result = await ctx.web.writeItems(lib, objects);
        return ok(
          { trashed: result.successful.map((s) => s.key), failed: result.failed, target: 'cloud' },
          `Trashed ${result.successful.length} annotation(s) via the cloud Web API.`,
        );
      }
      return {
        content: [{
          type: 'text',
          text: 'Deleting annotations needs write access this Zotero cannot grant: the running app\u2019s local API is read-only (local-API writes ship in Zotero 10) and the connector protocol cannot delete. Set ZOTERO_API_KEY for cloud writes, upgrade to Zotero 10 or newer, or delete the annotations manually in Zotero\u2019s PDF reader.',
        }],
        isError: true,
      };
    }

    // --- add ---
    if (!args.parent) {
      return { content: [{ type: 'text', text: '`parent` (item key or PDF attachment key) is required for action:"add".' }], isError: true };
    }
    const parentKey: string = args.parent;
    const anns = args.annotations ?? [];
    if (!anns.length) {
      return { content: [{ type: 'text', text: '`annotations` must contain at least one entry.' }], isError: true };
    }

    // Resolve the PDF attachment: the parent may be the attachment itself or any
    // regular item whose children include a stored/linked PDF.
    const parentItem = await ctx.router.getItem(parentKey, { library: lib });
    const parentData = parentItem?.data ?? parentItem;
    let attachmentKey: string | undefined;
    if (parentData?.itemType === 'attachment') {
      attachmentKey = parentData.key ?? parentKey;
    } else {
      const children = await ctx.router.getItemChildren(parentKey, { library: lib });
      const pdf = children.data
        .map((c: any) => c?.data ?? c)
        .filter((c: any) => c?.itemType === 'attachment')
        .sort((a: any, b: any) => scorePdf(b) - scorePdf(a))[0];
      attachmentKey = pdf?.key;
      if (!attachmentKey) {
        return {
          content: [{ type: 'text', text: `No PDF attachment found under item ${parentKey}. Add the PDF first (or pass the attachment key directly).` }],
          isError: true,
        };
      }
    }

    if (!attachmentKey) {
      return { content: [{ type: 'text', text: 'Could not resolve a PDF attachment.' }], isError: true };
    }
    const targetAttachment: string = attachmentKey;

    // The PDF is opened at most once per call, whichever of the two things below wants it:
    // anchoring a passage, or reading the page height a caller-supplied rect is sorted by.
    let pdfBytes: Uint8Array | null | undefined;
    const readPdf = async (): Promise<Uint8Array | null> => {
      if (pdfBytes === undefined) pdfBytes = await loadPdfBytes(ctx, lib, targetAttachment);
      return pdfBytes;
    };

    // Anchor every passage-only highlight to the lines it occupies in the PDF, so a caller
    // that can quote a passage never has to supply coordinates it has no way to know.
    const problems: string[] = [];
    const anchored = await anchorPassages(readPdf, anns, problems);

    // Build annotation items in Zotero's data model.
    const items: Record<string, unknown>[] = [];
    // Annotations placed by the caller, whose sort index is waiting on a page height.
    const unmeasured: Array<{ item: Record<string, unknown>; pageIndex: number; rects: number[][]; offset?: number }> = [];
    anns.forEach((a: any, i: number) => {
      const type = a.type ?? 'highlight';
      if ((type === 'highlight' || type === 'underline') && !a.text) {
        problems.push(`annotations[${i}]: ${type} requires \`text\` (the exact passage).`);
        return;
      }
      // A caller-supplied position always wins; the located passage fills in for its absence.
      const given = normalizePosition(a.position, a.page);
      if (given.problem) {
        problems.push(`annotations[${i}]: ${given.problem}`);
        return;
      }
      const found = anchored.get(i);
      const pos = given.position?.rects?.length
        ? given.position
        : found
          ? { pageIndex: found.pageIndex, rects: found.rects }
          : given.position;
      if ((type === 'highlight' || type === 'underline') && !pos?.rects?.length) {
        // anchorPassages has already explained why, in the terms the caller can act on.
        if (!problems.some((p) => p.startsWith(`annotations[${i}]:`))) {
          problems.push(`annotations[${i}]: ${type} could not be placed: the passage was not found in the PDF, and no \`position\` was given.`);
        }
        return;
      }
      const pageIndex = pos?.pageIndex ?? a.page ?? 0;
      const offset = a.char_offset ?? found?.charOffset;
      const pageHeight = a.page_height ?? found?.pageHeight;
      const item: Record<string, unknown> = {
        itemType: 'annotation',
        parentItem: targetAttachment,
        annotationType: type,
        annotationColor: a.color ?? (type === 'note' ? '#26a69a' : '#ffd400'),
        annotationSortIndex: a.sort_index ?? buildSortIndex(pageIndex, pos?.rects ?? [], { offset, pageHeight }),
        annotationPosition: JSON.stringify(pos ?? { pageIndex, rects: [] }),
        tags: (a.tags ?? []).map((t: string) => ({ tag: t })),
      };
      if (a.text) item.annotationText = a.text;
      if (a.comment) item.annotationComment = a.comment;
      const label = a.page_label ?? String(pageIndex + 1);
      if (label) item.annotationPageLabel = label;
      items.push(item);
      if (a.sort_index == null && pageHeight == null && pos?.rects?.length) unmeasured.push({ item, pageIndex, rects: pos.rects, offset });
    });
    if (problems.length) {
      return { content: [{ type: 'text', text: `Nothing was written:\n- ${problems.join('\n- ')}` }], isError: true };
    }

    // The sidebar order is a distance from the bottom of the page, so a rect the caller
    // placed sorts to the top of its page until the page height is known, and `position`
    // is exactly the path that never anchors, so nothing else reports one. Reading it costs
    // opening a PDF this call would otherwise leave alone, which is why it is asked for
    // only here, only for the annotations whose sort index actually turns on it, and never
    // for a call that is about to be refused.
    let unsorted = 0;
    if (unmeasured.length) {
      const bytes = await readPdf();
      const heights = bytes ? await pageHeights(bytes, unmeasured.map((u) => u.pageIndex)) : null;
      for (const u of unmeasured) {
        const height = heights?.get(u.pageIndex);
        if (height) u.item.annotationSortIndex = buildSortIndex(u.pageIndex, u.rects, { offset: u.offset, pageHeight: height });
        else unsorted++;
      }
    }
    const notes = anchorNote(anchored.size) + sortOrderNote(unsorted);

    // Prefer the desktop app for the personal library; fall back to the cloud.
    // (a) Zotero 10+ local-API writes (the first one asks for a key in-app — choose
    //     "Always Allow" to be asked once), or (b) the connector protocol that every
    //     recent Zotero exposes while running.
    if (personal && (await ensureLocalApi(ctx)) && ctx.localWrites) {
      try {
        const result = await ctx.localWrites.writeItems(items);
        if (result.failed.length) {
          return { content: [{ type: 'text', text: `Local write failed: ${JSON.stringify(result.failed)}` }], isError: true };
        }
        return ok(
          {
            target: 'local',
            attachment: targetAttachment,
            anchoredFromText: anchored.size,
            created: result.successful.map((s, i) => ({ key: s.key, type: items[i]?.annotationType, text: items[i]?.annotationText ?? '', comment: items[i]?.annotationComment ?? '' })),
          },
          `Added ${result.successful.length} annotation(s) to PDF ${targetAttachment} via the Zotero desktop app.` + notes,
        );
      } catch (e) {
        if (!isLocalWritesUnavailable(e)) throw e;
        ctx.logger.info(`Local-API writes unavailable (${e instanceof Error ? e.message : e}); using the connector protocol.`);
      }
    }
    if (personal && ctx.connectorWrites && (await ensureLocalApi(ctx))) {
      const { sessionID } = await ctx.connectorWrites.saveItems(items, { uri: 'zotero://zoteus/annotate' });
      // The connector returns no keys; recover them by querying the local API.
      const created = await pollCreatedAnnotations(ctx, targetAttachment, items);
      return ok(
        {
          target: 'desktop',
          sessionID,
          attachment: targetAttachment,
          anchoredFromText: anchored.size,
          created,
          note: created.length < items.length
            ? 'Some annotations could not be matched back yet; they may still appear in Zotero (check the PDF sidebar).'
            : undefined,
        },
        `Added ${created.length}/${items.length} annotation(s) to PDF ${targetAttachment} via the running Zotero desktop app.` + notes,
      );
    }
    requireCloud(ctx, lib);
    const result = await ctx.web.writeItems(lib, items);
    return ok(
      {
        target: 'cloud',
        attachment: targetAttachment,
        anchoredFromText: anchored.size,
        created: result.successful.map((s, i) => ({ key: s.key, type: items[i]?.annotationType })),
        failed: result.failed,
      },
      `Added ${result.successful.length} annotation(s) to PDF ${targetAttachment} via the cloud Web API.` + notes,
    );
  },
};

/**
 * Resolve the on-page geometry of every highlight/underline given as a passage rather than
 * as coordinates.
 *
 * This is what makes a highlight reachable from text alone. Zotero anchors a highlight by
 * page rects, which a caller reading extracted text cannot know; inventing them draws a
 * box over the wrong lines, so the honest fallback used to be a page-anchored note. Here
 * the passage is found in the PDF itself and its real rects computed, and where it cannot
 * be found nothing is written and the reason says which of the two it was: the passage is
 * not in the document, or it is there more than once.
 *
 * Annotations that already carry a `position`, and notes (which are placed by page, not by
 * passage), are left alone, and when nothing needs anchoring the PDF is never fetched.
 */
async function anchorPassages(
  readPdf: () => Promise<Uint8Array | null>,
  anns: any[],
  problems: string[],
): Promise<Map<number, PassageAnchor>> {
  const resolved = new Map<number, PassageAnchor>();
  const pending: Array<{ index: number; text: string; pageIndex?: number }> = [];
  anns.forEach((a, i) => {
    const type = a.type ?? 'highlight';
    if (type !== 'highlight' && type !== 'underline') return;
    if (!a.text) return;
    const given = normalizePosition(a.position, a.page);
    // A position that was given and cannot be read is the add loop's to refuse. Anchoring
    // it from text would answer a broken rect with coordinates the caller never asked for.
    if (given.problem || given.position?.rects?.length) return;
    pending.push({ index: i, text: a.text, pageIndex: typeof a.page === 'number' ? a.page : undefined });
  });
  if (!pending.length) return resolved;

  const bytes = await readPdf();
  if (!bytes) {
    for (const p of pending) {
      problems.push(
        `annotations[${p.index}]: the PDF could not be read, so the passage cannot be placed. ` +
          `Zoteus reads it from the running Zotero desktop app, or downloads it from Zotero storage when the file has synced. ` +
          `Neither worked here (a linked file with no stored copy, or an unsynced attachment on a hosted Zoteus). ` +
          `Pass an explicit \`position\` instead, or use type:"note" with \`page\`.`,
      );
    }
    return resolved;
  }

  const hits = await locatePassages(
    bytes,
    pending.map((p) => ({ text: p.text, pageIndex: p.pageIndex })),
  );
  if (!hits) {
    const maxMb = Math.round(DEFAULT_PRECISE_MAX_BYTES / (1024 * 1024));
    for (const p of pending) {
      problems.push(
        `annotations[${p.index}]: the PDF could not be parsed for text positions ` +
          `(a scanned/corrupt PDF, a file over the ${maxMb} MB parsing limit, or ${pdfjsUnavailableReason()}). ` +
          `Pass an explicit \`position\`, or use type:"note" with \`page\`.`,
      );
    }
    return resolved;
  }

  pending.forEach((p, n) => {
    const found = hits[n] ?? [];
    const where = p.pageIndex != null ? ` on page ${p.pageIndex + 1} (page index ${p.pageIndex})` : '';
    if (!found.length) {
      problems.push(
        `annotations[${p.index}]: passage not found in the PDF${where}: ${JSON.stringify(p.text.slice(0, 60))}. ` +
          `Quote it exactly as zotero_get_fulltext returns it (line breaks, hyphenation and spacing are ignored, but altered wording is not)` +
          (p.pageIndex != null ? ', or drop `page` to search the whole document.' : '.'),
      );
      return;
    }
    const pick = anns[p.index]?.occurrence;
    if (typeof pick === 'number') {
      const chosen = found[pick - 1];
      if (!chosen) {
        problems.push(`annotations[${p.index}]: occurrence ${pick} requested but the passage occurs ${found.length} time(s).`);
        return;
      }
      resolved.set(p.index, chosen);
      return;
    }
    if (found.length > 1) {
      // Placing the wrong one of several identical passages is the failure this whole path
      // exists to avoid, so ask rather than guess.
      const list = found
        .map((h, k) => `  ${k + 1}. page ${h.pageIndex + 1}: …${h.context.slice(0, 90)}…`)
        .join('\n');
      problems.push(
        `annotations[${p.index}]: the passage occurs ${found.length} times${where ? where : ''}; ` +
          `re-send it with \`occurrence\` (or a \`page\`) to say which:\n${list}`,
      );
      return;
    }
    resolved.set(p.index, found[0]!);
  });
  return resolved;
}

/**
 * The attachment's PDF bytes, from whichever side of Zoteus can reach them: the desktop
 * app reads them off its own disk (so unsynced and storage-quota-less libraries work), the
 * Zotero storage folder answers when the app is not running but shares the machine, and a
 * hosted Zoteus downloads them from Zotero storage. Returns null when none can.
 */
async function loadPdfBytes(
  ctx: ToolContext,
  library: LibraryRef,
  attachmentKey: string,
): Promise<Uint8Array | null> {
  const loaded = await loadAttachmentBytes(ctx, {
    key: attachmentKey,
    library,
    maxBytes: DEFAULT_PRECISE_MAX_BYTES,
  });
  if (loaded.bytes) return loaded.bytes;
  if (loaded.reasons.length) ctx.logger.debug(`No PDF bytes for ${attachmentKey}: ${loaded.reasons.join('; ')}`);
  return null;
}

/** Says so when highlights were placed from their text rather than from caller coordinates. */
function anchorNote(count: number): string {
  if (!count) return '';
  return ` ${count} highlight(s) were positioned by locating their text in the PDF.`;
}

/**
 * Says so when a sort index had to be left at the top of its page. The annotation is
 * written and drawn in the right place either way; only the sidebar order suffers, and a
 * caller who is told can fix it with one field instead of wondering why the list is odd.
 */
function sortOrderNote(count: number): string {
  if (!count) return '';
  return (
    ` ${count} annotation(s) sort to the top of their page: the sidebar order is measured from the bottom of the page` +
    ' and the PDF could not be read for its height. Pass `page_height` (or `sort_index`) to order them exactly.'
  );
}

/** Rank attachment children: stored PDFs first, then linked PDFs, then anything else. */
function scorePdf(att: any): number {
  if (att?.contentType !== 'application/pdf') return 0;
  const lm = att?.linkMode;
  if (lm === 'imported_file') return 3;
  if (lm === 'imported_url') return 2;
  if (lm === 'linked_file' || lm === 'linked_url') return 1;
  return 1;
}

export default annotateTool;


/**
 * Recover the item keys of annotations just created through the connector protocol
 * (which returns no payload) by querying the desktop local API for the attachment's
 * annotation children and matching them against what we sent.
 */
async function pollCreatedAnnotations(
  ctx: any,
  attachmentKey: string,
  sent: Record<string, unknown>[],
): Promise<Array<{ key: string; type?: unknown; text?: unknown; comment?: unknown }>> {
  const wanted = new Map<string, Record<string, unknown>>();
  for (const it of sent) {
    const fingerprint = `${it.annotationType ?? ''}::${(it.annotationText ?? '') as string}`;
    wanted.set(fingerprint, it);
  }
  const found: Array<{ key: string; type?: unknown; text?: unknown; comment?: unknown }> = [];
  const deadline = Date.now() + 15_000;
  while (wanted.size && Date.now() < deadline) {
    try {
      // Must be the /children endpoint: the local API ignores a `parentItem` filter
      // on /items and would hand back the entire library instead.
      const res = await ctx.local.getItemChildren(attachmentKey, { itemType: 'annotation', limit: 100 });
      for (const child of res.data) {
        const d = child?.data ?? child;
        if (d?.itemType && d.itemType !== 'annotation') continue;
        const fingerprint = `${d?.annotationType ?? ''}::${d?.annotationText ?? ''}`;
        if (wanted.has(fingerprint)) {
          wanted.delete(fingerprint);
          found.push({
            key: d.key,
            type: d.annotationType,
            text: d.annotationText ?? '',
            comment: d.annotationComment ?? '',
          });
        }
      }
    } catch {
      // Local API hiccup; keep polling until the deadline.
    }
    if (wanted.size) await new Promise((r) => setTimeout(r, 750));
  }
  return found;
}
