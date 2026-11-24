import { Address, rpc, scValToNative, Transaction, type xdr } from "@stellar/stellar-sdk";
import { STELLAR_PUBNET_CAIP2, STELLAR_TESTNET_CAIP2 } from "@x402/stellar";

/**
 * Local pre-validation of x402 `exact` payments on Stellar (#159). It runs
 * the static checks `@x402/stellar`'s facilitator runs before it simulates
 * the transaction, in the same order and with the same reason names, so a
 * payment that cannot pass them is refused without a `/verify` round trip.
 *
 * It is a filter, never an authority: a payment that passes still goes to
 * `/verify`, and nothing here can make an invalid payment valid. Simulation,
 * fees and signatures stay the facilitator's job. Everything is synchronous
 * and allocation-light, so it is cheap enough to run on every request.
 */

/**
 * Why a payment was refused locally. Where a reason overlaps a check the
 * facilitator runs, the name is its `invalidReason` from `@x402/stellar`
 * 2.31, so logs and clients see one vocabulary. Three are Tollway's own,
 * because the facilitator has no equivalent: `payment_signature_too_large`,
 * and `invalid_exact_stellar_signature_expired` for an authorization already
 * behind the latest ledger (the facilitator only checks one too far ahead).
 */
export type PrevalidationReason =
  | "payment_signature_too_large"
  | "unsupported_scheme"
  | "network_mismatch"
  | "invalid_network"
  | "invalid_exact_stellar_payload_malformed"
  | "invalid_exact_stellar_payload_wrong_operation"
  | "invalid_exact_stellar_payload_wrong_asset"
  | "invalid_exact_stellar_payload_wrong_function_name"
  | "invalid_exact_stellar_payload_wrong_recipient"
  | "invalid_exact_stellar_payload_wrong_amount"
  | "invalid_exact_stellar_payload_no_auth_entries"
  | "invalid_exact_stellar_payload_unsupported_credential_type"
  | "invalid_exact_stellar_signature_expired";

export type PrevalidationResult = { valid: true } | { valid: false; reason: PrevalidationReason };

/** The offer terms a payment is checked against, as x402 `PaymentRequirements` name them. */
export type StellarExactTerms = {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  amount: string;
};

export type StellarExactCheckOptions = {
  /** What the payer says it accepted; its scheme and network must match. */
  accepted?: Pick<StellarExactTerms, "scheme" | "network">;
  /**
   * The latest closed ledger. When set, an address authorization whose
   * `signatureExpirationLedger` is already behind it is refused. Leave it
   * unset to skip the check.
   */
  latestLedger?: number;
  /** Longest transaction string accepted, checked before decoding. */
  maxTransactionLength?: number;
};

/**
 * The default cap on the `PAYMENT-SIGNATURE` header, in characters. A real
 * x402 Stellar payment (one invoke-contract operation and one auth entry,
 * base64 inside a base64 JSON payload) is around 1.5 KiB; 16 KiB leaves room
 * for larger auth entries while refusing a flood of oversized headers before
 * anything is decoded.
 */
export const DEFAULT_MAX_PAYMENT_SIGNATURE_LENGTH = 16 * 1024;

const PASSPHRASES: Record<string, string> = {
  [STELLAR_TESTNET_CAIP2]: "Test SDF Network ; September 2015",
  [STELLAR_PUBNET_CAIP2]: "Public Global Stellar Network ; September 2015",
};

const INTEGER = /^[0-9]+$/;

/**
 * Checks a base64 Stellar transaction envelope against the offer's terms.
 * Returns a rejection reason, or `{ valid: true }` when every static check
 * passes. It never throws: anything the SDK cannot read is `malformed`.
 *
 * The network passphrase is not part of the envelope bytes (it only enters
 * the signature hash), so a payment signed for the wrong network cannot be
 * told apart here without verifying signatures. The network check is the
 * payer's own `accepted.network`; the facilitator's simulation catches the
 * rest.
 */
export function checkStellarExactPayment(
  transaction: string,
  terms: StellarExactTerms,
  options: StellarExactCheckOptions = {},
): PrevalidationResult {
  const maxLength = options.maxTransactionLength ?? DEFAULT_MAX_PAYMENT_SIGNATURE_LENGTH;
  if (transaction.length > maxLength) return reject("payment_signature_too_large");

  if (terms.scheme !== "exact" || (options.accepted && options.accepted.scheme !== "exact")) {
    return reject("unsupported_scheme");
  }
  if (options.accepted && options.accepted.network !== terms.network) {
    return reject("network_mismatch");
  }
  const passphrase = PASSPHRASES[terms.network];
  if (!passphrase) return reject("invalid_network");

  let parsed: Transaction;
  try {
    parsed = new Transaction(transaction, passphrase);
  } catch {
    // The SDK throws on bytes that are not a transaction envelope, and on a
    // fee-bump envelope, which the facilitator refuses the same way.
    return reject("invalid_exact_stellar_payload_malformed");
  }

  try {
    return checkOperation(parsed, terms, options.latestLedger);
  } catch {
    // XDR accessors throw on a union arm the envelope does not carry. A
    // payment whose shape the SDK cannot walk is malformed, not a crash.
    return reject("invalid_exact_stellar_payload_malformed");
  }
}

