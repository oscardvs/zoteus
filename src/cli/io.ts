/**
 * Where a CLI command writes.
 *
 * Its own interface rather than `process.stdout`/`process.stderr` directly, for one
 * reason: the tests assert what each stream received (the contract is "progress on
 * stderr, result on stdout", and an implementation that quietly swapped them would still
 * look right to a human watching a terminal). Kept in its own module so `index.ts` and
 * `index-command.ts` can both take it without importing each other.
 */
export interface CliIo {
  /** The command's result. Only ever written on a path where no transport was started. */
  out(text: string): void;
  /** Progress, notices, warnings and errors. Safe on every path. */
  err(text: string): void;
}

/** The real streams. */
export const processIo: CliIo = {
  out(text: string): void {
    process.stdout.write(text);
  },
  err(text: string): void {
    process.stderr.write(text);
  },
};

/** Collects both streams, for tests and for anything that wants the output as a string. */
export function captureIo(): CliIo & { stdout: string; stderr: string } {
  const captured = {
    stdout: '',
    stderr: '',
    out(text: string): void {
      captured.stdout += text;
    },
    err(text: string): void {
      captured.stderr += text;
    },
  };
  return captured;
}
