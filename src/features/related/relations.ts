import type { LibraryRef } from '../../api/web-client.js';
import { normaliseRelations } from '../dedupe/merge-plan.js';

/**
 * Zotero's "Related" links, as Zotero stores them.
 *
 * An item's `relations` object maps a predicate to one URI or an array of them; "Related"
 * is the predicate `dc:relation`, and Zotero writes it on BOTH items (A names B, B names A).
 * The URI names the library by its sync identity, never by the local API's `users/0`:
 *
 *   http://zotero.org/users/<userID>/items/<KEY>     personal library
 *   http://zotero.org/groups/<groupID>/items/<KEY>   group library
 *
 * Read on 2026-11-10 from a real Zotero 10 local API: `"relations": {"dc:relation":
 * ["http://zotero.org/users/19552201/items/B9IKRX2J"]}` on item Z6CXHRRJ, and the reverse
 * link on B9IKRX2J. The local API always answers an array, even for one URI; the Web API
 * documents a single URI as a plain string. Both are read here, and a write keeps Zotero's
 * written form (merge-plan's `denormaliseRelations`).
 *
 * A personal library that has never synced has no user id; Zotero then uses
 * `http://zotero.org/users/local/<localUserKey>/items/<KEY>`, and that local key is not
 * exposed by either API, so such a library cannot be given a correct URI from here.
 */
export const RELATED_PREDICATE = 'dc:relation';

/** `/items/KEY` at the end of a Zotero item URI. */
export function keyOfUri(uri: string): string | undefined {
  return /\/items\/([A-Z0-9]{8})$/.exec(uri)?.[1];
}

/** The library part of an item URI (everything before `/items/`). */
export function libraryOfUri(uri: string): string | undefined {
  return /^(.*)\/items\/[A-Z0-9]{8}$/.exec(uri)?.[1];
}

/** `http://zotero.org/users/123` or `http://zotero.org/groups/456`, or undefined when no real id is known. */
export function libraryUriBase(lib: LibraryRef, userId?: number): string | undefined {
  if (lib.type === 'group') return lib.id > 0 ? `http://zotero.org/groups/${lib.id}` : undefined;
  const id = lib.id > 0 ? lib.id : userId;
  return id && id > 0 ? `http://zotero.org/users/${id}` : undefined;
}

/** The account id a personal-library record names (`library.id`), when it is a real one. */
export function recordUserId(item: any): number | undefined {
  const l = item?.library;
  return l?.type === 'user' && Number.isSafeInteger(l.id) && l.id > 0 ? l.id : undefined;
}

/** The item keys `relations` names as Related, inside the library at `base` only. */
export function relatedKeys(relations: unknown, base?: string): Set<string> {
  const out = new Set<string>();
  for (const uri of normaliseRelations(relations)[RELATED_PREDICATE] ?? []) {
    const key = keyOfUri(uri);
    if (!key) continue;
    if (base && libraryOfUri(uri) !== base && !/\/users\/(0|local\/[^/]+)$/.test(libraryOfUri(uri) ?? '')) continue;
    out.add(key);
  }
  return out;
}
