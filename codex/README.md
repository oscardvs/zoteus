# Zoteus — code-execution wrappers

Generated TypeScript wrappers for the Zoteus MCP tools, for use with Anthropic's
[code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) pattern.

Instead of loading every tool definition into the model context, an agent can
**progressively disclose** tools: list this directory, read only the few files it
needs, and call them from a code-execution sandbox. Large intermediate data
(full text, big exports, thousands of items) is filtered/aggregated in code and
never round-trips through the model.

## Usage

```ts
import { setMCPCaller } from './runtime.js';
import { searchItems } from './zotero/searchItems.js';
import { formatBibliography } from './zotero/formatBibliography.js';

// 1. Bridge the wrappers to your live MCP connection once.
setMCPCaller((name, input) => myMcpClient.callTool({ name, arguments: input }));

// 2. Compose freely in code — only the small result is logged.
const { items } = (await searchItems({ tag: 'to-read', itemType: 'journalArticle', response_format: 'detailed' })).structuredContent;
const recent = items.filter((i) => Number(i.date?.slice(0, 4)) >= 2024);
console.log(await formatBibliography({ item_keys: recent.map((i) => i.key), style: 'IEEE' }));
```

These files are generated from the tool registry — regenerate with `npm run gen:codex`.

## Available wrappers

| Function | MCP tool | Purpose |
|---|---|---|
| `whoami()` | `zotero_whoami` | Zotero identity & access |
| `searchItems()` | `zotero_search_items` | Search Zotero items |
| `getItem()` | `zotero_get_item` | Get a Zotero item |
| `schema()` | `zotero_schema` | Zotero data model (types & fields) |
| `createItems()` | `zotero_create_items` | Create or update Zotero items |
| `updateItem()` | `zotero_update_item` | Update a Zotero item |
| `trashItems()` | `zotero_trash_items` | Trash or restore Zotero items |
| `deleteItems()` | `zotero_delete_items` | Permanently delete Zotero items |
| `manageCollections()` | `zotero_manage_collections` | Manage Zotero collections |
| `manageTags()` | `zotero_manage_tags` | Manage Zotero tags |
| `savedSearches()` | `zotero_saved_searches` | Manage Zotero saved searches |
| `groups()` | `zotero_groups` | List Zotero groups |
| `exportTool()` | `zotero_export` | Export Zotero items |
| `fulltext()` | `zotero_fulltext` | Attachment full-text |
| `getFulltext()` | `zotero_get_fulltext` | Get attachment full text / passages / outline (read-only) |
| `pdfImages()` | `zotero_pdf_images` | Look at PDF pages and figures as images (read-only) |
| `sync()` | `zotero_sync` | Incremental sync delta |
| `attachment()` | `zotero_attachment` | Zotero attachments (files) |
| `annotate()` | `zotero_annotate` | Annotate a PDF (highlights, notes) |
| `attachFile()` | `zotero_attach_file` | Attach a file (PDF, snapshot) to an item |
| `importTool()` | `zotero_import` | Import items by identifier or URL |
| `styles()` | `zotero_styles` | Resolve CSL citation styles |
| `formatBibliography()` | `zotero_format_bibliography` | Format a bibliography (citeproc / any CSL style) |
| `bibliography()` | `zotero_bibliography` | Server-rendered bibliography (library items) |
| `index()` | `zotero_index` | Build the semantic search index |
| `semanticSearch()` | `zotero_semantic_search` | Semantic / hybrid library search |
| `scholar()` | `zotero_scholar` | Scholarly context (references, citations, related) |
| `searchTools()` | `search_tools` | Discover Zotero tools |
| `listTags()` | `zotero_list_tags` | List Zotero tags (read-only) |
| `listCollections()` | `zotero_list_collections` | List Zotero collections (read-only) |
| `tagAudit()` | `zotero_tag_audit` | Audit tags against a controlled vocabulary |
