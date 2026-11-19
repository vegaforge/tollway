import {
  buildReceipt,
  canonicalJson,
  Ed25519Verifier,
  type JsonValue,
  type SignedReceipt,
  signReceipt,
  verifyReceipt,
} from "@vegaforge/tollway-core";
import { decodeHeader, deriveMppChargeNonce, encodeHeader } from "@vegaforge/tollway-server";
import { beforeAll, bench, describe } from "vitest";
import { BENCH_OPTIONS, PRICE, RESOURCE_PATH, signer } from "../src/fixtures.js";

/**
 * The steps the gate repeats on every request, one at a time, so a
 * regression in a gate-level benchmark can be traced to the step that
 * caused it. These are attribution aids: the CI check reports them but does
 * not fail on them.
 */

// Fixed id and timestamp, so every run signs and canonicalises the same bytes.
const body = buildReceipt({
  id: "00000000-0000-4000-8000-000000000000",
  issuedAt: "2026-11-19T00:00:00.000Z",
  payer: "GPAYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  payee: PRICE.payTo,
  amount: PRICE.amount,
  asset: PRICE.asset,
  resource: RESOURCE_PATH,
  model: "x402",
  settlement: { kind: "transaction", txHash: "a".repeat(64) },
  network: PRICE.network,
});

// The six fields the gate canonicalises twice per settled request, once from
// the offer and once from the receipt, to bind one to the other.
const binding: JsonValue = {
  model: "x402",
  network: PRICE.network,
  resource: RESOURCE_PATH,
  amount: PRICE.amount,
  asset: PRICE.asset,
  payee: PRICE.payTo,
};

// About the size of a base64 Stellar transaction envelope in an x402 payment.
const PAYMENT_PAYLOAD = "AAAAAgAAAAB".padEnd(600, "Q");

const verifier = Ed25519Verifier.forSigner(signer);
let signed: SignedReceipt;
let encoded: string;

beforeAll(async () => {
  signed = await signReceipt(body, signer);
  encoded = encodeHeader(signed);
  const check = await verifyReceipt(signed, verifier);
  if (!check.valid) throw new Error(`fixture receipt does not verify: ${check.reason}`);
});

describe("micro", () => {
  bench(
    "canonicalJson receipt body",
    () => {
      canonicalJson(body as JsonValue);
    },
    BENCH_OPTIONS,
  );

  bench(
    "canonicalJson offer binding",
    () => {
      canonicalJson(binding);
    },
    BENCH_OPTIONS,
  );

  bench(
    "buildReceipt (schema parse)",
    () => {
      buildReceipt({
        id: body.id,
        issuedAt: body.issuedAt,
        payer: body.payer,
        payee: body.payee,
        amount: body.amount,
        asset: body.asset,
        resource: body.resource,
        model: body.model,
        settlement: body.settlement,
        network: body.network,
      });
    },
    BENCH_OPTIONS,
  );

  bench(
    "signReceipt (Ed25519)",
    async () => {
      await signReceipt(body, signer);
    },
    BENCH_OPTIONS,
  );

  bench(
    "verifyReceipt (Ed25519)",
    async () => {
      const result = await verifyReceipt(signed, verifier);
      if (!result.valid) throw new Error(result.reason);
    },
    BENCH_OPTIONS,
  );

  bench(
    "encodeHeader receipt",
    () => {
      encodeHeader(signed);
    },
    BENCH_OPTIONS,
  );

  bench(
    "decodeHeader receipt",
    () => {
      decodeHeader<SignedReceipt>(encoded);
    },
    BENCH_OPTIONS,
  );

  // The x402 HTTP facilitator's nonce (deriveNonce in facilitator.ts) is not
  // exported. deriveMppChargeNonce is the same three steps (UTF-8 encode,
  // SHA-256 over WebCrypto, base64url), so it stands in for both.
  bench(
    "nonce digest (SHA-256, 600-byte payload)",
    async () => {
      await deriveMppChargeNonce(PAYMENT_PAYLOAD);
    },
    BENCH_OPTIONS,
  );
});
