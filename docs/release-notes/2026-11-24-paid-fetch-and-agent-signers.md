---
date: 2026-11-24
feature: createPaidFetch and the agent signer abstraction
scope: feat
packages: ["@vegaforge/tollway-client"]
scenario-impact: none
---

# createPaidFetch and agent signers

An agent can now pay for an HTTP resource with one call that looks like
`fetch`, and configure its payment identity once for every settler. Closes
#201 and #205, in pull request #348.

## What changed

- **`createPaidFetch({ client, network, fetch? })`.** Sends the request once
  and returns anything but a 402 untouched. A 402 is read into one
  `PaymentOffer` (x402 V2 `PAYMENT-REQUIRED`, validated with a schema, and
  Stellar MPP `charge` and `channel` challenges) and paid through
  `client.pay()`, so offer checks, quarantine, policy, routing, receipt
  verification, the receipt store and events all apply. The response is the
  service's own `Response` with `receipt` and `model` added.
- **Exactly two requests per paid call.** Settlers gain `settleExchange`,
  which answers the 402 the caller already has and replays the caller's
  request with the payment header. The x402 and MPP charge settlers implement
  it. The body is buffered before the first send, so a POST is replayed byte
  for byte; a `ReadableStream` body that meets a 402 is refused before any
  payment.
- **One settler per model.** `createClient` takes `settlers` as an
  alternative to `settler`. A model the router picks with no settler is
  refused with `no-viable-model`, never paid on another model.
- **Second 402.** When the service answers the signed payment with another
  402, the retry answers that new challenge under the existing `retry`
  option. The request is never sent unpaid twice.
- **Concurrent calls.** Identical concurrent requests share one payment and
  each caller gets its own copy of the response. Requests that differ in
  method, URL or body hash are separate purchases.
- **`AgentSigner`.** `createKeypairSigner(secret, network)` provides the x402,
  MPP charge and MPP channel capabilities, holding the secret in closures
  only. `createSmartAccountSigner({ contractId, network, signAuthEntry })`
  adapts a smart account's signing callback for x402 only, because
  `@stellar/mpp` signs only with an Ed25519 key. A settler given a signer
  without its capability throws `SignerCapabilityError` when it is created.
- **Router input.** `signerModels(signer)` and the `supportedModels` client
  option restrict the router to the models the agent can pay.

## Compatibility

`createX402Settler` still accepts a bare `ClientStellarSigner`, and
`createMppChargeSettler` still accepts `secretKey` or `keypair`. A custom
settler keeps working with `pay()`; it needs `settleExchange` only to be used
by `createPaidFetch`.

## Not covered

The smart-account signer has not been settled against a live facilitator
with a `C...` payer. No client settler exists yet for `mpp-channel`, so a
route offering only a channel cannot be paid through `createPaidFetch`.
