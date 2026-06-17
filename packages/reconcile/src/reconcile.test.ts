import type { SignedReceipt } from "@tollway/core";
import { describe, expect, it } from "vitest";
import { type CommitmentRecord, createReconciler, type SettlementRecord } from "./index.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function mkCommitment(sequence: number, cumulativeAmount: string): CommitmentRecord {
  return { channelId: "ch-1", sequence, cumulativeAmount };
}

function mkSettlement(settledAmount: string, returnedRemainder = "0"): SettlementRecord {
  return {
    channelId: "ch-1",
    settledAmount,
    returnedRemainder,
    txHash: "0xabc",
  };
}

function mkReceipt(
  overrides: Partial<{
    model: "x402" | "mpp-charge" | "mpp-channel";
    settlementKind: "transaction" | "channel-commitment";
    amount: string;
    txHash: string;
    channelId: string;
    sequence: number;
  }>,
): SignedReceipt {
  const model = overrides.model ?? "x402";
  const settlementKind = overrides.settlementKind ?? "transaction";
  const settlement =
    settlementKind === "transaction"
      ? { kind: "transaction" as const, txHash: overrides.txHash ?? "0xdeadbeef" }
      : {
          kind: "channel-commitment" as const,
          channelId: overrides.channelId ?? "ch-1",
          sequence: overrides.sequence ?? 0,
        };

  return {
    receipt: {
      version: 1,
      id: "receipt-001",
      payer: "GPAYER",
      payee: "GPAYEE",
      amount: overrides.amount ?? "100",
      asset: "USDC",
      resource: "https://api.example.com/resource",
      model,
      settlement,
      network: "testnet",
      issuedAt: "2026-01-01T00:00:00Z",
    },
    signature: {
      keyId: "key-1",
      algorithm: "ed25519",
      value: "c2lnbmF0dXJl",
    },
  };
}

const reconciler = createReconciler();

// ── reconcileChannel ──────────────────────────────────────────────────────────

describe("reconcileChannel", () => {
  describe("ok path", () => {
    it("returns ok when settled amount equals last commitment", async () => {
      const commitments = [mkCommitment(0, "100"), mkCommitment(1, "200"), mkCommitment(2, "300")];
      const result = await reconciler.reconcileChannel(commitments, mkSettlement("300", "700"));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.channelId).toBe("ch-1");
    });

    it("returns ok for a single commitment that matches settlement", async () => {
      const result = await reconciler.reconcileChannel([mkCommitment(0, "50")], mkSettlement("50"));
      expect(result.ok).toBe(true);
    });

    it("processes commitments in deterministic order regardless of input order", async () => {
      const shuffled = [mkCommitment(2, "300"), mkCommitment(0, "100"), mkCommitment(1, "200")];
      const result = await reconciler.reconcileChannel(shuffled, mkSettlement("300"));
      expect(result.ok).toBe(true);
    });
  });

  describe("missing-commitment", () => {
    it("flags when no commitments recorded but funds settled", async () => {
      const result = await reconciler.reconcileChannel([], mkSettlement("500"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.drift).toHaveLength(1);
        expect(result.drift[0]?.kind).toBe("missing-commitment");
      }
    });

    it("returns ok for empty commitments and zero settlement", async () => {
      const result = await reconciler.reconcileChannel([], mkSettlement("0"));
      expect(result.ok).toBe(true);
    });
  });

  describe("under-settled", () => {
    it("flags when settled amount is less than last commitment", async () => {
      const result = await reconciler.reconcileChannel(
        [mkCommitment(0, "100"), mkCommitment(1, "250")],
        mkSettlement("200"),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const drift = result.drift.find((d) => d.kind === "under-settled");
        expect(drift).toBeDefined();
        expect(drift?.detail).toContain("shortfall: 50");
      }
    });
  });

  describe("over-settled", () => {
    it("flags when settled amount exceeds last commitment", async () => {
      const result = await reconciler.reconcileChannel(
        [mkCommitment(0, "100")],
        mkSettlement("150"),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const drift = result.drift.find((d) => d.kind === "over-settled");
        expect(drift).toBeDefined();
        expect(drift?.detail).toContain("excess: 50");
      }
    });
  });

  describe("sequence-gap", () => {
    it("flags a gap in the commitment sequence", async () => {
      const commitments = [
        mkCommitment(0, "100"),
        mkCommitment(1, "200"),
        mkCommitment(3, "400"), // sequence 2 is missing
      ];
      const result = await reconciler.reconcileChannel(commitments, mkSettlement("400"));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const drift = result.drift.find((d) => d.kind === "sequence-gap");
        expect(drift).toBeDefined();
        expect(drift?.detail).toContain("expected sequence 2");
      }
    });

    it("flags when the sequence does not start at 0", async () => {
      const result = await reconciler.reconcileChannel(
        [mkCommitment(1, "100")],
        mkSettlement("100"),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const drift = result.drift.find((d) => d.kind === "sequence-gap");
        expect(drift?.detail).toContain("expected sequence 0");
      }
    });

    it("reports only the first gap for a multi-gap stream", async () => {
      const result = await reconciler.reconcileChannel(
        [mkCommitment(0, "100"), mkCommitment(2, "200"), mkCommitment(5, "300")],
        mkSettlement("300"),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const gaps = result.drift.filter((d) => d.kind === "sequence-gap");
        expect(gaps).toHaveLength(1);
        expect(gaps[0]?.detail).toContain("expected sequence 1");
      }
    });
  });

  describe("unexpected-remainder", () => {
    it("flags a negative returnedRemainder", async () => {
      const settlement: SettlementRecord = {
        channelId: "ch-1",
        settledAmount: "100",
        returnedRemainder: "-50",
        txHash: "0xabc",
      };
      const result = await reconciler.reconcileChannel([mkCommitment(0, "100")], settlement);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.drift.some((d) => d.kind === "unexpected-remainder")).toBe(true);
      }
    });

    it("flags when settled + remainder is 0 but commitments exist", async () => {
      const settlement: SettlementRecord = {
        channelId: "ch-1",
        settledAmount: "0",
        returnedRemainder: "0",
        txHash: "0xabc",
      };
      const result = await reconciler.reconcileChannel([mkCommitment(0, "300")], settlement);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.drift.some((d) => d.kind === "unexpected-remainder")).toBe(true);
      }
    });
  });

  describe("suppression hook", () => {
    it("suppresses matching drift kinds and returns ok when all drifts suppressed", async () => {
      const withSuppression = createReconciler({
        suppress: (drift) => drift.kind === "under-settled",
      });
      const result = await withSuppression.reconcileChannel(
        [mkCommitment(0, "300")],
        mkSettlement("200"),
      );
      expect(result.ok).toBe(true);
    });

    it("only suppresses matching items, leaves others", async () => {
      const withSuppression = createReconciler({
        suppress: (drift) => drift.kind === "under-settled",
      });
      // sequence gap + under-settled — suppress only under-settled
      const result = await withSuppression.reconcileChannel(
        [mkCommitment(0, "100"), mkCommitment(2, "300")],
        mkSettlement("200"),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.drift.some((d) => d.kind === "sequence-gap")).toBe(true);
        expect(result.drift.some((d) => d.kind === "under-settled")).toBe(false);
      }
    });

    it("passes channelId to suppressor", async () => {
      const seen: string[] = [];
      const withSuppression = createReconciler({
        suppress: (_drift, channelId) => {
          seen.push(channelId);
          return false;
        },
      });
      await withSuppression.reconcileChannel([mkCommitment(0, "100")], mkSettlement("50"));
      expect(seen).toContain("ch-1");
    });
  });
});

