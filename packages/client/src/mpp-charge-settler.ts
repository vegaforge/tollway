/**
 * The MPP charge settler: pays an `mpp-charge` route on Stellar with
 * `@stellar/mpp/charge/client` and returns the Tollway receipt the service
 * sends back. Issue #185.
 *
 * Wire format (MPP, as the gate speaks it; see packages/server/src/mpp-charge.ts):
 * - The service answers the first request with 402 and a
 *   `WWW-Authenticate: Payment ...` challenge. A Stellar charge challenge has
 *   method `stellar`, intent `charge`, and a request carrying `amount` (base
 *   units), `currency` (the token contract), `recipient` and
 *   `methodDetails.network`.
 * - The agent builds the SEP-41 transfer, signs it, and retries with
 *   `Authorization: Payment ...`.
 * - The service settles and answers with the resource and Tollway's signed
 *   receipt in TOLLWAY-RECEIPT. When it also sends MPP's own
 *   `Payment-Receipt`, its `reference` is the transaction hash, and it must
 *   match the Tollway receipt.
 *
 * Everything in the challenge is checked against the offer the client's
 * policy approved before anything is signed. `@stellar/mpp` only checks that
 * the transaction it builds matches the challenge; it cannot know what the
 * agent agreed to pay.
 *
 * The secret key goes to `@stellar/mpp` once, when the settler is created.
 * The settler never stores it, logs it or puts it in an error.
 */

import { stellar } from "@stellar/mpp/charge/client";
import { Asset, type Keypair, Networks } from "@stellar/stellar-sdk";
import { type SignedReceipt, type StellarNetwork, TollwayError } from "@vegaforge/tollway-core";
import { Challenge, Receipt } from "mppx";
import { Mppx } from "mppx/client";
import { z } from "zod";
import type { ClientSettler, SettleRequest } from "./index.js";
import { messageOf, readReceiptHeader, TOLLWAY_RECEIPT_HEADER } from "./receipt-header.js";

/** How the charge transaction reaches the chain; see the `mode` option. */
export type MppChargeMode = "pull" | "push";

type SignerOption =
  | {
      /** Stellar secret key (S...). Provide this or `keypair`, not both. */
      secretKey: string;
      keypair?: undefined;
    }
  | {
      /** Stellar keypair. Provide this or `secretKey`, not both. */
      keypair: Keypair;
      secretKey?: undefined;
    };

export type MppChargeSettlerOptions = SignerOption & {
  network: StellarNetwork;
  /** Soroban RPC URL for simulation and, in push mode, submission. Defaults to the public one. */
  rpcUrl?: string;
  /**
   * `pull` (the default): the agent signs the transaction and the service
   * submits it, so the service (or its fee payer) pays the network fee.
   *
   * `push`: the agent submits the transaction itself and sends the hash. The
   * agent then pays the network fee, so its account needs XLM as well as the
   * token, and the payment has landed on chain before the service answers.
   */
  mode?: MppChargeMode;
  /** Defaults to the global `fetch`. Inject one in tests. It is never patched. */
  fetch?: typeof globalThis.fetch;
  /** The header the Tollway receipt arrives in. Defaults to TOLLWAY-RECEIPT. */
  receiptHeader?: string;
  /** HTTP method for the paid request. Defaults to GET. */
  method?: string;
};

/** The network id MPP puts in `methodDetails.network`, per Tollway network. */
export const MPP_NETWORK_ID: Record<StellarNetwork, "stellar:testnet" | "stellar:pubnet"> = {
  testnet: "stellar:testnet",
  mainnet: "stellar:pubnet",
};

function networkPassphrase(network: StellarNetwork): string {
  return network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
}

/** The parts of a Stellar charge request the settler checks. Extra fields are allowed. */
const chargeRequestSchema = z.object({
  amount: z.string(),
  currency: z.string(),
  recipient: z.string(),
  methodDetails: z.object({ network: z.string() }).optional(),
});

type ChargeRequest = z.infer<typeof chargeRequestSchema>;

const CONTRACT_ADDRESS = /^C[A-Z2-7]{55}$/;
const CLASSIC_ASSET = /^([A-Za-z0-9]{1,12}):(G[A-Z2-7]{55})$/;

