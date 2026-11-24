/**
 * @vegaforge/tollway-reconcile
 *
 * The safety net. For channel mode it compares the stored commitment stream
 * against the channel contract state and the on-chain settlement at close,
 * flagging drift. For x402 and MPP charge it confirms each settlement landed
 * and matches its receipt. See docs/design.md, "Reconciliation".
 */

import {
  type SignedReceipt,
  type StellarNetwork,
  signedReceiptSchema,
} from "@vegaforge/tollway-core";
import {
  type ChainReader,
  type ChannelStateReader,
  chainTransactionSchema,
  describeReadFailure,
  describeSchemaFailure,
  onChainChannelStateSchema,
} from "./chain.js";
import { type ChargeDriftKind, confirmCharge } from "./charge.js";
import {
  type OpenChannelDriftKind,
  type OpenChannelSnapshot,
  reconcileOpenChannel,
} from "./open-channel.js";

export {
  type AlertDeliveryReport,
  type AlertEmitter,
  type AlertEventInput,
  createDriftAlertBridge,
  createMemoryDriftAlertStore,
  type DriftAlertBridge,
  type DriftAlertBridgeOptions,
  type DriftAlertPayload,
  type DriftAlertRunSummary,
  type DriftAlertStore,
} from "./alerts.js";
export {
  type ChainReader,
  type ChainTransaction,
  type ChainTransfer,
  type ChannelStateReader,
  chainTransactionSchema,
  chainTransferSchema,
  type OnChainChannelState,
  onChainChannelStateSchema,
  STELLAR_NETWORK_PASSPHRASE,
} from "./chain.js";
export {
  type ChargeConfirmation,
  type ChargeDrift,
  type ChargeDriftKind,
  type ChargeReceipt,
  confirmCharge,
} from "./charge.js";
export {
  type OpenChannelDrift,
  type OpenChannelDriftKind,
  type OpenChannelSnapshot,
  reconcileOpenChannel,
} from "./open-channel.js";
export {
  type BuildReconciliationReportOptions,
  buildReconciliationReport,
  type CsvReportOptions,
  DEFAULT_DRIFT_SEVERITY,
  type DriftSeverity,
  type ExportReportFormat,
  exportReconciliationReport,
  RECONCILIATION_CSV_COLUMNS,
  RECONCILIATION_REPORT_VERSION,
  type ReconciliationAmounts,
  type ReconciliationReport,
  type ReconciliationReportEntry,
  type ReconciliationReportInput,
  type ReconciliationReportTotals,
  type ReportRange,
  reconciliationReportToCsv,
  reconciliationReportToJson,
  resolveDriftSeverity,
} from "./report.js";

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

export type ChannelDriftKind =
  | "under-settled"
  | "over-settled"
  | "missing-commitment"
  | "unexpected-remainder"
  | "sequence-gap"
  | "malformed-record"
  /** A cumulative amount is lower than one at an earlier sequence. */
  | "non-monotonic-cumulative"
  /** A commitment names a different channel than the settlement. */
  | "foreign-commitment"
  /** Two or more commitments share one sequence. */
  | "duplicate-sequence";

export type DriftKind = ChannelDriftKind | ChargeDriftKind | OpenChannelDriftKind;

export type Drift = {
  kind: DriftKind;
  detail: string;
};

/** What a reconciliation result is about: a channel, or a settlement transaction. */
export type ReconciliationSubject =
  | { kind: "channel"; channelId: string }
  | { kind: "transaction"; txHash: string; network: StellarNetwork };

/**
 * The outcome of one reconciliation.
 *
 * - `ok`: checked and consistent.
 * - `drift`: checked, and the records disagree with each other or the chain.
 * - `unverifiable`: the chain no longer has the data, so it can neither
 *   confirm nor contradict the record. Not drift.
 * - `retryable`: the check could not run this time (an RPC error, a malformed
 *   RPC response, a server that has not caught up). Run it again later.
 *   Never ok, never drift.
 *
 * `ok` is `true` only for the `ok` status, so `if (result.ok)` still reads as
 * "confirmed clean". Narrow on `status` before reading `drift`.
 */
