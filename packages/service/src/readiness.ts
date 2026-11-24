import { z } from "zod";
import { describeError, type ServiceLogger } from "./logger.js";
import type { ServiceStore } from "./stores.js";

/** One store's readiness. The cause of a failure is logged, never returned. */
const storeStatusSchema = z.object({
  status: z.enum(["ok", "failing"]),
  /** `timeout` when the check outlived the budget, `error` when it rejected. */
  reason: z.enum(["timeout", "error"]).optional(),
});

export const readinessReportSchema = z.object({
  status: z.enum(["ready", "not-ready"]),
  stores: z.record(z.string(), storeStatusSchema),
});

export type ReadinessReport = z.infer<typeof readinessReportSchema>;
type StoreStatus = z.infer<typeof storeStatusSchema>;

const TIMED_OUT = Symbol("timed out");

async function checkOne(
  name: string,
  store: ServiceStore,
  timeoutMs: number,
  logger: ServiceLogger,
): Promise<StoreStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    const outcome = await Promise.race([store.check(), timeout]);
    if (outcome === TIMED_OUT) {
      logger.warn("store-not-ready", { store: name, reason: "timeout", timeoutMs });
      return { status: "failing", reason: "timeout" };
    }
    return { status: "ok" };
  } catch (error) {
    // A store error can name a host or carry a connection string, so it goes
    // to the operator's log, and the response says only that it failed.
    logger.warn("store-not-ready", { store: name, reason: "error", ...describeError(error) });
    return { status: "failing", reason: "error" };
  } finally {
    clearTimeout(timer);
  }
}

/** Checks every store concurrently, each bounded by `timeoutMs`. */
export async function checkReadiness(
  stores: Readonly<Record<string, ServiceStore>>,
  timeoutMs: number,
  logger: ServiceLogger,
): Promise<ReadinessReport> {
  const results = await Promise.all(
    Object.entries(stores).map(
      async ([name, store]) => [name, await checkOne(name, store, timeoutMs, logger)] as const,
    ),
  );
  const report: ReadinessReport = { status: "ready", stores: {} };
  for (const [name, result] of results) {
    report.stores[name] = result;
    if (result.status === "failing") report.status = "not-ready";
  }
  return report;
}
