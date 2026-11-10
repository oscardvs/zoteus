/**
 * The `search` / `fetch` pair that ChatGPT's deep research and company knowledge expect.
 *
 * Shapes follow OpenAI's "Building MCP servers for ChatGPT and API integrations"
 * (https://developers.openai.com/api/docs/mcp, read 2026-11-10; the page carries no date):
 *
 * - `search({ query })` returns `{ results: [{ id, title, url }] }`.
 * - `fetch({ id })` returns `{ id, title, text, url, metadata? }`.
 * - Both return the object as `structuredContent` AND as one JSON-encoded text item in
 *   `content`, and ChatGPT only makes a citation when `url` is a non-empty string.
 *
 * Nothing here reaches Zotero on its own: search delegates to the hybrid index behind
 * zotero_semantic_search when it holds rows, otherwise to the keyword search behind
 * zotero_search_items, and fetch to the record and full-text paths the zotero_* tools use.
 */
import type { LibraryRef } from '../../api/web-client.js';
import type { ToolContext, ToolHandlerResult } from '../../registry/registry.js';
import semanticSearch from '../../tools/semantic-search.js';
import searchItems, { creatorSummary } from '../../tools/search-items.js';
import getFulltext from '../../tools/get-fulltext.js';

/** Results one search returns. */
export const SEARCH_LIMIT = 10;
/** Characters of full text one fetch returns at most (get-fulltext's own ceiling). */
export const FETCH_MAX_CHARS = 100_000;

export interface SearchResult {
  id: string;
  title: string;
  url: string;
}

