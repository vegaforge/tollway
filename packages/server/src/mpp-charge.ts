import { StellarMppError } from "@stellar/mpp";
import { Mppx, type Store, stellar } from "@stellar/mpp/charge/server";
import type { MppChargePayment, PaymentOffer, StellarNetwork } from "@vegaforge/tollway-core";
import { bytesToBase64Url, TollwayError, utf8Bytes } from "@vegaforge/tollway-core";
import { Challenge, Credential, Errors } from "mppx";
import { mockAccount, mockHex } from "./hash.js";
import { mppSourceProofFailure } from "./mpp-payer.js";

/**
 * MPP charge handler. Unlike x402, MPP charge does not use a facilitator.
 * The service verifies and settles the SEP-41 transfer itself through
 * `mppx` and `@stellar/mpp/charge/server`. See docs/design.md, "Build plan",
 * Phase 1.
 *
 * MPP carries its challenge in `WWW-Authenticate: Payment ...` and the
 * agent's credential in `Authorization: Payment ...`, not in x402's
 * PAYMENT-REQUIRED and PAYMENT-SIGNATURE headers. The gate passes the
 * `Payment ...` credential through as `MppChargePayment.payload`.
 */

export type MppChargeVerifyInput = {
  payment: MppChargePayment;
  offer: PaymentOffer;
};

/**
 * The outcome of the offline checks on an MPP credential. A valid one carries
 * the payer and the nonce used to settle it at most once.
 */
export type MppChargeVerifyResult =
  | { valid: true; payer: string; nonce: string }
  | { valid: false; reason: string };

/** A verified MPP charge to settle, with the payer and nonce verification returned. */
export type MppChargeSettleInput = {
  payment: MppChargePayment;
  offer: PaymentOffer;
  payer: string;
  nonce: string;
};

/** The outcome of settling an MPP charge: the transaction hash, or why it failed. */
export type MppChargeSettleResult =
  | { settled: true; txHash: string }
  | { settled: false; reason: string };

/** What a handler needs to build the MPP challenge for an unpaid request. */
export type MppChargeChallengeInput = {
  offer: PaymentOffer;
  /** The request being challenged; only its method and URL are used. */
  request: { method: string; url: string };
};

/** The 402 response `mppx` produced for a request without a credential. */
export type MppChargeChallenge = {
  status: number;
  /** Includes `WWW-Authenticate: Payment ...`, the challenge itself. */
  headers: Record<string, string>;
  /**
   * The body `mppx` sent (a problem+json description in mppx 0.8), or null.
   * The gate keeps its own JSON body and only forwards the headers.
   */
  body: string | null;
};

/**
 * Handles MPP charge payments for the gate. {@link createMppChargeHandler}
 * settles on Stellar through `@stellar/mpp`; {@link createMockMppChargeHandler}
 * runs offline.
 */
export interface MppChargeHandler {
  /**
   * Builds the MPP challenge for a request that carries no credential. A
   * handler without it (the offline mock) adds nothing to the 402.
   */
  challenge?(input: MppChargeChallengeInput): Promise<MppChargeChallenge>;
  /**
   * Offline checks only: decoding, challenge provenance and binding to the
   * offer. Nothing is submitted, so the gate can dedupe before `settle`.
   */
  verify(input: MppChargeVerifyInput): Promise<MppChargeVerifyResult>;
  /** Verifies the payment on chain and settles it. Called at most once per nonce. */
  settle(input: MppChargeSettleInput): Promise<MppChargeSettleResult>;
}

/**
 * Offline MPP charge handler for tests and the demo. Any non-empty payload is
 * valid; payer, nonce, and tx hash are derived from it, so runs and retries
 * are deterministic with no network.
 */
export function createMockMppChargeHandler(): MppChargeHandler {
  return {
    async verify({ payment }) {
      if (!payment.payload) {
        return { valid: false, reason: "empty mpp charge payload" };
      }
      return {
        valid: true,
        payer: mockAccount(payment.payload),
        nonce: mockHex(payment.payload, 32),
      };
    },
    async settle({ nonce, offer }) {
      return { settled: true, txHash: mockHex(`${nonce}:${offer.resource}`) };
    },
  };
}

