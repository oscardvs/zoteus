# Check search readiness and PDF coverage

A connection, a readable PDF, and a semantic index are three different things. You can [read a known paper](./first-research-task.md) before indexing your whole library.

## Ask for a readiness check

> Use Zoteus to check my identity and the selected library. Show my permissions, index status, indexed versus available items, whether embeddings are active, whether PDF bodies are indexed, and any coverage warnings. Do not start a build yet. Explain what can be searched now.

The assistant should call `zotero_whoami` and `zotero_index` with `action:"status"`. For a group, first resolve its numeric ID with `zotero_groups`. Ask it to explain missing status fields as **unknown**, not as complete coverage.

| Check | What it means | What to do |
|---|---|---|
| Library and permissions | Your personal library or one named group, with the permissions Zotero grants | Correct the account, group ID or key permissions before searching |
| Indexed versus available items | `itemsTotal` / `itemsAvailable` in build progress, plus current stored item count | A capped or unfinished build is only a subset of the library |
| Active embeddings | `embedderActive` and `embedderReason`, not just the configured provider name | If inactive, keyword ranking works but search by meaning does not |
| PDF coverage | `fulltextEnabled`, `fulltextItems`, `fulltextReason`, `fulltextPartial` | Enabling PDF indexing does not make missing attachment text available |
| Notes and annotations | `ownWordsItems`, `ownWordsPassages`, and any `ownWordsReason` | Check that your notes/highlights were included |
| Build state and persistence | Progress, last error, any `persistError`, and available timestamps | A completed job does not prove every file was indexed or saved successfully |

## What is searched by default?

- **Direct keyword lookup:** find titles, creators or exact filters with `zotero_search_items`; this needs no Zoteus index.
- **Indexed search:** titles, abstracts, creators and tags, plus child notes and PDF annotations by default. Vector ranking needs a working embedding provider and vectors in the index. Keyword fallback is not semantic ranking.
- **PDF bodies:** opt-in with `fulltext:true` on a build or `ZOTEUS_INDEX_FULLTEXT=true`. This uses text Zotero has extracted. It does not scan your disk, upload files or perform OCR.

The default build cap is **5,000 items**. When PDF-body indexing is enabled, the default text cap is **40,000 characters per item**. These are indexing limits, not limits on which later pages you can request from a readable PDF. A claim near the end of a book may be absent from search even though [page-range reading](./grounding.md) can retrieve it.

Ask before building: "Show the current caps and whether this build will use a paid embedding API. Start with metadata and my notes, then let me choose whether to include PDF bodies." Larger coverage takes more time, storage and potentially API spend. No universal duration estimate fits every library.

## Set up search by meaning locally

The desktop bundle includes keyword search and PDF reading. It does **not** include the large local embedding dependency. Selecting `local` alone does not install it.

For Claude Desktop, install Node.js 20.19+ to perform this optional dependency setup. In a terminal on macOS or Linux:

```bash
mkdir -p ~/.zoteus-deps
cd ~/.zoteus-deps
npm init -y
npm install @huggingface/transformers
```

On Windows, in PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.zoteus-deps"
Set-Location "$env:USERPROFILE\.zoteus-deps"
npm init -y
npm install @huggingface/transformers
```

In the extension's **Configure** screen, set **Local embeddings path** to the absolute `node_modules` folder you just created, for example `/Users/you/.zoteus-deps/node_modules` or `C:\Users\you\.zoteus-deps\node_modules`. For a manually configured server, set `ZOTEUS_TRANSFORMERS_PATH` to that path. Do not use a global npm install: the extension runs on Claude's bundled Node runtime. Restart Claude, then check readiness again. The dependency tree is roughly 700 MB, with model weights downloaded separately on first use.

Alternatively choose `openai` or `gemini` and configure that provider's API key on your own server. Embedding text and queries then go to that provider and may incur separate charges. Your ChatGPT or Claude subscription does not supply an embedding API key. Use `off` to deliberately keep keyword-only ranking. See [provider configuration](./configuration.md).

For multilingual libraries, the existing local model choice `Xenova/multilingual-e5-small` with `ZOTEUS_EMBEDDING_DTYPE=q8` downloads about 129 MB of weights; this is not a total RAM estimate. Changing models requires rebuilding vectors. Test with a known passage in each language before relying on cross-language retrieval. [Detailed model reference](https://github.com/oscardvs/zoteus/blob/main/docs/semantic-search.md).

## Hosted search

The server operator controls embeddings and indexing caps. A software default does not establish a hosted allowance. If semantic PDF coverage is essential to your purchase, [ask support to confirm the active provider, included usage and coverage for your library](https://zoteus.com/pricing/#before-you-pay). After connecting, use the readiness check above. Do not paste an embedding API key into a research chat.

## One indexed library at a time

One data directory holds one library index, scoped per authenticated user in hosted mode. Ordinary tool calls can address different permitted groups, but that does not create multiple persistent semantic indexes or combined search. A build for a different library is refused to protect the existing index.

For local use, run a separate Zoteus instance with a different `ZOTEUS_DATA_DIR` for the second library. Keep the original index. Hosted users should agree on the intended indexed library with support before subscribing, especially for a personal-plus-group workflow.

## When search misses something

| Symptom | Remedy |
|---|---|
| A known title is absent | Try exact title lookup first. Confirm account, library, permissions and Zotero sync |
| Exact lookup works, indexed search misses it | Check item cap and progress; use `action:"update"` for new items, `action:"build"` to resume incomplete work |
| Results match words but miss the idea | Check active embeddings and missing vectors. Do not label keyword fallback as semantic search |
| A passage inside a PDF is absent | Check opt-in body indexing, available extracted text, text cap and partial coverage. Try reading its page directly |
| The PDF cannot be read | Follow [missing PDFs](./missing-pdfs.md): attachment bytes, local-only files, WebDAV, permissions or scanned pages |
| A build stops or is rate-limited | Read the error; `build` resumes persisted work. `refresh` starts over and can repeat API costs |
| Another library is already indexed | Use a separate data directory locally, or contact the hosted operator; do not delete your existing index as a routine fix |

[Continue to a verified passage](./first-research-task.md) · [Advanced search reference](./semantic-search.md)
