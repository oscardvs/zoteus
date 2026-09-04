# Distribution & release runbook (maintainers)

How to ship Zoteus to the public. Two tracks that ship independently:

- **Package release (W1–W3)** — npm + MCP registry + Claude Desktop DXT. Needs only a solid
  package; no hosted instance required.
- **Directory listing (W4–W5)** — the claude.ai connector directory. Needs the M13 hosted
  instance live + CIMD enabled. Ships after the package track.

`v1.0.0` is the long-reserved first public release.

---

## 1. Preconditions (green gate)

```bash
npm run typecheck && npm run lint && npm run build && npm test
```

Confirm the version is in lockstep across **all five** locations (a drift here ships a
mismatched release):

```bash
node -e "console.log('pkg ', require('./package.json').version)"
grep -n "const VERSION" src/server.ts src/index.ts      # MCP serverInfo + /healthz version
node -e "const s=require('./server.json'); console.log('server.json', s.version, s.packages[0].version)"
node -e "console.log('mcpb', require('./mcpb/manifest.json').version)"
node -e "console.log('lock', require('./package-lock.json').version)"
```

Every line must print the same `X.Y.Z`. (`src/server.ts` feeds the MCP `serverInfo.version`;
`src/index.ts` feeds the `/healthz` liveness version — keep both in step.)

---

## 2. npm publish (`@oscardvs/zoteus`, scoped public)

**Inspect the tarball first** — the `files` allowlist must ship only `dist/`, `README.md`,
`LICENSE`, `package.json` (no `.env`, `src/`, `tests/`, `docs/`, `mcpb/`):

```bash
npm run build
npm pack --dry-run 2>&1 | tee /tmp/zoteus-pack.txt
grep -E '(^|/)(\.env|src/|tests/|docs/|mcpb/|\.git)' /tmp/zoteus-pack.txt && echo "LEAK" || echo "clean"
```

**Manual publish** (`publishConfig.access=public` means no `--access` flag needed):

```bash
npm publish              # or: npm publish --dry-run  to rehearse
```

**CI publish (preferred)** — push a `vX.Y.Z` tag; `.github/workflows/deploy.yml`'s
`npm-publish` job runs `npm publish --provenance` (npm provenance via GitHub OIDC) behind the
green `test` gate. Requires a repo Actions secret **`NPM_TOKEN`** — an *automation* token from
npmjs.com with publish rights on `@oscardvs/zoteus`. Never commit the token.

> Prefer **one** path per release — CI **or** manual, not both. The CI `npm-publish` step is
> idempotent (it checks `npm view` and skips if the version already exists), so a prior manual
> publish or a re-pushed tag won't fail the pipeline or block the `.mcpb` release asset.

---

## 3. Post-publish verification (the broken-install path)

From a **clean** dir or container (no repo checkout):

```bash
# stdio: initialize must return serverInfo.version = X.Y.Z
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  | ZOTERO_API_KEY=dummy npx -y @oscardvs/zoteus | head -c 400; echo

# http: binds loopback and serves /mcp
npx -y @oscardvs/zoteus --http --port 3939 &
sleep 2 && curl -fsS http://127.0.0.1:3939/healthz && kill %1
```

---

## 4. MCP registry (`io.github.oscardvs/zoteus`)

`server.json` advertises the npm **package** only. It carries no `remotes` block: that was
removed in `2a6b616` when the paid hosted tier was extracted to the private operator repo, so
the registry entry describes the open-source package and nothing else.

That means `https://mcp.zoteus.com/mcp` is **not** discoverable through the registry. Leaving it
that way is a defensible open-core choice, but it is a choice, so make it on purpose rather than
by accident. To list the hosted remote, add a `remotes` block pointing at
`https://mcp.zoteus.com/mcp` and republish. Never publish `zoteus.duckdns.org`: it is a stale
legacy record that still resolves to the box but has no certificate.

```bash
mcp-publisher login github
mcp-publisher publish            # validates server.json against the registry schema
```

Verify the listing resolves under `io.github.oscardvs/zoteus`.

---

## 5. Claude Desktop extension (self-contained `.mcpb`)

> **Important:** the manifest lives in `mcpb/` but the runtime entry is `dist/index.js` with
> bare imports (tsc output, not bundled). Packing `mcpb/` **alone produces a broken bundle**
> (no `dist/`, no `node_modules`). You must stage a complete tree first.

```bash
npm run build
rm -rf /tmp/mcpb-build && mkdir -p /tmp/mcpb-build
cp mcpb/manifest.json mcpb/icon.png /tmp/mcpb-build/
cp -r dist /tmp/mcpb-build/dist
cp package.json package-lock.json /tmp/mcpb-build/
( cd /tmp/mcpb-build && npm ci --omit=dev --ignore-scripts --no-audit --no-fund )  # bundles prod deps incl. optional pdfjs-dist
npx --yes @anthropic-ai/mcpb validate /tmp/mcpb-build/manifest.json
npx --yes @anthropic-ai/mcpb pack /tmp/mcpb-build zoteus.mcpb
# verify it carries the entry point + bundled deps:
unzip -l zoteus.mcpb | grep -E ' dist/index.js$| icon.png$| manifest.json$'
unzip -l zoteus.mcpb | grep -q 'node_modules/@modelcontextprotocol/sdk/' && echo "deps bundled"
```

