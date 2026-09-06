// IMPORTANT: stdout carries the JSON-RPC stream on stdio transport.
// All logging MUST go to stderr.
import { createWriteStream, type WriteStream } from 'node:fs';
import { redactArgs } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'text' | 'json';
export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface LoggerOptions {
  /**
   * A file every line is appended to as well as stderr (ZOTEUS_LOG_FILE). For a server
   * nobody's terminal is attached to, a Windows scheduled task or a service manager that
   * discards stderr, it is the only record of what the process was doing when it stopped
   * answering (#59). Same format as stderr; a file that cannot be written is reported once
   * on stderr and then left alone, never a reason for the server not to start.
   */
  file?: string;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(
  level: LogLevel | string = 'info',
  format: LogFormat = 'text',
  opts: LoggerOptions = {},
): Logger {
  const threshold = ORDER[level as LogLevel] ?? ORDER.info;
  let file: WriteStream | undefined;
  if (opts.file) {
    file = createWriteStream(opts.file, { flags: 'a' });
    file.on('error', (e) => {
      process.stderr.write(`[zoteus] WARN log file ${opts.file} is not writable (${e.message}); logging to stderr only\n`);
      file?.destroy();
      file = undefined;
    });
  }
  const write = (line: string): void => {
    process.stderr.write(line);
    file?.write(line);
  };
  const emit = (lvl: LogLevel, args: unknown[]) => {
    if (ORDER[lvl] < threshold) return;
    const redacted = redactArgs(args);
    if (format === 'json') {
      // A trailing plain object becomes TOP-LEVEL keys, not text inside `msg`. Every call
      // site here already passes one — logger.info('http', { method, path, status, ms }) —
      // and stringifying it into the message made the whole structured format useless:
      // `docker logs | jq 'select(.status >= 500)'` matched nothing, because there was no
      // `.status`, only a `.msg` with an escaped JSON document inside it.
      const fields = trailingFields(redacted);
      const text = (fields ? redacted.slice(0, -1) : redacted)
        .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
        .join(' ');
      write(`${safeStringify({ level: lvl, time: new Date().toISOString(), msg: text, ...fields })}\n`);
    } else {
      const text = redacted.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ');
      write(`[zoteus] ${lvl.toUpperCase()} ${text}\n`);
    }
  };
  return {
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
  };
}

/**
 * The last argument, when it is a plain object worth spreading into the record.
 *
 * Deliberately narrow. An Error has no enumerable own properties, so spreading one would
 * silently drop it; an array would spread as `0`, `1`, `2`; and the reserved keys are
 * dropped rather than allowed to overwrite the record's own, so no caller can move the
 * meaning of `level` or `time` by naming a field after it.
 */
function trailingFields(args: unknown[]): Record<string, unknown> | undefined {
  const last = args[args.length - 1];
  if (!last || typeof last !== 'object' || Array.isArray(last) || last instanceof Error)
    return undefined;
  const entries = Object.entries(last as Record<string, unknown>).filter(
    ([k, v]) => v !== undefined && k !== 'level' && k !== 'time' && k !== 'msg',
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
