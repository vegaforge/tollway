---
date: 2026-11-24
feature: The x402 payment-identifier extension is the gate's second idempotency key
scope: feat
packages: [@vegaforge/tollway-server]
scenario-impact: none
---

# Payment identifiers as idempotency keys

An agent that re-signs a payment after a timeout or an expiry used to be
charged twice: a freshly signed envelope has a new auth-entry nonce, so its
digest, the gate's only idempotency key, was new too. The gate now supports
the x402 `payment-identifier` extension, and a client that sends the same id
again gets its first receipt back without a second `/settle`. Closes #153.

What changes for a service:

- Every 402 declares `payment-identifier`, built with
  `declarePaymentIdentifierExtension` from `@x402/extensions`. Set
  `paymentIdentifier: { required: true }` on a paywall to make clients send
  an id; the default is `false`.
- A payment with an id is verified first. Then the gate looks the settlement
  up under `<model>:payment-id:<payer>:<id>` as well as under the envelope
  digest. The id is scoped to the payer `/verify` returned, so another payer
  who reuses the id gets no one else's receipt: their payment settles as
  their own.
- The same id on a different offer (resource, amount, asset, payee, network,
  model or method) is a 409, exactly like a reused envelope.
- An invalid id, a malformed extension, or a missing id on a route that
  requires one is a 400 before `/verify`. The client's own `schema` in the
  extension is ignored, so a request cannot change the id rules.
- Without an id nothing changes: the envelope digest from `deriveNonce`
  remains the key.

Concurrent requests with the same id share one settlement in a process, and
take the cross-process lock on both keys. `SettlementCache` has a new
optional `setMany`; the Redis cache writes both keys in one Lua script, so a
reader never sees one key without the other. The in-memory cache writes both
with no await in between.

Notes:

- The `@x402/core` and `@x402/stellar` 2.31 upgrade and the
  `@x402/extensions` dependency the issue lists were already on `dev`; this
  change adds no dependency. The layering table in the engineering standards
  now lists `@x402/extensions` for `@vegaforge/tollway-server`.
- A 402 now always carries an `extensions` object. Code that treated its
  presence as "this route publishes to Bazaar" should check
  `extensions.bazaar` instead.

scenario-impact is `none`: no scenario under docs/scenarios/ covers payment
identifiers yet.
