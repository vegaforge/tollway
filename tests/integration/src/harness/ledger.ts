import {
  Address,
  type Asset,
  BASE_FEE,
  type FeeBumpTransaction,
  type Keypair,
  Operation,
  rpc,
  scValToNative,
  type Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { LOCAL_NETWORK_PASSPHRASE } from "./readiness.js";

/**
 * Chain reads and writes the suite needs, all through Stellar RPC. Every
 * assertion about money checks ledger state here, never only an HTTP status.
 */

/** Stellar classic amounts carry 7 decimals; the SAC exposes the same integer. */
const CLASSIC_DECIMALS = 7n;
const CLASSIC_SCALE = 10n ** CLASSIC_DECIMALS;

/** How many one-second polls a submitted transaction gets before the test fails. */
const CONFIRMATION_ATTEMPTS = 30;

/**
 * Formats integer base units as the decimal string classic operations take,
 * so amounts stay `bigint` everywhere else.
 */
export function toClassicAmount(units: bigint): string {
  if (units < 0n) throw new RangeError(`negative amount ${units}`);
  const whole = units / CLASSIC_SCALE;
  const fraction = (units % CLASSIC_SCALE).toString().padStart(Number(CLASSIC_DECIMALS), "0");
  return `${whole}.${fraction}`;
}

/** Builds, signs and submits `operations` from `source`, then waits for SUCCESS. */
export async function submitOperations(
  server: rpc.Server,
  source: Keypair,
  operations: ReturnType<typeof Operation.payment>[],
  extraSigners: Keypair[] = [],
): Promise<string> {
  const account = await server.getAccount(source.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: LOCAL_NETWORK_PASSPHRASE,
  }).setTimeout(60);
  for (const operation of operations) builder.addOperation(operation);
  const transaction = builder.build();
  transaction.sign(source, ...extraSigners);
  return submit(server, transaction);
}

/** Submits a signed transaction and waits until RPC reports it SUCCESS. */
export async function submit(
  server: rpc.Server,
  transaction: Transaction | FeeBumpTransaction,
): Promise<string> {
  const sent = await server.sendTransaction(transaction);
  if (sent.status !== "PENDING") {
    const code = sent.errorResult?.result().switch().name;
    throw new Error(`sendTransaction returned ${sent.status}${code ? ` (${code})` : ""}`);
  }
  const final = await server.pollTransaction(sent.hash, {
    attempts: CONFIRMATION_ATTEMPTS,
    sleepStrategy: () => 1_000,
  });
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`transaction ${sent.hash} ended as ${final.status}`);
  }
  return sent.hash;
}

/**
 * Deploys the Stellar Asset Contract for a classic asset and returns its
 * contract address, the `asset` x402 and MPP offers name.
 */
export async function deployAssetContract(
  server: rpc.Server,
  asset: Asset,
  deployer: Keypair,
): Promise<string> {
  const account = await server.getAccount(deployer.publicKey());
  const draft = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: LOCAL_NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.createStellarAssetContract({ asset }))
    .setTimeout(60)
    .build();
  // Soroban operations need their footprint and resource fee from simulation.
  const prepared = await server.prepareTransaction(draft);
  prepared.sign(deployer);
  await submit(server, prepared);
  return asset.contractId(LOCAL_NETWORK_PASSPHRASE);
}

/** The account's trustline balance in base units. Throws if it has no trustline. */
export async function balanceOf(
  server: rpc.Server,
  account: string,
  asset: Asset,
): Promise<bigint> {
  const { balanceEntry } = await server.getAssetBalance(account, asset);
  if (!balanceEntry) {
    throw new Error(`${account} has no trustline for ${asset.toString()}`);
  }
  return BigInt(balanceEntry.amount);
}

/**
 * Hashes of the successful transactions that emitted a SEP-41 `transfer`
 * event from `contractId` to `recipient` since `startLedger`. Counting them
 * is how a test proves a payment moved funds once, not only that the gate
 * said so.
 */
export async function transferTransactions(
  server: rpc.Server,
  options: { contractId: string; recipient: string; startLedger: number },
): Promise<string[]> {
  const hashes = new Set<string>();
  let request: rpc.Api.GetEventsRequest = {
    startLedger: options.startLedger,
    filters: [{ type: "contract", contractIds: [options.contractId] }],
    limit: 100,
  };
  for (;;) {
    const page = await server.getEvents(request);
    for (const event of page.events) {
      // No `inSuccessfulContractCall` check: current Stellar RPC omits the
      // field, and getEvents only returns contract events of transactions
      // that succeeded.
      const [name, , to] = event.topic;
      if (!name || !to) continue;
      if (scValToNative(name) !== "transfer") continue;
      if (Address.fromScVal(to).toString() !== options.recipient) continue;
      hashes.add(event.txHash);
    }
    if (page.events.length < 100) break;
    request = { cursor: page.cursor, filters: request.filters, limit: 100 };
  }
  return [...hashes];
}

export async function latestLedger(server: rpc.Server): Promise<number> {
  return (await server.getLatestLedger()).sequence;
}