export type ReconciliationResult =
  | { status: "ok"; ok: true; subject: ReconciliationSubject }
  | { status: "drift"; ok: false; subject: ReconciliationSubject; drift: Drift[] }
  | { status: "unverifiable"; ok: false; subject: ReconciliationSubject; reason: string }
  | { status: "retryable"; ok: false; subject: ReconciliationSubject; reason: string };

/**
 * A stable string for a subject: the channel id or the transaction hash.
 * Reports, alerts and quarantine keys use it.
 */
export function reconciliationSubjectId(subject: ReconciliationSubject): string {
  return subject.kind === "channel" ? subject.channelId : subject.txHash;
}

export interface Reconciler {
  /** Reconciles a channel's commitment stream against its on-chain close. */
  reconcileChannel(
    commitments: CommitmentRecord[],
    settlement: SettlementRecord,
  ): Promise<ReconciliationResult>;
  /**
   * Validates an x402 or MPP charge receipt's structure and, when a
   * `ChainReader` is configured, confirms its settlement transaction on chain
   * (#211). Without a reader only the structure is checked.
   */
  reconcileCharge(receipt: SignedReceipt): Promise<ReconciliationResult>;
  /**
   * Reads an open channel's contract state through the configured
   * `ChannelStateReader` and compares it with the snapshot (#212). Throws a
   * `TypeError` when no reader is configured.
   */
  checkOpenChannel(snapshot: OpenChannelSnapshot): Promise<ReconciliationResult>;
}

export type ReconcilerOptions = {
  /**
   * Optional suppression hook. Return true to suppress a detected drift item.
   * Applied after all drift is collected; if all items are suppressed, the
   * result is ok. Use to filter known-acceptable divergences.
   */
  suppress?: (drift: Drift, subject: ReconciliationSubject) => boolean;
  /**
   * Reads settlement transactions for charge confirmation (#211). The
   * Stellar implementation is `createStellarChainReader` from
   * `@vegaforge/tollway-reconcile/stellar`.
   */
  chain?: ChainReader;
  /**
   * Reads channel contract state for live channel checks (#212). The Stellar
   * implementation is `createStellarChannelStateReader` from
   * `@vegaforge/tollway-reconcile/stellar`.
   */
  channels?: ChannelStateReader;
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
  subject: ReconciliationSubject,
  drifts: readonly Drift[],
  suppress: ReconcilerOptions["suppress"],
): ReconciliationResult {
  const active = suppress ? drifts.filter((d) => !suppress(d, subject)) : [...drifts];

  if (active.length === 0) return { status: "ok", ok: true, subject };
  return { status: "drift", ok: false, subject, drift: active };
}

