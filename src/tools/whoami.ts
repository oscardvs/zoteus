import { z } from 'zod';
import type { ToolContext, ToolDefinition } from '../registry/registry.js';
import { ok } from '../registry/registry.js';
import { canonicalLibraryToken, describeLibraryToken } from '../features/search/backend.js';
import { ATTRIBUTION_LINE, CITEPROC_ATTRIBUTION } from '../lib/notices.js';
import { VERSION } from '../lib/version.js';

/**
 * Where the default library came from, and what a caller can do about it.
 *
 * The three values mirror the three branches of `LibraryRouter.defaultLibrary()`. The
 * wording for "configured" is split on `remoteCaller` deliberately: ZOTERO_LIBRARY_ID is
 * process-wide, so on a shared deployment it pins every account that connects to the same
 * library, while on a single-user install it is simply the library its owner chose.
 */
function librarySourceDetail(source: 'configured' | 'key' | 'local', remoteCaller: boolean): string {
  if (source === 'configured') {
    return remoteCaller
      ? 'Whoever runs this server set ZOTERO_LIBRARY_ID. That setting is process-wide, so every account connecting to this server gets the same default library, whatever their own account holds. Name `library_id` and `library_type` on a call to work in another library.'
      : 'Set with ZOTERO_LIBRARY_ID in this server\'s own configuration. Name `library_id` and `library_type` on a call to work in another library.';
  }
  if (source === 'key') {
    return 'No ZOTERO_LIBRARY_ID is set, so the default is the personal library of the account this API key belongs to.';
  }
  return 'No cloud API key and no ZOTERO_LIBRARY_ID, so the default is the Zotero desktop app\'s own personal library, which is addressed as users/0.';
}

/**
 * This context's index status, or undefined when it cannot be read at all. An unreadable
 * index already reports itself through `buildStatus()` (state "error"), so a throw here is
 * not an expected path; it must still not take the diagnostic tool down with it.
 */
function indexStatus(ctx: ToolContext) {
  try {
    return ctx.search?.buildStatus?.();
  } catch {
    return undefined;
  }
}

