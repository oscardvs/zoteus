import { callMCPTool } from '../runtime.js';

/**
 * Zotero identity & access — Resolve the current Zotero identity (userID, username, display name) and per-library access scopes from the configured API key, report the running Zoteus `version`, and report which library backends are available (cloud Web API and/or the desktop local API). Call this first to discover the userID — never ask the user to type a numeric ID. If no API key is configured, the server runs in local-only read mode against the desktop library (users/0).
 * Takes no parameters.
 */
export function whoami(input: Record<string, unknown> = {}): Promise<any> {
  return callMCPTool('zotero_whoami', input);
}
