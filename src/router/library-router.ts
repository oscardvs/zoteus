import type { ZoteusConfig } from '../config.js';
import type { Capabilities } from './capabilities.js';
import type {
  WebApiClient,
  LibraryRef,
  ItemQuery,
  ListResult,
  KeyInfo,
  VersionsResult,
  WrittenObjectType,
} from '../api/web-client.js';
import type { LocalApiClient, SyncObjectType } from '../api/local-client.js';
import type { VersionBackend } from '../features/search/backend.js';
import { PendingCloudWrites, type PendingWrite } from './pending-writes.js';

/**
 * Keys per `?itemKey=` request. Both APIs cap that list at 50, so a full page of 100
 * results is two requests rather than one refusal.
 */
const ITEM_KEY_BATCH = 50;

/** The page size a caller that named no `limit` gets, matching zotero_search_items. */
const DEFAULT_PAGE = 25;

export interface LibraryRouterOptions {
  config: ZoteusConfig;
  capabilities: Capabilities;
  web: WebApiClient;
  local?: LocalApiClient;
}

export interface ReadOpts {
  library?: LibraryRef;
  /**
   * Force this read to one API instead of letting the router choose.
   *
   * For crawls that span many requests and then RECORD which API served them. The routing
   * rule is re-evaluated per request, and whether the desktop app is up can change while a
   * crawl runs, so an index build that let the rule decide each page could splice pages
   * from two APIs together and stamp the result with a single library version — and the
   * two APIs number their versions independently, so the next incremental update would
   * diff against a sequence its rows never came from.
   *
   * Pinning the decision instead makes the crawl coherent by construction: if the app it
   * chose goes away mid-crawl the read fails, the build ends in `error`, and no stamp is
   * written. That is the right outcome — better a build to redo than an index that quietly
   * claims to be current.
   */
  backend?: VersionBackend;
}

/**
 * Decides whether a READ is served by the desktop local API or the cloud Web API.
 * Rule: use local for the default personal (user) library, and for a group library the
 * desktop actually holds, whenever the local API is up and not disabled; everything else
 * -> cloud.
 *
 * Groups were cloud-only until Zotero 10, which began serving /groups/<id> locally. That
 * is why the rule used to read "personal library only": on a Zotero 10 install with no
 * cloud key, the old rule returned nothing for a group the desktop was holding all along.
 */
export class LibraryRouter {
  private readonly config: ZoteusConfig;
  private readonly capabilities: Capabilities;
  private readonly web: WebApiClient;
  private readonly local?: LocalApiClient;
  private readonly pending = new PendingCloudWrites();

  constructor(opts: LibraryRouterOptions) {
    this.config = opts.config;
    this.capabilities = opts.capabilities;
    this.web = opts.web;
    this.local = opts.local;
  }

  whoami(): KeyInfo | null {
    return this.capabilities.cloud;
  }

  defaultLibrary(): LibraryRef {
    if (this.config.libraryId) return { type: this.config.libraryType, id: this.config.libraryId };
    if (this.capabilities.cloud) return { type: 'user', id: this.capabilities.cloud.userID };
    // Local-only mode: the desktop personal library is addressed as users/0.
    return { type: 'user', id: 0 };
  }

  private useLocal(library: LibraryRef, pinned?: VersionBackend): boolean {
    // A pinned read has already been routed once, by `servesLocally`, and is repeating that
    // decision rather than making a new one.
    if (pinned) return pinned === 'local';
    if (!this.local || !this.capabilities.localApi || this.config.local === 'off') return false;
    const def = this.defaultLibrary();
    // users/0 maps to the desktop's own personal library, whatever its cloud id.
    if (library.type === 'user') return library.id === def.id || library.id === 0;
    // A group only if this desktop holds it; otherwise the read belongs to the cloud.
    // Capabilities is a published interface: an older caller may hand us a literal with
    // no localGroupIds at all, and a missing field must route to the cloud, not throw.
    return (this.capabilities.localGroupIds ?? []).includes(library.id);
  }

