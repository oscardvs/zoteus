import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolContext } from '../registry/registry.js';

/**
 * The directory tree one caller's files live in, and the root a confined caller is held to.
 *
 * `ctx.config.dataDir` is a single directory for the whole process: every tenant of a hosted
 * deployment shares it, because the config object is built once and handed to every per-user
 * context (src/server.ts). The search index already keys its own file by `zoteroUserId`
 * (`defaultIndexPath` in src/features/search/index-registry.ts) for exactly that reason, and a
 * document a researcher wrote is worse to share than an index: it is their own prose, their own
 * library's citations.
 *
 * So in multi-tenant mode the caller gets a subtree of their own and `resolveCallerPath` is
 * pointed at that subtree rather than at the whole data directory. Two things follow, and both
 * are the point: one tenant cannot write into another's subtree, and one tenant cannot use the
 * "that file already exists" refusal to learn whether another tenant's file is there.
 *
 * On stdio the caller is the operator and the root is the data directory itself, exactly as
 * before. A REMOTE caller with no per-user identity (a passcode-mode deployment, where every
 * caller shares the operator's context) gets a `tenants/shared` subtree instead: the bare data
 * directory holds the OAuth token store, the granted local-API key and every other tenant's
 * subtree, and holding a bearer token is not a reason to be allowed to read those into a
 * library or to learn which of them exist.
 *
 * The directory is created here rather than at write time because `resolveCallerPath` compares
 * real (symlink-resolved) paths: if the root does not exist it cannot be resolved, and a data
 * directory reached through a symlink would then compare unequal to a path inside it.
 */
export async function callerRoot(ctx: Pick<ToolContext, 'config' | 'remoteCaller' | 'zoteroUserId'>): Promise<string> {
  if (!ctx.remoteCaller) return ctx.config.dataDir;
  const root = join(ctx.config.dataDir, 'tenants', ctx.zoteroUserId === undefined ? 'shared' : String(ctx.zoteroUserId));
  // A root that cannot be created is not worth failing on here: the write that follows fails
  // with a message about the file the caller actually asked for.
  await mkdir(root, { recursive: true }).catch(() => {});
  return root;
}
