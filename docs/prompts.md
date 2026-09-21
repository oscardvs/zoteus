# Prompts (workflows)

Zoteus ships MCP **Prompts** — user-triggered scholarly workflows that hosts expose as slash commands. They orchestrate the `zotero_*` tools for common research tasks.

| Prompt | Arguments | What it does |
|---|---|---|
| `zotero-literature-review` | `topic`, `collection?` | Search + read + synthesize a cited mini-review. |
| `zotero-cite` | `item_keys`, `style?` | Format a bibliography for specific items in a style. |
| `zotero-add-from-url` | `source`, `collection?` | Ingest a paper from a URL/DOI/ISBN/PMID/arXiv. |
| `zotero-organize` | `collection?` | Suggest tags and collection moves for loose items. |
| `zotero-find-related` | `item_key` | Find related & citing work (library + scholarly graph). |
| `zotero-citation-audit` | `text` | Check a draft's citations against the library/literature. |
| `zotero-summarize-collection` | `collection` | Summarize a collection's themes and gaps. |
| `zotero-evidence-table` | `question`, `item_keys?`, `collection?`, `max_items?` | Compare sources on one question in a table of retrieved passages, page locators and evidence status. See [`evidence-tables.md`](./evidence-tables.md). |

Each prompt returns a templated instruction message that guides the model to use the right tools (e.g. `zotero_semantic_search`, `zotero_get_item`, `zotero_bibliography`). They are read-only by themselves — any writes happen through the tools, with the usual safety gates.
