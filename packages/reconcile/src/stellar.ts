/**
 * @vegaforge/tollway-reconcile/stellar
 *
 * Stellar implementations of the reconcile package's chain readers (#211,
 * #212). This is the only part of the package that imports the Stellar SDK
 * and @stellar/mpp; the main entry works on the Tollway-owned shapes in
 * chain.ts, so callers with their own chain access never load either.
 *
 * Every RPC response is parsed with a schema before it is mapped to the
 * Tollway shape (AGENTS.md checklist item 1). A response that does not parse
 * is thrown as `ChainReadError`, which reconciliation reports as retryable.
 */

import { getChannelState as mppGetChannelState } from "@stellar/mpp/channel/server";
import { Address, Asset, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { StellarNetwork } from "@vegaforge/tollway-core";
import { z } from "zod";
import {
  type ChainReader,
  type ChainTransaction,
  type ChainTransfer,
  type ChannelStateReader,
  chainTransactionSchema,
  describeSchemaFailure,
  type OnChainChannelState,
  onChainChannelStateSchema,
  STELLAR_NETWORK_PASSPHRASE,
} from "./chain.js";
import type { OpenChannelSnapshot } from "./open-channel.js";

/** The public RPC endpoints @stellar/mpp 0.7.1 defaults to, per network. */
export const DEFAULT_STELLAR_RPC_URLS: Record<StellarNetwork, string> = {
  testnet: "https://soroban-testnet.stellar.org",
  mainnet: "https://soroban-rpc.mainnet.stellar.gateway.fm",
};

const MPP_NETWORK_ID = { testnet: "stellar:testnet", mainnet: "stellar:pubnet" } as const;

/** A chain read that failed or returned something that does not parse. */
export class ChainReadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ChainReadError";
  }
}

const CONTRACT_ADDRESS_RE = /^C[A-Z2-7]{55}$/;
// The same forms the client accepts for an offer asset (offerAssetContract).
const CLASSIC_ASSET_RE = /^([A-Za-z0-9]{1,12}):(G[A-Z2-7]{55})$/;

/**
 * The token contract address for a Tollway asset identifier on `network`: a
 * `C...` contract address as is, `native` as the native asset's Stellar
 * Asset Contract, and `CODE:ISSUER` as that classic asset's contract.
 */
export function resolveAssetContractId(asset: string, network: StellarNetwork): string {
  if (CONTRACT_ADDRESS_RE.test(asset)) return asset;
  const passphrase = STELLAR_NETWORK_PASSPHRASE[network];
  if (asset === "native") return Asset.native().contractId(passphrase);
  const classic = CLASSIC_ASSET_RE.exec(asset);
  if (classic?.[1] !== undefined && classic[2] !== undefined) {
    return new Asset(classic[1], classic[2]).contractId(passphrase);
  }
  throw new TypeError(`asset "${asset}" is not a C... contract address, CODE:ISSUER, or native`);
}

/**
 * Decodes one contract event as a SEP-41 `transfer`, or returns undefined
 * for any other event. The topics are `transfer`, from, to, and for a Stellar
 * Asset Contract a fourth naming the classic asset. The data is the amount
 * as an i128, or since CAP-67 a map carrying `amount` (with `to_muxed_id`
 * when the recipient is muxed). Both shapes are accepted.
 */
export function decodeTransferEvent(event: xdr.ContractEvent): ChainTransfer | undefined {
  const contractId = event.contractId();
  if (contractId === null) return undefined;
  if (event.type().value !== xdr.ContractEventType.contract().value) return undefined;
  const body = event.body().v0();
  const topics = body.topics();
  if (topics.length !== 3 && topics.length !== 4) return undefined;
  const [name, fromVal, toVal] = topics;
  if (name === undefined || fromVal === undefined || toVal === undefined) return undefined;
  if (name.switch().value !== xdr.ScValType.scvSymbol().value) return undefined;
  if (name.sym().toString() !== "transfer") return undefined;

  const from = addressOf(fromVal);
  const to = addressOf(toVal);
  const amount = amountOf(body.data());
  if (from === undefined || to === undefined || amount === undefined) return undefined;

  return {
    contract: Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(contractId)).toString(),
    from,
    to,
    amount: amount.toString(),
  };
}