The result is a ~35 MB self-contained `.mcpb` (full feature parity, incl. PDF passage
extraction). Install it in Claude Desktop, confirm the tools load, and attach it to the
GitHub Release for the tag (the `release` job in `deploy.yml` does this automatically).

> **Uploading it by hand: checksum what actually landed.** Only needed when CI cannot do it
> (an Actions outage, say). `gh release create` uploads the asset by creating the release as
> a **draft** first, so a slow or interrupted upload leaves a draft release carrying a
> **truncated** asset — and the API still reports it at the full size with
> `state=uploaded`, so nothing about the release page looks wrong. Verify the bytes you can
> actually download, never the size the API claims:
>
> ```bash
> gh release upload vX.Y.Z zoteus.mcpb   # re-run with --clobber, or delete-asset first
> gh release edit vX.Y.Z --draft=false
> curl -sL --retry 3 -o /tmp/check.mcpb \
>   "https://github.com/oscardvs/zoteus/releases/download/vX.Y.Z/zoteus.mcpb"
> sha256sum /tmp/check.mcpb zoteus.mcpb   # the two lines must match
> ```
>
> If they differ, `gh release delete-asset vX.Y.Z zoteus.mcpb --yes` and upload again. A
> short download is not automatically the server's fault — pull a known-good asset from a
> previous release as a control before concluding the new one is bad. This bit v1.7.1: the
> first upload timed out at 30 MiB of 34 and published a bundle that could not be installed.

> **Toolchain note:** we migrated from the deprecated `@anthropic-ai/dxt` (`.dxt`,
> `dxt_version` 0.1 manifests) to `@anthropic-ai/mcpb` (`.mcpb`, `manifest_version` 0.3)
> in 1.4.1. MCPB is required for official directory submission, and its 0.2+ manifest
> carries the mandatory `privacy_policies` field (see `PRIVACY.md`). Releases up to
> v1.4.0 attach `zoteus.dxt`; later releases attach `zoteus.mcpb`.

> **Updates (#6):** Claude only auto-updates extensions installed from the official
> directory; a manually installed bundle stays on its version forever. Zoteus therefore
> ships an in-server update check (`ZOTEUS_UPDATE_CHECK`, opt-in since 1.14.0): a daily cached
> GET of the latest GitHub release, surfaced through `zotero_whoami` with a
> download-and-reinstall hint when the manifest marks the install as `ZOTEUS_DIST=mcpb`
> (or the legacy `dxt`).
> True auto-update would require acceptance into the official extension directory, which
> is a separate Anthropic review/submission process.

---

## 6. Git tag (triggers the release pipeline)

```bash
git tag v1.0.0
git push origin v1.0.0
```

`deploy.yml` (on `v*`) runs: `test` → `image` (multi-arch GHCR push) + `npm-publish`
(provenance) + `release` (self-contained `.mcpb` attached, auto release notes).

---

## 7. CIMD (Client ID Metadata Document)

CIMD lets a directory-scale connector use **one shared client app** instead of per-connection
Dynamic Client Registration: the provider resolves a **URL `client_id`** by fetching +
validating its metadata document.

- **Enable:** `ZOTEUS_CIMD_ENABLED=true` (off by default — OSS self-host is unaffected).
- **Validation:** https-only URL, byte cap (`ZOTEUS_CIMD_MAX_BYTES`, default 16 KB),
  `client_id` must equal the document URL, redirect_uri schemes limited to
  `ZOTEUS_CIMD_ALLOWED_REDIRECT_SCHEMES` (default `https`), TTL cache
  (`ZOTEUS_CIMD_CACHE_TTL_SEC`, default 1 h). Invalid/unreachable docs → treated as an unknown
  client (no error leak). `redirect: 'error'` blocks redirect-based fetch tricks.
- **Advertised** as `client_id_metadata_document_supported: true` on
  `/.well-known/oauth-authorization-server` (only when enabled). **DCR keeps working** in
  parallel for custom (non-directory) connectors.
- **Composes with M11 multi-tenant:** CIMD identifies the *client app* (Claude); per-user
  Zotero login (`ZOTEUS_OAUTH_MODE=zotero`) identifies the *user*. They are orthogonal.

---

## 8. claude.ai connector directory submission (async, external)

Depends on the M13 hosted instance being live. Prepare:

1. **Hosted instance** at a stable HTTPS domain (`docs/deployment.md` — free-tier VM + Caddy +
   DuckDNS). Set `ZOTEUS_CIMD_ENABLED=true`. Either serve a CIMD document for Claude's client
   app, or request **Anthropic-held credentials** by emailing `mcp-review@anthropic.com`.
2. **Production posture (M13):** health/readiness probes, structured **secret-redacted**
   logging (no token/key/passcode ever logged), `/metrics`, graceful shutdown, backups.
3. **Privacy/security statement:** single operator key (passcode mode) vs per-user Zotero
   login (zotero mode); per-user keys encrypted at rest (`ZOTEUS_OAUTH_STORE=file` +
   `ZOTEUS_OAUTH_TOKEN_SECRET`); GDPR data-processor posture for stored Zotero keys.

Submit per Anthropic's directory process (or email `mcp-review@anthropic.com`). Track as an
external, async review — not gated on code.

---

## 9. Rollback

- Bad version published: `npm deprecate @oscardvs/zoteus@X.Y.Z "reason"` and ship a patch.
- **Do not `npm unpublish`** after 72 h (and avoid it generally — it breaks installs).
- Re-tag a corrected `vX.Y.(Z+1)`; the registry/DXT/image follow from the new tag.