/** The single-text-item envelope OpenAI's page shows: structuredContent plus its JSON. */
export function jsonResult(structured: Record<string, unknown>): ToolHandlerResult {
  return { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
}

export function errorResult(text: string): ToolHandlerResult {
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * The stable id of an item: its key in the personal library, `group:<groupId>:<KEY>` in a
 * group, so a key that repeats across libraries still names one item.
 */
export function documentId(lib: LibraryRef, key: string): string {
  return lib.type === 'group' ? `group:${lib.id}:${key}` : key;
}

/** Inverse of documentId. Undefined for anything that is not one of its two forms. */
export function parseDocumentId(id: string): { key: string; library?: LibraryRef } | undefined {
  const trimmed = id.trim();
  if (/^[A-Z0-9]{8}$/.test(trimmed)) return { key: trimmed };
  const m = /^group:(\d+):([A-Z0-9]{8})$/.exec(trimmed);
  if (m) return { key: m[2]!, library: { type: 'group', id: Number(m[1]) } };
  return undefined;
}

/**
 * A URL a person can open. The zotero.org web library form is the one Zotero itself puts in
 * an item's `links.alternate` (`https://www.zotero.org/users/<id>/items/<KEY>`, and
 * `/groups/<id>/items/<KEY>` for a group). With no known user id (a desktop-only install
 * with no API key) the desktop app's own `zotero://select` link is the only one that opens
 * the item, so that is returned rather than an empty string, which would drop the citation.
 */
export function itemUrl(lib: LibraryRef, key: string, userId?: number): string {
  if (lib.type === 'group') return `https://www.zotero.org/groups/${lib.id}/items/${key}`;
  const id = lib.id > 0 ? lib.id : (userId ?? 0);
  if (id > 0) return `https://www.zotero.org/users/${id}/items/${key}`;
  return `zotero://select/library/items/${key}`;
}

function cloudUserId(ctx: ToolContext): number | undefined {
  return ctx.capabilities?.cloud?.userID;
}

/** Whether the default library's hybrid index holds anything worth querying. */
function indexHasRows(ctx: ToolContext): boolean {
  const index = ctx.search;
  if (!index) return false;
  index.syncFromStore?.();
  return !index.isEmpty;
}

export async function runSearch(ctx: ToolContext, query: string): Promise<ToolHandlerResult> {
  const lib = ctx.router.defaultLibrary();
  const userId = cloudUserId(ctx);
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  const add = (key: unknown, title: unknown): void => {
    if (typeof key !== 'string' || !key || seen.has(key)) return;
    seen.add(key);
    results.push({
      id: documentId(lib, key),
      title: typeof title === 'string' && title.trim() ? title : '(untitled)',
      url: itemUrl(lib, key, userId),
    });
  };

  let source: 'index' | 'keyword' = 'keyword';
  if (indexHasRows(ctx)) {
    const semantic = await semanticSearch.handler({ q: query, limit: SEARCH_LIMIT }, ctx);
    const hits = (semantic.structuredContent?.hits as Array<{ itemKey?: string; title?: string }>) ?? [];
    if (!semantic.isError && hits.length) {
      source = 'index';
      for (const h of hits) add(h.itemKey, h.title);
    }
  }
  if (source === 'keyword') {
    const keyword = await searchItems.handler({ q: query, limit: SEARCH_LIMIT, top: true }, ctx);
    if (keyword.isError) return keyword;
    const items = (keyword.structuredContent?.items as Array<{ key?: string; title?: string }>) ?? [];
    for (const it of items) add(it.key, it.title);
  }
  // A desktop-only install has no cloud key to name the user, but the desktop app knows it
  // and says so in every record it serves (`library.id`, `links.alternate`). One record is
  // enough to turn every `zotero://` link into the web library URL ChatGPT can cite.
  if (results.length && lib.type === 'user' && !(lib.id > 0) && !(userId && userId > 0)) {
    const learned = await userIdFromRecord(ctx, results[0]!.id);
    if (learned) for (const r of results) r.url = itemUrl(lib, r.id, learned);
  }
  return jsonResult({ results });
}

async function userIdFromRecord(ctx: ToolContext, key: string): Promise<number | undefined> {
  try {
    const item: any = await ctx.router.getItem(key, {});
    const fromLibrary = item?.library?.type === 'user' ? Number(item.library.id) : NaN;
    if (fromLibrary > 0) return fromLibrary;
    const m = /\/users\/(\d+)\//.exec(String(item?.links?.alternate?.href ?? ''));
    return m && Number(m[1]) > 0 ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

/** The metadata header fetch puts before the full text, so an item with none still has text. */
function metadataText(d: Record<string, any>): string {
  const lines: string[] = [];
  const title = d.title ?? d.caseName ?? d.subject;
  if (title) lines.push(`Title: ${title}`);
  const creators = (d.creators ?? [])
    .map((c: any) => c.name ?? [c.firstName, c.lastName].filter(Boolean).join(' '))
    .filter(Boolean);
  if (creators.length) lines.push(`Creators: ${creators.join('; ')}`);
  if (d.date) lines.push(`Date: ${d.date}`);
  const venue = d.publicationTitle ?? d.bookTitle ?? d.proceedingsTitle ?? d.publisher;
  if (venue) lines.push(`Published in: ${venue}`);
  if (d.DOI) lines.push(`DOI: ${d.DOI}`);
  if (d.abstractNote) lines.push('', `Abstract: ${d.abstractNote}`);
  return lines.join('\n');
}

export async function runFetch(ctx: ToolContext, id: string): Promise<ToolHandlerResult> {
  const parsed = parseDocumentId(id);
  if (!parsed) {
    return errorResult(
      `"${id}" is not a document id from search: expected an 8-character Zotero item key, or group:<groupId>:<KEY>.`,
    );
  }
  const lib = parsed.library ?? ctx.router.defaultLibrary();
  const libArgs = parsed.library ? { library_type: 'group', library_id: parsed.library.id } : {};
  let item: any;
  try {
    item = await ctx.router.getItem(parsed.key, { library: parsed.library });
  } catch (e) {
    return errorResult(`No item ${id} could be read: ${e instanceof Error ? e.message : String(e)}`);
  }
  const d: Record<string, any> = item?.data ?? item ?? {};
  const header = metadataText(d);

  const metadata: Record<string, unknown> = { itemType: d.itemType, key: parsed.key };
  if (d.date) metadata.date = d.date;
  const creators = creatorSummary(d.creators);
  if (creators) metadata.creators = creators;
  if (d.DOI) metadata.DOI = d.DOI;
  if (d.url) metadata.sourceUrl = d.url;
  if (parsed.library) metadata.library = `group:${parsed.library.id}`;

  // Notes are their own text; everything else reads its best attachment, as get-fulltext does.
  let body = '';
  if (d.itemType === 'note') {
    body = String(d.note ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    metadata.fulltext = body ? 'note' : 'none';
  } else if (d.itemType !== 'attachment' || d.contentType) {
    try {
      const ft = await getFulltext.handler({ item_key: parsed.key, max_chars: FETCH_MAX_CHARS, ...libArgs }, ctx);
      const sc = ft.structuredContent ?? {};
      if (!ft.isError && typeof sc.text === 'string' && sc.text.trim()) {
        body = sc.text;
        metadata.fulltext = sc.fulltextSource ?? 'yes';
        if (sc.truncated) metadata.truncated = true;
      } else {
        metadata.fulltext = 'none';
      }
    } catch {
      metadata.fulltext = 'none';
    }
  }

  const alternate: unknown = item?.links?.alternate?.href;
  const url =
    typeof alternate === 'string' && alternate.startsWith('https://www.zotero.org/') && !alternate.includes('/users/0/')
      ? alternate
      : itemUrl(lib, parsed.key, cloudUserId(ctx));

  return jsonResult({
    id: documentId(lib, parsed.key),
    title: (d.title ?? d.caseName ?? d.subject ?? '').trim() || '(untitled)',
    text: [header, body].filter(Boolean).join('\n\n') || '(no text)',
    url,
    metadata,
  });
}
