---
date: 2026-11-24
feature: Machine-readable gate error codes and consistent Retry-After in all adapters
scope: feat
packages: ["@vegaforge/tollway-server", "@vegaforge/tollway-adapter-express", "@vegaforge/tollway-adapter-fastify", "@vegaforge/tollway-adapter-hono", "@vegaforge/tollway-adapter-next"]
scenario-impact: updated
---

# Gate error codes

Every gate rejection now has a stable `code`, and Express, Fastify, Hono and Next answer it identically: `{ "error": { "code", "message", "upstreamReason"? } }` with the same status and headers. Agents branch on the code instead of parsing English. `settlement-in-progress`, `facilitator-unavailable` and `settlement-unknown` carry `Retry-After`; a refused payment is a 402 with a fresh `PAYMENT-REQUIRED`, so the agent can sign again at once.

A facilitator that cannot be reached is now a 503 instead of an exception that each framework rendered differently. A `/settle` that may have landed is a held 503 `settlement-unknown`, keeping the #329 hold. Errors the gate cannot classify still propagate.

**Breaking:** the error body shape, and transport failures from the built-in facilitator clients are thrown as `facilitator-unavailable` rather than `payment-failed`. See docs/gate-errors.md for every code. Related issue: #161. Scenario: docs/scenarios/gate-errors-and-replays.md (updated). Pull request: #342.
