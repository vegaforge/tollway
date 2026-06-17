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
  | "sequence-gap"
  | "malformed-record";

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
  /**
   * Validates a single x402 or MPP charge receipt structurally.
   * On-chain settlement confirmation requires chain access and is tracked
   * separately.
   */
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

/** Non-negative integer string as produced by the channel manager. */
const AMOUNT_RE = /^[0-9]+$/;

function parseAmount(
  value: string,
  field: string,
): { ok: true; amount: bigint } | { ok: false; drift: Drift } {
  if (!AMOUNT_RE.test(value)) {
    return {
      ok: false,
      drift: {
        kind: "malformed-record",
        detail: `${field} "${value}" is not a valid non-negative integer string`,
      },
    };
  }
  return { ok: true, amount: BigInt(value) };
}

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

      const settledResult = parseAmount(settledAmount, "settledAmount");
      if (!settledResult.ok) {
        drifts.push(settledResult.drift);
        return buildResult(channelId, drifts, suppress);
      }
      const settled = settledResult.amount;

      const remainderResult = parseAmount(returnedRemainder, "returnedRemainder");
      if (!remainderResult.ok) {
        drifts.push(remainderResult.drift);
        return buildResult(channelId, drifts, suppress);
      }
      const remainder = remainderResult.amount;

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

      const lastCumulativeResult = parseAmount(
        last.cumulativeAmount,
        `commitments[${last.sequence}].cumulativeAmount`,
      );
      if (!lastCumulativeResult.ok) {
        drifts.push(lastCumulativeResult.drift);
        return buildResult(channelId, drifts, suppress);
      }
      const lastCumulative = lastCumulativeResult.amount;

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

      // Structural validation only — on-chain settlement confirmation requires
      // chain access and is out of scope here.
      const parsed = signedReceiptSchema.safeParse(receipt);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          drifts.push({
            kind: "malformed-record",
            detail: `receipt structural error at ${issue.path.join(".")}: ${issue.message}`,
          });
        }
      }

      return buildResult(channelId, drifts, suppress);
    },
  };
}