/** A key pair or `S...` secret, as `@stellar/mpp` accepts it. */
type StellarSigner = NonNullable<stellar.Parameters["feePayer"]>["envelopeSigner"];

/** Configuration for {@link createMppChargeHandler}. */
export type MppChargeOptions = {
  /** Stellar account (G...) or contract (C...) that receives the payment. */
  recipient: string;
  /**
   * SEP-41 token contract (C...) of the asset charged, for example the USDC
   * SAC. The gate's offer `asset` must be this same address.
   */
  currency: string;
  network: StellarNetwork;
  /**
   * HMAC key `mppx` binds its challenges to, so it only accepts credentials
   * for challenges it issued. At least 32 bytes (`mppx` refuses shorter
   * keys); keep it secret and stable across restarts.
   */
  secretKey: string;
  /**
   * Replay protection for challenges and transaction hashes. Required by
   * `@stellar/mpp` 0.7. Use `Store.memory()` for one process; several
   * processes need a shared store with an atomic `update()`.
   */
  store: Store.AtomicStore;
  /**
   * Optional sponsor that pays network fees. With it the agent signs only
   * the transfer; the server rebuilds and signs the envelope. Funds still
   * move from the payer straight to the recipient.
   */
  feePayer?: { envelopeSigner: StellarSigner; feeBumpSigner?: StellarSigner };
  /** Soroban RPC URL. Defaults to the public endpoint for the network. */
  rpcUrl?: string;
  /** Server realm in the challenge. Defaults to "tollway". */
  realm?: string;
};

const MPP_NETWORK: Record<StellarNetwork, "stellar:testnet" | "stellar:pubnet"> = {
  testnet: "stellar:testnet",
  mainnet: "stellar:pubnet",
};

const STELLAR_ACCOUNT = /^G[A-Z2-7]{55}$/;

/**
 * The real MPP charge handler, built on `mppx` and
 * `@stellar/mpp/charge/server`.
 *
 * Amounts stay integer base units end to end: the charge method is created
 * with `decimals: 0`, so `@stellar/mpp` passes the offer amount through
 * unchanged instead of scaling a decimal string.
 *
 * Every challenge is scoped to the offer's resource, and `settle` asks
 * `mppx` to check the credential against the offer's amount and resource,
 * so a credential paid for one route cannot unlock another.
 *
 * The secret key and fee payer secrets are passed to `mppx` and
 * `@stellar/mpp` only; they are never logged or put in a reason.
 */