  /**
   * Whether a read of this library goes to the desktop app rather than the cloud. Public
   * because the two APIs number their library versions independently: anything that STORES
   * a version (the search index's stamp) has to record which sequence it came from, and a
   * routing change between runs must invalidate it rather than diff across the two.
   *
   * Answers the standing rule, deliberately ignoring the pending-write override below. The
   * callers are the ones that pin a whole crawl and stamp the result, and a write would
   * otherwise flip their answer for a few minutes, changing the recorded backend and
   * forcing the index to be rebuilt from scratch. They keep reading the desktop and stay a
   * write behind, which is what an index that stamps its own as-of version already means.
   */
  servesLocally(library?: LibraryRef): boolean {
    return this.useLocal(library ?? this.defaultLibrary());
  }

  /**
   * The library slot a pending write is filed under. The personal library has two
   * spellings, users/0 on the desktop and users/<cloud id> on the Web API, and a write
   * addressed one way has to be found again by a read addressed the other. Mirrors the
   * personal-library test in `useLocal`.
   */
  private librarySlot(library: LibraryRef): string {
    const def = this.defaultLibrary();
    if (library.type === 'user' && (library.id === def.id || library.id === 0)) return 'user:default';
    return `${library.type}:${library.id}`;
  }

  /**
   * Record a cloud write so that reads of that library stop being answered by a desktop app
   * that has not synced it yet.
   *
   * The bug this closes: group writes always go to the cloud, and personal-library writes
   * from zotero_create_items and zotero_update_item do too, while reads of both go to the
   * desktop whenever it holds the library. Measured against a real Zotero 10 and a real
   * cloud key, an item created in either library came back "Wrote 1 item(s)" with its key,
   * and the very next zotero_search_items found nothing and zotero_get_item answered
   * "Local API 404". An agent that verifies its own writes is told they did not happen, and
   * writes them again.
   *
   * The obvious repair, holding the library version the write returned and reading from the
   * cloud until the desktop reaches it, does not work: the sequences are unrelated. On this
   * machine the personal library was at cloud version 3476 and desktop version 681, and the
   * test group at cloud 15 and desktop 5, so the desktop never "reaches" a cloud version and
   * every library would stay pinned to the cloud forever after one write. What IS comparable
   * is the desktop against itself, so the witness is the written object: reads go to the
   * cloud until the desktop can show it has that object, and has it at a version newer than
   * the one it held before the write.
   *
   * The entry is recorded synchronously, before the baseline is measured, because the entry
   * is what pins reads; a read arriving in the meantime must find it already there.
   */
  noteCloudWrite(
    lib: LibraryRef,
    type: WrittenObjectType,
    keys: string[],
    removed = false,
  ): void {
    // Any one key witnesses the whole write, and the last is the newest.
    const key = keys[keys.length - 1];
    if (!key) return;
    const slot = this.librarySlot(lib);
    this.pending.note(slot, { type, key, removed, before: undefined });
    // A delete is watched for the object disappearing, so it needs no baseline; and a
    // library the desktop does not serve has nothing to compare against.
    if (removed || !this.local || !this.useLocal(lib)) return;
    void this.local
      .objectVersion(type, key, lib)
      .then((before) => this.pending.setBaseline(slot, key, before))
      .catch(() => {
        // Without a baseline the write clears as soon as the desktop has the key at all.
        // That is exact for a create and weak for an update, which is the right way round:
        // it is the create whose absence sends an agent round the loop again.
      });
  }

  /**
   * The routing decision for one read: the standing rule, then the pending-write override.
   *
   * The override costs nothing on a library nobody has written to, which is every read on
   * the common path: with no entry for the library this returns after the same test
   * `servesLocally` makes, and issues no request of its own.
   */
  private async route(library: LibraryRef, pinned?: VersionBackend): Promise<boolean> {
    if (pinned) return pinned === 'local';
    if (!this.useLocal(library)) return false;
    const slot = this.librarySlot(library);
    const write = this.pending.get(slot);
    if (!write) return true;
    if (!(await this.desktopHasCaughtUp(library, write))) return false;
    this.pending.clear(slot);
    return true;
  }

