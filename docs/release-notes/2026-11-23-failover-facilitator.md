---
date: 2026-11-23
feature: Multi-facilitator client with health checks and safe failover
scope: feat
packages: [@vegaforge/tollway-core, @vegaforge/tollway-server]
scenario-impact: none
---

# Failover facilitator

`createFailoverFacilitator({ facilitators, ... })` returns a drop-in
`FacilitatorClient` that fronts several backing facilitators under health
tracking, capability filtering, and pin-based settlement safety. It can
replace `createHttpFacilitator` in a gate without touching anything else,
and turns the single-facilitator single-point-of-failure into N.

- `/verify` and `/supported` fail over freely across healthy members. A
  structured `VerifyError` from `@x402/core` is a deliberate rejection and
  short-circuits the chain.
- `/settle` is pinned to the first facilitator that received it, so a retry
  for the same signed payment always goes to the same place. The pin lives
  in a new `SettlementPinStore` seam (`setIfAbsent` / `release`) that
  mirrors the `SettlementCache` shape; an in-memory implementation ships
  by default and a shared-backend plug-in slots in for multi-process gates.
- Settle errors are classified: `pre-send` (Node's ECONNREFUSED / ENOTFOUND /
  EAI_AGAIN on the fetch cause chain) releases the pin and moves on.
  `createHttpFacilitator` now keeps the network error as the `cause` of the
  `TollwayError` it throws, which is what makes this work with real
  facilitators; tests cover a refused connection and a 500 from a real HTTP
  facilitator;
  `outcome-unknown` (`FacilitatorTimeoutError`, `FacilitatorResponseError`,
  or any other post-send transport failure) keeps the pin and raises
  `TollwayError("outcome-unknown", ...)` without retrying on another
  facilitator.
- Per-member health counts consecutive failures, trips a cool-down at a
  configurable threshold, and lets the next call through as a half-open
  probe once the cool-down elapses. The clock is injectable.
- Each member may carry a validator built with the Issue #155
  `createFacilitatorValidator`. A member whose cached `/supported` does not
  cover the offer's network is skipped for that call, and a member whose
  `/supported` cannot be read is skipped and reported with a
  `capabilities-unavailable` event. Neither is marked unhealthy.
- Every failover and every `outcome-unknown` is reported through an
  `onEvent` callback for observability.

Not solved yet: resolving an `outcome-unknown` payment. The on-chain
Soroban nonce check is not implemented. On a retry the gate verifies before
it settles, so a payment that did land on chain can come back as a failed
verify instead of reaching the pinned facilitator again. Until the nonce
check exists, an `outcome-unknown` settlement needs an operator, or a later
on-chain check, to confirm.

A new `outcome-unknown` `TollwayErrorCode` ships in `@vegaforge/tollway-core`
(the related Issue #161 covers wiring the adapter-level `Retry-After`;
that stays in scope for its own issue).

Pull request: #325. Closes #156.
