import { createRequire } from 'node:module';

/**
 * The running Zoteus version, read from the package manifest beside the compiled output.
 *
 * Exported rather than kept private to the server because `zotero_whoami` reports it too.
 * Nothing in a conversation could previously say which Zoteus was running: the update check
 * only speaks up when a NEWER release exists, so silence meant either "current" or "never
 * checked", and a client pinned several releases back looked exactly like a healthy one.
 */
export const VERSION: string = createRequire(import.meta.url)('../../package.json').version;