  /**
   * Whether the desktop app now holds the pending write. One request to 127.0.0.1, and only
   * while a write is outstanding: it stops for good the moment Zotero syncs (measured at a
   * few minutes on this machine), and there is no timeout that gives up before then, because
   * until the desktop has the write the cloud is simply where the data is.
   */
  private async desktopHasCaughtUp(library: LibraryRef, write: PendingWrite): Promise<boolean> {
    if (!this.local) return false;
    let now: number | null;
    try {
      now = await this.local.objectVersion(write.type, write.key, library);
    } catch {
      // An app that cannot answer cannot be shown to hold the write. The cloud took the
      // write and can take the read.
      return false;
    }
    if (write.removed) return now === null;
    if (now === null) return false;
    // No baseline, or none to have: presence is the whole signal for a created object.
    if (write.before === undefined || write.before === null) return true;
    // It already had the object, so only its own version moving proves the write landed.
    return now > write.before;
  }

  /** Item keys and versions (`?format=versions`), routed like every other read. */
  async itemVersions(
    opts: ReadOpts & { since?: number; top?: boolean; limit?: number; start?: number; itemType?: string } = {},
  ): Promise<VersionsResult> {
    const { library, backend, ...rest } = opts;
    const lib = library ?? this.defaultLibrary();
    if (await this.route(lib, backend)) return this.local!.itemVersions(rest, lib);
    return this.web.itemVersions(lib, rest);
  }

  async searchItems(query: ItemQuery & ReadOpts = {}): Promise<ListResult> {
    const { library, backend, ...q } = query;
    const lib = library ?? this.defaultLibrary();
    // `top` combined with an `itemType` filter is the one shape neither API answers the
    // way the tool promises, so Zoteus works it out itself (#79).
    if (q.top && q.itemType) return this.topLevelItemsOfType(lib, backend, q);
    if (await this.route(lib, backend)) return this.local!.listItems(q, lib);
    return this.web.listItems(lib, q);
  }

  /**
   * `top: true` together with an `itemType` filter, resolved by Zoteus rather than by the
   * API, because neither API answers that combination the way `top` is documented
   * ("Only top-level items"). Measured on 2026-09-12 against a 1302-item library held by
   * both a Zotero 10 desktop and the cloud, asking for `itemType=attachment, top=true`:
   *
   *   - the desktop local API DROPS the top-level restriction as soon as an `itemType`
   *     filter is present. `/items/top?itemType=attachment` answered Total-Results 363
   *     with all ten items of the first page carrying a `parentItem`, byte for byte the
   *     same answer as `/items?itemType=attachment`. `itemType=annotation` settles it:
   *     an annotation is never top-level, yet `/items/top` reported all 543 of them.
   *     This is what #79 reported.
   *   - the cloud Web API keeps its promise about `parentItem` but breaks the other one:
   *     it maps each matching child UP to its top-level parent, so the same request came
   *     back as 263 preprints, books and conference papers, not one of them an
   *     attachment. No `parentItem` anywhere, and no item of the requested type either.
   *
   * The true answer for that library is zero standalone attachments, which is what this
   * method returns on both backends.
   *
   * Both APIs are correct about `top` with no `itemType` in play (`/items/top` alone gave
   * 320 of 1302, none with a `parentItem`; `/items/top?itemKey=<child>` answers with
   * nothing), so the restriction is only ever taken away from them for this one shape,
   * and the ordinary `top` listing that the search index and zotero_tag_audit page
   * through is left exactly as it was.
   *
   * `totalResults` is EXACT, not an estimate and not the API's inflated count: the whole
   * key set is intersected before anything is sliced, so the number the tool reports and
   * the pages it hands out come from one and the same list. That is affordable only
   * because keys are cheap (see `listItemKeys`); reading every candidate item instead
   * would have cost seconds per search on attachments alone.
   */
  private async topLevelItemsOfType(
    lib: LibraryRef,
    backend: VersionBackend | undefined,
    q: ItemQuery,
  ): Promise<ListResult> {
    const useLocal = await this.route(lib, backend);
    const keysOf = (query: ItemQuery) =>
      useLocal ? this.local!.listItemKeys(query, lib) : this.web.listItemKeys(lib, query);
    const itemsOf = (query: ItemQuery) =>
      useLocal ? this.local!.listItems(query, lib) : this.web.listItems(lib, query);

    const { top: _top, limit, start, ...filters } = q;
    // The second read is deliberately filter-free apart from `includeTrashed`: it is the
    // library's top-level key set, the fact the APIs get right, and the filters are
    // already accounted for by the first read. Giving it the `itemType` back would walk
    // straight into the bug this method exists to route around.
    const [matching, topLevel] = await Promise.all([
      keysOf({ ...filters, top: false }),
      keysOf({ top: true, includeTrashed: filters.includeTrashed }),
    ]);
    const isTopLevel = new Set(topLevel.keys);
    const hits = matching.keys.filter((key) => isTopLevel.has(key));

    const from = start ?? 0;
    const wanted = hits.slice(from, from + (limit ?? DEFAULT_PAGE));
    const fetched = new Map<string, any>();
    for (let i = 0; i < wanted.length; i += ITEM_KEY_BATCH) {
      const batch = wanted.slice(i, i + ITEM_KEY_BATCH);
      // `top: true` matters on the desktop, whose `?itemKey=` on plain /items answers with
      // the named items AND every descendant they have (77 items for three keys, measured);
      // on /items/top it is exactly the keys asked for. Every key here is top-level by
      // construction, so nothing the caller should see is filtered out by asking that way.
      const page = await itemsOf({ itemKey: batch.join(','), top: true, limit: batch.length });
      for (const item of page.data) if (item?.key) fetched.set(item.key, item);
    }

    return {
      // Back in the order the keys came in, which is the caller's `sort`: neither API
      // promises to honour the order of an `itemKey` list.
      data: wanted.map((key) => fetched.get(key)).filter(Boolean),
      totalResults: hits.length,
      lastModifiedVersion: matching.lastModifiedVersion,
    };
  }

