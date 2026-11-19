import { getServices } from "./lib/services";

/**
 * Builds the services when the server starts, so a bad configuration
 * (missing or malformed receipt key, a deployment without Redis) stops the
 * instance with the full list of problems instead of failing the first paid
 * request. The build also loads instrumentation; the runtime configuration
 * is not there yet, so the check is skipped then.
 */
if (process.env.NEXT_PHASE !== "phase-production-build") {
  try {
    await getServices();
  } catch (error) {
    // Next.js logs a failed register and keeps serving, which would leave an
    // instance up that answers every paid request with a 500. Stop instead.
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
