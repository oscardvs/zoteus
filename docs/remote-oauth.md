# Remote OAuth: using Zoteus as a claude.ai or ChatGPT custom connector

claude.ai and ChatGPT connect to remote MCP servers **from the cloud**, so a connector must be reachable at a **public HTTPS URL** and protected by **OAuth 2.1 + PKCE** (claude.ai's connector UI has no field for a static API key or `Authorization` header). ChatGPT has no local option at all: it only connects to remote servers, so this is the one way it reaches Zoteus. Since **v0.9.0**, Zoteus can be that connector: it runs its own OAuth 2.1 authorization server in front of the Streamable HTTP `/mcp` endpoint.

## How it works (single-tenant gating)

Zotero's own API uses OAuth 1.0a, which can't be proxied to satisfy the OAuth 2.1 that claude.ai and ChatGPT expect. So Zoteus acts as **its own OAuth 2.1 authorization server** and gates *who may connect*: it does not federate Zotero accounts.

- The deployed instance holds **one** operator `ZOTERO_API_KEY` (single tenant).
- The client (claude.ai or ChatGPT) self-registers via **Dynamic Client Registration** (RFC 7591), runs the **authorization-code + PKCE (S256)** flow, and exchanges the code for a short-lived **opaque bearer token**.
- Issuance is gated by a single **operator passcode** (`ZOTEUS_OAUTH_PASSCODE`): during consent the browser shows a one-field passcode page; only a correct passcode mints an authorization code.
- `/mcp` then requires a valid bearer token (`requireBearerAuth`).

Standards served automatically by the MCP SDK auth helpers:

| Endpoint | Spec |
|---|---|
| `/.well-known/oauth-authorization-server` | RFC 8414 (AS metadata) |
| `/.well-known/oauth-protected-resource/mcp` | RFC 9728 (protected-resource metadata) |
| `/register` | RFC 7591 (Dynamic Client Registration) |
| `/authorize` → consent → `/token` | OAuth 2.1 auth-code + PKCE S256 |
| `/revoke` | RFC 7009 |

Discovery is driven by the `WWW-Authenticate: Bearer ..., resource_metadata="…"` header returned from an unauthenticated `/mcp` request, so neither claude.ai nor ChatGPT has to guess paths.

## Configuration

| Variable | Required | Purpose |
|---|---|---|
| `ZOTERO_API_KEY` | yes | The operator's Zotero key (the library every connected client uses). |
| `ZOTEUS_OAUTH_ENABLED` | yes | Set `true` to turn on the OAuth-protected remote. |
| `ZOTEUS_PUBLIC_URL` | yes | Public HTTPS origin claude.ai or ChatGPT reaches, e.g. `https://zoteus.example.com` (no trailing slash). Becomes the OAuth issuer; **must be HTTPS** in production. |
| `ZOTEUS_OAUTH_PASSCODE` | yes | Consent passcode, **≥ 12 chars**. Generate with `openssl rand -base64 24`. |
| `ZOTEUS_READ_ONLY` | recommended | `true` exposes only non-mutating tools — strongly recommended for a public connector. |
| `ZOTEUS_OAUTH_ACCESS_TTL` | no | Access-token lifetime in seconds (default `3600`). |
| `ZOTEUS_OAUTH_REFRESH_TTL` | no | Refresh-token lifetime in seconds (default `2592000`, 30 days). |
| `ZOTEUS_ALLOWED_HOSTS` | no | Comma-separated extra `Host` values accepted by DNS-rebinding protection, merged with the `ZOTEUS_PUBLIC_URL` host. Use only if your proxy rewrites `Host` (see below). |

When OAuth is enabled, `zoteus --http` binds `0.0.0.0` (so a reverse proxy/tunnel can reach it) and enables DNS-rebinding protection with `allowedHosts = [<public host>, …ZOTEUS_ALLOWED_HOSTS]`.

> **Safety guard:** without OAuth, Zoteus refuses to bind a non-loopback host (it would be an open, unauthenticated relay to your library). Override only for a deliberate trusted-network setup with `ZOTEUS_ALLOW_INSECURE_HTTP=true`.

## Run it

```bash
ZOTERO_API_KEY=zzz \
ZOTEUS_OAUTH_ENABLED=true \
ZOTEUS_PUBLIC_URL=https://zoteus.example.com \
ZOTEUS_OAUTH_PASSCODE="$(openssl rand -base64 24)" \
ZOTEUS_READ_ONLY=true \
node dist/index.js --http --port 3939 --host 0.0.0.0
```

Or with Docker (see [`Dockerfile`](../Dockerfile)):

```bash
docker build -t zoteus:0.9.0 .
docker run -p 3939:3939 \
  -e ZOTERO_API_KEY=zzz \
  -e ZOTEUS_OAUTH_ENABLED=true \
  -e ZOTEUS_PUBLIC_URL=https://zoteus.example.com \
  -e ZOTEUS_OAUTH_PASSCODE="$(openssl rand -base64 24)" \
  -e ZOTEUS_READ_ONLY=true \
  zoteus:0.9.0
```

## Put it behind HTTPS

TLS is required. Any of these works; the key requirement is **the proxy must forward the public `Host` header verbatim** (DNS-rebinding protection does an exact `Host` match, including port):

- **VPS + Caddy** — `zoteus.example.com { reverse_proxy 127.0.0.1:3939 }` (Caddy auto-provisions TLS and preserves `Host`).
- **Cloudflare named tunnel** — `cloudflared tunnel run` mapped to a stable hostname (`https://zoteus.example.com`). Use a *named* tunnel so the hostname is stable; a quick tunnel's random hostname changes each run and won't match `ZOTEUS_PUBLIC_URL`.
- **Fly.io / Render / Railway** — deploy the Docker image; set the env vars above; set `ZOTEUS_PUBLIC_URL` to the platform-assigned HTTPS hostname. These terminate TLS and forward the public `Host`.

If your proxy rewrites `Host` to an internal value (causing every `/mcp` request to 403), add the forwarded value to `ZOTEUS_ALLOWED_HOSTS`.

## Connect from claude.ai

1. **Settings → Connectors → Add custom connector**.
2. URL: `https://<your-host>/mcp`. (No client id/secret needed — claude.ai self-registers via DCR.)
3. Click **Connect**. claude.ai opens the Zoteus consent page.
4. Enter your `ZOTEUS_OAUTH_PASSCODE` and authorize.
5. The tool list loads; try a read (e.g. `zotero_whoami` or `zotero_search_items`).

## Connect from ChatGPT

ChatGPT connects to remote MCP servers only, so a self-hosted Zoteus is the free way to reach it from ChatGPT (the other is the hosted connector at `https://mcp.zoteus.com/mcp`, see [zoteus.com/pricing](https://zoteus.com/pricing)). It needs ChatGPT's **Developer mode**, which OpenAI offers on the Plus, Pro, Business, Enterprise and Edu plans in the web app; on Business and Enterprise an admin may have to allow it first, and free accounts cannot add custom servers. The steps below were verified on 2026-09-12 against the hosted connector, which runs this same OAuth server.

1. **Settings → Security and login → Developer mode** (also linked from **Settings → Plugins**). ChatGPT labels it elevated risk.
2. **Plugins** (left sidebar, or `chatgpt.com/plugins`) → **Create app**.
3. In the **New Plugin** dialog: Name `Zoteus`, Connection **Server URL**, MCP Server URL `https://<your-host>/mcp`, Authentication **OAuth** (the default). Tick **I understand and want to continue** and click **Create**. Leave **Advanced OAuth settings** empty: ChatGPT reads the endpoints from the `WWW-Authenticate` discovery above and self-registers via DCR. It shows "CIMD unavailable" there, which is expected and harmless.
4. ChatGPT shows **Add Zoteus to ChatGPT**. Click **Sign in with Zoteus**: the popup opens the Zoteus consent page (the `ZOTEUS_OAUTH_PASSCODE` prompt in passcode mode; in `zotero` mode a redirect to zotero.org, where write access can be unticked for a read-only grant) and returns to ChatGPT. The plugin page then shows **Connected on <date>**.
5. If **Actions** says "No app actions available yet", click **Refresh** under **Information**. All 30 tools load, each labelled READ or PUBLIC WRITE, with "Destructive" where the tool annotations say so.
6. In a chat, click **+** in the composer ("Add files and more"), pick Zoteus, and try a read (e.g. `zotero_whoami`).

Notes:

- **Redirect URI.** ChatGPT registers a per-connector `https://chatgpt.com/connector/oauth/<id>`; there is no allowlist to maintain.
- **Confidential client.** claude.ai registers a public client; ChatGPT registers a confidential one and receives a client secret from DCR. The server needs no configuration for either.
- **Write confirmations are ChatGPT's.** Reads never prompt. For writes ChatGPT decides per action: in testing, adding a tag ran without a prompt, while removing one showed "Allow ChatGPT to use Zoteus?" (Always allow / Allow once / Allow Zoteus for this conversation / Deny). The plugin's **Permissions** control ("Choose when ChatGPT should ask for permission when using this plugin") has four settings: **Always ask** (asks before reading or making changes), **Allow read actions** (reads without asking, asks before making changes), **Allow low-risk actions** (the default: low-risk actions approved automatically, actions involving sensitive information denied or prompted) and **Allow all actions** (elevated risk: never asks). A user who wants a prompt before every write picks **Allow read actions**. `ZOTEUS_READ_ONLY=true` remains the guarantee that lives on the server.

## Connect from Claude Code (remote)

The same OAuth remote also works from the **Claude Code CLI** — useful for testing the connector or using a hosted instance from the terminal. Claude Code runs the OAuth flow itself (DCR + PKCE with an RFC 8252 loopback redirect):

```bash
claude mcp add --transport http zoteus https://<your-host>/mcp
```

Then, inside Claude Code:

1. Run `/mcp` → select **zoteus** → **Authenticate** (a browser opens).
2. Complete the Zoteus consent page (enter the `ZOTEUS_OAUTH_PASSCODE`) → it redirects to a `localhost` port Claude Code owns and `/mcp` flips to **connected**.
3. Use it, e.g. *"use zoteus — who am I signed in as?"*.

Notes:

- Names must be unique. If `zoteus` already exists (e.g. a leftover stdio entry), run `claude mcp remove zoteus` first. A stdio entry pointing at `npx -y @oscardvs/zoteus` will fail until the package is published — use this remote form, or a local build (`claude mcp add zoteus -e ZOTERO_API_KEY=… -- node /path/to/zoteus/dist/index.js`).
- Add `-s user` to make the server available in every project (default scope is the current directory).
- The callback is an ephemeral `http://localhost:<port>/callback` that Claude Code owns; Zoteus accepts loopback redirects port-agnostically, so no `--callback-port` is needed.
- Manage with `claude mcp list` / `claude mcp get zoteus` / `claude mcp remove zoteus`.

## Multi-tenant: per-user Zotero accounts

By default Zoteus runs **single-tenant** (`ZOTEUS_OAUTH_MODE=passcode`): every connected
client uses the one operator `ZOTERO_API_KEY`, gated by a shared passcode.

Set **`ZOTEUS_OAUTH_MODE=zotero`** to make Zoteus **multi-tenant** — each user who adds the
connector logs into **their own Zotero account**, and every call runs against that user's
library. Zoteus stays its own OAuth 2.1 server for claude.ai or ChatGPT; during consent it performs
Zotero's OAuth 1.0a on the user's behalf and binds the resulting per-user Zotero key to the
issued bearer token. No `ZOTERO_API_KEY` and no `ZOTEUS_OAUTH_PASSCODE` are needed in this mode.

### Setup

1. Register a Zotero app at https://www.zotero.org/oauth/apps. Set the callback to
   `https://<your-host>/oauth/zotero/callback`. Note the **Client Key** and **Client Secret**.
2. Configure:
   ```bash
   ZOTEUS_OAUTH_ENABLED=true
   ZOTEUS_OAUTH_MODE=zotero
   ZOTEUS_PUBLIC_URL=https://<your-host>
   ZOTERO_OAUTH_CLIENT_KEY=<client key>
   ZOTERO_OAUTH_CLIENT_SECRET=<client secret>
   ZOTEUS_OAUTH_STORE=file
   ZOTEUS_OAUTH_TOKEN_SECRET="$(openssl rand -base64 32)"
   ZOTEUS_READ_ONLY=true
   ZOTEUS_DATA_DIR=/data        # mount a volume so the store + per-user indexes persist
   ```
3. Deploy behind HTTPS (Fly/Render/Railway/VPS+Caddy/named cloudflared) exactly as for
   single-tenant, mounting a volume at `ZOTEUS_DATA_DIR`.

### Verifying two accounts (operator runbook)

1. In **Account A**'s claude.ai: Settings → Connectors → Add custom connector →
   `https://<your-host>/mcp` → Connect → you are redirected to **zotero.org**, sign in,
   approve → tools load. Run `zotero_whoami`; confirm it reports **Account A**'s userID.
2. Repeat in **Account B** (a second account / browser profile). `zotero_whoami` must report
   **Account B**'s userID — not A's, and not the operator's. Read a few items to confirm it's
   B's library.
3. Restart the server and reconnect from both — neither user is forced back through Zotero
   (the encrypted file store kept their keys).

### Notes

- **Encryption at rest:** stored Zotero keys are AES-256-GCM encrypted with
  `ZOTEUS_OAUTH_TOKEN_SECRET`. Losing or rotating the secret invalidates the store (users
  simply re-authorize). The store file lives under `ZOTEUS_DATA_DIR` (git-ignored).
- **Per-user index:** `zotero_index` builds a separate semantic index per user
  (`search-index-<userID>.sqlite`, or `.json` on the legacy backend); tenants never share
  an index.
- **Single instance:** the file store is local; run one instance (no shared-replica state).
- **Read-only recommended:** keep `ZOTEUS_READ_ONLY=true` so the connector requests
  read-only Zotero permissions (`library_access=1&write_access=0&all_groups=read`).

## Security notes & v1 limitations

- **The passcode is the trust boundary.** Use a high-entropy value and rotate it (restart with a new `ZOTEUS_OAUTH_PASSCODE`). `/consent` is rate-limited and locks a pending authorization after repeated wrong attempts.
- **Single tenant.** Every connected client acts as the one operator `ZOTERO_API_KEY`. For per-user Zotero accounts, switch to multi-tenant mode (`ZOTEUS_OAUTH_MODE=zotero`, see above).
- **State persistence.** By default (`ZOTEUS_OAUTH_STORE=memory`) registered clients and tokens live in memory only — they do not survive a restart. Set `ZOTEUS_OAUTH_STORE=file` (with `ZOTEUS_OAUTH_TOKEN_SECRET`) to persist clients, tokens, and per-user Zotero keys across restarts, encrypted at rest under the data dir. Either way, state is local to one instance (no shared-replica store). Short-lived pending consents and auth codes always stay in memory; a mid-flow restart just re-prompts.
- **Per-session transports.** Each MCP session gets its own Streamable HTTP transport (keyed by `Mcp-Session-Id`), sharing one Zotero context — so multiple/reconnecting claude.ai sessions are isolated and do not collide.
- **Dynamic Client Registration.** Claude registers a fresh public client per connection, and ChatGPT registers a confidential client and receives a client secret from DCR; Zoteus caps the in-memory client store (FIFO) and sweeps expired state. For very high-traffic use, a Client ID Metadata Document (CIMD) flow would avoid per-connection registrations (future enhancement).
- **Token lifetime.** Refresh tokens are rotated on each use (the old one is invalidated in the same response); access tokens remain valid until their TTL even after rotation. Shorten `ZOTEUS_OAUTH_ACCESS_TTL` for tighter revocation, or use `/revoke`.
- **Proxy must forward `Host`.** DNS-rebinding protection matches the `Host` header exactly; your TLS proxy/tunnel must forward the public host verbatim (add extras via `ZOTEUS_ALLOWED_HOSTS` if not).
- Prefer `ZOTEUS_READ_ONLY=true` and keep `ZOTEUS_ALLOW_DELETE=false` for public connectors.