  async getItem(
    key: string,
    opts: ReadOpts & { include?: string; format?: string; style?: string; locale?: string } = {},
  ): Promise<any> {
    const { library, ...rest } = opts;
    const lib = library ?? this.defaultLibrary();
    if (await this.route(lib)) return this.local!.getItem(key, rest, lib);
    return this.web.getItem(lib, key, rest);
  }

  async getItemChildren(key: string, opts: ReadOpts & ItemQuery = {}): Promise<ListResult> {
    const { library, ...rest } = opts;
    const lib = library ?? this.defaultLibrary();
    // Prefer the desktop app for the personal library (local-only mode has no cloud
    // fallback — hitting api.zotero.org with user id 0 yields "Invalid user ID").
    if (await this.route(lib)) return this.local!.getItemChildren(key, rest, lib);
    return this.web.getItemChildren(lib, key, rest);
  }

  /**
   * Indexed full text for an attachment (null when there is none).
   *
   * Routed like every other read, so a running desktop app answers key-free: Zotero 7+
   * serves the same `/fulltext` endpoints locally as the cloud does. Before this was
   * routed, full-text reads went to api.zotero.org unconditionally and failed outright in
   * local-only mode (no key, and the personal library addressed as users/0).
   */
  async getFullText(key: string, opts: ReadOpts = {}): Promise<any | null> {
    const lib = opts.library ?? this.defaultLibrary();
    if (await this.route(lib, opts.backend)) return this.local!.getFullText(key, lib);
    return this.web.getFullText(lib, key);
  }

  /** Attachment keys whose full text changed after `version`, mapped to that version. */
  async fullTextSince(version: number, opts: ReadOpts = {}): Promise<Record<string, number>> {
    const lib = opts.library ?? this.defaultLibrary();
    if (await this.route(lib, opts.backend)) return this.local!.fullTextSince(version, lib);
    return this.web.fullTextSince(lib, version);
  }

