---
date: 2026-11-24
feature: Issue x402 offer-receipt extension offers and receipts from the gate, opt-in per route
scope: feat
packages: ["@vegaforge/tollway-server"]
scenario-impact: none
---

# x402 offer-receipt extension

A paywall can now issue the x402 offer-receipt extension (#172), so a stock
x402 client receives a signed offer with the 402 and a signed receipt with
the paid response, in the format `@x402/extensions/offer-receipt` reads.
Nothing changes unless a route sets `offerReceipt`; with it off, the 402 and
PAYMENT-RESPONSE are byte for byte what they were.

- `PaywallConfig.offerReceipt` takes `true` or `{ includeTxHash, kid,
  offerValiditySeconds }`. The 402 then carries one JWS offer per x402
  requirement in `extensions["offer-receipt"].info.offers`, and a settled x402
  payment's `SettleResponse` carries a JWS receipt in
  `extensions["offer-receipt"].info.receipt`.
- Both are signed with the gate's `ReceiptSigner` through
  `createOfferReceiptJwsSigner`: `EdDSA` with a `did:key` for Ed25519,
  `ES256` with a `did:jwk` for P-256, or an explicit `did:web` `kid`. A
  signer the extension cannot use is refused at `createPaywall`.
- The extension receipt is derived from the Tollway receipt (resource,
  payer, CAIP-2 network, issue time), which stays the authoritative record.
  The transaction hash is left out unless `includeTxHash` is set.
- An offer never outlives the gate's acceptance window (`maxTimeoutSeconds`,
  or the quote lifetime for a dynamic price). Signed offers are cached per
  requirement, at most 256, and reused until half their validity is gone.
- `@x402/extensions` was already a dependency. Its offer-receipt subpath
  loads `viem` and `jose`, so the gate imports it lazily: a service that
  never opts in never loads it.
- Tests verify what the gate emits with the library's own
  `verifyOfferSignatureJWS`, `verifyReceiptSignatureJWS`,
  `extractReceiptFromResponse` and `verifyReceiptMatchesOffer`, resolving the
  key from the DID alone, and the Express adapter test shows both headers
  reach the HTTP response.

See docs/receipt-format.md, "x402 offer-receipt extension".
