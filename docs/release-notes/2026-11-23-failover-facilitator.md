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
  EAI_AGAIN on the fetch cause chain) releases the pin and moves on;
  `outcome-unknown` (`FacilitatorTimeoutError`, `FacilitatorResponseError`,
  or any other post-send transport failure) keeps the pin and raises
  `TollwayError("outcome-unknown", ...)` without retrying on another
  facilitator.
- Per-member health counts consecutive failures, trips a cool-down at a
  configurable threshold, and lets the next call through as a half-open
  probe once the cool-down elapses. The clock is injectable.
- Each member may carry an optional validator built from the Issue #155
  `createFacilitatorValidator`; members whose advertised capabilities
  cannot verify an offer are skipped for that call without being marked
  unhealthy.
- Every failover and every `outcome-unknown` is reported through an
  `onEvent` callback for observability.

The on-chain Soroban nonce check the issue outlines as the strict solution
to indeterminate settle outcomes is not implemented; the issue's permitted
fallback ("hold the payment as outcome-unknown until the pinned facilitator
answers") is the semantics here, and every retry of an `outcome-unknown`
payment is routed back to the pinned facilitator.

A new `outcome-unknown` `TollwayErrorCode` ships in `@vegaforge/tollway-core`
(the related Issue #161 covers wiring the adapter-level `Retry-After`;
that stays in scope for its own issue).

Closes #156.