  /**
   * Tags with their usage counts, routed like every other read. Before this existed,
   * zotero_list_tags and zotero_tag_audit read tags from api.zotero.org unconditionally,
   * and in key-free local mode that is users/0, which the cloud rejects: on the majority
   * setup (desktop app, no cloud key) both tools were unreachable, and the desktop had
   * been serving /users/0/tags all along.
   */
  async listTags(
    opts: ReadOpts & { q?: string; limit?: number; start?: number } = {},
  ): Promise<ListResult> {
    const { library, backend, ...rest } = opts;
    const lib = library ?? this.defaultLibrary();
    if (await this.route(lib, backend)) return this.local!.listTags(rest, lib);
    return this.web.listTags(lib, rest);
  }

  /**
   * Object keys mapped to their versions for one type, routed like every other read: the
   * sync delta zotero_sync reports (#64, #26, #67, same cause as the tag reads above).
   *
   * Throws LocalApiUnsupportedError where the desktop app serves the library but has no
   * answer for that type. Deliberately NOT a per-type fallback to the cloud: the two APIs
   * number their library versions independently, so a delta answered half from each would
   * be handed back under a single `since` that belongs to neither sequence. A caller that
   * wants the whole delta from one API asks that one for all of it.
   */
  async versions(
    type: SyncObjectType,
    since: number,
    opts: ReadOpts = {},
  ): Promise<Record<string, number>> {
    const lib = opts.library ?? this.defaultLibrary();
    if (await this.route(lib, opts.backend)) return this.local!.objectVersions(type, since, lib);
    return this.web.versions(lib, type, since);
  }

  /**
   * The deletion log since a version, routed like every other read. Cloud-only in
   * practice: the desktop app keeps none, so a locally served library throws
   * LocalApiUnsupportedError here for the caller to report.
   */
  async deleted(since: number, opts: ReadOpts = {}): Promise<Record<string, string[]>> {
    const lib = opts.library ?? this.defaultLibrary();
    if (await this.route(lib, opts.backend)) return this.local!.deleted(since, lib);
    return this.web.deleted(lib, since);
  }

  async listCollections(
    opts: ReadOpts & { top?: boolean; limit?: number; start?: number } = {},
  ): Promise<ListResult> {
    const { library, ...rest } = opts;
    const lib = library ?? this.defaultLibrary();
    if (await this.route(lib)) return this.local!.listCollections(rest, lib);
    return this.web.listCollections(lib, rest);
  }

  /**
   * Saved-search definitions, routed like every other read so a running desktop app serves
   * them with no cloud key (#64, #26, #67, same cause as the tag reads above).
   */
  async listSearches(opts: ReadOpts = {}): Promise<ListResult> {
    const lib = opts.library ?? this.defaultLibrary();
    if (await this.route(lib)) return this.local!.listSearches(lib);
    return this.web.listSearches(lib);
  }

  /**
   * Items exported in a bibliographic format, routed like every other read. Before this
   * existed, `zotero_format_bibliography item_keys` exported its CSL-JSON from
   * api.zotero.org unconditionally, and in key-free local mode that is users/0, which the
   * cloud rejects (#64).
   */
  async exportItems(
    params: ReadOpts & {
      format: string;
      itemKey?: string[];
      collectionKey?: string;
      q?: string;
      itemType?: string;
      limit?: number;
    },
  ): Promise<string> {
    const { library, backend, ...rest } = params;
    const lib = library ?? this.defaultLibrary();
    if (await this.route(lib, backend)) return this.local!.exportItems(rest, lib);
    return this.web.exportItems(lib, rest);
  }

  /**
   * A Zotero-rendered bibliography (`format=bib`) for item keys, routed like every other
   * read: the desktop app renders it, honouring the same style, locale and linkwrap
   * parameters, for any library it serves (#64).
   */
  async getBibliography(
    itemKeys: string[],
    opts: ReadOpts & { style?: string; locale?: string; linkwrap?: boolean } = {},
  ): Promise<string> {
    const { library, backend, ...rest } = opts;
    const lib = library ?? this.defaultLibrary();
    if (await this.route(lib, backend)) return this.local!.getBibliography(itemKeys, rest, lib);
    return this.web.getBibliography(lib, itemKeys, rest);
  }
}
