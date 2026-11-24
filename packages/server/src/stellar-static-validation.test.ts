import { Keypair, nativeToScVal } from "@stellar/stellar-sdk";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  checkStellarExactPayment,
  createLatestLedgerSource,
  type PrevalidationReason,
} from "./stellar-static-validation.js";
import { envelope, OTHER_ASSET, PAY_TO, REQUIREMENTS } from "./testing/stellar-envelopes.js";

/**
 * Issue #159: the static checks `@x402/stellar`'s facilitator runs before
 * simulation, run locally so a junk payment never costs a /verify call.
 */

function reasonOf(transaction: string, latestLedger?: number): PrevalidationReason | undefined {
  const result = checkStellarExactPayment(transaction, REQUIREMENTS, {
    accepted: REQUIREMENTS,
    ...(latestLedger === undefined ? {} : { latestLedger }),
  });
  return result.valid ? undefined : result.reason;
}

describe("checkStellarExactPayment", () => {
  it("accepts a well-formed transfer to the payee for the offer amount", () => {
    expect(checkStellarExactPayment(envelope(), REQUIREMENTS, { accepted: REQUIREMENTS })).toEqual({
      valid: true,
    });
  });

  it.each<[string, () => string, PrevalidationReason]>([
    ["an undecodable envelope", () => "not-xdr", "invalid_exact_stellar_payload_malformed"],
    [
      "two operations",
      () => envelope({ operations: "two" }),
      "invalid_exact_stellar_payload_wrong_operation",
    ],
    [
      "a non-Soroban operation",
      () => envelope({ operations: "payment" }),
      "invalid_exact_stellar_payload_wrong_operation",
    ],
    [
      "a host function that is not invoke-contract",
      () => envelope({ hostFunction: "upload" }),
      "invalid_exact_stellar_payload_wrong_operation",
    ],
    [
      "another contract",
      () => envelope({ asset: OTHER_ASSET }),
      "invalid_exact_stellar_payload_wrong_asset",
    ],
    [
      "a function other than transfer",
      () => envelope({ functionName: "approve" }),
      "invalid_exact_stellar_payload_wrong_function_name",
    ],
    [
      "transfer with two arguments",
      () => envelope({ args: [nativeToScVal(PAY_TO, { type: "address" }), nativeToScVal(1n)] }),
      "invalid_exact_stellar_payload_wrong_function_name",
    ],
    [
      "another recipient",
      () => envelope({ to: Keypair.random().publicKey() }),
      "invalid_exact_stellar_payload_wrong_recipient",
    ],
    [
      "a smaller amount",
      () => envelope({ amount: 9_999n }),
      "invalid_exact_stellar_payload_wrong_amount",
    ],
    [
      "no auth entries",
      () => envelope({ auth: "none" }),
      "invalid_exact_stellar_payload_no_auth_entries",
    ],
    [
      "source-account credentials",
      () => envelope({ auth: "source-account" }),
      "invalid_exact_stellar_payload_unsupported_credential_type",
    ],
  ])("rejects %s", (_name, build, reason) => {
    expect(reasonOf(build())).toBe(reason);
  });

  it("rejects a payment that accepted another network or scheme", () => {
    expect(
      checkStellarExactPayment(envelope(), REQUIREMENTS, {
        accepted: { ...REQUIREMENTS, network: "stellar:pubnet" },
      }),
    ).toEqual({ valid: false, reason: "network_mismatch" });
    expect(
      checkStellarExactPayment(envelope(), REQUIREMENTS, {
        accepted: { ...REQUIREMENTS, scheme: "upto" },
      }),
    ).toEqual({ valid: false, reason: "unsupported_scheme" });
  });

  it("rejects a transaction longer than the cap before decoding it", () => {
    expect(
      checkStellarExactPayment(envelope(), REQUIREMENTS, {
        accepted: REQUIREMENTS,
        maxTransactionLength: 100,
      }),
    ).toEqual({ valid: false, reason: "payment_signature_too_large" });
  });

  it("rejects an authorization that expired behind the latest ledger, and skips the check without one", () => {
    const expiring = envelope({ expirationLedger: 500 });
    expect(reasonOf(expiring, 501)).toBe("invalid_exact_stellar_signature_expired");
    expect(reasonOf(expiring, 500)).toBeUndefined();
    expect(reasonOf(expiring)).toBeUndefined();
  });

  it("compares amounts as integers, as the facilitator does, never as strings", () => {
    // "010000" and 10000n are the same integer: the facilitator accepts the
    // pair, so the local filter must not be stricter.
    expect(checkStellarExactPayment(envelope(), { ...REQUIREMENTS, amount: "010000" })).toEqual({
      valid: true,
    });
    expect(checkStellarExactPayment(envelope(), { ...REQUIREMENTS, amount: "1e4" })).toEqual({
      valid: false,
      reason: "invalid_exact_stellar_payload_wrong_amount",
    });
  });

  it("never throws and never accepts random bytes or random base64", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.uint8Array({ maxLength: 2_048 }).map((bytes) => Buffer.from(bytes).toString("base64")),
        ),
        (candidate) => {
          const result = checkStellarExactPayment(candidate, REQUIREMENTS, {
            accepted: REQUIREMENTS,
          });
          expect(result.valid).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("never throws on a real envelope with random bytes flipped", () => {
    const original = Buffer.from(envelope(), "base64");
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(original.length - 1), fc.integer({ min: 0, max: 255 })), {
          minLength: 1,
          maxLength: 8,
        }),
        (flips) => {
          const bytes = Buffer.from(original);
          for (const [index, value] of flips) bytes[index] = value;
          // A flip may leave a valid envelope; what matters is no exception.
          checkStellarExactPayment(bytes.toString("base64"), REQUIREMENTS, {
            accepted: REQUIREMENTS,
          });
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("createLatestLedgerSource", () => {
  it("caches the ledger for its TTL and refreshes after it", async () => {
    let now = 0;
    const getLatestLedger = vi.fn(async () => 100 + now);
    const source = createLatestLedgerSource({ getLatestLedger, ttlMs: 5_000, now: () => now });
    expect(await source.latest()).toBe(100);
    now = 4_999;
    expect(await source.latest()).toBe(100);
    now = 5_000;
    expect(await source.latest()).toBe(5_100);
    expect(getLatestLedger).toHaveBeenCalledTimes(2);
  });

  it("shares one lookup between concurrent callers", async () => {
    const getLatestLedger = vi.fn(async () => 7);
    const source = createLatestLedgerSource({ getLatestLedger });
    expect(await Promise.all([source.latest(), source.latest(), source.latest()])).toEqual([
      7, 7, 7,
    ]);
    expect(getLatestLedger).toHaveBeenCalledTimes(1);
  });

  it("answers undefined and reports the error when the lookup fails, so the check is skipped", async () => {
    const failure = new Error("rpc down");
    const onError = vi.fn();
    const source = createLatestLedgerSource({
      getLatestLedger: async () => {
        throw failure;
      },
      onError,
    });
    expect(await source.latest()).toBeUndefined();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("refuses a lookup that answers something other than a ledger number", async () => {
    const onError = vi.fn();
    const source = createLatestLedgerSource({
      getLatestLedger: async () => -1,
      onError,
    });
    expect(await source.latest()).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("needs an RPC URL or a lookup function", () => {
    expect(() => createLatestLedgerSource({})).toThrow(/rpcUrl or getLatestLedger/);
  });
});
