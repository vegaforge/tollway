/**
 * On-chain confirmation for x402 and MPP charge receipts (#211).
 *
 * Fetches the settlement transaction from Soroban RPC `getTransaction`,
 * checks that it succeeded on the receipt's network, and verifies that it
 * contains a SEP-41 token transfer event of the receipt's amount and asset
 * from `receipt.payer` to `receipt.payee`.
 */

import { Asset, Networks, type rpc, scValToNative, StrKey, type xdr } from "@stellar/stellar-sdk";
import type { SignedReceipt, StellarNetwork } from "@vegaforge/tollway-core";

export type ChargeDriftKind =
  | "transaction-not-found"
  | "transaction-failed"
  | "network-mismatch"
  | "transfer-mismatch";

export type ChargeDrift = {
  kind: ChargeDriftKind;
  detail: string;
};

/** Subset of Soroban `rpc.Server` needed to confirm a charge receipt. */
export type ChargeRpcSource = {
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
  getNetwork?(): Promise<{ passphrase: string }>;
};

export const NETWORK_PASSPHRASE: Record<StellarNetwork, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
};

const CONTRACT_ADDRESS_RE = /^C[A-Z2-7]{55}$/;

/**
 * Resolves a Tollway asset identifier (`C...` SAC address, `"native"` / `"XLM"`,
 * or `"CODE:ISSUER"`) to its Soroban Asset Contract address on `network`.
 */
export function resolveAssetContractId(asset: string, network: StellarNetwork): string {
  if (CONTRACT_ADDRESS_RE.test(asset)) {
    return asset;
  }
  const passphrase = NETWORK_PASSPHRASE[network];
  if (asset === "native" || asset === "XLM") {
    return Asset.native().contractId(passphrase);
  }
  const colon = asset.indexOf(":");
  if (colon > 0 && colon < asset.length - 1) {
    const code = asset.slice(0, colon);
    const issuer = asset.slice(colon + 1);
    return new Asset(code, issuer).contractId(passphrase);
  }
  throw new TypeError(`unsupported asset format "${asset}"; expected C..., native, or CODE:ISSUER`);
}

type DecodedTransfer = {
  contractId: string;
  from: string;
  to: string;
  amount: bigint;
};

/**
 * Confirms a validated transaction-settled receipt against Soroban RPC.
 * Returns an array of drift items (empty when the on-chain transfer matches).
 */
export async function confirmChargeOnChain(
  receipt: SignedReceipt,
  source: ChargeRpcSource,
): Promise<ChargeDrift[]> {
  const body = receipt.receipt;
  if (body.settlement.kind !== "transaction") {
    return [];
  }

  const drifts: ChargeDrift[] = [];
  const expectedPassphrase = NETWORK_PASSPHRASE[body.network];

  if (source.getNetwork) {
    const net = await source.getNetwork();
    if (net.passphrase !== expectedPassphrase) {
      drifts.push({
        kind: "network-mismatch",
        detail: `RPC network passphrase "${net.passphrase}" does not match receipt network "${body.network}"`,
      });
      return drifts;
    }
  }

  const txHash = body.settlement.txHash;
  const tx = await source.getTransaction(txHash);

  if (tx.status === "NOT_FOUND") {
    drifts.push({
      kind: "transaction-not-found",
      detail: `transaction ${txHash} was not found on ${body.network} (latestLedger=${tx.latestLedger})`,
    });
    return drifts;
  }

  if (tx.status === "FAILED") {
    drifts.push({
      kind: "transaction-failed",
      detail: `transaction ${txHash} failed on ${body.network}`,
    });
    return drifts;
  }

  let expectedContractId: string;
  try {
    expectedContractId = resolveAssetContractId(body.asset, body.network);
  } catch (error) {
    drifts.push({
      kind: "transfer-mismatch",
      detail: `cannot resolve asset "${body.asset}" on ${body.network}: ${error instanceof Error ? error.message : String(error)}`,
    });
    return drifts;
  }

  const expectedAmount = BigInt(body.amount);
  const transfers = extractTransfers(tx.events?.contractEventsXdr ?? []);

  const matched = transfers.some(
    (t) =>
      t.contractId === expectedContractId &&
      t.from === body.payer &&
      t.to === body.payee &&
      t.amount === expectedAmount,
  );

  if (!matched) {
    drifts.push({
      kind: "transfer-mismatch",
      detail:
        `transaction ${txHash} contains no SEP-41 transfer of ${body.amount} ` +
        `on contract ${expectedContractId} from ${body.payer} to ${body.payee} ` +
        `(observed ${transfers.length} transfer event(s))`,
    });
  }

  return drifts;
}

function extractTransfers(contractEventsXdr: readonly (readonly xdr.ContractEvent[])[]): DecodedTransfer[] {
  const transfers: DecodedTransfer[] = [];
  for (const opEvents of contractEventsXdr) {
    for (const event of opEvents) {
      const decoded = decodeTransferEvent(event);
      if (decoded) transfers.push(decoded);
    }
  }
  return transfers;
}

function decodeTransferEvent(event: xdr.ContractEvent): DecodedTransfer | undefined {
  const rawContractId = event.contractId();
  if (!rawContractId) return undefined;
  const contractId = StrKey.encodeContract(rawContractId);

  const body = event.body();
  if (body.switch().value !== 0) return undefined;
  const v0 = body.v0();
  const topics = v0.topics();
  if (topics.length < 3) return undefined;

  const eventName = safeScValToNative(topics[0]);
  if (eventName !== "transfer") return undefined;

  const from = safeScValToNative(topics[1]);
  const to = safeScValToNative(topics[2]);
  if (typeof from !== "string" || typeof to !== "string") return undefined;

  const data = safeScValToNative(v0.data());
  let amount: bigint | undefined;
  if (typeof data === "bigint") {
    amount = data;
  } else if (
    typeof data === "object" &&
    data !== null &&
    "amount" in data &&
    typeof (data as { amount: unknown }).amount === "bigint"
  ) {
    amount = (data as { amount: bigint }).amount;
  }
  if (amount === undefined) return undefined;

  return { contractId, from, to, amount };
}

function safeScValToNative(val: xdr.ScVal | undefined): unknown {
  if (!val) return undefined;
  try {
    return scValToNative(val);
  } catch {
    return undefined;
  }
}
