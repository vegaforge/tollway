import { describe, expect, it } from "vitest";

import type { OpenChannelRow } from "./open-channels";
import {
  failureRateBasisPoints,
  fetchOverview,
  RECENT_RECEIPT_COUNT,
  remainingByAsset,
} from "./overview";

describe("fetchOverview", () => {
  it("counts only settled payments toward spend, and keeps each asset apart", async () => {
    const { spend } = await fetchOverview();

    // USDC settled: 1,200,000 + 120,000 + 7,500,000 + 85,000,000 + 41,000,000.
    // The failed and skipped USDC payments are left out.
    expect(spend.byAsset).toEqual({ USDC: "134820000", XLM: "42500000" });
  });

  it("counts every outcome, so the failure rate has its denominator", async () => {
    const { spend } = await fetchOverview();

    expect(spend.count).toBe(11);
    expect(spend.byOutcome).toEqual({ settled: 7, failed: 3, skipped: 1 });
  });

  it("reports spend per model and asset, with a zero entry for a model that did not spend", async () => {
    const { spend } = await fetchOverview();

    expect(spend.byModelAsset).toContainEqual(
      expect.objectContaining({ model: "mpp-channel", asset: "USDC", amount: "126000000" }),
    );
    expect(
      spend.byModelAsset.some((row) => row.model === "mpp-channel" && row.asset === "XLM"),
    ).toBe(false);
  });

  it("lists the newest receipts first, at most the strip's count", async () => {
    const { recentReceipts } = await fetchOverview();
    const issued = recentReceipts.map((row) => row.receipt.issuedAt);

    expect(recentReceipts.length).toBeLessThanOrEqual(RECENT_RECEIPT_COUNT);
    expect(issued).toEqual([...issued].sort((a, b) => b.localeCompare(a)));
    expect(recentReceipts[0]?.receipt.id).toBe("rcpt-x402-v2-stripe-02");
  });

  it("keeps only open channels' remaining budget", async () => {
    const { channels } = await fetchOverview();

    // Open: stripe (5,000 - 1,250) and anthropic (10,000 - 8,600), in 7-decimal units.
    // The closing and recovering channels are not counted.
    expect(remainingByAsset(channels)).toEqual([{ asset: "USDC", amount: "5150000000" }]);
  });
});

describe("failureRateBasisPoints", () => {
  it("is failed over attempted, where attempted is settled plus failed", () => {
    expect(failureRateBasisPoints({ settled: 7, failed: 3, skipped: 1 })).toBe(3000n);
  });

  it("is null when nothing was attempted, so the page does not show 0% or NaN", () => {
    expect(failureRateBasisPoints({ settled: 0, failed: 0, skipped: 4 })).toBeNull();
  });
});

describe("remainingByAsset", () => {
  it("sums remaining budget per asset without adding across assets", () => {
    const row = (asset: string, deposit: string, committed: string): OpenChannelRow => ({
      id: `${asset}-${deposit}`,
      counterparty: "G",
      deposit,
      committed,
      sequence: 0,
      status: "open",
      asset,
    });

    expect(
      remainingByAsset([row("USDC", "100", "40"), row("XLM", "50", "0"), row("USDC", "10", "1")]),
    ).toEqual([
      { asset: "USDC", amount: "69" },
      { asset: "XLM", amount: "50" },
    ]);
  });
});