// ── reconcileCharge ───────────────────────────────────────────────────────────

describe("reconcileCharge", () => {
  it("returns ok for a structurally valid x402 receipt", async () => {
    const result = await reconciler.reconcileCharge(mkReceipt({ model: "x402", amount: "100" }));
    expect(result.ok).toBe(true);
  });

  it("returns ok for a valid mpp-charge receipt", async () => {
    const result = await reconciler.reconcileCharge(
      mkReceipt({ model: "mpp-charge", amount: "500" }),
    );
    expect(result.ok).toBe(true);
  });

  it("returns ok for a valid mpp-channel receipt with channel-commitment settlement", async () => {
    const result = await reconciler.reconcileCharge(
      mkReceipt({ model: "mpp-channel", settlementKind: "channel-commitment", amount: "200" }),
    );
    expect(result.ok).toBe(true);
  });

  it("flags a model/settlement-kind mismatch as missing-commitment", async () => {
    // x402 with channel-commitment is invalid
    const bad = mkReceipt({ model: "x402", settlementKind: "channel-commitment" });
    const result = await reconciler.reconcileCharge(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.drift.some((d) => d.kind === "missing-commitment")).toBe(true);
    }
  });

  it("flags zero amount as under-settled", async () => {
    const bad = mkReceipt({ amount: "0" });
    const result = await reconciler.reconcileCharge(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.drift.some((d) => d.kind === "under-settled")).toBe(true);
    }
  });

  it("uses txHash as channelId for transaction-settled receipts", async () => {
    const txHash = "0xfeedcafe";
    const result = await reconciler.reconcileCharge(mkReceipt({ txHash }));
    expect(result.channelId).toBe(txHash);
  });

  it("uses channelId for channel-commitment receipts", async () => {
    const result = await reconciler.reconcileCharge(
      mkReceipt({
        model: "mpp-channel",
        settlementKind: "channel-commitment",
        channelId: "ch-target",
      }),
    );
    expect(result.channelId).toBe("ch-target");
  });
});
