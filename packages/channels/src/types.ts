/**
 * Domain types for the MPP channel lifecycle manager.
 *
 * Field shapes that belong to @stellar/mpp (the commitment encoding, the
 * channel contract address format) are kept as opaque strings — the manager
 * is responsible for orchestration, not for the SDK's wire format.
 */

import type { StellarNetwork } from "@tollway/core";

export type ChannelStatus = "open" | "closing" | "closed" | "recovering" | "recovered";

export type OpenChannelInput = {
  counterparty: string;
  asset: string;
  /** Initial deposit as an integer string in the asset's smallest unit. */
  deposit: string;
  network: StellarNetwork;
};

export type Channel = {
  id: string;
  counterparty: string;
  asset: string;
  deposit: string;
  /** Total committed so far, cumulative. */
  committed: string;
  /** Highest commitment sequence issued. Starts at -1 before any commit lands. */
  sequence: number;
  status: ChannelStatus;
  network: StellarNetwork;
  /** On-chain transaction hash that opened the channel. */
  openTxHash: string;
};

export type Commitment = {
  channelId: string;
  sequence: number;
  cumulativeAmount: string;
  /** Funder-signed commitment blob; encoding owned by @stellar/mpp. */
  commitment: string;
};

export type CloseResult = {
  channelId: string;
  settlementTxHash: string;
  /** Amount returned to the funder after paying out the cumulative total. */
  returnedRemainder: string;
};

export type RecoveryResult = {
  channelId: string;
  recoveredAmount: string;
  txHash: string;
};

/**
 * Heuristics that decide when an open channel should close. See
 * docs/design.md, "The channel lifecycle manager".
 */
export type ClosePolicy = {
  /** Close once committed reaches this fraction of the deposit, 0 to 1. */
  drawdownThreshold?: number;
  /** Close after this many seconds with no new commitment. */
  idleTimeoutSeconds?: number;
};

export interface ChannelManager {
  open(input: OpenChannelInput): Promise<Channel>;
  commit(channelId: string, amount: string): Promise<Commitment>;
  /** Read-only access to the tracked channel record. */
  get(channelId: string): Promise<Channel | undefined>;
  /** Read-only access to a channel's commitment stream, ordered by sequence. */
  list(channelId: string): Promise<readonly Commitment[]>;
  shouldClose(channelId: string): Promise<boolean>;
  close(channelId: string): Promise<CloseResult>;
  recover(channelId: string): Promise<RecoveryResult>;
}
