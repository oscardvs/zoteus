import type { ToolContext } from '../../registry/registry.js';
import type { LibraryRef } from '../../api/web-client.js';
import type { VersionBackend } from '../search/backend.js';

/**
 * What changed in a library (or one collection) over the last N days, and by whom.
 *
 * Read by listing items newest-modified first (`sort=dateModified&direction=desc`, which
 * both APIs serve, annotations and notes included) and stopping at the first row older than
 * the window. That is one request per 100 changes, not a crawl of the library.
 *
 * Attribution: the cloud Web API puts `meta.createdByUser` and `meta.lastModifiedByUser` on
 * GROUP items. The desktop local API does not (Zotero 10's `toResponseJSON` writes only
 * creatorSummary, parsedDate and numChildren into `meta`; checked against the running app on
 * 2026-11-10), so for a group the read is pinned to the cloud when a key can reach it, and
 * otherwise the answer says attribution is unavailable. The personal library has one author
 * by definition, and neither API names one there.
 *
 * "Recently Read" (Zotero 9+) is NOT used: it is built from `itemAttachments.lastRead`, a
 * column of the desktop's own database that neither the local API's item JSON nor the cloud
 * carries, so no Zotero API can answer it.
 */

export const MAX_ACTIVITY_SCAN = 1000;
const PAGE = 100;

export interface Person {
  id?: number;
  username?: string;
  name?: string;
}

export interface ActivityRow {
  key: string;
  itemType: string;
  change: 'added' | 'modified';
  dateAdded?: string;
  dateModified?: string;
  title?: string;
  parentItem?: string;
  /** The top-level item a note, attachment or annotation belongs to, when it could be resolved. */
  item?: string;
  itemTitle?: string;
  annotationType?: string;
  text?: string;
  comment?: string;
  color?: string;
  pageLabel?: string;
  createdBy?: string;
  modifiedBy?: string;
}

export interface ActivityResult {
  since: string;
  items: ActivityRow[];
  notes: ActivityRow[];
  annotations: ActivityRow[];
  byUser?: Record<string, { added: number; modified: number }>;
  attribution: 'cloud' | 'unavailable' | 'personal-library';
  attributionNote?: string;
  scanned: number;
  /** False when the window held more than MAX_ACTIVITY_SCAN changes. */
  complete: boolean;
}

