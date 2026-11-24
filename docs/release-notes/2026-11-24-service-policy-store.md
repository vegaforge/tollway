---
date: 2026-11-24
feature: Policy store with If-Match concurrency, retirement and a client policy fetcher
scope: feat
packages: ["@vegaforge/tollway-service", "@vegaforge/tollway-client"]
scenario-impact: none
---

# Policy store with If-Match concurrency and a client policy fetcher

Operators can now keep each agent's policy in `@vegaforge/tollway-service` and have agents load it from there with `fetchPolicy` from `@vegaforge/tollway-client`, so a budget change happens in one place. Every change is versioned, guarded against concurrent edits, and written to the tenant's audit log.

This completes #228 on top of the tenant-scoped routes from #231. `PUT /v1/agents/{agentId}/policy` takes the policy document as its body and validates it with `parsePolicy` from `@vegaforge/tollway-core`, returning `422 invalid-policy` with every failing path. The first version needs no `If-Match`; every later change must send the current version's `ETag` (`"v<n>"`), and a missing or stale tag returns `412 precondition-failed` while the store's compare-and-set refuses a version that moved underneath. `DELETE` appends a retirement tombstone, `GET .../policy/versions/{version}` returns one version, and `GET .../policy` answers a matching `If-None-Match` with `304`. Audit entries now distinguish `policy.created` from `policy.updated` and `policy.retired`. `fetchPolicy` checks the response with `parsePolicy`, refuses a response for another agent or without an `ETag`, and caches per API key so two tenants never share a cached policy.

The `{ policy, expectedVersion }` request body and `409` conflict from #231 are replaced by the document body and `If-Match`, and `putPolicyBodySchema` is removed. Neither had been released.