function checkOperation(
  parsed: Transaction,
  terms: StellarExactTerms,
  latestLedger: number | undefined,
): PrevalidationResult {
  const [operation, ...extra] = parsed.operations;
  if (!operation || extra.length > 0 || operation.type !== "invokeHostFunction") {
    return reject("invalid_exact_stellar_payload_wrong_operation");
  }
  if (operation.func.switch().name !== "hostFunctionTypeInvokeContract") {
    return reject("invalid_exact_stellar_payload_wrong_operation");
  }
  const invocation = operation.func.invokeContract();
  if (Address.fromScAddress(invocation.contractAddress()).toString() !== terms.asset) {
    return reject("invalid_exact_stellar_payload_wrong_asset");
  }
  const args = invocation.args();
  if (invocation.functionName().toString() !== "transfer" || args.length !== 3) {
    return reject("invalid_exact_stellar_payload_wrong_function_name");
  }
  const [, toArg, amountArg] = args as [xdr.ScVal, xdr.ScVal, xdr.ScVal];
  if (scValToNative(toArg) !== terms.payTo) {
    return reject("invalid_exact_stellar_payload_wrong_recipient");
  }
  // i128 decodes to a bigint. The offer amount is an integer string; compare
  // them as integers, never as strings or floats (AGENTS.md item 2).
  const amount: unknown = scValToNative(amountArg);
  // Never stricter than the facilitator, which compares `BigInt`s, so a
  // payment it would accept is never refused here.
  if (
    typeof amount !== "bigint" ||
    !INTEGER.test(terms.amount) ||
    amount !== BigInt(terms.amount)
  ) {
    return reject("invalid_exact_stellar_payload_wrong_amount");
  }

  const auth = operation.auth ?? [];
  if (auth.length === 0) return reject("invalid_exact_stellar_payload_no_auth_entries");
  for (const entry of auth) {
    const credentials = entry.credentials();
    if (credentials.switch().name !== "sorobanCredentialsAddress") {
      return reject("invalid_exact_stellar_payload_unsupported_credential_type");
    }
    if (
      latestLedger !== undefined &&
      credentials.address().signatureExpirationLedger() < latestLedger
    ) {
      return reject("invalid_exact_stellar_signature_expired");
    }
  }
  return { valid: true };
}

function reject(reason: PrevalidationReason): PrevalidationResult {
  return { valid: false, reason };
}

/** A cached view of the latest closed ledger, for the optional expiry check. */
export interface LatestLedgerSource {
  /**
   * The latest ledger sequence, or undefined when it is not known right now.
   * Undefined means "skip the expiry check", never "refuse the payment".
   */
  latest(): Promise<number | undefined>;
}

export type LatestLedgerSourceOptions = {
  /** Stellar RPC URL; `getLatestLedger` is called on it. */
  rpcUrl?: string;
  /** Overrides the RPC call, for tests or a custom client. */
  getLatestLedger?: () => Promise<number>;
  /**
   * How long a fetched ledger is reused, in milliseconds. Defaults to 5 000,
   * about one ledger close: the check only needs to catch authorizations
   * that are clearly stale, and a slightly old value only lets more through.
   */
  ttlMs?: number;
  /** Called when a lookup fails or answers nonsense. The check is skipped for that request. */
  onError?: (error: Error) => void;
  /** Clock in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
};

const DEFAULT_LEDGER_TTL_MS = 5_000;

/**
 * Builds a {@link LatestLedgerSource} that asks Stellar RPC at most once per
 * TTL. Concurrent callers share one lookup. A failed lookup is reported to
 * `onError` and answers undefined, so the gate skips the expiry check rather
 * than refusing payments while RPC is down.
 */
export function createLatestLedgerSource(options: LatestLedgerSourceOptions): LatestLedgerSource {
  const fetchLedger = options.getLatestLedger ?? rpcLookup(options.rpcUrl);
  const ttlMs = options.ttlMs ?? DEFAULT_LEDGER_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) {
    throw new TypeError("ttlMs must be a non-negative integer number of milliseconds");
  }
  const now = options.now ?? Date.now;
  let cached: { ledger: number; at: number } | undefined;
  let pending: Promise<number | undefined> | undefined;

  async function refresh(): Promise<number | undefined> {
    const at = now();
    try {
      const ledger = await fetchLedger();
      if (!Number.isSafeInteger(ledger) || ledger < 0) {
        throw new Error(`latest ledger lookup answered ${String(ledger)}, not a ledger sequence`);
      }
      cached = { ledger, at };
      return ledger;
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
      return undefined;
    }
  }

  return {
    latest() {
      if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.ledger);
      pending ??= refresh().finally(() => {
        pending = undefined;
      });
      return pending;
    },
  };
}

function rpcLookup(rpcUrl: string | undefined): () => Promise<number> {
  if (!rpcUrl) {
    throw new TypeError("createLatestLedgerSource needs rpcUrl or getLatestLedger");
  }
  const server = new rpc.Server(rpcUrl);
  return async () => (await server.getLatestLedger()).sequence;
}
