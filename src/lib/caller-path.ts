import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

/**
 * A caller-supplied filesystem path was refused. Tools surface the message as-is, so it
 * says what to do instead rather than only what went wrong.
 */
export class CallerPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CallerPathError';
  }
}

export interface CallerPathOptions {
  /** The one directory a confined caller may read from and write to. */
  dataDir: string;
  /**
   * Whether the caller is someone other than the operator. On stdio they are the same
   * person and a path is just a path: "save this PDF to ~/Desktop" is the tool working
   * as intended. On a shared HTTP deployment they are not, and a caller-supplied path
   * reaches the OPERATOR's disk: the OAuth token store under the data directory, the
   * process environment, the server's own code.
   */
  confined: boolean;
  mode: 'read' | 'write';
  /** The tool argument being resolved, so the refusal names what the caller should change. */
  argName: string;
  /** What to suggest instead, e.g. 'Use `url` instead'. */
  alternative: string;
}

/**
 * `~/Downloads/x.bib` as the operator means it: their own home directory.
 *
 * Only the operator's paths are expanded. A shell expands `~` before a program ever sees
 * it, so a path typed by hand arrives expanded and one passed through a tool argument does
 * not, and `path.resolve` would have quietly turned the latter into `<cwd>/~/Downloads`.
 * For a confined caller `~` would name the OPERATOR's home, which is exactly what
 * confinement exists to keep them out of, so their `~` stays a literal and is refused as
 * any other path outside the data directory is.
 */
function expandHome(raw: string): string {
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2));
  return raw;
}

/**
 * Resolve a path a tool caller supplied, refusing it when it escapes the data directory
 * on a deployment where the caller is not the operator.
 *
 * Resolution is done against the real (symlink-followed) path, not the string, so that a
 * symlink planted inside the data directory cannot be used to step outside it. For a write
 * the file itself need not exist yet, so its parent directory is what gets resolved.
 */
export async function resolveCallerPath(raw: string, opts: CallerPathOptions): Promise<string> {
  if (!opts.confined) return resolve(expandHome(raw));
  const target = resolve(raw);

  const root = await realpath(opts.dataDir).catch(() => resolve(opts.dataDir));

  let real: string;
  if (opts.mode === 'read') {
    // A read target must already exist; if it does not, the tool's own error is clearer
    // than ours, so fall through with the lexical path and let it fail there.
    real = await realpath(target).catch(() => target);
  } else {
    const parent = await realpath(dirname(target)).catch(() => dirname(target));
    real = join(parent, basename(target));
  }

  if (real !== root && !real.startsWith(root + sep)) {
    throw new CallerPathError(
      `\`${opts.argName}\` must be inside this server's data directory. Zoteus is running as a ` +
        `shared server here, so a filesystem path points at the operator's disk rather than ` +
        `yours. ${opts.alternative}`,
    );
  }
  return real;
}