export function createReconciler(options: ReconcilerOptions = {}): Reconciler {
  const { suppress } = options;

  return {
    async reconcileChannel(
      commitments: CommitmentRecord[],
      settlement: SettlementRecord,
    ): Promise<ReconciliationResult> {
      const { channelId, settledAmount, returnedRemainder } = settlement;
      const subject: ReconciliationSubject = { kind: "channel", channelId };
      const drifts: Drift[] = [];

      const settledResult = parseAmount(settledAmount, "settledAmount");
      if (!settledResult.ok) {
        drifts.push(settledResult.drift);
        return buildResult(subject, drifts, suppress);
      }
      const settled = settledResult.amount;

      const remainderResult = parseAmount(returnedRemainder, "returnedRemainder");
      if (!remainderResult.ok) {
        drifts.push(remainderResult.drift);
        return buildResult(subject, drifts, suppress);
      }
      const remainder = remainderResult.amount;

      // A commitment for another channel can neither cause nor hide drift
      // here, so it is reported and left out of every amount check.
      const own: CommitmentRecord[] = [];
      for (const commitment of commitments) {
        if (commitment.channelId === channelId) {
          own.push(commitment);
        } else {
          drifts.push({
            kind: "foreign-commitment",
            detail: `commitment at sequence ${commitment.sequence} belongs to channel ${commitment.channelId}, not ${channelId}; excluded from the amount checks`,
          });
        }
      }

      // No commitments recorded, but funds moved on-chain.
      if (own.length === 0) {
        if (settled > 0n) {
          drifts.push({
            kind: "missing-commitment",
            detail: `settlement settled ${settledAmount} but no commitment records found for channel ${channelId}`,
          });
        }
        return buildResult(subject, drifts, suppress);
      }

      // The highest amount committed at each sequence. Where duplicates
      // disagree, the higher one counts, so ambiguity can only add drift.
      const bySequence = new Map<number, { amount: bigint; count: number }>();
      for (const entry of own) {
        const parsedAmount = parseAmount(
          entry.cumulativeAmount,
          `commitments[${entry.sequence}].cumulativeAmount`,
        );
        if (!parsedAmount.ok) {
          drifts.push(parsedAmount.drift);
          return buildResult(subject, drifts, suppress);
        }
        const seen = bySequence.get(entry.sequence);
        bySequence.set(entry.sequence, {
          amount: seen && seen.amount > parsedAmount.amount ? seen.amount : parsedAmount.amount,
          count: (seen?.count ?? 0) + 1,
        });
      }
      const sequences = [...bySequence.keys()].sort((a, b) => a - b);

      for (const sequence of sequences) {
        const seen = bySequence.get(sequence);
        if (seen && seen.count > 1) {
          drifts.push({
            kind: "duplicate-sequence",
            detail: `sequence ${sequence} appears ${seen.count} times; the highest amount, ${seen.amount}, is used for the settlement check`,
          });
        }
      }

      // Sequences must start at 0 and be contiguous. Report only the first gap
      // so the detail stays actionable.
      for (const [i, sequence] of sequences.entries()) {
        if (sequence !== i) {
          drifts.push({
            kind: "sequence-gap",
            detail: `sequence gap at position ${i}: expected sequence ${i}, got ${sequence}`,
          });
          break;
        }
      }

      // Cumulative amounts never go down. A decrease is what a rolled back or
      // tampered store looks like. Report the first one. The expected
      // settlement is the most that was ever committed, at whichever sequence.
      let previous: { sequence: number; amount: bigint } | undefined;
      let highest = { sequence: sequences[0] ?? 0, amount: 0n };
      let reportedDecrease = false;
      for (const sequence of sequences) {
        const amount = bySequence.get(sequence)?.amount ?? 0n;
        if (previous && amount < previous.amount && !reportedDecrease) {
          drifts.push({
            kind: "non-monotonic-cumulative",
            detail: `cumulative amount fell from ${previous.amount} at sequence ${previous.sequence} to ${amount} at sequence ${sequence}`,
          });
          reportedDecrease = true;
        }
        if (amount > highest.amount) highest = { sequence, amount };
        previous = { sequence, amount };
      }

      const expected = highest.amount;
      const expectedText = expected.toString();

      if (settled < expected) {
        drifts.push({
          kind: "under-settled",
          detail: `channel settled ${settledAmount} but last commitment was ${expectedText} (sequence ${highest.sequence}); shortfall: ${String(expected - settled)}`,
        });
      } else if (settled > expected) {
        drifts.push({
          kind: "over-settled",
          detail: `channel settled ${settledAmount} but last commitment was only ${expectedText} (sequence ${highest.sequence}); excess: ${String(settled - expected)}`,
        });
      }

      // settled + remainder = 0 with positive commitments means all channel
      // funds are unaccounted for.
      if (settled + remainder === 0n && expected > 0n) {
        drifts.push({
          kind: "unexpected-remainder",
          detail: `settled (${settledAmount}) + returnedRemainder (${returnedRemainder}) is zero but commitments totalled ${expectedText}; channel funds appear lost`,
        });
      }

      return buildResult(subject, drifts, suppress);
    },

    async reconcileCharge(receipt: SignedReceipt): Promise<ReconciliationResult> {
      // The subject comes from the input before it is validated, so even a
      // malformed receipt is reported against the reference it carries.
      const ref = receipt.receipt.settlement;
      const subject: ReconciliationSubject =
        ref.kind === "channel-commitment"
          ? { kind: "channel", channelId: ref.channelId }
          : { kind: "transaction", txHash: ref.txHash, network: receipt.receipt.network };

      const parsed = signedReceiptSchema.safeParse(receipt);
      if (!parsed.success) {
        const drifts: Drift[] = parsed.error.issues.map((issue) => ({
          kind: "malformed-record",
          detail: `receipt structural error at ${issue.path.join(".")}: ${issue.message}`,
        }));
        return buildResult(subject, drifts, suppress);
      }

      const body = parsed.data.receipt;
      // A channel receipt settles through the channel, which reconcileChannel
      // and checkOpenChannel cover; without a reader there is no chain check.
      if (body.settlement.kind !== "transaction" || !options.chain) {
        return buildResult(subject, [], suppress);
      }
      const txHash = body.settlement.txHash;

      let assetContract: string;
      try {
        assetContract = options.chain.assetContractId(body.asset, body.network);
      } catch (error) {
        return buildResult(
          subject,
          [
            {
              kind: "malformed-record",
              detail: `receipt asset "${body.asset}" has no token contract on ${body.network}: ${describeReadFailure(error)}`,
            },
          ],
          suppress,
        );
      }

      let raw: unknown;
      try {
        raw = await options.chain.getTransaction(txHash, body.network);
      } catch (error) {
        return {
          status: "retryable",
          ok: false,
          subject,
          reason: `could not read transaction ${txHash}: ${describeReadFailure(error)}`,
        };
      }
      const tx = chainTransactionSchema.safeParse(raw);
      if (!tx.success) {
        return {
          status: "retryable",
          ok: false,
          subject,
          reason: `the chain reader returned a malformed transaction for ${txHash}: ${describeSchemaFailure(tx.error)}`,
        };
      }

      const confirmation = confirmCharge({ ...body, txHash }, tx.data, assetContract);
      switch (confirmation.status) {
        case "confirmed":
          return buildResult(subject, [], suppress);
        case "drift":
          return buildResult(subject, confirmation.drift, suppress);
        case "unverifiable":
          return { status: "unverifiable", ok: false, subject, reason: confirmation.reason };
        case "retryable":
          return { status: "retryable", ok: false, subject, reason: confirmation.reason };
      }
    },

    async checkOpenChannel(snapshot: OpenChannelSnapshot): Promise<ReconciliationResult> {
      if (!options.channels) {
        throw new TypeError(
          "checkOpenChannel needs a ChannelStateReader: pass `channels` to createReconciler",
        );
      }
      const subject: ReconciliationSubject = { kind: "channel", channelId: snapshot.channelId };

      let raw: unknown;
      try {
        raw = await options.channels.getChannelState(snapshot.channelId, snapshot.network);
      } catch (error) {
        return {
          status: "retryable",
          ok: false,
          subject,
          reason: `could not read channel ${snapshot.channelId}: ${describeReadFailure(error)}`,
        };
      }
      const state = onChainChannelStateSchema.safeParse(raw);
      if (!state.success) {
        return {
          status: "retryable",
          ok: false,
          subject,
          reason: `the channel reader returned a malformed state for ${snapshot.channelId}: ${describeSchemaFailure(state.error)}`,
        };
      }

      return buildResult(subject, reconcileOpenChannel(snapshot, state.data), suppress);
    },
  };
}

export {
  createQuarantineEnforcer,
  DEFAULT_DRIFT_ACTIONS,
  type DriftAction,
  type DriftQuarantineEvent,
  type DriftWarnEvent,
  type ProcessedDriftAction,
  type ProcessReconciliationInput,
  type ProcessReconciliationOutput,
  type QuarantineEnforcerOptions,
  type ReconciliationQuarantineEnforcer,
} from "./quarantine.js";