/** Account and contract addresses only: receipts name a G... payer and payee. */
function addressOf(value: xdr.ScVal): string | undefined {
  if (value.switch().value !== xdr.ScValType.scvAddress().value) return undefined;
  const address = value.address();
  const kind = address.switch().value;
  if (
    kind !== xdr.ScAddressType.scAddressTypeAccount().value &&
    kind !== xdr.ScAddressType.scAddressTypeContract().value
  ) {
    return undefined;
  }
  return Address.fromScAddress(address).toString();
}

function amountOf(data: xdr.ScVal): bigint | undefined {
  const kind = data.switch().value;
  if (kind === xdr.ScValType.scvI128().value) {
    const amount: unknown = scValToNative(data);
    return typeof amount === "bigint" && amount >= 0n ? amount : undefined;
  }
  if (kind === xdr.ScValType.scvMap().value) {
    for (const entry of data.map() ?? []) {
      const key = entry.key();
      if (
        key.switch().value === xdr.ScValType.scvSymbol().value &&
        key.sym().toString() === "amount"
      ) {
        return amountOf(entry.val());
      }
    }
  }
  return undefined;
}

/** The parts of `rpc.Server` the chain reader uses. */
export type StellarTransactionRpc = {
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
  getNetwork(): Promise<rpc.Api.GetNetworkResponse>;
};

export type StellarChainReaderOptions = {
  /**
   * RPC endpoints per network: a URL, or an object with `getTransaction` and
   * `getNetwork` such as an `rpc.Server`. Networks left out use
   * `DEFAULT_STELLAR_RPC_URLS`.
   */
  rpc?: Partial<Record<StellarNetwork, string | StellarTransactionRpc>>;
};

// RPC returns ledger close times as unix seconds, as a number or a numeric
// string depending on the server and SDK version.
const unixSeconds = z
  .union([z.number().int().nonnegative(), z.string().regex(/^[0-9]+$/)])
  .transform((value) => new Date(Number(value) * 1000).toISOString());

const retentionSchema = {
  txHash: z.string().min(1),
  latestLedger: z.number().int().nonnegative(),
  latestLedgerCloseTime: unixSeconds,
  oldestLedger: z.number().int().nonnegative(),
  oldestLedgerCloseTime: unixSeconds,
};

const sdkTransactionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("NOT_FOUND"), ...retentionSchema }),
  z.object({
    status: z.enum(["SUCCESS", "FAILED"]),
    ...retentionSchema,
    ledger: z.number().int().nonnegative(),
    createdAt: unixSeconds,
    feeBump: z.boolean(),
    events: z.object({
      contractEventsXdr: z.array(z.array(z.instanceof(xdr.ContractEvent))),
    }),
  }),
]);

const sdkNetworkSchema = z.object({ passphrase: z.string().min(1) });

/**
 * A `ChainReader` over Soroban RPC `getTransaction`. The reader asks each
 * server for its network passphrase once and reports it with every
 * transaction, so a server on the wrong network is drift, not a silent pass.
 */
export function createStellarChainReader(options: StellarChainReaderOptions = {}): ChainReader {
  const servers = new Map<StellarNetwork, StellarTransactionRpc>();
  const passphrases = new Map<StellarNetwork, Promise<string>>();

  function serverFor(network: StellarNetwork): StellarTransactionRpc {
    const existing = servers.get(network);
    if (existing) return existing;
    const configured = options.rpc?.[network] ?? DEFAULT_STELLAR_RPC_URLS[network];
    const server = typeof configured === "string" ? new rpc.Server(configured) : configured;
    servers.set(network, server);
    return server;
  }

  function passphraseFor(network: StellarNetwork): Promise<string> {
    const cached = passphrases.get(network);
    if (cached) return cached;
    const lookup = serverFor(network)
      .getNetwork()
      .then((response) => {
        const parsed = sdkNetworkSchema.safeParse(response);
        if (!parsed.success) {
          throw new ChainReadError(
            `getNetwork returned a malformed response: ${describeSchemaFailure(parsed.error)}`,
          );
        }
        return parsed.data.passphrase;
      });
    // A failed lookup is not cached, so the next read asks again.
    lookup.catch(() => passphrases.delete(network));
    passphrases.set(network, lookup);
    return lookup;
  }

  return {
    assetContractId: resolveAssetContractId,
    async getTransaction(hash, network): Promise<ChainTransaction> {
      const [networkPassphrase, response] = await Promise.all([
        passphraseFor(network),
        serverFor(network).getTransaction(hash),
      ]);
      const parsed = sdkTransactionSchema.safeParse(response);
      if (!parsed.success) {
        throw new ChainReadError(
          `getTransaction(${hash}) returned a malformed response: ${describeSchemaFailure(parsed.error)}`,
        );
      }
      const tx = parsed.data;
      const retention = {
        hash,
        networkPassphrase,
        latestLedger: tx.latestLedger,
        latestLedgerCloseTime: tx.latestLedgerCloseTime,
        oldestLedger: tx.oldestLedger,
        oldestLedgerCloseTime: tx.oldestLedgerCloseTime,
      };
      const mapped: ChainTransaction =
        tx.status === "NOT_FOUND"
          ? { status: "NOT_FOUND", ...retention }
          : {
              status: tx.status,
              ...retention,
              ledger: tx.ledger,
              createdAt: tx.createdAt,
              feeBump: tx.feeBump,
              transfers: tx.events.contractEventsXdr
                .flat()
                .map(decodeTransferEvent)
                .filter((transfer): transfer is ChainTransfer => transfer !== undefined),
            };
      // The mapped value must satisfy the shape reconciliation parses.
      return chainTransactionSchema.parse(mapped);
    },
  };
}

