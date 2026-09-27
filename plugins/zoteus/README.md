# Zoteus for Claude

Zoteus puts your [Zotero](https://www.zotero.org) library inside Claude. You can ask questions about the papers you have saved and get the answer with the exact passage and page number from your own PDFs. You can also format a reference list in any citation style, add a paper by its DOI or arXiv id, and tidy tags, collections and duplicates. Every change is shown first and is reversible.

The plugin has two parts:

- **The Zoteus MCP server**, which gives Claude its `zotero_*` tools. The server is open source under the MIT license, and its code is in the [repository](https://github.com/oscardvs/zoteus) this folder belongs to.
- **Four skills** that tell Claude how to use those tools well:

| Skill | What it does |
|---|---|
| `grounded-answers` | Answers from your library with a verbatim quotation and a page locator, and says so when only the abstract was available. |
| `evidence-table` | Compares several sources on one question, writes a cited literature review, or audits a draft's citations against the PDFs. |
| `citations` | Formats bibliographies in any CSL style, exports BibTeX or RIS, and writes Word documents with live Zotero citations. |
| `library-upkeep` | Imports papers, attaches open-access PDFs, merges duplicates, and handles tags, collections, highlights and trash, confirming each change first. |

## Before you start

1. Install and run the [Zotero desktop app](https://www.zotero.org/download). In **Settings → Advanced**, turn on **Allow other applications on this computer to communicate with Zotero**.
2. Have [Node.js](https://nodejs.org) 20.19 or later installed. The server is started with `npx`.
3. Optional: in the plugin's settings, enter a Zotero API key from [zotero.org/settings/keys](https://www.zotero.org/settings/keys). Without one, Zoteus reads your library through the desktop app. It can also add items, attachments and annotations there, and trash or restore them. A key adds sync, group libraries, metadata edits, tags and collections, and access while the app is closed. Claude Code stores the key in your system's secure credential store.

## Where it works

- **Claude Code**, and **Cowork** sessions that run on your computer: the plugin starts the server for you. Cowork does not ask for plugin settings, so there it works through the desktop app, with no key.
- **claude.ai chat**: the skills load, but a chat cannot start a program on your computer. For the tools, add a remote Zoteus connector: the [hosted one](https://zoteus.com/pricing) or [one you run yourself](https://github.com/oscardvs/zoteus/blob/main/docs/remote-oauth.md).

## Try it

- "What does my saved copy of the Vaswani et al. paper say about positional encoding? Quote it with the page."
- "Compare the five most relevant papers in my library on sleep and memory consolidation, in an evidence table."
- "Format these three items in APA 7th."
- "Add arXiv 2305.10403 to my Reading collection and attach the PDF."

## What it runs, sends and stores

When the plugin starts, it runs `npx -y @oscardvs/zoteus@1.21.0`. On first use, that downloads this exact published version of the package from the npm registry. The package is built from this repository and published with npm provenance.

The server contacts only what a request needs:

- **The Zotero desktop app**, on your own machine at `127.0.0.1`.
- **The Zotero Web API** (`api.zotero.org`), with your API key, for cloud reads and writes.
- **Scholarly services**, only when you look up references, citing works, open-access copies or retraction notices: OpenAlex by default, and Crossref or Semantic Scholar where configured. Only identifiers and search terms are sent.
- **Identifier resolvers**, such as doi.org and arXiv, when you import by identifier or URL.
- **Publisher or repository hosts**, when you ask it to download an open-access PDF.
- **Optional extras, only if you set them up**:
  - an embedding provider you choose (OpenAI, Gemini, or a local Ollama);
  - Hugging Face, for on-device model weights, if you install the on-device embedding runtime;
  - OCR language data, if you install OCR;
  - GitHub, for a once-a-day update check, which is off by default.

Tool results, including passages from your PDFs, go to Claude. There, they are handled under Anthropic's terms.

Zoteus sends no analytics. It keeps a search index, caches and any files you ask it to write, such as Word documents and page images, in its data directory on your machine. Deleting that directory removes all of it. The full policy is in [PRIVACY.md](https://github.com/oscardvs/zoteus/blob/main/PRIVACY.md). Advanced settings, such as semantic-search embeddings and read-only mode, are described in the [configuration reference](https://github.com/oscardvs/zoteus/blob/main/docs/configuration.md).

## Support

Report problems at [github.com/oscardvs/zoteus/issues](https://github.com/oscardvs/zoteus/issues), or email support@zoteus.com.

Zoteus is not affiliated with or endorsed by the Corporation for Digital Scholarship or Zotero. It is licensed under the MIT license: see [LICENSE](./LICENSE).
