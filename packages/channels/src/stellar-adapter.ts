/**
 * The real `MppChannelAdapter`, backed by `@stellar/mpp/channel` and the
 * one-way-channel contract on Stellar. Every @stellar/mpp and stellar-sdk
 * import in this package lives in this file and stellar-settlement.ts, so the
 * manager stays SDK-free.
 *
 * The adapter does not deploy the channel contract. `@stellar/mpp` 0.7 has
 * no deploy or open call: the funder deploys and funds the contract out of
 * band, and the adapter is bound to that one contract. `openChannel` checks
 * the deployed contract against the requested channel and reports it.
 */

import { SOROBAN_RPC_URLS } from "@stellar/mpp";
import { channel as channelClient } from "@stellar/mpp/channel/client";
import { close, getChannelState } from "@stellar/mpp/channel/server";
import { Keypair, rpc, StrKey } from "@stellar/stellar-sdk";
import { type StellarNetwork, TollwayError } from "@vegaforge/tollway-core";
import { Credential, Store } from "mppx";
import type {
  ChannelChainState,
  CloseAdapterInput,
  CloseAdapterResult,
  FoundChannelSettlement,
  MppChannelAdapter,
  OpenAdapterInput,
  OpenAdapterResult,
  SignCommitmentInput,
  SignedCommitment,
} from "./adapter.js";
import { CloseNotSubmittedError } from "./errors.js";
import { findSettlementInEvents } from "./stellar-settlement.js";

export type StellarMppChannelAdapterOptions = {
  /** The deployed, funded one-way-channel contract (C...). */
  channelContract: string;
  /**
   * Hash of the transaction that deployed and funded the contract. Reported
   * as `openTxHash`, since the adapter does not open the channel itself.
   */
  openTxHash: string;
  /**
   * The funder's commitment key: a raw ed25519 seed as 64 hex characters,
   * not an `S...` secret. Its public key is the one the contract checks
   * commitment signatures against.
   */
  commitmentKey: string;
  /**
   * The account that submits and pays for the close transaction (`S...`).
   * `feeBumpSigner` optionally wraps the close in a fee bump.
   */
  feePayer: { envelopeSigner: string; feeBumpSigner?: string };
  network: StellarNetwork;
  /** Soroban RPC URL. Defaults to the public endpoint for the network. */
  rpcUrl?: string;
  /** Timeout for the read-only simulations, in milliseconds. */
  simulationTimeoutMs?: number;
};

const MPP_NETWORK: Record<StellarNetwork, "stellar:testnet" | "stellar:pubnet"> = {
  testnet: "stellar:testnet",
  mainnet: "stellar:pubnet",
};

const RAW_SEED = /^[0-9a-fA-F]{64}$/;
const TX_HASH = /^[0-9a-fA-F]{64}$/;
/** An ed25519 signature is 64 bytes, so 128 hex characters. */
const SIGNATURE = /^[0-9a-fA-F]{128}$/;
const INTEGER = /^(0|[1-9][0-9]*)$/;

/**
 * Builds the adapter. Configuration errors throw a `TypeError` here, before
 * any network call. Messages name the bad option but never echo a secret.
 */