export function cutoffIso(days: number, now = Date.now()): string {
  return new Date(now - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function personName(p: unknown): string | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const o = p as Person;
  return o.name?.trim() || o.username?.trim() || (o.id != null ? `user ${o.id}` : undefined);
}

export function stripHtml(html: string, max = 300): string {
  const text = html
    .replace(/<(br|\/p|\/h\d|\/li|\/div)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The ISO timestamp both APIs use, compared as strings (same format, UTC). */
function within(date: unknown, since: string): boolean {
  return typeof date === 'string' && date >= since;
}

export async function collectActivity(
  ctx: Pick<ToolContext, 'router' | 'capabilities' | 'logger'>,
  lib: LibraryRef,
  opts: { days: number; collectionKey?: string; now?: number },
): Promise<ActivityResult> {
  const since = cutoffIso(opts.days, opts.now);
  let backend: VersionBackend | undefined;
  let attribution: ActivityResult['attribution'] = lib.type === 'group' ? 'unavailable' : 'personal-library';
  let attributionNote: string | undefined;
  if (lib.type === 'group') {
    if (ctx.capabilities.cloud) {
      backend = 'cloud';
      attribution = 'cloud';
      attributionNote =
        'Read from the cloud Web API, the only one that names who added or changed a group item. Changes made in a desktop app show up once it has synced.';
    } else {
      attributionNote =
        'Who made each change is unavailable: the desktop local API does not report it, and no cloud API key is configured (set ZOTERO_API_KEY to see names).';
    }
  }

  const rows: any[] = [];
  let start = 0;
  let complete = true;
  const read = async (b: VersionBackend | undefined) =>
    ctx.router.searchItems({ sort: 'dateModified', direction: 'desc', limit: PAGE, start, library: lib, ...(b ? { backend: b } : {}) });
  for (;;) {
    let page;
    try {
      page = await read(backend);
    } catch (e) {
      if (backend !== 'cloud' || start > 0) throw e;
      // The key cannot read this group in the cloud: answer from wherever the router reads it.
      ctx.logger.info(`Activity: cloud read of group ${lib.id} failed (${e instanceof Error ? e.message : e}); reading unattributed.`);
      backend = undefined;
      attribution = 'unavailable';
      attributionNote = 'Who made each change is unavailable: the cloud API key could not read this group, and the desktop local API does not report it.';
      page = await read(backend);
    }
    let older = false;
    for (const it of page.data) {
      const data = it?.data ?? it;
      if (!within(data?.dateModified, since)) {
        older = true;
        break;
      }
      rows.push(it);
    }
    start += page.data.length;
    if (older || !page.data.length || (typeof page.totalResults === 'number' && start >= page.totalResults)) break;
    if (start >= MAX_ACTIVITY_SCAN) {
      complete = false;
      break;
    }
  }

  // Ancestors for children, so a note or annotation can name its paper and be scoped to a
  // collection. Read from the window first, then looked up (cached) when needed.
  const known = new Map<string, any>();
  for (const it of rows) known.set(String((it?.data ?? it)?.key ?? it?.key), it?.data ?? it);
  let lookups = 0;
  const dataOf = async (key: string): Promise<any | undefined> => {
    if (known.has(key)) return known.get(key);
    if (lookups >= 200) return undefined;
    lookups++;
    try {
      const it = await ctx.router.getItem(key, { library: lib, ...(backend ? { backend } : {}) });
      const data = it?.data ?? it;
      known.set(key, data);
      return data;
    } catch {
      known.set(key, undefined);
      return undefined;
    }
  };
  const topOf = async (data: any): Promise<any | undefined> => {
    let cur = data;
    for (let i = 0; i < 3 && cur?.parentItem; i++) cur = await dataOf(String(cur.parentItem));
    return cur?.parentItem ? undefined : cur;
  };

  const items: ActivityRow[] = [];
  const notes: ActivityRow[] = [];
  const annotations: ActivityRow[] = [];
  const byUser: Record<string, { added: number; modified: number }> = {};
  for (const it of rows) {
    const data = it?.data ?? it;
    if (data?.deleted) continue;
    const top = await topOf(data);
    if (opts.collectionKey && !(Array.isArray(top?.collections) && top.collections.includes(opts.collectionKey))) continue;
    const change: ActivityRow['change'] = within(data.dateAdded, since) ? 'added' : 'modified';
    const createdBy = personName(it?.meta?.createdByUser);
    const modifiedBy = personName(it?.meta?.lastModifiedByUser) ?? (change === 'added' ? createdBy : undefined);
    const row: ActivityRow = {
      key: String(data.key ?? it.key),
      itemType: String(data.itemType ?? ''),
      change,
      ...(data.dateAdded ? { dateAdded: data.dateAdded } : {}),
      ...(data.dateModified ? { dateModified: data.dateModified } : {}),
      ...(data.parentItem ? { parentItem: data.parentItem } : {}),
      ...(createdBy ? { createdBy } : {}),
      ...(modifiedBy ? { modifiedBy } : {}),
    };
    if (data.parentItem && top) {
      row.item = String(top.key);
      if (typeof top.title === 'string') row.itemTitle = top.title;
    }
    const who = change === 'added' ? createdBy : modifiedBy;
    if (who) {
      const u = (byUser[who] ??= { added: 0, modified: 0 });
      u[change]++;
    }
    if (row.itemType === 'annotation') {
      if (data.annotationType) row.annotationType = data.annotationType;
      if (data.annotationText) row.text = data.annotationText;
      if (data.annotationComment) row.comment = data.annotationComment;
      if (data.annotationColor) row.color = data.annotationColor;
      if (data.annotationPageLabel) row.pageLabel = data.annotationPageLabel;
      annotations.push(row);
    } else if (row.itemType === 'note') {
      row.text = stripHtml(String(data.note ?? ''));
      notes.push(row);
    } else {
      row.title = typeof data.title === 'string' ? data.title : '';
      items.push(row);
    }
  }
  return {
    since,
    items,
    notes,
    annotations,
    ...(Object.keys(byUser).length ? { byUser } : {}),
    attribution,
    ...(attributionNote ? { attributionNote } : {}),
    scanned: rows.length,
    complete,
  };
}