/** `getChannelState` from @stellar/mpp, or a stand-in with the same signature. */
export type GetChannelState = typeof mppGetChannelState;

export type StellarChannelStateReaderOptions = {
  /** RPC URLs per network. Networks left out use @stellar/mpp's default. */
  rpcUrl?: Partial<Record<StellarNetwork, string>>;
  /** Per-RPC timeout passed to `getChannelState`. Defaults to its 10 seconds. */
  simulationTimeoutMs?: number;
  /** Replaces @stellar/mpp's `getChannelState`, for tests or a custom adapter. */
  getChannelState?: GetChannelState;
};

const mppChannelStateSchema = z.object({
  balance: z.bigint().nonnegative(),
  refundWaitingPeriod: z.number().int().nonnegative(),
  token: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  closeEffectiveAtLedger: z.number().int().nonnegative().nullable(),
  currentLedger: z.number().int().nonnegative(),
});

/**
 * A `ChannelStateReader` over @stellar/mpp's `getChannelState`, which reads
 * the channel contract's getters by simulation and its close ledger from
 * instance storage.
 */
export function createStellarChannelStateReader(
  options: StellarChannelStateReaderOptions = {},
): ChannelStateReader {
  const read = options.getChannelState ?? mppGetChannelState;
  return {
    async getChannelState(channelId, network): Promise<OnChainChannelState> {
      const rpcUrl = options.rpcUrl?.[network];
      const response: unknown = await read({
        channel: channelId,
        network: MPP_NETWORK_ID[network],
        ...(rpcUrl !== undefined ? { rpcUrl } : {}),
        ...(options.simulationTimeoutMs !== undefined
          ? { simulationTimeoutMs: options.simulationTimeoutMs }
          : {}),
      });
      const parsed = mppChannelStateSchema.safeParse(response);
      if (!parsed.success) {
        throw new ChainReadError(
          `getChannelState(${channelId}) returned a malformed state: ${describeSchemaFailure(parsed.error)}`,
        );
      }
      const state = parsed.data;
      return onChainChannelStateSchema.parse({
        balance: state.balance.toString(),
        token: state.token,
        from: state.from,
        to: state.to,
        closeEffectiveAtLedger: state.closeEffectiveAtLedger,
        currentLedger: state.currentLedger,
        refundWaitingPeriod: state.refundWaitingPeriod,
      });
    },
  };
}

/** The fields of a `@vegaforge/tollway-channels` `Channel` a snapshot needs. */
export type ChannelRecordLike = {
  id: string;
  network: StellarNetwork;
  status: string;
  counterparty: string;
  asset: string;
  deposit: string;
  committed: string;
};

/**
 * Builds an `OpenChannelSnapshot` from a channel record, resolving its asset
 * to the token contract. Structural, so it needs no import of
 * `@vegaforge/tollway-channels`.
 */
export function openChannelSnapshot(
  channel: ChannelRecordLike,
  options: { funder?: string } = {},
): OpenChannelSnapshot {
  return {
    channelId: channel.id,
    network: channel.network,
    status: channel.status,
    counterparty: channel.counterparty,
    tokenContract: resolveAssetContractId(channel.asset, channel.network),
    deposit: channel.deposit,
    committed: channel.committed,
    ...(options.funder !== undefined ? { funder: options.funder } : {}),
  };
}
