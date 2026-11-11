# Zoteus for Claude

Zoteus puts your [Zotero](https://www.zotero.org) library inside Claude. You can ask questions about the papers you have saved and get the answer with the exact passage and page number from your own PDFs. You can also format a reference list in any citation style, add a paper by its DOI or arXiv id, and tidy tags, collections and duplicates. Every change is shown first and is reversible.

The plugin has two parts:

- **The hosted Zoteus connector** at `https://mcp.zoteus.com/mcp`, which gives Claude its `zotero_*` tools. It is a paid service run by the author, with a 14-day free trial. The server code is open source under the MIT license, in the [repository](https://github.com/oscardvs/zoteus) this folder belongs to, and you can [run it yourself](https://github.com/oscardvs/zoteus/blob/main/docs/remote-oauth.md) instead.
- **Four skills** that tell Claude how to use those tools well:

| Skill | What it does |
|---|---|
| `grounded-answers` | Answers from your library with a verbatim quotation and a page locator, and says so when only the abstract was available. |
| `evidence-table` | Compares several sources on one question, writes a cited literature review, or audits a draft's citations against the PDFs. |
| `citations` | Formats bibliographies in any CSL style, exports BibTeX or RIS, and writes Word documents with live Zotero citations. |
| `library-upkeep` | Imports papers, attaches open-access PDFs, merges duplicates, and handles tags, collections, highlights and trash, confirming each change first. |

## Before you start

1. Have a [Zotero](https://www.zotero.org) account with your library synced to it. Zoteus reads and writes the cloud copy of your library, and changes reach the desktop app on its next sync.
2. Install the plugin, then connect Zoteus when Claude asks. Sign-in opens zoteus.com, where you start a subscription or the free trial ([pricing](https://zoteus.com/pricing)) and link your Zotero account. You choose read-only or read and write access there.

Nothing is installed or run on your computer.

## Where it works

The connector and the skills work in Claude Code, Claude Desktop, Cowork and claude.ai chat, wherever remote connectors are available.

## Try it

- "What does my saved copy of the Vaswani et al. paper say about positional encoding? Quote it with the page."
- "Compare the five most relevant papers in my library on sleep and memory consolidation, in an evidence table."
- "Format these three items in APA 7th."
- "Add arXiv 2305.10403 to my Reading collection and attach the PDF."

## What it runs, sends and stores

The plugin runs nothing on your computer. It adds one remote MCP server, `https://mcp.zoteus.com/mcp`, which you sign in to with OAuth.

The hosted server contacts only what a request needs:

- **The Zotero Web API** (`api.zotero.org`), with the access you granted, for reads and writes.
- **Scholarly services**, only when you look up references, citing works, open-access copies or retraction notices: OpenAlex, Crossref or Semantic Scholar. Only identifiers and search terms are sent.
- **Identifier resolvers**, such as doi.org and arXiv, when you import by identifier or URL.
- **Publisher or repository hosts**, when you ask it to download an open-access PDF.
- **Polar** (polar.sh), the payment provider, for your subscription.

Tool results, including passages from your PDFs, go to Claude. There, they are handled under Anthropic's terms.

The hosted server stores your account, the Zotero access token you granted and, if you use semantic search, a search index of your library. The search index is deleted within 30 days of cancelling. Zoteus sends no analytics from the tools. The full policy is at [zoteus.com/privacy](https://zoteus.com/privacy).

## Support

Report problems at [github.com/oscardvs/zoteus/issues](https://github.com/oscardvs/zoteus/issues), or email support@zoteus.com.

Zoteus is not affiliated with or endorsed by the Corporation for Digital Scholarship or Zotero. It is licensed under the MIT license: see [LICENSE](./LICENSE).
