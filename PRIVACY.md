# Zoteus Privacy Policy

_Last updated: 2026-09-14_

Zoteus is an open-source MCP server (MIT license) that runs **locally on your machine**, whether installed as a Claude desktop extension, via `npx`, or as a self-hosted service. This policy describes what data **the software** handles and where it goes. It does not cover the optional paid hosted connector at `mcp.zoteus.com`, which the project operates as a service and which has its own policy at [zoteus.com/privacy](https://zoteus.com/privacy).

## What Zoteus collects

The default installation does not send usage analytics to the project. Optional operator-controlled usage logging is described below. The connector processes data on the machine or server where it runs, and returns tool results to your chosen AI client. Retrieved passages, notes and metadata may therefore be sent to that client's cloud AI service under its own terms. Local embedding computation does not make a cloud AI conversation local.

## Network requests Zoteus makes

Zoteus only contacts external services as needed to do what you ask of it:

- **Zotero (`api.zotero.org`, zotero.org)**: your library data (items, collections, tags, attachments, full text) is read and written using the Zotero API key you configure. Requests go directly to Zotero and are governed by the [Zotero privacy policy](https://www.zotero.org/support/privacy).
- **Zotero desktop app (`127.0.0.1`)**: when the Zotero app is running, reads and writes can go to it over the local loopback interface. This traffic never leaves your machine.
- **Scholarly-graph providers** (when you use scholarly lookup, notice checks, or open-access discovery): search terms, DOIs, and similar identifiers are sent to the configured providers (OpenAlex by default; optionally Crossref or Semantic Scholar). If you set `ZOTEUS_CONTACT_EMAIL`, it is included in those requests as a contact address (Crossref's `mailto=` polite-pool parameter, and the User-Agent header on OpenAlex requests). If you set `ZOTEUS_OPENALEX_API_KEY`, it is sent to OpenAlex as an Authorization header on those requests and nowhere else.
- **Embedding providers** (only if you explicitly select them): the default setting is `local`, which requires installing the optional embedding dependency. When active, embedding computation runs on the connector host; this is separate from sending retrieved results to your AI client. If you set the embeddings option to `openai` or `gemini`, the text being indexed or searched (item titles, abstracts, notes, and full-text excerpts) is sent to that provider using your own API key, under that provider's privacy policy. With `ollama`, the same text goes to `ZOTEUS_OLLAMA_URL`, which defaults to a loopback address on the connector host. A remote Ollama URL sends text to that remote server. Use `local`, `off`, or a loopback Ollama service to keep embedding text off external services.
- **Import resolvers** (only when you import by identifier or URL): the identifier or URL you provide is sent to the relevant public resolver (for example doi.org or arXiv), or to a translation server you host yourself.
- **Open-access PDF hosts**: requesting PDF attachment downloads contacts the repository or publisher URL returned by discovery. The host receives normal HTTP request metadata, without your Zotero API key.
- **OCR language data**: optional OCR downloads Tesseract language data on first use and caches it on the connector host. Recognition runs on that host; OCR text is returned to your AI client and is not persisted in the search index.
- **Update check (`api.github.com`), off unless you turn it on**: setting `ZOTEUS_UPDATE_CHECK=true` makes Zoteus fetch the latest release tag from GitHub, at most once per day, to tell you when a newer version exists. The request is unauthenticated and contains no personal data or library content, only the standard HTTP metadata any web request carries. It is off by default so that a default install makes no network request you did not ask for.

## Storage

- **Zotero API key**: stored by your MCP client (for example Claude Desktop stores extension settings as sensitive configuration). Zoteus itself never writes your cloud API key to disk and never logs it.
- **Local data directory**: Zoteus keeps per-library search indexes (which contain text and embeddings derived from your library), a locally granted Zotero desktop-API key, caches, and the update-check timestamp in its data directory on your machine. Files that tools write on request also land there unless you name another path: Word documents from `zotero_word_document`, evidence tables saved to disk, attachments downloaded with `zotero_attachment`, and page images from `zotero_pdf_images`. On a shared server each user's files live in a subtree of their own inside that directory.
- **Usage log (off unless you turn it on)**: setting `ZOTEUS_USAGE_LOG=true` makes Zoteus keep a local record of which tools were called, when, whether they succeeded, how long they took, and (on a multi-user server) which Zotero user made the call. It records no argument values, no search strings and no library content, it is never sent anywhere, and it does not exist unless you enable it. It is there for operators running a shared instance who need to see how their own server is used.

## Third-party sharing

Zoteus does not sell library data. Tool results go to the chosen AI client/service, and the external services listed above receive the data needed for the features you use. The operator of a self-hosted remote also controls its storage and logs.

## Data retention

All stored data lives on your device and persists until you delete it. Removing the data directory removes the search index, caches, the granted local key, and every document, table, download and page image a tool wrote there. Your Zotero API key can be revoked at any time at [zotero.org/settings/keys](https://www.zotero.org/settings/keys). On a shared server, revoking the key does not delete that user's subtree; the operator removes it.

## Self-hosted remote mode

If you (or your organization) run Zoteus as a hosted server with OAuth enabled, the operator of that instance controls its data handling: per-user Zotero keys can be held in memory or encrypted at rest, and requests are logged with secrets redacted. The Zoteus project operates one such instance itself, the optional paid hosted connector at `mcp.zoteus.com`. This policy does not govern it, because this policy is about the software you run; the controlling policy for the hosted service is at [zoteus.com/privacy](https://zoteus.com/privacy), which names the data controller, what is stored, and where it is stored.

## Contact

Privacy and data-protection questions: <privacy@zoteus.com>. Anything else, including support for
the hosted connector: <support@zoteus.com>. Bugs and feature requests are best filed as an issue at
[github.com/oscardvs/zoteus/issues](https://github.com/oscardvs/zoteus/issues).
