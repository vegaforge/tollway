---
date: 2026-11-23
feature: Production deployment guide
scope: docs
packages: [@vegaforge/tollway-web]
scenario-impact: none
---

# Production deployment guide

An operator can now deploy a Tollway gate across several processes from
documentation alone. The new [deployment guide](https://github.com/vegaforge/tollway/blob/dev/apps/web/src/content/docs/deployment.mdx)
covers the topology, why the in-memory settlement cache cannot protect a
multi-process deployment and what the Redis cache does instead, the cache TTL
as the replay window against Stellar's ledger close time, and the
cross-process lock with its renewal, its 409 responses and the `lockLost`
signal.

It documents receipt signing keys end to end: `Ed25519Signer.fromPrivateKey`
for a persisted key, a stable `keyId`, how agents verify against it, and a
rotation and revocation runbook. It covers facilitator URLs, API-key handling,
`maxTimeoutSeconds`, the 90-second per-request timeout from `@x402/core`, and
exactly what the gate returns for each facilitator failure. It lists which
outcomes and callbacks to alert on and how they relate to
`@vegaforge/tollway-observability`, and it ends with a security checklist and a
table of known gaps, each linked to its tracking issue.

The reference configuration is
[`examples/production-gate/src/index.ts`](https://github.com/vegaforge/tollway/blob/dev/examples/production-gate/src/index.ts),
a real workspace file that imports the real packages and is type-checked by
`pnpm typecheck` in CI.

Closes #255.
