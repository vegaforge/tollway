---
date: 2026-11-24
feature: Offer sanity checks in the client
scope: feat
packages: ["@vegaforge/tollway-client", "@vegaforge/tollway-core"]
scenario-impact: none
---

# Offer sanity checks in the client

A 402 challenge is attacker-controlled input, and the client used to sign
whatever amount, asset and payee it named, limited only by budget rules. It
now checks each offer before the policy engine and before any signature.

## What changed

- **Always on.** The offer must name the client's network and the URL the
  agent requested (the receipt binding from #202 enforces both). Its amount
  must be an integer string in base units and not zero, and `models`, `payTo`
  and `asset` must not be empty.
- **`offerChecks` on `createClient`.**
  - `maxAmount`: a ceiling per asset, compared as `bigint`. Once set, an asset
    with no entry is refused (fail closed).
  - `allowedPayees` and `allowedAssets`: exact-string allowlists.
  - `allowZeroAmount`: accept free offers. Off by default.
  - `requireNetwork`: defaults to the client's network and must equal it.
- **Errors.** A failed check throws `OfferRejectedError`, code
  `offer-rejected`, with `checkName`, and emits `skip`. The settler and policy
  engine are never reached. A malformed `offerChecks` fails when the client is
  created.
- **x402 settler.** `createX402Settler` takes the same `offerChecks` and
  registers the allowlists as an x402 `PaymentPolicy` over every option in the
  challenge, so a 402 listing a disallowed option first cannot steer it.

## Verification

Unit tests cover each check passing and failing, a property test compares the
checks with an independent predicate over random offers and limits, and a
settler test signs only the allowed option of a two-option challenge.

See the client README, "Hardening an agent".

Pull request: #305.
