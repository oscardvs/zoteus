# Zoteus Privacy Policy

_Last updated: 2026-09-04_

Zoteus is an open-source MCP server (MIT license) that runs **locally on your machine**, whether installed as a Claude desktop extension, via `npx`, or as a self-hosted service. This policy describes what data **the software** handles and where it goes. It does not cover the optional paid hosted connector at `mcp.zoteus.com`, which the project operates as a service and which has its own policy at [zoteus.com/privacy](https://zoteus.com/privacy).

## What Zoteus collects

**Nothing.** Zoteus has no telemetry, no analytics and no accounts, and the software you install never sends anything to a server operated by the project. The developers of Zoteus never receive your data. All processing happens on your device, except for the network requests listed below, which go directly from your machine to the named service.

## Network requests Zoteus makes

Zoteus only contacts external services as needed to do what you ask of it:

- **Zotero (`api.zotero.org`, zotero.org)**: your library data (items, collections, tags, attachments, full text) is read and written using the Zotero API key you configure. Requests go directly to Zotero and are governed by the [Zotero privacy policy](https://www.zotero.org/support/privacy).
- **Zotero desktop app (`127.0.0.1`)**: when the Zotero app is running, reads and writes can go to it over the local loopback interface. This traffic never leaves your machine.
- **Scholarly-graph providers** (only when you use the `zotero_scholar` tool): search terms, DOIs, and similar identifiers are sent to the configured providers (OpenAlex by default; optionally Crossref or Semantic Scholar). If you set `ZOTEUS_CONTACT_EMAIL`, it is included in those requests as the standard "polite pool" contact.
- **Embedding providers** (only if you explicitly select them): semantic search uses an **on-device model by default**, so no library text leaves your machine. If you set the embeddings option to `openai` or `gemini`, the text being indexed or searched (item titles, abstracts, notes, and full-text excerpts) is sent to that provider using your own API key, under that provider's privacy policy. Set embeddings to `local` or `off` to avoid this entirely.
- **Import resolvers** (only when you import by identifier or URL): the identifier or URL you provide is sent to the relevant public resolver (for example doi.org or arXiv), or to a translation server you host yourself.
- **Update check (`api.github.com`), off unless you turn it on**: setting `ZOTEUS_UPDATE_CHECK=true` makes Zoteus fetch the latest release tag from GitHub, at most once per day, to tell you when a newer version exists. The request is unauthenticated and contains no personal data or library content, only the standard HTTP metadata any web request carries. It is off by default so that a default install makes no network request you did not ask for.

## Storage

- **Zotero API key**: stored by your MCP client (for example Claude Desktop stores extension settings as sensitive configuration). Zoteus itself never writes your cloud API key to disk and never logs it.
- **Local data directory**: Zoteus keeps a semantic-search index (which contains text and embeddings derived from your library), a locally granted Zotero desktop-API key, caches, and the update-check timestamp in its data directory on your machine.
- **Usage log (off unless you turn it on)**: setting `ZOTEUS_USAGE_LOG=true` makes Zoteus keep a local record of which tools were called, when, whether they succeeded, how long they took, and (on a multi-user server) which Zotero user made the call. It records no argument values, no search strings and no library content, it is never sent anywhere, and it does not exist unless you enable it. It is there for operators running a shared instance who need to see how their own server is used.

## Third-party sharing

Zoteus does not share, sell, or transmit your data to anyone. The only parties that see any data are the services listed above, contacted directly from your machine at your instruction.

## Data retention

All stored data lives on your device and persists until you delete it. Removing the data directory removes the search index, caches, and the granted local key. Your Zotero API key can be revoked at any time at [zotero.org/settings/keys](https://www.zotero.org/settings/keys).

## Self-hosted remote mode

If you (or your organization) run Zoteus as a hosted server with OAuth enabled, the operator of that instance controls its data handling: per-user Zotero keys can be held in memory or encrypted at rest, and requests are logged with secrets redacted. The Zoteus project operates one such instance itself, the optional paid hosted connector at `mcp.zoteus.com`. This policy does not govern it, because this policy is about the software you run; the controlling policy for the hosted service is at [zoteus.com/privacy](https://zoteus.com/privacy), which names the data controller, what is stored, and where it is stored.

## Contact

Privacy and data-protection questions: <privacy@zoteus.com>. Anything else, including support for
the hosted connector: <support@zoteus.com>. Bugs and feature requests are best filed as an issue at
[github.com/oscardvs/zoteus/issues](https://github.com/oscardvs/zoteus/issues).
