import type { ToolContext } from '../../registry/registry.js';
import type { LibraryRef } from '../../api/web-client.js';
import { doiFrom, yearKey } from '../resolve/library-census.js';
import { libraryUriBase, recordUserId, relatedKeys } from './relations.js';

const PAGE = 100;
const SKIP_TYPES = new Set(['note', 'attachment', 'annotation']);

export interface ScopeItem {
  key: string;
  title?: string;
  year?: string;
  doi?: string;
  /** Keys this item already names as Related, in this library. */
  related: Set<string>;
}

export interface Scope {
  items: ScopeItem[];
  /** Top-level items the listing reported, when it did. */
  totalResults?: number;
  complete: boolean;
}

function project(raw: any, base: string | undefined): ScopeItem | undefined {
  const d = raw?.data ?? raw ?? {};
  if (!d.itemType || SKIP_TYPES.has(d.itemType) || d.deleted) return undefined;
  return {
    key: raw.key ?? d.key,
    ...(d.title ? { title: String(d.title) } : {}),
    ...(yearKey(d.date) ? { year: yearKey(d.date) } : {}),
    ...(doiFrom(d) ? { doi: doiFrom(d) } : {}),
    related: relatedKeys(d.relations, base),
  };
}

/** The library URI base, from the library itself or from the account a record names. */
export function baseFor(ctx: ToolContext, lib: LibraryRef, records: any[]): string | undefined {
  const userId = records.map(recordUserId).find((id) => id) ?? ctx.capabilities.cloud?.userID;
  return libraryUriBase(lib, userId);
}

/** The items to look for citation links among: given keys, a collection, or the whole library. */
export async function gatherScope(
  ctx: ToolContext,
  lib: LibraryRef,
  opts: { itemKeys?: string[]; collectionKey?: string; maxItems: number },
): Promise<Scope> {
  const raws: any[] = [];
  let totalResults: number | undefined;
  let complete = true;
  if (opts.itemKeys?.length) {
    const keys = [...new Set(opts.itemKeys)];
    for (let i = 0; i < keys.length; i += 50) {
      const page = await ctx.router.searchItems({ itemKey: keys.slice(i, i + 50).join(','), limit: 50, library: lib });
      raws.push(...(page.data ?? []));
    }
  } else {
    for (let start = 0; ; start += PAGE) {
      if (start >= opts.maxItems) {
        complete = totalResults !== undefined && totalResults <= opts.maxItems;
        break;
      }
      const page = await ctx.router.searchItems({
        top: true,
        limit: Math.min(PAGE, opts.maxItems - start),
        start,
        library: lib,
        ...(opts.collectionKey ? { collectionKey: opts.collectionKey } : {}),
      });
      raws.push(...(page.data ?? []));
      totalResults = page.totalResults ?? totalResults;
      if (!page.data?.length || start + PAGE >= (page.totalResults ?? 0)) break;
    }
  }
  const base = baseFor(ctx, lib, raws);
  const items = raws.map((r) => project(r, base)).filter((x): x is ScopeItem => Boolean(x));
  return { items, ...(totalResults !== undefined ? { totalResults } : {}), complete };
}

export interface Suggestion {
  citing: ScopeItem;
  cited: ScopeItem;
  /** Both cite each other (it happens: preprints and replies). */
  mutual: boolean;
  alreadyRelated: boolean;
}

/**
 * Pairs inside `items` where one cites the other, from each work's OpenAlex reference list.
 * Items that share a DOI are duplicates, not a citation, and are never paired.
 */
export function citationPairs(items: ScopeItem[], links: Map<string, { id: string; references: string[] }>): Suggestion[] {
  const byId = new Map<string, ScopeItem[]>();
  for (const item of items) {
    const link = item.doi ? links.get(item.doi) : undefined;
    if (!link) continue;
    const list = byId.get(link.id) ?? [];
    list.push(item);
    byId.set(link.id, list);
  }
  const out = new Map<string, Suggestion>();
  for (const citing of items) {
    const link = citing.doi ? links.get(citing.doi) : undefined;
    if (!link) continue;
    for (const ref of new Set(link.references)) {
      for (const cited of byId.get(ref) ?? []) {
        if (cited.key === citing.key || cited.doi === citing.doi) continue;
        const pairKey = [citing.key, cited.key].sort().join('|');
        const already = citing.related.has(cited.key) || cited.related.has(citing.key);
        const prev = out.get(pairKey);
        if (prev) {
          if (prev.citing.key !== citing.key) prev.mutual = true;
          continue;
        }
        out.set(pairKey, { citing, cited, mutual: false, alreadyRelated: already });
      }
    }
  }
  return [...out.values()];
}
