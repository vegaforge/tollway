/**
 * The chain-facing seam of reconciliation (#211, #212).
 *
 * Reconciliation logic reads the chain only through the two interfaces in
 * this file, and only through the Tollway-owned shapes below. Nothing here
 * imports the Stellar SDK or @stellar/mpp: the readers that do live behind
 * the `@vegaforge/tollway-reconcile/stellar` subpath, so a caller with its
 * own chain access never loads them. See docs/design.md, "Reconciliation".
 *
 * Whatever a reader returns is parsed with the schemas here before any
 * comparison runs, so a custom reader that returns the wrong shape produces
 * a retryable outcome, never a silent default.
 */

import type { StellarNetwork } from "@vegaforge/tollway-core";
import { z } from "zod";

/** Network passphrases, used to check which network an RPC server is on. */
export const STELLAR_NETWORK_PASSPHRASE: Record<StellarNetwork, string> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
};

const contractAddress = z.string().regex(/^C[A-Z2-7]{55}$/, "must be a C... contract address");
const integerAmount = z.string().regex(/^[0-9]+$/, "must be a non-negative integer string");
const ledgerSequence = z.number().int().nonnegative();

/**
 * One SEP-41 `transfer` event, decoded. For a Stellar Asset Contract the
 * event also names the classic asset; `contract` is what identifies the token.
 */
export const chainTransferSchema = z.strictObject({
  /** The token contract that emitted the event. */
  contract: contractAddress,
  from: z.string().min(1),
  to: z.string().min(1),
  /** The amount in the token's smallest unit, as an integer string. */
  amount: integerAmount,
});
export type ChainTransfer = z.infer<typeof chainTransferSchema>;

/** The ledger window the RPC server still keeps, read with the lookup. */
const retentionFields = {
  /** The transaction hash that was looked up. */
  hash: z.string().min(1),
  /** The passphrase of the network the RPC server is on. */
  networkPassphrase: z.string().min(1),
  latestLedger: ledgerSequence,
  latestLedgerCloseTime: z.iso.datetime(),
  oldestLedger: ledgerSequence,
  /** Older transactions are gone from this server; see `NOT_FOUND`. */
  oldestLedgerCloseTime: z.iso.datetime(),
} as const;

/**
 * A transaction as reconciliation sees it. `NOT_FOUND` carries only the
 * retention window, so the caller can tell "too old for this server" from
 * "should be visible but is not".
 */
export const chainTransactionSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("NOT_FOUND"), ...retentionFields }),
  z.strictObject({
    status: z.enum(["SUCCESS", "FAILED"]),
    ...retentionFields,
    ledger: ledgerSequence,
    /** When the ledger holding the transaction closed. */
    createdAt: z.iso.datetime(),
    /**
     * True when a fee-bump envelope wrapped the transaction. Recorded for the
     * operator; confirmation never depends on who paid the fee.
     */
    feeBump: z.boolean(),
    transfers: z.array(chainTransferSchema),
  }),
]);
export type ChainTransaction = z.infer<typeof chainTransactionSchema>;

/** Reads settled transactions for charge confirmation (#211). */
export interface ChainReader {
  /**
   * Looks a transaction up on `network`. Throws when the lookup itself
   * failed (timeout, RPC error), which reconciliation reports as retryable.
   * A transaction the server does not have is `status: "NOT_FOUND"`, not a
   * throw.
   */
  getTransaction(hash: string, network: StellarNetwork): Promise<ChainTransaction>;
  /**
   * The token contract address for a receipt's `asset` (a `C...` address,
   * `CODE:ISSUER`, or `native`) on `network`. Throws for any other form.
   */
  assetContractId(asset: string, network: StellarNetwork): string;
}

/** A one-way payment channel contract's state, as reconciliation sees it (#212). */
export const onChainChannelStateSchema = z.strictObject({
  /** Tokens the contract holds now, in the token's smallest unit. */
  balance: integerAmount,
  /** The token contract the channel pays in. */
  token: contractAddress,
  /** The funder. */
  from: z.string().min(1),
  /** The recipient. */
  to: z.string().min(1),
  /**
   * Set once `close_start` or `close` has run: the ledger at which the close
   * takes effect. Null while the channel is open.
   */
  closeEffectiveAtLedger: ledgerSequence.nullable(),
  /** The latest ledger when the state was read. */
  currentLedger: ledgerSequence,
  refundWaitingPeriod: ledgerSequence,
});
export type OnChainChannelState = z.infer<typeof onChainChannelStateSchema>;

/** Reads a channel contract's live state (#212). */
export interface ChannelStateReader {
  /**
   * Reads the channel contract `channelId` on `network`. Throws when the
   * read failed, which reconciliation reports as retryable.
   */
  getChannelState(channelId: string, network: StellarNetwork): Promise<OnChainChannelState>;
}

/** Converts a reader's failure message into one line for a retryable outcome. */
export function describeReadFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Formats a zod failure as `path: message` pairs for a retryable reason. */
export function describeSchemaFailure(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("; ");
}
