import type { LibraryRef } from '../../api/web-client.js';
import type { ToolContext, ToolHandlerResult } from '../../registry/registry.js';
import { ok, writeResult } from '../../registry/registry.js';
import { ZoteroApiError } from '../../api/errors.js';
import { withLibraryWriter, type LibraryWriter } from '../../tools/library-writer.js';
import { citedKeys, markdownToNoteHtml } from './markdown.js';
import { citationHtml, resolveCitations, storedCitationItems, type StoredCitationItem } from './citations.js';

/**
 * The one path every note write takes: zotero_create_note, zotero_append_to_note,
 * zotero_replace_note and zotero_save_annotation_digest all render through `renderNoteBody`
 * (or hand over HTML of their own) and write through `withLibraryWriter`, so a note goes to
 * the running desktop app for every library it holds and to the cloud otherwise, exactly as
 * an item from zotero_create_items does.
 */

export function refusal(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/** A note body ready to write, or what has to be fixed first. */
export type RenderedNote =
  | { body: string; citationItems: StoredCitationItem[]; citations: number }
  | { problems: string[] };

/**
 * Markdown to note HTML, with its `[@KEY]` citations resolved against `lib` when `cite` is
 * on. Every cited key is read before anything is rendered, so a citation that names nothing
 * refuses the whole write rather than reaching the note as a dead link.
 */
export async function renderNoteBody(
  ctx: ToolContext,
  lib: LibraryRef,
  markdown: string,
  cite: boolean,
): Promise<RenderedNote> {
  if (!cite) return { body: markdownToNoteHtml(markdown), citationItems: [], citations: 0 };
  const keys = citedKeys(markdown);
  if (!keys.length) return { body: markdownToNoteHtml(markdown), citationItems: [], citations: 0 };
  const { cited, problems } = await resolveCitations(ctx, lib, keys);
  if (problems.length) return { problems };
  let citations = 0;
  const body = markdownToNoteHtml(markdown, {
    citation: (refs) => {
      citations++;
      return citationHtml(refs, cited);
    },
  });
  return { body, citationItems: storedCitationItems(cited.values()), citations };
}

/** Item types a note may hang under: Zotero refuses any other parent ("must be a regular item"). */
const NOT_A_PARENT = new Set(['note', 'attachment', 'annotation']);

const isNotFound = (e: unknown): boolean => (e as { status?: number } | null)?.status === 404;

/** The item at `key` read through `w`, or null when the library has none. */
export async function readItem(w: LibraryWriter, key: string): Promise<any | null> {
  try {
    const item = await w.getItem(key);
    return item?.data?.itemType || item?.itemType ? item : null;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/** Why `parentKey` cannot take a child note, or null when it can. */
export async function parentProblem(w: LibraryWriter, parentKey: string): Promise<string | null> {
  const parent = await readItem(w, parentKey);
  const where = w.lib.type === 'group' ? `group library ${w.lib.id}` : 'this library';
  if (!parent) return `No item ${parentKey} in ${where}, so no note was written. Check the key with zotero_search_items.`;
  const type = (parent.data ?? parent).itemType;
  if (NOT_A_PARENT.has(type)) {
    const up = (parent.data ?? parent).parentItem;
    return (
      `${parentKey} is ${type === 'attachment' || type === 'annotation' ? 'an' : 'a'} ${type}, and Zotero only lets a note hang under a regular item, so no note was written.` +
      (up ? ` Use its parent item, ${up}.` : ' Omit parent_item to write a standalone note.')
    );
  }
  return null;
}

export interface NoteRewrite {
  /** The new HTML, from the note's HTML as read. Called again after a version conflict. */
  transform: (existing: string) => string;
  /**
   * The version the caller read the note at. When given, a note that changed since is
   * refused rather than retried: pinning a version means "only if nobody else wrote it".
   */
  version?: number;
  /** The summary line, from the note key and the version the write left. */
  describe: (key: string, newVersion: number, via: string) => string;
  /** Extra structured fields; `previous` is the note's HTML before this write. */
  extra?: (previous: string) => Record<string, unknown>;
}

/**
 * Read note `key` from `lib`, rewrite its HTML with `transform`, and PATCH it back at the
 * version it was read at, desktop first. A conflict (412) re-reads the note and applies
 * `transform` to the fresh copy once, so an append never drops what someone else added in
 * between, unless the caller pinned `version`.
 */
export async function rewriteNote(
  ctx: ToolContext,
  lib: LibraryRef,
  key: string,
  rewrite: NoteRewrite,
): Promise<ToolHandlerResult> {
  return withLibraryWriter(ctx, lib, async (w) => {
    const where = w.lib.type === 'group' ? `group library ${w.lib.id}` : 'this library';
    const read = async (): Promise<{ html: string; version: number } | ToolHandlerResult> => {
      const item = await readItem(w, key);
      if (!item) return refusal(`No item ${key} in ${where}, so nothing was written. Check the key with zotero_search_items.`);
      const data = item.data ?? item;
      if (data.itemType !== 'note') {
        return refusal(
          `${key} is ${data.itemType === 'attachment' || data.itemType === 'annotation' ? 'an' : 'a'} ${data.itemType}, not a note, so nothing was written.` +
            (data.itemType === 'annotation' ? ' An annotation comment is edited with zotero_update_item (`annotationComment`).' : ''),
        );
      }
      return { html: String(data.note ?? ''), version: Number(item.version ?? data.version) };
    };
    const first = await read();
    if ('content' in first) return first;
    const via = w.target === 'local' ? ' via the Zotero desktop app' : '';
    const done = (newVersion: number, previous: string, retried: boolean): ToolHandlerResult => {
      const structured: Record<string, unknown> = {
        note_key: key,
        newVersion,
        ...(rewrite.extra?.(previous) ?? {}),
        target: w.target,
      };
      if (retried) structured.retried = true;
      return ok(structured, rewrite.describe(key, newVersion, via) + (retried ? ' (re-read after a version conflict)' : ''));
    };
    const pinned = rewrite.version;
    if (pinned != null && pinned !== first.version) return stale(key, pinned, first.version);
    try {
      return done(await w.patchItem(key, { note: rewrite.transform(first.html) }, first.version), first.html, false);
    } catch (e) {
      if (!(e instanceof ZoteroApiError && e.status === 412)) throw e;
      if (pinned != null) return stale(key, pinned);
      const fresh = await read();
      if ('content' in fresh) return fresh;
      return done(await w.patchItem(key, { note: rewrite.transform(fresh.html) }, fresh.version), fresh.html, true);
    }
  });
}

function stale(key: string, pinned: number, current?: number): ToolHandlerResult {
  return refusal(
    `Note ${key} changed since version ${pinned}${current != null ? ` (it is at ${current} now)` : ''}, so nothing was written. ` +
      'Read it again with zotero_get_item, or omit `version` to write over whatever it holds now.',
  );
}

export interface NewNote {
  html: string;
  parentItem?: string;
  collections?: string[];
  tags?: string[];
}

/**
 * Write one new note into `lib`, desktop first. `describe` turns the new key into the
 * summary line; `extra` rides along in the structured result.
 */
export async function writeNewNote(
  ctx: ToolContext,
  lib: LibraryRef,
  note: NewNote,
  describe: (key: string, via: string) => string,
  extra: Record<string, unknown> = {},
): Promise<ToolHandlerResult> {
  return withLibraryWriter(ctx, lib, async (w) => {
    if (note.parentItem) {
      const problem = await parentProblem(w, note.parentItem);
      if (problem) return refusal(problem);
    }
    const item: Record<string, unknown> = {
      itemType: 'note',
      note: note.html,
      tags: (note.tags ?? []).map((tag) => ({ tag })),
    };
    if (note.parentItem) item.parentItem = note.parentItem;
    if (note.collections?.length) item.collections = note.collections;
    const result = await w.writeItems([item]);
    const written = result.successful[0];
    const via = w.target === 'local' ? ' via the Zotero desktop app' : '';
    return writeResult(
      {
        ...(written ? { key: written.key, version: written.version } : {}),
        ...(note.parentItem ? { parentItem: note.parentItem } : {}),
        ...extra,
        target: w.target,
        libraryVersion: result.newLibraryVersion,
        failed: result.failed,
      },
      written ? describe(written.key, via) : 'No note was written.',
      result.successful.length,
      1,
      result.failed,
    );
  });
}
