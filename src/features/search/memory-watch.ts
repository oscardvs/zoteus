import { readFileSync } from 'node:fs';
import { freemem, platform, totalmem } from 'node:os';

/**
 * How close an index job is to being killed for memory, and the guard that stops it first.
 *
 * On Linux an index build that outgrows the machine is not refused or slowed down: the
 * kernel's out-of-memory killer sends SIGKILL, which takes the Zoteus process and the MCP
 * session it serves with it, with no exception, no log line and nothing in the index status
 * (#105: a 42k-passage build on a 6.3 GB machine, killed twice at about 4 GB). Nothing
 * inside the process can catch that signal, so the only defence is to stop the job while
 * there is still room to stop it.
 */

const MB = 1024 * 1024;

/** What is left before the out-of-memory killer, as well as this platform can say. */
export interface MemoryHeadroom {
  /** Bytes the system could still hand this process. */
  availableBytes: number;
  /** The RAM (or container limit) the headroom is out of. */
  totalBytes: number;
  /**
   * Where the numbers came from. `cgroup`: a container memory limit, minus this process's
   * resident memory. `meminfo`: Linux's own estimate of what can still be allocated
   * (MemAvailable) plus free swap. `os`: the platform's free-memory figure, everywhere else.
   */
  source: 'cgroup' | 'meminfo' | 'os';
}

/** The fields of /proc/meminfo this needs, in bytes, or undefined off Linux. */
function readMeminfo(): { memTotal: number; memAvailable: number; swapFree: number } | undefined {
  if (platform() !== 'linux') return undefined;
  let text: string;
  try {
    text = readFileSync('/proc/meminfo', 'utf8');
  } catch {
    return undefined;
  }
  const field = (name: string): number | undefined => {
    const m = new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(text);
    return m ? Number(m[1]) * 1024 : undefined;
  };
  const memTotal = field('MemTotal');
  const memAvailable = field('MemAvailable');
  if (memTotal === undefined || memAvailable === undefined) return undefined;
  return { memTotal, memAvailable, swapFree: field('SwapFree') ?? 0 };
}

/**
 * Read the headroom now.
 *
 * A container limit wins when there is one, because the system figures inside a container
 * describe the host: the cgroup kills at its own limit, long before the host runs short.
 * Its usage counter includes reclaimable page cache, so this process's resident memory is
 * subtracted instead, which is the part that cannot be reclaimed.
 *
 * Swap counts on Linux. With swap the killer does not act when RAM runs out, only when swap
 * does too, and a build that would have finished by paging (#105 finished with 2.1 GB of
 * swap in use) must not be stopped for using it.
 */
export function memoryHeadroom(): MemoryHeadroom {
  const host = totalmem();
  const limit = typeof process.constrainedMemory === 'function' ? process.constrainedMemory() : 0;
  if (limit > 0 && limit < host) {
    return { availableBytes: Math.max(0, limit - process.memoryUsage.rss()), totalBytes: limit, source: 'cgroup' };
  }
  const info = readMeminfo();
  if (info) {
    return { availableBytes: info.memAvailable + info.swapFree, totalBytes: info.memTotal, source: 'meminfo' };
  }
  return { availableBytes: freemem(), totalBytes: host, source: 'os' };
}

/**
 * The floor a job stops at when the operator has not set one, in bytes, or 0 for none.
 *
 * 5% of RAM, at least 128 MB and at most 1 GB. The watchdog samples every two seconds, so
 * the floor is the allocation a build can make between two samples without being caught
 * out: a page of attachments, an embedding batch, a store commit. 128 MB covers that on a
 * 1 GB cloud machine; 5% of a 6.3 GB laptop is about 320 MB.
 *
 * Off where the figure is not to be trusted. macOS counts memory it would hand back on
 * request (inactive, compressed, purgeable) as used, so its free figure sits near zero on a
 * healthy machine and a default floor would stop every build. An operator can still set one
 * there, knowing what the platform reports.
 */
export function defaultMemoryFloorBytes(h: MemoryHeadroom): number {
  if (h.source === 'os') return 0;
  return Math.min(1024 * MB, Math.max(128 * MB, Math.round(h.totalBytes * 0.05)));
}

/**
 * The floor for a job: the operator's setting in MB when there is one (0 turns the guard
 * off), otherwise the default for this machine.
 */
export function memoryFloorBytes(configuredMb: number | undefined, h: MemoryHeadroom): number {
  if (configuredMb !== undefined) return Math.max(0, configuredMb) * MB;
  return defaultMemoryFloorBytes(h);
}

/** Whole megabytes, for messages. */
export function toMb(bytes: number): number {
  return Math.round(bytes / MB);
}

/**
 * Samples the headroom while a job runs and calls `onLow` once, the first time it falls
 * below the floor. Two seconds apart: a read of /proc/meminfo is a few microseconds, and a
 * build grows by megabytes per second at the very most, so a finer grain buys nothing.
 */
export class MemoryWatchdog {
  private timer: ReturnType<typeof setInterval> | undefined;
  private fired = false;
  /** The lowest headroom seen while the job ran. */
  lowest: MemoryHeadroom | undefined;

  constructor(private readonly sample: () => MemoryHeadroom = memoryHeadroom) {}

  start(floorBytes: number, onLow: (h: MemoryHeadroom) => void, intervalMs = 2_000): void {
    this.stop();
    this.fired = false;
    this.lowest = undefined;
    if (floorBytes <= 0) return;
    const check = (): void => {
      let h: MemoryHeadroom;
      try {
        h = this.sample();
      } catch {
        return;
      }
      if (!this.lowest || h.availableBytes < this.lowest.availableBytes) this.lowest = h;
      if (!this.fired && h.availableBytes < floorBytes) {
        this.fired = true;
        onLow(h);
      }
    };
    this.timer = setInterval(check, intervalMs);
    // Never the reason the process stays alive: a guard on an idle server is not work.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

function describe(h: MemoryHeadroom): string {
  if (h.source === 'cgroup') return `of its ${toMb(h.totalBytes)} MB container limit`;
  if (h.source === 'meminfo') return 'free RAM plus free swap';
  return 'as the system reports it';
}

const REMEDY =
  'To give it room: close other programs, add swap, run Node 22.13 or later so the index lives in SQLite ' +
  'instead of in memory, or lower ZOTEUS_EMBED_BATCH_SIZE. ZOTEUS_INDEX_MIN_FREE_MB sets the floor, and 0 ' +
  'turns this guard off.';

/** Why a job was not started: the machine is already under the floor. */
export function lowMemoryRefusal(h: MemoryHeadroom, floorBytes: number): string {
  return (
    `Not starting: this machine has ${toMb(h.availableBytes)} MB of memory left (${describe(h)}), under the ` +
    `${toMb(floorBytes)} MB floor at which an index job stops itself rather than be killed by the system. ${REMEDY}`
  );
}

/** What a job the guard stopped says about it, on its status and in the log. */
export function memoryStopSentence(h: MemoryHeadroom, floorBytes: number, operation: 'build' | 'update'): string {
  return (
    `This ${operation} stopped itself when the machine was down to ${toMb(h.availableBytes)} MB of memory ` +
    `(${describe(h)}), under the ${toMb(floorBytes)} MB floor, so that the system would not kill Zoteus ` +
    `mid-job. What it saved is kept, and running action:"${operation}" again continues from there. ${REMEDY}`
  );
}
