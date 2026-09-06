import { callMCPTool } from '../runtime.js';

/**
 * Zotero attachments (files) — Upload, download, or inspect attachment files. `action`: "upload" stores a file as a Zotero attachment using the full File Storage protocol (provide `url` to have Zoteus fetch it, or `file_path` for a file on the machine running Zoteus; optional `parent_item` to attach it under an item, `title`, `content_type`) and returns the new attachment key; "download" fetches an attachment's file to a local path (provide `item_key`; optional `save_path`, default under the Zoteus data dir) and returns the path and byte count; "info" returns an attachment item's metadata. File bytes are written to / read f
 * Params: action, file_path, url, parent_item, title, content_type, item_key, save_path, overwrite, library_type, library_id.
 */
export function attachment(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_attachment', input);
}
