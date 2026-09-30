import type { ZoteusConfig } from '../config.js';
import type { WebApiClient, KeyInfo } from '../api/web-client.js';
import type { LocalApiClient, LocalProbeResult } from '../api/local-client.js';
import type { Logger } from '../lib/logger.js';

/**
 * Why the local API is, or is not, available, as the latest probe found it.
 *
 * `up` and `unreachable` are the two ordinary answers. The other two used to be reported
 * as the same bare `false`, and that cost one user an afternoon of guessing at User-Agent
 * strings and IPv6 when the answer was that Zotero took longer than the budget (#102).
 */
export type LocalProbeOutcome =
  | { kind: 'up' }
  /** Nothing accepted the connection: Zotero is not running, or listens on another port. */
  | { kind: 'unreachable' }
  /** Something accepted the connection and did not answer within the budget. */
  | { kind: 'timeout'; budgetMs: number }
  /** Something answered, and it was not a success. 403 is the local API switched off. */
  | { kind: 'http'; status: number };

export interface Capabilities {
  cloud: KeyInfo | null;
  localApi: boolean;
  /**
   * Group libraries the desktop app serves locally (Zotero 10+). Empty on older
   * versions, and empty when the local API is down — a group the cloud key can see but
   * the desktop does not hold must still be read over the Web API.
   */
  localGroupIds: number[];
  /**
   * What the latest liveness probe found, kept live by `LocalApiStatus` alongside
   * `localApi`. Absent until a probe has run, which on a hosted server is forever. Nothing
   * routes on it: it exists so the startup log and zotero_whoami can say why.
   */
  localProbe?: LocalProbeOutcome;
}

/** One probe's result, as an outcome the log and zotero_whoami can name. */
export function probeOutcome(result: LocalProbeResult, budgetMs: number): LocalProbeOutcome {
  if (result.up) return { kind: 'up' };
  if (result.status !== undefined) return { kind: 'http', status: result.status };
  if (result.timedOut) return { kind: 'timeout', budgetMs };
  return { kind: 'unreachable' };
}

/** The outcome as a short parenthetical for a log line: what happened, not what to do. */
export function describeLocalProbe(outcome: LocalProbeOutcome, port: number): string {
  switch (outcome.kind) {
    case 'up':
      return 'answering';
    case 'unreachable':
      return `nothing listening on 127.0.0.1:${port}`;
    case 'timeout':
      return `no answer within ${outcome.budgetMs} ms`;
    case 'http':
      return outcome.status === 403 ? 'HTTP 403, the local API is switched off in Zotero' : `HTTP ${outcome.status}`;
  }
}

export interface ProbeDeps {
  web: Pick<WebApiClient, 'hasKey' | 'keysCurrent'>;
  /**
   * `probe` is optional so a fixture can supply `ping` alone; where it exists it is
   * preferred, because it carries a time budget and `ping` does not.
   */
  local?: Pick<LocalApiClient, 'ping' | 'listLocalGroupIds'> & Partial<Pick<LocalApiClient, 'probe'>>;
  logger: Logger;
}

/**
 * Budget for one startup attempt. Without it each attempt inherits the fetcher's 25 s
 * default, so a firewall that DROPs the packet instead of refusing it turns three attempts
 * into over a minute of startup before the answer is even `false`.
 */
const STARTUP_PROBE_TIMEOUT_MS = 2_000;

export async function probeCapabilities(
  config: ZoteusConfig,
  deps: ProbeDeps,
): Promise<Capabilities> {
  const cloudPromise: Promise<KeyInfo | null> = deps.web.hasKey
    ? deps.web
        .keysCurrent()
        .then((info) => info)
        .catch((err) => {
          deps.logger.warn('Cloud key probe failed:', String(err));
          return null;
        })
    : Promise.resolve(null);

  // The desktop app may be mid-startup when zoteus boots; a single instant ping can
  // race it and wrongly disable every desktop write path for the process lifetime.
  //
  // The last attempt's outcome is kept, not the first: a Zotero still loading its library
  // times out on the first attempt and refuses nothing, and it is the final answer the
  // log line reports. A fixture that supplies `ping` alone records no outcome.
  let localProbe: LocalProbeOutcome | undefined;
  const localPromise: Promise<boolean> =
    config.local !== 'off' && deps.local
      ? (async () => {
          for (let attempt = 0; attempt < 3; attempt++) {
            let up: boolean;
            if (deps.local!.probe) {
              const result = await deps.local!
                .probe(STARTUP_PROBE_TIMEOUT_MS)
                .catch((): LocalProbeResult => ({ up: false, timedOut: false }));
              localProbe = probeOutcome(result, STARTUP_PROBE_TIMEOUT_MS);
              up = result.up;
            } else {
              up = await deps.local!.ping().catch(() => false);
            }
            if (up) return true;
            await new Promise((r) => setTimeout(r, 600));
          }
          return false;
        })()
      : Promise.resolve(false);

  const [cloud, localApi] = await Promise.all([cloudPromise, localPromise]);
  const localGroupIds =
    localApi && deps.local?.listLocalGroupIds
      ? await deps.local.listLocalGroupIds().catch(() => [])
      : [];
  // The reason rides along whenever the answer is no: "localApi=false" on its own has been
  // read as a Zoteus bug, a Zotero bug and a firewall, and it is the one line every bug
  // report quotes.
  const why = !localApi && localProbe ? ` (${describeLocalProbe(localProbe, config.localPort)})` : '';
  deps.logger.info(
    `Capabilities: cloud=${cloud ? `user ${cloud.userID}` : 'none'}, localApi=${localApi}${why}` +
      `, localGroups=${localGroupIds.length}`,
  );
  return { cloud, localApi, localGroupIds, ...(localProbe ? { localProbe } : {}) };
}
