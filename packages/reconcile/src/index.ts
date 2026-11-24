/**
 * @vegaforge/tollway-reconcile
 *
 * The safety net. For channel mode it compares the stored commitment stream
 * against the channel contract state and the on-chain settlement at close,
 * flagging drift. For x402 and MPP charge it confirms each settlement landed
 * and matches its receipt. See docs/design.md, "Reconciliation".
 */

import { rpc as stellarRpc } from "@stellar/stellar-sdk";
import { type SignedReceipt, type StellarNetwork, signedReceiptSchema } from "@vegaforge/tollway-core";
import { type ChargeDriftKind, type ChargeRpcSource, confirmChargeOnChain } from "./charge.js";
import {
  checkOpenChannelDrift,
  type OpenChannelDriftKind,
  type OpenChannelRecord,
  type ReconcileOpenChannelOptions,
} from "./open-channel.js";

export {
  type ChargeDrift,
  type ChargeDriftKind,
  type ChargeRpcSource,
  confirmChargeOnChain,
  NETWORK_PASSPHRASE,
  resolveAssetContractId,
} from "./charge.js";
export {
  type ChannelStateReader,
  type ChannelWatchEvent,
  checkOpenChannelDrift,
  MPP_NETWORK_ID,
  type MppNetworkId,
  type OnChainChannelState,
  type OpenChannelDriftKind,
  type OpenChannelRecord,
  type ReconcileOpenChannelOptions,
  startOpenChannelWatcher,
  type WatchOpenChannelOptions,
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
   * Reconciles a live open channel's commitment stream and local record
   * against its current on-chain contract state (#212).
   */
  reconcileOpenChannel(
    channel: OpenChannelRecord,
    commitments: CommitmentRecord[],
    options?: ReconcileOpenChannelOptions,
  ): Promise<ReconciliationResult>;
  /**
   * Validates an x402 or MPP charge receipt structurally and, when an RPC
   * source or URL is configured, confirms the settlement transaction on chain
   * via Soroban RPC `getTransaction` (#211).
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
  /**
   * Soroban RPC source(s) for on-chain charge confirmation (#211). Pass a
   * single `ChargeRpcSource` or a per-network map.
   */
  rpc?: ChargeRpcSource | Partial<Record<StellarNetwork, ChargeRpcSource>>;
  /** Soroban RPC URL(s) used to construct `rpc.Server` when `rpc` is omitted. */
  rpcUrl?: string | Partial<Record<StellarNetwork, string>>;
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

function resolveRpcSource(
  options: ReconcilerOptions,
  network: StellarNetwork,
): ChargeRpcSource | undefined {
  if (options.rpc) {
    if ("getTransaction" in options.rpc) {
      return options.rpc;
    }
    const perNet = options.rpc[network];
    if (perNet) return perNet;
  }
  if (options.rpcUrl) {
    const url = typeof options.rpcUrl === "string" ? options.rpcUrl : options.rpcUrl[network];
    if (url) {
      return new stellarRpc.Server(url);
    }
  }
  return undefined;
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
        return buildResult(channelId, drifts, suppress);
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
          return buildResult(channelId, drifts, suppress);
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

      return buildResult(channelId, drifts, suppress);
    },

    async reconcileOpenChannel(
      channel: OpenChannelRecord,
      commitments: CommitmentRecord[],
      openOptions?: ReconcileOpenChannelOptions,
    ): Promise<ReconciliationResult> {
      const mergedOptions: ReconcileOpenChannelOptions = {
        ...openOptions,
        ...(openOptions?.rpcUrl === undefined && typeof options.rpcUrl === "string"
          ? { rpcUrl: options.rpcUrl }
          : openOptions?.rpcUrl === undefined &&
              typeof options.rpcUrl === "object" &&
              options.rpcUrl[channel.network] !== undefined
            ? { rpcUrl: options.rpcUrl[channel.network] }
            : {}),
      };
      const drifts = await checkOpenChannelDrift(channel, commitments, mergedOptions);
      return buildResult(channel.id, drifts, suppress);
    },

    async reconcileCharge(receipt: SignedReceipt): Promise<ReconciliationResult> {
      const ref = receipt.receipt.settlement;
      const channelId = ref.kind === "channel-commitment" ? ref.channelId : ref.txHash;

      const drifts: Drift[] = [];

      const parsed = signedReceiptSchema.safeParse(receipt);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          drifts.push({
            kind: "malformed-record",
            detail: `receipt structural error at ${issue.path.join(".")}: ${issue.message}`,
          });
        }
        return buildResult(channelId, drifts, suppress);
      }

      const rpcSource = resolveRpcSource(options, parsed.data.receipt.network);
      if (rpcSource && parsed.data.receipt.settlement.kind === "transaction") {
        const chainDrifts = await confirmChargeOnChain(parsed.data, rpcSource);
        drifts.push(...chainDrifts);
      }

      return buildResult(channelId, drifts, suppress);
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
