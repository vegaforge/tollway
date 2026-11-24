import { SOROBAN_RPC_URLS } from "@stellar/mpp";
import { getChannelState } from "@stellar/mpp/channel/server";
import { Address, rpc, StrKey, xdr } from "@stellar/stellar-sdk";
import type { StellarNetwork } from "@vegaforge/tollway-core";

/**
 * Reads of a one-way channel contract's on-chain state, for registration
 * (#173) and settlement (#174). The contract is
 * stellar-experimental/one-way-channel, `contracts/channel/src/lib.rs`.
 */

/** Tollway's network names mapped to the ids `@stellar/mpp` uses. */
export const MPP_NETWORK: Record<StellarNetwork, "stellar:testnet" | "stellar:pubnet"> = {
  testnet: "stellar:testnet",
  mainnet: "stellar:pubnet",
};

/** On-chain state of a channel, with integer amounts as strings. */
export type OnChainChannel = {
  /** Token balance the contract holds, in base units. */
  balance: string;
  refundWaitingPeriod: number;
  token: string;
  /** The funder. */
  from: string;
  /** The recipient. */
  to: string;
  /** Set once `close_start` (a funder dispute) or `close` has run. */
  closeEffectiveAtLedger: number | null;
  currentLedger: number;
  /** The funder's commitment public key as a `G...` string. */
  commitmentKey: string;
};

/**
 * Finds `DataKey::CommitmentKey` in a contract instance's storage and returns
 * it as a `G...` string, or null when it is absent or not 32 bytes.
 *
 * The contract has no getter for the key; it keeps it as `BytesN<32>` in
 * instance storage, and Soroban encodes the unit enum variant as
 * `Vec([Symbol("CommitmentKey")])`. `@stellar/mpp` reads
 * `CloseEffectiveAtLedger` the same way.
 */
export function commitmentKeyFromInstance(storage: readonly xdr.ScMapEntry[]): string | null {
  for (const entry of storage) {
    if (!isUnitVariant(entry.key(), "CommitmentKey")) continue;
    const value = entry.val();
    if (value.switch().value !== xdr.ScValType.scvBytes().value) return null;
    const bytes = value.bytes();
    return bytes.length === 32 ? StrKey.encodeEd25519PublicKey(bytes) : null;
  }
  return null;
}

function isUnitVariant(value: xdr.ScVal, name: string): boolean {
  if (value.switch().value !== xdr.ScValType.scvVec().value) return false;
  const items = value.vec();
  if (items?.length !== 1) return false;
  const [symbol] = items;
  return (
    symbol !== undefined &&
    symbol.switch().value === xdr.ScValType.scvSymbol().value &&
    symbol.sym().toString() === name
  );
}

/** Where to read chain state from. */
export type ChainReadOptions = {
  network: StellarNetwork;
  /** Soroban RPC URL. Defaults to `@stellar/mpp`'s public endpoint for the network. */
  rpcUrl?: string;
};

/** Reads the commitment key from the contract's instance entry. Throws when it cannot be found. */
export async function readCommitmentKey(
  channel: string,
  options: ChainReadOptions,
): Promise<string> {
  const server = new rpc.Server(rpcUrlFor(options));
  const instanceKey = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(channel).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const response = await server.getLedgerEntries(instanceKey);
  const [entry] = response.entries;
  const storage = entry?.val.contractData().val().instance().storage();
  const key = storage ? commitmentKeyFromInstance(storage) : null;
  if (!key) {
    throw new Error(`channel ${channel} has no 32-byte commitment key in its instance storage`);
  }
  return key;
}

/**
 * Reads everything registration needs: the getters `@stellar/mpp` reads, plus
 * the commitment key. Throws on any RPC failure, so callers fail closed.
 */
export async function readOnChainChannel(
  channel: string,
  options: ChainReadOptions,
): Promise<OnChainChannel> {
  const [state, commitmentKey] = await Promise.all([
    getChannelState({
      channel,
      network: MPP_NETWORK[options.network],
      rpcUrl: rpcUrlFor(options),
    }),
    readCommitmentKey(channel, options),
  ]);
  return {
    balance: state.balance.toString(),
    refundWaitingPeriod: state.refundWaitingPeriod,
    token: state.token,
    from: state.from,
    to: state.to,
    closeEffectiveAtLedger: state.closeEffectiveAtLedger,
    currentLedger: state.currentLedger,
    commitmentKey,
  };
}

/** Reads the getters only, without the commitment key. Used around a close. */
export async function readChannelBalanceState(
  channel: string,
  options: ChainReadOptions,
): Promise<Pick<OnChainChannel, "balance" | "closeEffectiveAtLedger" | "currentLedger">> {
  const state = await getChannelState({
    channel,
    network: MPP_NETWORK[options.network],
    rpcUrl: rpcUrlFor(options),
  });
  return {
    balance: state.balance.toString(),
    closeEffectiveAtLedger: state.closeEffectiveAtLedger,
    currentLedger: state.currentLedger,
  };
}

function rpcUrlFor(options: ChainReadOptions): string {
  return options.rpcUrl ?? SOROBAN_RPC_URLS[MPP_NETWORK[options.network]];
}
