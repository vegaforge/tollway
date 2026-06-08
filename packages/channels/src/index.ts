/**
 * @tollway/channels
 *
 * The MPP payment channel lifecycle the raw SDK leaves to the integrator:
 * open the channel, advance cumulative commitments off chain, close with a
 * single settlement, and recover when a counterparty goes quiet. See
 * docs/design.md, "The channel lifecycle manager".
 */

import { NotImplementedError, type StellarNetwork } from "@tollway/core";

export type ChannelStatus = "open" | "closing" | "closed" | "recovering" | "recovered";

export type OpenChannelInput = {
  counterparty: string;
  asset: string;
  /** Initial deposit as an integer string, sized from budget and demand. */
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
  /** Highest commitment sequence issued. */
  sequence: number;
  status: ChannelStatus;
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
  shouldClose(channelId: string): Promise<boolean>;
  close(channelId: string): Promise<CloseResult>;
  recover(channelId: string): Promise<RecoveryResult>;
}

/**
 * TODO: implement the lifecycle against the MPP one-way-channel contract on
 * testnet, with recovery as a first-class case. The recovery and dispute
 * surface of @stellar/mpp is still an open question; see docs/design.md,
 * "Open questions", item 1.
 */
export function createChannelManager(_closePolicy?: ClosePolicy): ChannelManager {
  throw new NotImplementedError(
    "the channel lifecycle manager",
    'docs/design.md, "The channel lifecycle manager"',
  );
}
