import type { ToolDefinition } from '../registry/registry.js';
import { ok } from '../registry/registry.js';
import { ATTRIBUTION_LINE, CITEPROC_ATTRIBUTION } from '../lib/notices.js';
import { VERSION } from '../lib/version.js';

const whoami: ToolDefinition = {
  name: 'zotero_whoami',
  title: 'Zotero identity & access',
  description:
    'Resolve the current Zotero identity (userID, username, display name) and per-library access scopes from the configured API key, report the running Zoteus `version`, and report which library backends are available (cloud Web API and/or the desktop local API). Call this first to discover the userID — never ask the user to type a numeric ID. If no API key is configured, the server runs in local-only read mode against the desktop library (users/0).',
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
  handler: async (_args, ctx) => {
    // The diagnostic tool answers from a probe taken now, not from one cached behind a
    // TTL: this is the tool someone calls precisely because they have just started Zotero
    // and want to know whether the server can see it (#22).
    await ctx.localStatus?.ensure({ force: true });
    const cloud = ctx.router.whoami();
    const lib = ctx.router.defaultLibrary();
    const update = ctx.updates?.available ?? null;
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
      defaultLibrary: lib,
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
