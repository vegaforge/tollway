---
date: 2026-11-20
feature: Offer sanity checks in @vegaforge/tollway-client
scope: feat
packages: ["@vegaforge/tollway-client", "@vegaforge/tollway-core"]
scenario-impact: none
---

# Offer sanity checks in @vegaforge/tollway-client

## What changed

`createClient` now accepts an `offerChecks` option that validates each 402
offer **before** the policy engine and **before** any signature is produced.

**Always-on checks (no configuration required)**

- **network** — `offer.network` must equal the client's configured `network`.
  An offer naming `mainnet` is always rejected by a testnet client, and vice
  versa. This was a gap: `options.network` was set but never read against the
  offer.
- **structural** — `amount` is a non-negative, non-zero integer string;
  `models` is non-empty; `payTo` and `asset` are non-empty; `offer.resource`
  matches the request URL.

**Configurable checks (`offerChecks` option)**

- `maxAmount` — per-asset price ceiling as integer strings. Amounts are
  compared as `bigint`. **Fail-closed**: an asset with no entry in the map is
  rejected; this prevents an unexpected asset from slipping through silently
  when price limits are configured.
- `allowedPayees` — exact-string allowlist of payee addresses. Glob patterns
  are not supported.
- `allowedAssets` — exact-string allowlist of asset identifiers.

**x402 settler PaymentPolicy**

When `offerChecks` includes `allowedPayees` or `allowedAssets`,
`createX402Settler` also registers a `PaymentPolicy` on the `x402Client` that
filters the `accepts` array in the 402 challenge. This prevents a
multi-option challenge from steering the settler to a disallowed option.

**New error code**

`TollwayErrorCode` gains `"offer-rejected"`. `OfferRejectedError` extends
`TollwayError` with `code: "offer-rejected"` and a `checkName` field naming
the specific check that fired. A rejected offer also emits a `skip` event.

## Technical shape

New file `packages/client/src/offer-checks.ts` owns the check logic and the
`OfferRejectedError` class. `createClient` in `packages/client/src/index.ts`
calls `runOfferChecks` as the first step of `pay()`. `packages/core/src/errors.ts`
adds `"offer-rejected"` to `TollwayErrorCode`.

See `packages/client/README.md`, "Hardening an agent" for the recommended
configuration.

Closes #209.