/**
 * The token contract an offer's asset is paid in. MPP's `currency` is a
 * contract address. An offer may name the contract directly (`C...`), a
 * classic asset as `CODE:ISSUER`, or `native` for XLM; the last two map to
 * their Stellar Asset Contract on the offer's network.
 */
export function offerAssetContract(asset: string, network: StellarNetwork): string {
  if (CONTRACT_ADDRESS.test(asset)) return asset;
  const passphrase = networkPassphrase(network);
  if (asset === "native") return Asset.native().contractId(passphrase);
  const classic = CLASSIC_ASSET.exec(asset);
  if (classic) {
    const [, code, issuer] = classic;
    if (code !== undefined && issuer !== undefined) {
      return new Asset(code, issuer).contractId(passphrase);
    }
  }
  throw new TollwayError(
    "payment-failed",
    `the offer asset ${asset} is not a contract address, CODE:ISSUER or native`,
  );
}

/**
 * Creates a `ClientSettler` for MPP charge on Stellar. For each settlement
 * it requests the resource, checks the Stellar charge challenge against the
 * offer, signs (and in push mode submits) the transfer, retries with the
 * credential, and returns the Tollway receipt.
 */
export function createMppChargeSettler(options: MppChargeSettlerOptions): ClientSettler {
  if ((options.secretKey === undefined) === (options.keypair === undefined)) {
    throw new TypeError("createMppChargeSettler: provide exactly one of secretKey or keypair");
  }
  const { network } = options;
  const networkId = MPP_NETWORK_ID[network];
  const doFetch = options.fetch ?? globalThis.fetch;
  const method = options.method ?? "GET";
  const receiptHeader = options.receiptHeader ?? TOLLWAY_RECEIPT_HEADER;

  // The key is handed to @stellar/mpp here and not kept anywhere else.
  const chargeMethod = stellar.charge({
    ...(options.secretKey !== undefined
      ? { secretKey: options.secretKey }
      : { keypair: options.keypair }),
    // Tollway amounts are already base units, and so are MPP challenge amounts.
    decimals: 0,
    ...(options.rpcUrl !== undefined ? { rpcUrl: options.rpcUrl } : {}),
    mode: options.mode ?? "pull",
  });
  // polyfill: false, so globalThis.fetch is never replaced. Only
  // createCredential is used: the settler makes both HTTP requests itself.
  const mppx = Mppx.create({ methods: [chargeMethod], fetch: doFetch, polyfill: false });

  return {
    async settle({ resource, offer, model }: SettleRequest): Promise<SignedReceipt> {
      if (model !== "mpp-charge") {
        throw new TollwayError(
          "payment-failed",
          `the MPP charge settler cannot settle model "${model}"`,
        );
      }
      if (offer.network !== network) {
        throw new TollwayError(
          "payment-failed",
          `the MPP charge settler is configured for ${network}, but the offer is on ${offer.network}`,
        );
      }
      const currency = offerAssetContract(offer.asset, network);

      const first = await doFetch(resource, { method });
      if (first.status !== 402) {
        throw new TollwayError(
          "payment-failed",
          `expected a 402 challenge from ${resource}, got ${first.status}`,
        );
      }
      const challenge = selectChallenge(first, resource, (request) =>
        offerMismatch(request, offer, currency, networkId),
      );

      let credential: string;
      try {
        credential = await mppx.createCredential(first, undefined, {
          // Pin the credential to the challenge that was checked.
          orderChallenges: (candidates) =>
            candidates.filter((candidate) => candidate.challenge.id === challenge.id),
        });
      } catch (error) {
        throw new TollwayError(
          "payment-failed",
          `could not create the MPP charge credential for ${resource}: ${messageOf(error)}`,
        );
      }

      const paid = await doFetch(resource, { method, headers: { Authorization: credential } });
      if (paid.status === 402) {
        throw new TollwayError(
          "payment-failed",
          `${resource} answered the MPP credential with another 402`,
        );
      }
      if (!paid.ok) {
        throw new TollwayError(
          "payment-failed",
          `${resource} answered the MPP credential with ${paid.status}`,
        );
      }

      const receipt = readReceiptHeader(paid, resource, receiptHeader);
      assertReceiptMatches(receipt, offer, resource);
      assertMppReferenceMatches(paid, receipt, resource);
      return receipt;
    },
  };
}

