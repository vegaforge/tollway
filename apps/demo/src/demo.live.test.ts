import { describe, expect, it } from "vitest";
import { runDemo } from "./demo.js";

/**
 * Opt-in: pays real testnet USDC through OpenZeppelin Channels. Skipped
 * unless enabled, because it needs funded accounts and an API key. Run with:
 *
 *   TOLLWAY_DEMO_LIVE=true OZ_API_KEY=... STELLAR_RECIPIENT=G... \
 *     STELLAR_SECRET_KEY=S... pnpm --filter @tollway/demo test
 *
 * Both accounts need a USDC trustline and the payer needs testnet USDC.
 */
const RUN = process.env.TOLLWAY_DEMO_LIVE === "true";

describe.skipIf(!RUN)("runDemo against the testnet facilitator (live)", () => {
  it("settles a real payment and returns a verifiable receipt", async () => {
    const result = await runDemo();

    expect(result.mock).toBe(false);
    expect(result.receiptValid).toBe(true);
    expect(result.receipt.receipt.settlement.kind).toBe("transaction");
  }, 60_000);
});