const whoami: ToolDefinition = {
  name: 'zotero_whoami',
  title: 'Zotero identity & access',
  description:
    'Resolve the current Zotero identity (userID, username, display name) and per-library access scopes from the configured API key, report the running Zoteus `version`, and report which library backends are available (cloud Web API and/or the desktop local API). Call this first to discover the userID — never ask the user to type a numeric ID. It also reports which library every call defaults to and WHY (`defaultLibrary.source`: pinned by whoever runs the server, derived from the key, or the desktop app\'s own library), whether this caller has a context of their own or shares the one the server operator configured (`context`), and which single library this context\'s search index holds (`searchIndex`). For per-group write permission, call zotero_groups. If no API key is configured, the server runs in local-only read mode against the desktop library (users/0).',
  inputSchema: {},
  outputSchema: z
    .object({
      version: z.string().describe('The Zoteus release answering this call, e.g. "1.19.0".'),
      cloud: z.boolean().describe('Whether a cloud API key is configured and identified a Zotero user.'),
      userID: z.number().optional().describe('Zotero numeric user id that key belongs to.'),
      username: z.string().optional().describe('Zotero username on that account.'),
      displayName: z.string().optional().describe('Display name on that account, when it has one.'),
      access: z
        .record(z.unknown())
        .nullable()
        .optional()
        .describe('What the key may do, as Zotero reports it: { user: {...}, groups: {...} }. Null when no key is configured.'),
      localApi: z.boolean().describe('Whether the Zotero desktop local API answered the probe taken for this call.'),
      localApiChecked: z
        .string()
        .nullable()
        .optional()
        .describe('ISO timestamp of that probe, or null when this server does not watch for the desktop app.'),
      localApiWatched: z.boolean().optional().describe('Whether this server watches for the desktop app at all (false in hosted mode).'),
      localApiReason: z
        .string()
        .optional()
        .describe('Why the desktop local API is out of reach for this caller rather than merely down; present only when it is structurally unavailable.'),
      defaultLibrary: z
        .object({
          type: z.string().describe('"user" or "group".'),
          id: z.number().describe("Library id; 0 is the desktop app's own personal library."),
          source: z
            .string()
            .describe(
              'Where that choice came from: "configured" (ZOTERO_LIBRARY_ID, set by whoever runs this server), "key" (the personal library of the account the API key belongs to) or "local" (no key and no setting, so the desktop app\'s own library).',
            ),
          sourceDetail: z.string().describe('The same answer in words, including how to address a different library on a call.'),
        })
        .passthrough()
        .describe('The library every tool reads and writes when a call names none.'),
      context: z
        .object({
          perUser: z
            .boolean()
            .describe(
              'True when this call is answered by a context of its own: its own Zotero API key and its own search index, keyed by the Zotero account that authorised. False means it is answered by the context whoever runs this server configured, which every caller of that server shares.',
            ),
          confined: z
            .boolean()
            .describe(
              'True when the caller is someone other than the operator of this server (any HTTP/OAuth deployment). File paths a tool accepts are then confined to the server\'s data directory.',
            ),
          zoteroUserId: z
            .number()
            .optional()
            .describe('The Zotero user id this context and its search index are keyed by; absent on a single-user install, where there is only one context.'),
        })
        .passthrough()
        .describe('Whether this caller has a context of their own or shares the operator\'s. Says nothing about any subscription: Zoteus stores no account of its own.'),
      searchIndex: z
        .object({
          library: z
            .string()
            .optional()
            .describe('Canonical id of the library whose rows this context\'s search index holds: "user" for the personal library, "group:<id>" for a group. Absent when nothing has been indexed yet, or when the index predates that stamp.'),
          libraryLabel: z.string().optional().describe('The same thing in words, e.g. "the personal library" or "group 4523".'),
          holdsDefaultLibrary: z
            .boolean()
            .optional()
            .describe('Whether that is the library named in `defaultLibrary`. Present only when the index says which library it holds.'),
          items: z.number().optional().describe('Library items the index represents.'),
          state: z.string().optional().describe('Lifecycle of the background index job: "idle", "building", "done" or "error".'),
        })
        .passthrough()
        .optional()
        .describe('Which single library this context\'s search index holds. One index file holds one library, so a second library is searchable by meaning only after its own index exists; zotero_groups reports the same fact per group.'),
      embeddings: z
        .object({
          configured: z.string().optional().describe('The requested ZOTEUS_EMBEDDINGS value, whether or not it works.'),
          active: z.boolean().optional().describe('True only while that provider is genuinely producing vectors.'),
          effective: z.string().optional().describe('The embedder actually in use, or "none (...)" with the reason.'),
          reason: z.string().optional().describe('Why the configured provider is not active.'),
        })
        .passthrough()
        .describe('Semantic-search health, so a keyword-only fallback is visible here and not only in zotero_index.'),
      update: z
        .object({
          current: z.string().describe('Version running now.'),
          latest: z.string().describe('Newer published version.'),
          url: z.string().describe('Where to get it.'),
        })
        .passthrough()
        .nullable()
        .describe('A newer Zoteus release, or null when this is the latest (or the check is off).'),
      attribution: z
        .record(z.unknown())
        .describe('citeproc-js attribution (CPAL Exhibit B): phrase, copyright, licence and URL.'),
    })
    .passthrough(),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  handler: async (_args, ctx) => {
    // The diagnostic tool answers from a probe taken now, not from one cached behind a
    // TTL: this is the tool someone calls precisely because they have just started Zotero
    // and want to know whether the server can see it (#22).
    await ctx.localStatus?.ensure({ force: true });
    const cloud = ctx.router.whoami();
    const lib = ctx.router.defaultLibrary();
    const update = ctx.updates?.available ?? null;
    // Which context answered. On a shared deployment this is the difference between "my
    // own Zotero key and my own index" and "the one the operator configured", and it was
    // invisible to the caller until now.
    const perUser = ctx.zoteroUserId !== undefined;
    const remoteCaller = Boolean(ctx.remoteCaller);
    // The three branches of LibraryRouter.defaultLibrary(), reported rather than re-derived.
    const librarySource: 'configured' | 'key' | 'local' = ctx.config?.libraryId ? 'configured' : cloud ? 'key' : 'local';
    // One index file holds one library (see assertLibrary). Read only through the public
    // status, so this stays correct whatever the store underneath is doing, and never at
    // the cost of the answer: this is the tool someone calls to find out what is wrong, so
    // an index that cannot even report itself costs this one field and nothing else.
    const index = indexStatus(ctx);
    const indexLibrary = index?.library;
    const searchIndex = index
      ? {
          ...(indexLibrary ? { library: indexLibrary, libraryLabel: describeLibraryToken(indexLibrary) } : {}),
          ...(indexLibrary ? { holdsDefaultLibrary: indexLibrary === canonicalLibraryToken(lib) } : {}),
          ...(typeof index.items === 'number' ? { items: index.items } : {}),
          ...(index.state ? { state: index.state } : {}),
        }
      : undefined;
    const structured = {
      // What is actually running. Both of this machine's clients were found several
      // releases behind with nothing to say so, because the update notice below only
      // appears when a newer release exists.
      version: VERSION,
      cloud: Boolean(cloud),
      userID: cloud?.userID,
      username: cloud?.username,
      displayName: cloud?.displayName,
      access: cloud?.access ?? null,
      localApi: ctx.capabilities.localApi,
      // So a `false` is visibly a live answer rather than possibly a stale one. Whether
      // this server watches for the desktop app at all is part of the answer: in hosted
      // mode it never does, and there `localApi: false` is a setting, not a diagnosis.
      localApiChecked: ctx.localStatus?.enabled ? new Date(ctx.localStatus.lastCheckedAt()).toISOString() : null,
      localApiWatched: ctx.localStatus?.enabled ?? (ctx.config?.local !== 'off' && Boolean(ctx.local)),
      // A per-user context is built without any desktop client at all, so its `false` can
      // never become true however the Zotero on the caller's own machine is configured.
      ...(perUser
        ? {
            localApiReason:
              'This call is answered by a server that is not on your machine, so it never reaches a Zotero desktop app: the local API is available only to whoever runs the server. Reads and writes here go to the Zotero Web API with your own key.',
          }
        : {}),
      defaultLibrary: { ...lib, source: librarySource, sourceDetail: librarySourceDetail(librarySource, remoteCaller) },
      context: {
        perUser,
        confined: remoteCaller,
        ...(ctx.zoteroUserId !== undefined ? { zoteroUserId: ctx.zoteroUserId } : {}),
      },
      ...(searchIndex ? { searchIndex } : {}),
      // Search health belongs in the "call this first" tool: a semantic embedder that was
      // configured but never ran is invisible everywhere else a user would think to look.
      embeddings: {
        configured: ctx.search.embedderConfigured,
        active: ctx.search.embedderActive,
        effective: ctx.search.embedderName,
        ...(ctx.search.embedderReason ? { reason: ctx.search.embedderReason } : {}),
      },
      update,
      // The bibliography formatter is citeproc-js, redistributed under the CPAL, whose
      // Exhibit B asks for its attribution where a session begins (#70). This is the tool
      // the server's instructions tell every client to call first, so it is the one place
      // in the protocol that reliably reaches a person once per session; the startup log
      // line in src/index.ts is per process, which is not the same thing over HTTP.
      // THIRD_PARTY_NOTICES.md carries the full text.
      attribution: CITEPROC_ATTRIBUTION,
    };
    // Naming the remedy beside the symptom: an unavailable local API is nearly always the
    // one Zotero setting, and the answer is re-checked on every call now, so there is no
    // longer any reason to tell someone to restart their MCP host.
    const localHint =
      ctx.localStatus?.enabled && !ctx.capabilities.localApi
        ? ` Zotero's local API is not answering on port ${ctx.config?.localPort ?? 23119} — start Zotero and enable Settings → Advanced → "Allow other applications on this computer to communicate with Zotero". The server re-checks by itself; no restart is needed.`
        : '';
    let summary = cloud
      ? `Signed in as ${cloud.username} (userID ${cloud.userID}). Local API: ${ctx.capabilities.localApi ? 'available' : 'unavailable'}.${localHint}`
      : `No cloud API key configured — running in local-only read mode (local API ${ctx.capabilities.localApi ? 'available' : 'unavailable'}).${localHint}`;
    // Which library a call with no library argument lands in, and who decided that. On a
    // shared server the answer is the operator's setting, not the caller's account, and a
    // lab that reads or writes the wrong library otherwise finds out from the contents.
    const sourcePhrase = {
      configured: 'pinned for this server with ZOTERO_LIBRARY_ID',
      key: "the personal library of the account this API key belongs to",
      local: "the Zotero desktop app's own library, since no key and no ZOTERO_LIBRARY_ID are set",
    }[librarySource];
    summary += ` Default library: ${lib.type}s/${lib.id} (${sourcePhrase}).`;
    if (searchIndex) {
      if (indexLibrary === undefined) {
        summary +=
          index && index.items > 0
            ? ` Search index: ${index.items} items, from a build that did not record which library they came from.`
            : ' Search index: nothing indexed here yet. Run zotero_index action:"build" to make this library searchable by meaning.';
      } else if (searchIndex.holdsDefaultLibrary) {
        summary += ` Search index holds ${describeLibraryToken(indexLibrary)} (${index?.items ?? 0} items), which is the default library.`;
      } else {
        // The path is worth naming, because the remedy is a file on disk. A hand-built
        // context need not carry one, and "at undefined" would be worse than saying nothing.
        const where = ctx.searchIndexPath ? ` at ${ctx.searchIndexPath}` : '';
        summary += ` Search index${where} holds ${describeLibraryToken(indexLibrary)}, which is NOT this server's default library: a call that names no library is answered from the default library's own index file once that exists, and from this one until it does. zotero_index action:"libraries" lists every library that has an index here.`;
      }
    }
    if (!ctx.search.embedderActive && ctx.search.embedderConfigured !== 'off') {
      summary += ` Semantic search is degraded to keyword-only (embeddings=${ctx.search.embedderConfigured} requested but not active): ${ctx.search.embedderReason}`;
    }
    if (update) {
      const dist = ctx.config?.dist;
      const bundleHint =
        dist === 'dxt' || dist === 'mcpb'
          ? ' Manually installed desktop extensions do not auto-update: tell the user to download the new bundle for their operating system (zoteus-macos.mcpb, zoteus-windows.mcpb or zoteus-linux.mcpb) from that page and reinstall it in Claude to upgrade.'
          : '';
      summary += ` Zoteus ${update.latest} is available (installed: ${update.current}): ${update.url}.${bundleHint}`;
    }
    // Last, so it never displaces the answer the caller asked for, and unconditional, so it
    // is displayed whatever the identity turns out to be.
    summary += ` ${ATTRIBUTION_LINE}`;
    return ok(structured, summary);
  },
};

export default whoami;
