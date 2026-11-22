---
date: 2026-11-22
feature: Per-payer service policy in the gate
scope: feat
packages: [@vegaforge/tollway-server, @vegaforge/tollway-adapter-express, @vegaforge/tollway-adapter-fastify, @vegaforge/tollway-adapter-next, @vegaforge/tollway-adapter-hono]
scenario-impact: none
---

# Per-payer service policy in the gate

A service can now throttle or exclude agents before their payments settle.
`PaywallDeps.servicePolicy` accepts payer allow and deny lists, requests per
payer per window, and spend per payer per asset per window; the gate evaluates
it after `/verify` and before the settlement lock. A denial is a rejection
with a stable `service-policy:*` reason code, and a window denial carries
`Retry-After`. The denied payment is never sent to `/settle`.

Allowlist misses and denylist hits share one answer, so a denial does not
disclose which list matched. Spend is recorded only for a settled payment,
never twice for a replayed receipt. Admissions reserve their slots before the
settlement lock, so concurrent requests from one payer cannot both pass a cap
only one of them fits under. The default in-memory store keeps at most 10 000
payers with least-recently-used eviction; `ServicePolicyStore` is the seam for
a shared store across processes (#190). Rate limiting here happens after
verification, so it does not protect the facilitator from a flood (#159).

Two copies of one payment sent at once settle once and are admitted once: the
policy runs inside the in-flight attempt, so the second copy shares the first
one's receipt or denial. A store failure after the outcome is known does not
change it; it goes to the new `PaywallDeps.onServicePolicyError` hook.

Closes #160.