export function createMppChargeHandler(options: MppChargeOptions): MppChargeHandler {
  if (!options.secretKey) {
    throw new TypeError("createMppChargeHandler: secretKey is required");
  }
  if (typeof options.store?.update !== "function") {
    throw new TypeError(
      "createMppChargeHandler: store must be an atomic mppx store (for example Store.memory())",
    );
  }
  const { secretKey, recipient, currency } = options;
  const network = MPP_NETWORK[options.network];
  const realm = options.realm ?? "tollway";

  const mppx = Mppx.create({
    secretKey,
    realm,
    methods: [
      stellar.charge({
        recipient,
        currency,
        network,
        decimals: 0,
        store: options.store,
        feePayer: options.feePayer,
        rpcUrl: options.rpcUrl,
      }),
    ],
  });

  /** Null when the offer matches this handler, otherwise why not. */
  function offerMismatch(offer: PaymentOffer): string | null {
    if (offer.network !== options.network) {
      return `mpp charge handler is configured for ${options.network}, not ${offer.network}`;
    }
    if (offer.payTo !== recipient) {
      return "mpp charge handler recipient does not match the offer payTo";
    }
    if (offer.asset !== currency) {
      return "mpp charge handler currency does not match the offer asset";
    }
    return null;
  }

  return {
    async challenge({ offer, request }) {
      const mismatch = offerMismatch(offer);
      if (mismatch) {
        throw new TollwayError("payment-failed", mismatch);
      }
      // mppx reads a Web Request. Only the method and URL matter here: the
      // request carries no credential, so mppx answers with a challenge.
      const url = new URL(request.url, `https://${realm}`);
      const result = await mppx.charge({ amount: offer.amount, scope: offer.resource })(
        new Request(url, { method: request.method }),
      );
      if (result.status !== 402) {
        throw new TollwayError(
          "payment-failed",
          "mppx accepted a request that carried no credential",
        );
      }
      const headers: Record<string, string> = {};
      result.challenge.headers.forEach((value, name) => {
        headers[name] = value;
      });
      const body = await result.challenge.text();
      return { status: result.challenge.status, headers, body: body === "" ? null : body };
    },

    async verify({ payment, offer }) {
      const mismatch = offerMismatch(offer);
      if (mismatch) {
        return { valid: false, reason: mismatch };
      }
      let credential: Credential.Credential;
      try {
        credential = Credential.deserialize(payment.payload);
      } catch (error) {
        return { valid: false, reason: `malformed mpp credential: ${errorMessage(error)}` };
      }
      const { challenge } = credential;
      if (challenge.method !== "stellar" || challenge.intent !== "charge") {
        return {
          valid: false,
          reason: `mpp credential is for ${challenge.method}/${challenge.intent}, not stellar/charge`,
        };
      }
      if (!Challenge.verify(challenge, { secretKey })) {
        return { valid: false, reason: "mpp challenge was not issued by this server" };
      }
      if (challenge.request.amount !== offer.amount) {
        return { valid: false, reason: "mpp credential amount does not match the offer" };
      }
      const payer = payerFromSource(credential.source, network);
      if (!payer) {
        return { valid: false, reason: "mpp credential source is not a Stellar account" };
      }
      // The payer is only a name until the credential proves that account
      // signed for this payment. The gate acts on the payer before settlement
      // (service policy), so the proof cannot wait for @stellar/mpp's checks.
      const unproven = mppSourceProofFailure(credential.payload, {
        challengeId: challenge.id,
        payer,
        network: options.network,
      });
      if (unproven) {
        return { valid: false, reason: unproven };
      }
      return { valid: true, payer, nonce: await deriveMppChargeNonce(payment.payload) };
    },

    async settle({ payment, offer }) {
      let receipt: { reference: string };
      try {
        receipt = await mppx.verifyCredential(payment.payload, {
          request: { amount: offer.amount },
          scope: offer.resource,
        });
      } catch (error) {
        // A network failure says nothing about the payment, so it is thrown
        // for the caller to retry or alert on. Everything else came out of
        // mppx or @stellar/mpp judging this credential (an mppx PaymentError,
        // a StellarMppError, or an SDK error on a malformed transaction) and
        // is a rejection of the payment.
        if (isTransportFailure(error)) {
          throw new TollwayError(
            "payment-failed",
            `mpp charge settlement failed: ${errorMessage(error)}`,
          );
        }
        return { settled: false, reason: `mpp charge rejected: ${rejectionMessage(error)}` };
      }
      return { settled: true, txHash: receipt.reference };
    },
  };
}

/** Reads the payer's G... account from a `did:pkh:stellar:<network>:<account>` source. */
function payerFromSource(source: string | undefined, network: string): string | null {
  if (!source) return null;
  const prefix = `did:pkh:${network}:`;
  if (!source.startsWith(prefix)) return null;
  const account = source.slice(prefix.length);
  return STELLAR_ACCOUNT.test(account) ? account : null;
}

const TRANSPORT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * True for errors raised by the HTTP layer rather than by payment checks:
 * axios errors (stellar-sdk's RPC client), fetch's `TypeError`, aborts and
 * timeouts, and socket error codes.
 */
function isTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof Errors.PaymentError || error instanceof StellarMppError) return false;
  if ("isAxiosError" in error && error.isAxiosError === true) return true;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  if (error instanceof TypeError && error.message === "fetch failed") return true;
  const code = "code" in error ? error.code : undefined;
  return typeof code === "string" && TRANSPORT_ERROR_CODES.has(code);
}

function rejectionMessage(error: unknown): string {
  if (error instanceof Errors.PaymentError || error instanceof StellarMppError) {
    return error.message;
  }
  return `invalid payment: ${errorMessage(error)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A stable idempotency key for an MPP charge payment. The payload is unique
 * per payment, so its SHA-256 digest dedupes retries without leaking the
 * payload into cache keys or logs.
 */
export async function deriveMppChargeNonce(payload: string): Promise<string> {
  const data = new Uint8Array(utf8Bytes(payload));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToBase64Url(new Uint8Array(digest));
}
