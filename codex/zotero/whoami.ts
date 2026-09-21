import { callMCPTool } from '../runtime.js';

/**
 * Zotero identity & access : Resolve the current Zotero identity (userID, username, display name) and per-library access scopes from the configured API key, report the running Zoteus `version`, and report which library backends are available (cloud Web API and/or the desktop local API). Call this first to discover the userID : never ask the user to type a numeric ID. It also reports which library every call defaults to and WHY (`defaultLibrary.source`: pinned by whoever runs the server, derived from the key, or the desktop app's own library), whether this caller has a context of their own or shares the one the server oper
 * Takes no parameters.
 */
export function whoami(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_whoami', input);
}
