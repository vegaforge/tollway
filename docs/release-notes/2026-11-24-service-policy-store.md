---
date: 2026-11-24
feature: Versioned service policy store with audit trail and client policy fetcher
scope: feat
packages: ["@vegaforge/tollway-service", "@vegaforge/tollway-client"]
scenario-impact: none
---

# Versioned service policy store and audit trail

`@vegaforge/tollway-service` now serves versioned per-agent policies with `ETag` / `If-Match` optimistic concurrency, conditional `If-None-Match` (`304`) reads, tombstone retirement, and an immutable audit log (`GET /v1/audit`), while `@vegaforge/tollway-client` adds `fetchPolicy` so agents can load and cache their active policy for `createPolicyEngine`.

`policyModule()` in `packages/service/src/policies.ts` validates incoming policies with `parsePolicy` from `@vegaforge/tollway-core` (returning `422 invalid-policy` with issue paths on failure), stores every version and structural diff atomically through `PolicyStore` in `packages/service/src/stores.ts`, and exposes all routes in `/openapi.json` and `apps/web/src/content/docs/service.mdx`. `fetchPolicy` in `packages/client/src/policy-fetcher.ts` sends `If-None-Match`, reuses its cached policy on `304`, and validates `200` responses before returning.
