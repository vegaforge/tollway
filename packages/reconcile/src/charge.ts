/**
 * On-chain confirmation of x402 and MPP charge receipts (#211).
 *
 * docs/design.md, "Reconciliation": for x402 and MPP charge, confirm each
 * settlement landed on chain and matches its receipt. This module is the
 * comparison only. It takes a transaction already read and parsed into the
 * Tollway shape in chain.ts, so it needs no SDK and no network.
 *
 * What a match means: the transaction succeeded on the receipt's network and
 * carries a SEP-41 `transfer` event, emitted by the receipt asset's token
 * contract, moving exactly `receipt.amount` from `receipt.payer` to
 * `receipt.payee`. The transaction's source account is never compared to the
 * payer: on the x402 exact scheme the facilitator submits, and may sponsor
 * the fee with a fee-bump, so the payer shows up in the transfer event, not
 * as the source.
 */

import type { ReceiptBody } from "@vegaforge/tollway-core";
import { type ChainTransaction, type ChainTransfer, STELLAR_NETWORK_PASSPHRASE } from "./chain.js";

export type ChargeDriftKind =
  /** The transaction is on chain but failed. */
  | "tx-failed"
  /** The transaction should be inside the RPC retention window but is not there. */
  | "tx-not-found"
  /** The transaction succeeded but moved no SEP-41 token at all. */
  | "transfer-missing"
  | "amount-mismatch"
  | "payee-mismatch"
  | "payer-mismatch"
  /** The closest transfer was emitted by a different token contract. */
  | "asset-mismatch"
  /** The RPC server is on a different network than the receipt names. */
  | "network-mismatch";

export type ChargeDrift = { kind: ChargeDriftKind; detail: string };

/**
 * What the chain says about one charge receipt. `unverifiable` is not drift:
 * the transaction is older than the RPC server keeps, so the chain can neither
 * confirm nor contradict the receipt. `retryable` is not drift either: the
 * server has not caught up with the receipt yet.
 */
export type ChargeConfirmation =
  | { status: "confirmed" }
  | { status: "drift"; drift: ChargeDrift[] }
  | { status: "unverifiable"; reason: string }
  | { status: "retryable"; reason: string };

/** The receipt fields confirmation compares, plus the settlement's hash. */
export type ChargeReceipt = Pick<
  ReceiptBody,
  "payer" | "payee" | "amount" | "asset" | "network" | "issuedAt"
> & { txHash: string };

/**
 * Compares a receipt with the transaction its settlement names.
 * `assetContract` is the token contract the receipt's asset resolves to.
 */
export function confirmCharge(
  receipt: ChargeReceipt,
  tx: ChainTransaction,
  assetContract: string,
): ChargeConfirmation {
  const expectedPassphrase = STELLAR_NETWORK_PASSPHRASE[receipt.network];
  if (tx.networkPassphrase !== expectedPassphrase) {
    return {
      status: "drift",
      drift: [
        {
          kind: "network-mismatch",
          detail: `the receipt names ${receipt.network} ("${expectedPassphrase}"), but the RPC server is on "${tx.networkPassphrase}"`,
        },
      ],
    };
  }

  if (tx.status === "NOT_FOUND") {
    const issuedAt = Date.parse(receipt.issuedAt);
    if (issuedAt < Date.parse(tx.oldestLedgerCloseTime)) {
      return {
        status: "unverifiable",
        reason: `transaction ${receipt.txHash} is older than the RPC retention window (receipt issued ${receipt.issuedAt}, oldest ledger ${tx.oldestLedger} closed ${tx.oldestLedgerCloseTime})`,
      };
    }
    if (issuedAt > Date.parse(tx.latestLedgerCloseTime)) {
      return {
        status: "retryable",
        reason: `the RPC server has not reached the receipt yet (receipt issued ${receipt.issuedAt}, latest ledger ${tx.latestLedger} closed ${tx.latestLedgerCloseTime})`,
      };
    }
    return {
      status: "drift",
      drift: [
        {
          kind: "tx-not-found",
          detail: `expected transaction ${receipt.txHash} on ${receipt.network} inside the RPC retention window (ledgers ${tx.oldestLedger} to ${tx.latestLedger}), but it is not there`,
        },
      ],
    };
  }

  if (tx.status === "FAILED") {
    return {
      status: "drift",
      drift: [
        {
          kind: "tx-failed",
          detail: `expected transaction ${receipt.txHash} to have succeeded, but it failed in ledger ${tx.ledger}`,
        },
      ],
    };
  }

  const expected: ChainTransfer = {
    contract: assetContract,
    from: receipt.payer,
    to: receipt.payee,
    amount: receipt.amount,
  };

  const [first, ...rest] = tx.transfers;
  if (first === undefined) {
    return {
      status: "drift",
      drift: [
        {
          kind: "transfer-missing",
          detail: `expected a transfer of ${expected.amount} on ${expected.contract} from ${expected.from} to ${expected.to} in transaction ${receipt.txHash}, but it moved no token`,
        },
      ],
    };
  }

  const closest = closestTransfer(first, rest, expected);
  const drift = describeDifferences(closest, expected, receipt.txHash);
  return drift.length === 0 ? { status: "confirmed" } : { status: "drift", drift };
}

/** Which receipt field each transfer field answers to, and the drift it raises. */
const COMPARED_FIELDS = [
  { field: "contract", kind: "asset-mismatch", label: "token contract" },
  { field: "from", kind: "payer-mismatch", label: "payer" },
  { field: "to", kind: "payee-mismatch", label: "payee" },
  { field: "amount", kind: "amount-mismatch", label: "amount" },
] as const satisfies ReadonlyArray<{
  field: keyof ChainTransfer;
  kind: ChargeDriftKind;
  label: string;
}>;

function sameField(actual: ChainTransfer, expected: ChainTransfer, field: keyof ChainTransfer) {
  // Amounts are integer strings; compare them as integers so "010" and "10"
  // agree. The schema has already ruled out anything else.
  return field === "amount"
    ? BigInt(actual.amount) === BigInt(expected.amount)
    : actual[field] === expected[field];
}

/**
 * The transfer that agrees with the receipt on the most fields. A
 * transaction often carries unrelated transfers, so the drift report
 * describes the one that was meant to be the payment. Ties go to the first.
 */
function closestTransfer(
  first: ChainTransfer,
  rest: readonly ChainTransfer[],
  expected: ChainTransfer,
): ChainTransfer {
  const score = (transfer: ChainTransfer) =>
    COMPARED_FIELDS.filter(({ field }) => sameField(transfer, expected, field)).length;
  let best = first;
  let bestScore = score(first);
  for (const transfer of rest) {
    const transferScore = score(transfer);
    if (transferScore > bestScore) {
      best = transfer;
      bestScore = transferScore;
    }
  }
  return best;
}

function describeDifferences(
  actual: ChainTransfer,
  expected: ChainTransfer,
  txHash: string,
): ChargeDrift[] {
  return COMPARED_FIELDS.filter(({ field }) => !sameField(actual, expected, field)).map(
    ({ field, kind, label }) => ({
      kind,
      detail: `expected ${label} ${expected[field]}, got ${actual[field]} in the closest transfer of transaction ${txHash}`,
    }),
  );
}
