---
date: 2026-11-24
feature: Local pre-validation of x402 payments before the facilitator is called
scope: feat
packages: ["@vegaforge/tollway-server"]
scenario-impact: updated
---

# Local payment pre-validation

The gate now decodes the Stellar transaction inside an x402 payment and runs the facilitator's static checks itself before calling `/verify`. A payment for the wrong asset, payee or amount, with the wrong operation or no address authorization, or a header over 16 KiB is refused with a 402 at no facilitator cost, so invalid-payment floods no longer spend the service's facilitator quota. Reasons use `@x402/stellar`'s `invalidReason` names. A payment that passes still goes to `/verify`, which stays authoritative.

Optional: a cached latest-ledger lookup refuses authorizations that have already expired, and is skipped when RPC is unavailable. `onRejected` counts refusals. The offline mock facilitator is exempt. See docs/payment-prevalidation.md. Related issue: #159. Scenario: docs/scenarios/gate-errors-and-replays.md (updated). Pull request: #342.
