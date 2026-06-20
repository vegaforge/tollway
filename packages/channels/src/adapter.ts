/**
 * The boundary between the channel manager and @stellar/mpp.
 *
 * The manager owns sequencing, persistence, and lifecycle policy. The
 * adapter owns the on-chain and cryptographic primitives: deploying or
 * opening the one-way-channel contract, and producing the next ed25519
 * commitment signature via the contract's prepare_commitment simulation.
 *
 * Splitting along this line keeps the manager testable without testnet,
 * and keeps the manager free of stellar-sdk specifics so a different
 * channel implementation could slot in later.
 */

import type { StellarNetwork } from "@tollway/core";

export type OpenAdapterInput = {
  counterparty: string;
  asset: string;
  /** Initial deposit as an integer string in base units. */
  deposit: string;
  network: StellarNetwork;
};

export type OpenAdapterResult = {
  /** Deployed channel contract address (C...). */
  channelId: string;
  /** On-chain transaction hash of the open. */
  openTxHash: string;
};

export type SignCommitmentInput = {
  channelId: string;
  /** Next cumulative amount as an integer string in base units. */
  cumulativeAmount: string;
  network: StellarNetwork;
};

export type SignedCommitment = {
  /** Serialized commitment blob; encoding is @stellar/mpp's. */
  commitment: string;
};

export type CloseAdapterInput = {
  channelId: string;
  network: StellarNetwork;
  /** Latest cumulative commitment to settle with, as an integer string in base units. */
  cumulativeAmount: string;
  /**
   * Funder-signed commitment blob for `cumulativeAmount`. Empty string when
   * the channel has no commits and the close is effectively a refund.
   */
  commitment: string;
  /** Original deposit recorded at open time, in base units. */
  deposit: string;
};

export type CloseAdapterResult = {
  /** On-chain transaction hash of the settlement. */
  settlementTxHash: string;
  /**
   * Amount actually settled to the recipient, as an integer string. Should
   * equal `cumulativeAmount`; the manager's close path verifies this.
   */
  settledAmount: string;
  /** Amount returned to the funder after settlement, as an integer string. */
  returnedRemainder: string;
};

/**
 * The minimum surface the manager needs from @stellar/mpp.
 *
 * Implementations:
 * - `stellarMppAdapter` — real adapter against the one-way-channel contract
 *   on testnet or mainnet. Submits on chain in `openChannel` and
 *   `closeChannel`, runs a read-only simulate + local ed25519 sign in
 *   `signCommitment`.
 * - test doubles — used by the manager's own tests to assert off-chain
 *   behaviour without standing up a testnet.
 */
export interface MppChannelAdapter {
  openChannel(input: OpenAdapterInput): Promise<OpenAdapterResult>;
  /**
   * Produces the next cumulative commitment signature off chain. MUST NOT
   * submit a transaction; the off-chain invariant is the whole point of
   * channel mode (docs/design.md, "The channel lifecycle manager").
   */
  signCommitment(input: SignCommitmentInput): Promise<SignedCommitment>;
  /**
   * Submits the single on-chain settlement for the channel using the latest
   * cumulative commitment. Returns the settlement tx hash, the settled
   * amount, and the remainder returned to the funder.
   */
  closeChannel(input: CloseAdapterInput): Promise<CloseAdapterResult>;
}