/**
 * The Stellar charge challenge from a 402 whose request matches the offer.
 * Rejects when the 402 has no Stellar charge challenge, or when none of
 * them matches; the error names the first mismatch.
 */
function selectChallenge(
  response: Response,
  resource: string,
  mismatch: (request: ChargeRequest) => string | null,
): Challenge.Challenge {
  let challenges: Challenge.Challenge[];
  try {
    challenges = Challenge.fromResponseList(response);
  } catch (error) {
    throw new TollwayError(
      "payment-failed",
      `the 402 from ${resource} carries no readable MPP challenge: ${messageOf(error)}`,
    );
  }
  const stellarCharges = challenges.filter(
    (candidate) => candidate.method === "stellar" && candidate.intent === "charge",
  );
  if (stellarCharges.length === 0) {
    throw new TollwayError(
      "payment-failed",
      `the 402 from ${resource} has no Stellar MPP charge challenge`,
    );
  }
  let firstReason: string | undefined;
  for (const candidate of stellarCharges) {
    const parsed = chargeRequestSchema.safeParse(candidate.request);
    const reason = parsed.success
      ? mismatch(parsed.data)
      : "its request is not a Stellar charge request";
    if (reason === null) return candidate;
    firstReason ??= reason;
  }
  throw new TollwayError(
    "payment-failed",
    `the MPP challenge from ${resource} does not match the offer: ${firstReason}`,
  );
}

/** Null when the challenge asks for exactly the approved offer, otherwise why not. */
function offerMismatch(
  request: ChargeRequest,
  offer: SettleRequest["offer"],
  currency: string,
  networkId: string,
): string | null {
  if (request.amount !== offer.amount) {
    return `it asks for ${request.amount}, but the offer was ${offer.amount}`;
  }
  if (request.recipient !== offer.payTo) {
    return `it pays ${request.recipient}, not the offer's payee ${offer.payTo}`;
  }
  if (request.currency !== currency) {
    return `it charges ${request.currency}, not ${currency}`;
  }
  // @stellar/mpp falls back to testnet when the network is missing. The
  // settler does not guess: the challenge must name the offer's network.
  const challengeNetwork = request.methodDetails?.network;
  if (challengeNetwork !== networkId) {
    return `it is for network ${challengeNetwork ?? "(none)"}, not ${networkId}`;
  }
  return null;
}

/** The receipt must describe the MPP charge that was approved. */
function assertReceiptMatches(
  receipt: SignedReceipt,
  offer: SettleRequest["offer"],
  resource: string,
): void {
  const body = receipt.receipt;
  const problems: string[] = [];
  if (body.model !== "mpp-charge") problems.push(`model is ${body.model}, not mpp-charge`);
  if (body.amount !== offer.amount) problems.push(`amount is ${body.amount}, not ${offer.amount}`);
  if (body.payee !== offer.payTo) problems.push(`payee is ${body.payee}, not ${offer.payTo}`);
  if (body.network !== offer.network)
    problems.push(`network is ${body.network}, not ${offer.network}`);
  if (problems.length > 0) {
    throw new TollwayError(
      "invalid-receipt",
      `the receipt from ${resource} does not match the offer: ${problems.join("; ")}`,
    );
  }
}

/**
 * When the service also sends MPP's `Payment-Receipt`, its `reference` is
 * the transaction hash and must equal the Tollway receipt's `txHash`.
 */
function assertMppReferenceMatches(
  response: Response,
  receipt: SignedReceipt,
  resource: string,
): void {
  if (!response.headers.has("Payment-Receipt")) return;
  let reference: string;
  try {
    reference = Receipt.fromResponse(response).reference;
  } catch (error) {
    throw new TollwayError(
      "invalid-receipt",
      `the Payment-Receipt header from ${resource} is not a valid MPP receipt: ${messageOf(error)}`,
    );
  }
  const settlement = receipt.receipt.settlement;
  if (settlement.kind !== "transaction" || settlement.txHash !== reference) {
    throw new TollwayError(
      "invalid-receipt",
      `the Tollway receipt from ${resource} does not name the transaction ${reference} in its MPP receipt`,
    );
  }
}
