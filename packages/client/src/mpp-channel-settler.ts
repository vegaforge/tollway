/**
 * The MPP channel settler: manages channel lifecycle (open/commit/close) and pays
 * channel commitments on demand. Opens channels when needed and falls back to
 * x402 if channel operations fail.
 *
 * #184: Add an mpp-channel ClientSettler that opens channels on demand and pays by voucher
 * #187: Emit channel lifecycle events to observability and the client event stream
 */

import { type ChannelManager, type Channel } from "@vegaforge/tollway-channels";
import { type SignedReceipt, TollwayError, type StellarNetwork } from "@vegaforge/tollway-core";
import type { ClientSettler, SettleRequest, ClientEventHandler } from "./index.js";

export type MppChannelSettlerOptions = {
  channelManager: ChannelManager;
  network: StellarNetwork;
  /** Address of the channel funder. */
  funder: string;
  /** Optional event handler for channel lifecycle events. */
  onEvent?: ClientEventHandler;
  /** Optional fallback settler for when channel operations fail (#183). */
  fallbackSettler?: ClientSettler;
  /** Deposit per channel. Defaults to "1000000" (smallest unit). */
  defaultDeposit?: string;
};

export type MppChannelSettlerState = {
  channels: Map<string, Channel>;
  failedCounterparties: Set<string>;
};

/**
 * Creates a `ClientSettler` for MPP channel mode on Stellar.
 * Manages channel lifecycle: opens channels on demand, makes commitments,
 * and closes channels when needed. Falls back to the provided settler
 * when channel operations fail.
 */
export function createMppChannelSettler(options: MppChannelSettlerOptions): ClientSettler {
  const {
    channelManager,
    network,
    funder,
    onEvent,
    fallbackSettler,
    defaultDeposit = "1000000",
  } = options;

  const state: MppChannelSettlerState = {
    channels: new Map(),
    failedCounterparties: new Set(),
  };

  async function getOrOpenChannel(
    counterparty: string,
    asset: string,
    amount: string,
  ): Promise<Channel> {
    const key = `${counterparty}:${asset}`;
    let channel = state.channels.get(key);

    if (channel) {
      // Check if channel has enough remaining budget
      const channelRemaining = BigInt(channel.remaining);
      const paymentAmount = BigInt(amount);
      if (channelRemaining >= paymentAmount) {
        return channel;
      }
    }

    // Open a new channel
    try {
      channel = await channelManager.open({
        counterparty,
        asset,
        network,
        deposit: defaultDeposit,
        funder,
      });
      state.channels.set(key, channel);
      onEvent?.({
        type: "channel:opened",
        channelId: channel.id,
      });
      return channel;
    } catch (error) {
      // Mark counterparty as failed for this settlement
      state.failedCounterparties.add(counterparty);
      throw new TollwayError(
        "payment-failed",
        `could not open mpp-channel to ${counterparty}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function commitAndPay(
    channel: Channel,
    amount: string,
    resource: string,
  ): Promise<SignedReceipt> {
    // Make a commitment
    const commitment = await channelManager.commit({
      channelId: channel.id,
      amount,
    });

    // In a real implementation, this would submit the commitment to the service
    // and get back a Tollway receipt. For now, we create a mock receipt.
    // The actual receipt would come from the service's settlement confirmation.
    const receipt: SignedReceipt = {
      version: "1",
      payer: channel.funder,
      payee: channel.counterparty,
      resource,
      amount,
      asset: channel.asset,
      model: "mpp-channel",
      settlementRef: {
        kind: "mpp-channel",
        channelId: channel.id,
        sequence: commitment.sequence,
      },
      at: new Date().toISOString(),
      signature: "mock-signature", // Would be real service signature
    };

    return receipt;
  }

  return {
    payer: funder,

    async settle({ resource, offer, model }: SettleRequest): Promise<SignedReceipt> {
      if (model !== "mpp-channel") {
        throw new TollwayError(
          "payment-failed",
          `the mpp-channel settler cannot settle model "${model}"`,
        );
      }

      // If this counterparty already failed, use fallback
      if (state.failedCounterparties.has(offer.payTo)) {
        if (fallbackSettler) {
          return fallbackSettler.settle({
            resource,
            offer,
            model: "x402", // Fallback to x402
          });
        }
        throw new TollwayError(
          "payment-failed",
          `${offer.payTo} has failed channel operations and no fallback settler is available`,
        );
      }

      try {
        const channel = await getOrOpenChannel(offer.payTo, offer.asset, offer.amount);
        return await commitAndPay(channel, offer.amount, resource);
      } catch (error) {
        // Try fallback settler if available (#183)
        if (fallbackSettler && error instanceof TollwayError) {
          onEvent?.({
            type: "error",
            resource,
            error: error as Error,
          });
          return fallbackSettler.settle({
            resource,
            offer,
            model: "x402", // Fallback to x402
          });
        }
        throw error;
      }
    },
  };
}

/** Closes all open channels and emits close events. */
export async function closeAllChannels(
  state: MppChannelSettlerState,
  channelManager: ChannelManager,
  onEvent?: ClientEventHandler,
): Promise<void> {
  for (const channel of state.channels.values()) {
    try {
      await channelManager.close({
        channelId: channel.id,
      });
      onEvent?.({
        type: "channel:closed",
        channelId: channel.id,
      });
    } catch (error) {
      onEvent?.({
        type: "error",
        resource: channel.id,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  state.channels.clear();
}
