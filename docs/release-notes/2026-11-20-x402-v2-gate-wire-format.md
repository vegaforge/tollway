---
date: 2026-11-20
feature: the gate speaks the x402 V2 wire format, and the Tollway receipt moves to TOLLWAY-RECEIPT
scope: feat
packages: [@vegaforge/tollway-server, @vegaforge/tollway-core]
scenario-impact: none
---

# x402 V2 at the gate

A standard x402 V2 client can now pay a Tollway-gated route. Before this, the
gate used the V2 header names but Tollway's own base64url encoding and payload
shapes, so `@x402/fetch` and other stock clients could not read the 402 or sign
a payment the gate would accept. Issue #43.

## What changed

- `PAYMENT-REQUIRED` carries standard base64 JSON of an x402 `PaymentRequired`
  (`x402Version: 2`, `resource`, and one `accepts` entry for the Stellar
  `exact` scheme), built by `@x402/core/http`'s `encodePaymentRequiredHeader`.
  The 402 body is the same object.
- `PAYMENT-SIGNATURE` is decoded with `decodePaymentSignatureHeader`. A
  malformed header, or one whose `x402Version` is not 2, is a `rejected`
  outcome with status 400; it never throws through an adapter.
- The HTTP facilitator forwards the decoded `PaymentPayload` as received. The
  idempotency nonce is still the SHA-256 digest of the signed transaction, so
  retries dedupe.
- A settlement sets `PAYMENT-RESPONSE` to standard base64 of the
  facilitator's `SettleResponse`, and sets the new `TOLLWAY-RECEIPT` header
  (exported as `TOLLWAY_RECEIPT_HEADER`) to the signed Tollway receipt.
- `PaywallConfig` gains `maxTimeoutSeconds` and `extra`, so the challenge and
  the facilitator name the same terms. `PaymentOffer.asset` is documented as
  the Soroban asset contract address (`C...`) for x402.
- `X402Payment` in `@vegaforge/tollway-core` carries the decoded
  `PaymentPayload` (a type-only import from `@x402/core/types`) instead of a
  bare `paymentSignature` string.

## Verification

- Unit tests cover the 402 challenge, a missing, malformed, base64url and
  wrong-version signature, the two settled headers, and a payload with no
  transaction.
- `packages/adapter-express/src/x402-round-trip.test.ts` drives the Express
  adapter with `x402HTTPClient` from `@x402/core`: it reads the challenge,
  encodes a `PaymentPayload`, and reads both the `SettleResponse` and the
  receipt, against a stubbed facilitator.
- The four adapter suites, the demo's mock and live-stub modes, and
  `MOCK_MODE=true pnpm --filter @vegaforge/tollway-demo start` still produce a
  verified receipt.
