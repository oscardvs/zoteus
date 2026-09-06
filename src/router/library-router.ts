import type { ZoteusConfig } from '../config.js';
import type { Capabilities } from './capabilities.js';
import type {
  WebApiClient,
  LibraryRef,
  ItemQuery,
  ListResult,
  KeyInfo,
  VersionsResult,
} from '../api/web-client.js';
import type { LocalApiClient } from '../api/local-client.js';
import type { VersionBackend } from '../features/search/backend.js';

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
   */
  servesLocally(library?: LibraryRef): boolean {
    return this.useLocal(library ?? this.defaultLibrary());
  }

  /** Item keys and versions (`?format=versions`), routed like every other read. */
  async itemVersions(
    opts: ReadOpts & { since?: number; top?: boolean; limit?: number; start?: number; itemType?: string } = {},
  ): Promise<VersionsResult> {
    const { library, backend, ...rest } = opts;
    const lib = library ?? this.defaultLibrary();
    if (this.useLocal(lib, backend)) return this.local!.itemVersions(rest, lib);
    return this.web.itemVersions(lib, rest);
  }

  async searchItems(query: ItemQuery & ReadOpts = {}): Promise<ListResult> {
    const { library, backend, ...q } = query;
    const lib = library ?? this.defaultLibrary();
    if (this.useLocal(lib, backend)) return this.local!.listItems(q, lib);
    return this.web.listItems(lib, q);
  }

  async getItem(
    key: string,
    opts: ReadOpts & { include?: string; format?: string; style?: string; locale?: string } = {},
  ): Promise<any> {
    const { library, ...rest } = opts;
    const lib = library ?? this.defaultLibrary();
    if (this.useLocal(lib)) return this.local!.getItem(key, rest, lib);
    return this.web.getItem(lib, key, rest);
  }

  async getItemChildren(key: string, opts: ReadOpts & ItemQuery = {}): Promise<ListResult> {
    const { library, ...rest } = opts;
    const lib = library ?? this.defaultLibrary();
    // Prefer the desktop app for the personal library (local-only mode has no cloud
    // fallback — hitting api.zotero.org with user id 0 yields "Invalid user ID").
    if (this.useLocal(lib)) return this.local!.getItemChildren(key, rest, lib);
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
    if (this.useLocal(lib, opts.backend)) return this.local!.getFullText(key, lib);
    return this.web.getFullText(lib, key);
  }

  /** Attachment keys whose full text changed after `version`, mapped to that version. */
  async fullTextSince(version: number, opts: ReadOpts = {}): Promise<Record<string, number>> {
    const lib = opts.library ?? this.defaultLibrary();
    if (this.useLocal(lib, opts.backend)) return this.local!.fullTextSince(version, lib);
    return this.web.fullTextSince(lib, version);
  }

  async listCollections(
    opts: ReadOpts & { top?: boolean; limit?: number; start?: number } = {},
  ): Promise<ListResult> {
    const { library, ...rest } = opts;
    const lib = library ?? this.defaultLibrary();
    if (this.useLocal(lib)) return this.local!.listCollections(rest, lib);
    return this.web.listCollections(lib, rest);
  }
}
