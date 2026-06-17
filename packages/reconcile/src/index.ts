/**
 * @tollway/reconcile
 *
 * The safety net. For channel mode it compares the stored commitment stream
 * against the channel contract state and the on-chain settlement at close,
 * flagging drift. For x402 and MPP charge it confirms each settlement landed
 * and matches its receipt. See docs/design.md, "Reconciliation".
 */

import { type SignedReceipt, signedReceiptSchema } from "@tollway/core";

/** One stored cumulative commitment, as the channel manager recorded it. */
export type CommitmentRecord = {
  channelId: string;
  sequence: number;
  cumulativeAmount: string;
};

/** What actually settled on chain when the channel closed. */
export type SettlementRecord = {
  channelId: string;
  settledAmount: string;
  returnedRemainder: string;
  txHash: string;
};

export type DriftKind =
  | "under-settled"
  | "over-settled"
  | "missing-commitment"
  | "unexpected-remainder"
  | "sequence-gap";

export type Drift = {
  kind: DriftKind;
  detail: string;
};

export type ReconciliationResult =
  | { ok: true; channelId: string }
  | { ok: false; channelId: string; drift: Drift[] };

export interface Reconciler {
  /** Reconciles a channel's commitment stream against its on-chain close. */
  reconcileChannel(
    commitments: CommitmentRecord[],
    settlement: SettlementRecord,
  ): Promise<ReconciliationResult>;
  /** Confirms a single x402 or MPP charge settlement matches its receipt. */
  reconcileCharge(receipt: SignedReceipt): Promise<ReconciliationResult>;
}

export type ReconcilerOptions = {
  /**
   * Optional suppression hook. Return true to suppress a detected drift item.
   * Applied after all drift is collected; if all items are suppressed, the
   * result is ok: true. Use to filter known-acceptable divergences.
   */
  suppress?: (drift: Drift, channelId: string) => boolean;
};

function buildResult(
  channelId: string,
  drifts: Drift[],
  suppress: ReconcilerOptions["suppress"],
): ReconciliationResult {
  const active = suppress ? drifts.filter((d) => !suppress(d, channelId)) : drifts;

  if (active.length === 0) return { ok: true, channelId };
  return { ok: false, channelId, drift: active };
}

export function createReconciler(options: ReconcilerOptions = {}): Reconciler {
  const { suppress } = options;

  return {
    async reconcileChannel(
      commitments: CommitmentRecord[],
      settlement: SettlementRecord,
    ): Promise<ReconciliationResult> {
      const { channelId, settledAmount, returnedRemainder } = settlement;
      const drifts: Drift[] = [];

      const settled = BigInt(settledAmount);
      const remainder = BigInt(returnedRemainder);

      // A negative returnedRemainder means the close record is malformed.
      if (remainder < 0n) {
        drifts.push({
          kind: "unexpected-remainder",
          detail: `returnedRemainder is negative (${returnedRemainder}); channel close record is malformed`,
        });
      }

      // No commitments recorded, but funds moved on-chain.
      if (commitments.length === 0) {
        if (settled > 0n) {
          drifts.push({
            kind: "missing-commitment",
            detail: `settlement settled ${settledAmount} but no commitment records found for channel ${channelId}`,
          });
        }
        return buildResult(channelId, drifts, suppress);
      }

      // Sort by sequence for deterministic processing regardless of input order.
      const sorted = [...commitments].sort((a, b) => a.sequence - b.sequence);

      // Sequences must start at 0 and be contiguous. Report only the first gap
      // so the detail stays actionable.
      for (const [i, entry] of sorted.entries()) {
        if (entry.sequence !== i) {
          drifts.push({
            kind: "sequence-gap",
            detail: `sequence gap at position ${i}: expected sequence ${i}, got ${entry.sequence}`,
          });
          break;
        }
      }

      // sorted is guaranteed non-empty: the commitments.length === 0 guard above returned early.
      const last = sorted.at(-1);
      if (last === undefined) return buildResult(channelId, drifts, suppress);
      const lastCumulative = BigInt(last.cumulativeAmount);

      if (settled < lastCumulative) {
        drifts.push({
          kind: "under-settled",
          detail: `channel settled ${settledAmount} but last commitment was ${last.cumulativeAmount} (sequence ${last.sequence}); shortfall: ${String(lastCumulative - settled)}`,
        });
      } else if (settled > lastCumulative) {
        drifts.push({
          kind: "over-settled",
          detail: `channel settled ${settledAmount} but last commitment was only ${last.cumulativeAmount} (sequence ${last.sequence}); excess: ${String(settled - lastCumulative)}`,
        });
      }

      // settled + remainder = 0 with positive commitments means all channel
      // funds are unaccounted for.
      if (settled + remainder === 0n && lastCumulative > 0n) {
        drifts.push({
          kind: "unexpected-remainder",
          detail: `settled (${settledAmount}) + returnedRemainder (${returnedRemainder}) is zero but commitments totalled ${last.cumulativeAmount}; channel funds appear lost`,
        });
      }

      return buildResult(channelId, drifts, suppress);
    },

    async reconcileCharge(receipt: SignedReceipt): Promise<ReconciliationResult> {
      const ref = receipt.receipt.settlement;
      const channelId = ref.kind === "channel-commitment" ? ref.channelId : ref.txHash;

      const drifts: Drift[] = [];

      // Full structural parse catches model/settlement-kind mismatch, amount
      // format errors, missing required fields, and other cross-field invariants.
      const parsed = signedReceiptSchema.safeParse(receipt);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          drifts.push({
            kind: "missing-commitment",
            detail: `receipt structural error at ${issue.path.join(".")}: ${issue.message}`,
          });
        }
        return buildResult(channelId, drifts, suppress);
      }

      const amount = BigInt(receipt.receipt.amount);
      if (amount <= 0n) {
        drifts.push({
          kind: "under-settled",
          detail: `receipt amount must be positive, got ${receipt.receipt.amount}`,
        });
      }

      return buildResult(channelId, drifts, suppress);
    },
  };
}