export function createStellarMppChannelAdapter(
  options: StellarMppChannelAdapterOptions,
): MppChannelAdapter {
  const { channelContract, openTxHash } = options;
  if (!channelContract) {
    throw new TypeError("createStellarMppChannelAdapter: channelContract is required");
  }
  if (!StrKey.isValidContract(channelContract)) {
    throw new TypeError(
      "createStellarMppChannelAdapter: channelContract must be a contract address (C...)",
    );
  }
  if (!TX_HASH.test(openTxHash ?? "")) {
    throw new TypeError(
      "createStellarMppChannelAdapter: openTxHash must be a 64-character hex transaction hash",
    );
  }
  if (!RAW_SEED.test(options.commitmentKey ?? "")) {
    throw new TypeError(
      "createStellarMppChannelAdapter: commitmentKey must be a raw ed25519 seed of 64 hex characters, not an S... secret",
    );
  }
  if (!StrKey.isValidEd25519SecretSeed(options.feePayer?.envelopeSigner ?? "")) {
    throw new TypeError(
      "createStellarMppChannelAdapter: feePayer.envelopeSigner must be a Stellar secret key (S...)",
    );
  }
  const { feeBumpSigner } = options.feePayer;
  if (feeBumpSigner !== undefined && !StrKey.isValidEd25519SecretSeed(feeBumpSigner)) {
    throw new TypeError(
      "createStellarMppChannelAdapter: feePayer.feeBumpSigner must be a Stellar secret key (S...)",
    );
  }
  if (!(options.network in MPP_NETWORK)) {
    throw new TypeError("createStellarMppChannelAdapter: network must be testnet or mainnet");
  }

  const network = MPP_NETWORK[options.network];
  const { rpcUrl, simulationTimeoutMs } = options;
  const feePayer = { envelopeSigner: options.feePayer.envelopeSigner, feeBumpSigner };

  const signer = channelClient({
    commitmentKey: Keypair.fromRawEd25519Seed(Buffer.from(options.commitmentKey, "hex")),
    allowedChannels: [channelContract],
    network,
    rpcUrl,
    simulationTimeoutMs,
    // The manager owns the cumulative stream; this store only keeps
    // @stellar/mpp from warning that none was passed.
    store: Store.memory(),
  });

  function assertChannel(channelId: string, requested: StellarNetwork): void {
    if (channelId !== channelContract) {
      throw new TollwayError(
        "channel-not-found",
        `this adapter is bound to channel ${channelContract}, not ${channelId}`,
      );
    }
    if (requested !== options.network) {
      throw new TollwayError(
        "payment-failed",
        `this adapter is configured for ${options.network}, not ${requested}`,
      );
    }
  }

  /** The close checks that run before anything is sent to the network. */
  function checkClose(input: CloseAdapterInput): { amount: bigint } {
    assertChannel(input.channelId, input.network);
    const amount = toBigInt(input.cumulativeAmount, "cumulativeAmount");
    const deposit = toBigInt(input.deposit, "deposit");
    if (amount > deposit) {
      throw new TollwayError(
        "commitment-exceeds-deposit",
        `cumulative ${input.cumulativeAmount} exceeds the deposit of ${input.deposit}`,
      );
    }
    if (input.commitment === "") {
      throw new TollwayError(
        "payment-failed",
        "a channel with no commitments has nothing to settle; the funder reclaims the deposit through the contract's refund path (see #38)",
      );
    }
    if (!SIGNATURE.test(input.commitment)) {
      throw new TollwayError(
        "payment-failed",
        "commitment must be a 128-character hex ed25519 signature",
      );
    }
    return { amount };
  }

  return {
    async openChannel(input: OpenAdapterInput): Promise<OpenAdapterResult> {
      assertChannel(channelContract, input.network);
      const deposit = toBigInt(input.deposit, "deposit");
      const state = await getChannelState({
        channel: channelContract,
        network,
        rpcUrl,
        simulationTimeoutMs,
      });
      if (state.to !== input.counterparty) {
        throw new TollwayError(
          "payment-failed",
          `channel ${channelContract} pays ${state.to}, not the counterparty ${input.counterparty}`,
        );
      }
      if (StrKey.isValidContract(input.asset) && state.token !== input.asset) {
        throw new TollwayError(
          "payment-failed",
          `channel ${channelContract} holds token ${state.token}, not ${input.asset}`,
        );
      }
      if (state.closeEffectiveAtLedger !== null) {
        throw new TollwayError(
          "channel-already-closed",
          `channel ${channelContract} is already closing`,
        );
      }
      if (state.balance < deposit) {
        throw new TollwayError(
          "commitment-exceeds-deposit",
          `channel ${channelContract} holds ${state.balance.toString()}, less than the deposit of ${input.deposit}`,
        );
      }
      return { channelId: channelContract, openTxHash };
    },

    async signCommitment(input: SignCommitmentInput): Promise<SignedCommitment> {
      assertChannel(input.channelId, input.network);
      toBigInt(input.cumulativeAmount, "cumulativeAmount");
      // The client method signs the commitment the contract's
      // prepare_commitment simulation returns. Simulation is read-only, and
      // nothing is submitted. The challenge is built locally and only
      // carries the channel, network and amount the signer needs.
      const serialized = await signer.createCredential({
        challenge: {
          id: "tollway-local-commitment",
          realm: "tollway",
          method: "stellar",
          intent: "channel",
          request: {
            amount: input.cumulativeAmount,
            channel: channelContract,
            methodDetails: { network },
          },
        },
        context: { cumulativeAmount: input.cumulativeAmount, action: "voucher" },
      });
      const { payload } = Credential.deserialize<{ amount: string; signature: string }>(serialized);
      if (payload.amount !== input.cumulativeAmount || !SIGNATURE.test(payload.signature)) {
        throw new TollwayError(
          "payment-failed",
          "@stellar/mpp returned a commitment that does not match the requested amount",
        );
      }
      return { commitment: payload.signature };
    },

    async closeChannel(input: CloseAdapterInput): Promise<CloseAdapterResult> {
      // Everything up to the call into @stellar/mpp happens before any
      // submission, so a failure here is reported as not submitted.
      let amount: bigint;
      try {
        ({ amount } = checkClose(input));
      } catch (error) {
        throw new CloseNotSubmittedError(input.channelId, error);
      }
      const deposit = toBigInt(input.deposit, "deposit");
      const settlementTxHash = await close({
        channel: channelContract,
        amount,
        signature: Uint8Array.from(Buffer.from(input.commitment, "hex")),
        feePayer,
        network,
        rpcUrl,
      });
      return {
        settlementTxHash,
        settledAmount: amount.toString(),
        returnedRemainder: (deposit - amount).toString(),
      };
    },

    async getChannelState(input): Promise<ChannelChainState> {
      assertChannel(input.channelId, input.network);
      const state = await getChannelState({
        channel: channelContract,
        network,
        rpcUrl,
        simulationTimeoutMs,
      });
      const chainState: ChannelChainState = {
        balance: state.balance.toString(),
        currentLedger: state.currentLedger,
      };
      if (state.closeEffectiveAtLedger != null) {
        chainState.closeEffectiveAtLedger = state.closeEffectiveAtLedger;
      }
      return chainState;
    },

    async findChannelSettlement(input): Promise<FoundChannelSettlement | null> {
      assertChannel(input.channelId, input.network);
      return findSettlementInEvents({
        source: new rpc.Server(rpcUrl ?? SOROBAN_RPC_URLS[network]),
        channelId: channelContract,
        startLedger: input.startLedger,
      });
    },
  };
}

/** Amounts cross the adapter boundary as integer strings; bigint only at the SDK call. */
function toBigInt(value: string, field: string): bigint {
  if (!INTEGER.test(value)) {
    throw new TollwayError(
      "invalid-amount",
      `${field} "${value}" is not a non-negative integer string`,
    );
  }
  return BigInt(value);
}
