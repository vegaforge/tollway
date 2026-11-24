import type { PolicyTraceEntry, PolicyWindow } from "./policy-trace.js";

/**
 * The agent-side rate limit (issue #197): what is counted, over which
 * windows, and per which scope. See apps/web/src/content/docs/policy.mdx,
 * "Rate limit".
 *
 * Each tracked key (the payee address under `per-counterparty` scope, one
 * shared key under `global`) keeps a sliding log of event timestamps. The
 * log is exact: an event counts toward a window while it is at most
 * `windowSeconds` old, the same edge the one-minute limit has always used.
 *
 * Memory is bounded twice over. A key keeps at most as many timestamps as
 * the largest configured limit, because deciding "is the window full" only
 * ever needs the most recent `limit` events. And under `per-counterparty`
 * scope at most `keyLimit` keys are tracked: a key whose newest event has
 * aged out of every window is idle and is dropped first. When every
 * tracked key is still active, a new counterparty is refused rather than
 * evicting a live one, because evicting would reset that payee's count and
 * let it through: the limit fails closed.
 */

/** The validated `rateLimit` section, as `policySchema` accepts it. */
export type RateLimitPolicy = {
  requestsPerMinute?: number | undefined;
  windows?: ReadonlyArray<{ windowSeconds: number; limit: number }> | undefined;
  count?: "settlements" | "attempts" | undefined;
  scope?: "global" | "per-counterparty" | undefined;
  perCounterpartyKeyLimit?: number | undefined;
};

/** What a rate-limit event is: a recorded settlement or a submitted attempt. */
export type RateLimitCount = "settlements" | "attempts";

/** The default cap on tracked counterparties under `per-counterparty` scope. */
export const DEFAULT_PER_COUNTERPARTY_KEY_LIMIT = 1024;

const GLOBAL_KEY = "";

type ResolvedWindow = { windowSeconds: number; windowMs: number; limit: bigint };

/** One rate limit, resolved from the policy, with its in-memory log. */
export type RateLimiter = {
  readonly count: RateLimitCount;
  /** The trace entry for one intent. Reads state only. */
  evaluate(payee: string, now: number): PolicyTraceEntry;
  /** Records one event for the payee. Called by `record` or `recordAttempt`. */
  record(payee: string, now: number): void;
};

/**
 * Builds the limiter for a policy's `rateLimit` section, or `undefined` when
 * the policy sets none. The section has already passed `policySchema`, so
 * there is nothing left to refuse here.
 */
export function createRateLimiter(config: RateLimitPolicy | undefined): RateLimiter | undefined {
  if (config === undefined) return undefined;
  const windows: ResolvedWindow[] = (
    config.windows ??
    (config.requestsPerMinute === undefined
      ? []
      : [{ windowSeconds: 60, limit: config.requestsPerMinute }])
  ).map((entry) => ({
    windowSeconds: entry.windowSeconds,
    windowMs: entry.windowSeconds * 1000,
    limit: BigInt(entry.limit),
  }));
  if (windows.length === 0) return undefined;

  const scope = config.scope ?? "global";
  const count = config.count ?? "settlements";
  const keyLimit = config.perCounterpartyKeyLimit ?? DEFAULT_PER_COUNTERPARTY_KEY_LIMIT;
  const longestMs = Math.max(...windows.map((window) => window.windowMs));
  // Deciding whether any window is full needs only the newest `limit`
  // events, so the log never has to hold more than the largest limit.
  const maxLogLength = Math.max(...windows.map((window) => Number(window.limit)));
  /** Timestamps per key, oldest first. */
  const logs = new Map<string, number[]>();

  const keyFor = (payee: string): string => (scope === "global" ? GLOBAL_KEY : payee);
  const isActive = (log: readonly number[], now: number): boolean => {
    const newest = log.at(-1);
    return newest !== undefined && now - newest <= longestMs;
  };
  const countIn = (log: readonly number[], window: ResolvedWindow, now: number): bigint => {
    let inWindow = 0n;
    for (let index = log.length - 1; index >= 0; index -= 1) {
      const timestamp = log[index];
      if (timestamp === undefined || now - timestamp > window.windowMs) break;
      inWindow += 1n;
    }
    return inWindow;
  };
  const activeKeys = (now: number): number => {
    let active = 0;
    for (const log of logs.values()) if (isActive(log, now)) active += 1;
    return active;
  };

  return {
    count,

    evaluate(payee, now) {
      const base = { id: "rate-limit", rule: "rate-limit", configured: true } as const;
      const key = keyFor(payee);
      const where =
        scope === "per-counterparty"
          ? `per-counterparty rate limit for ${payee}`
          : "global rate limit";
      const log = logs.get(key) ?? [];

      // A counterparty the engine has no room to track is refused: the
      // alternative is to forget a live one, which would reset its count.
      if (scope === "per-counterparty" && !logs.has(key) && activeKeys(now) >= keyLimit) {
        const first = windows[0] as ResolvedWindow;
        return {
          ...base,
          outcome: "fail",
          limit: first.limit.toString(),
          current: "0",
          projected: "1",
          window: sliding(first),
          detail: `${where}: already tracking ${keyLimit} active counterparties, the most perCounterpartyKeyLimit allows; a new counterparty waits until one goes idle`,
        };
      }

      // Report the first full window, otherwise the one closest to full.
      let reported: ResolvedWindow | undefined;
      let reportedCount = 0n;
      let failed = false;
      for (const window of windows) {
        const inWindow = countIn(log, window, now);
        const full = inWindow + 1n > window.limit;
        if (full && !failed) {
          reported = window;
          reportedCount = inWindow;
          failed = true;
        } else if (
          !failed &&
          (reported === undefined || window.limit - inWindow < reported.limit - reportedCount)
        ) {
          reported = window;
          reportedCount = inWindow;
        }
      }
      const window = reported as ResolvedWindow;
      const projected = reportedCount + 1n;
      const what = count === "attempts" ? "attempts" : "settled payments";
      return {
        ...base,
        outcome: failed ? "fail" : "pass",
        limit: window.limit.toString(),
        current: reportedCount.toString(),
        projected: projected.toString(),
        window: sliding(window),
        detail: failed
          ? `${where} exceeded: ${reportedCount} ${what} in the last ${window.windowSeconds} seconds, limit ${window.limit}`
          : `${where}: ${projected} of ${window.limit} ${what} in the last ${window.windowSeconds} seconds`,
      };
    },

    record(payee, now) {
      const key = keyFor(payee);
      let log = logs.get(key);
      if (log === undefined) {
        if (scope === "per-counterparty" && logs.size >= keyLimit) {
          for (const [candidate, candidateLog] of logs) {
            if (!isActive(candidateLog, now)) logs.delete(candidate);
          }
          // Every tracked key is active. `evaluate` refused this
          // counterparty, so only a dry-run payment reaches here; it is
          // not tracked, and the next evaluation refuses it again.
          if (logs.size >= keyLimit) return;
        }
        log = [];
        logs.set(key, log);
      }
      log.push(now);
      // Drop what no window can see any more, then anything beyond the
      // newest `maxLogLength` events.
      while (log.length > 0 && now - (log[0] as number) > longestMs) log.shift();
      if (log.length > maxLogLength) log.splice(0, log.length - maxLogLength);
      if (log.length === 0) logs.delete(key);
    },
  };
}

function sliding(window: ResolvedWindow): PolicyWindow {
  return { kind: "sliding", seconds: window.windowSeconds };
}
