/**
 * @tollway/reconcile
 *
 * The safety net. For channel mode it compares the stored commitment stream
 * against the channel contract state and the on-chain settlement at close,
 * flagging drift. For x402 and MPP charge it confirms each settlement landed
 * and matches its receipt. See docs/design.md, "Reconciliation".
 */

import { NotImplementedError, type SignedReceipt } from "@tollway/core";

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

/**
 * TODO: implement deterministic reconciliation with drift detection and a
 * suppression mechanism to keep false positives low. See docs/design.md,
 * "Reconciliation".
 */
export function createReconciler(): Reconciler {
  throw new NotImplementedError("the reconciliation engine", 'docs/design.md, "Reconciliation"');
}
