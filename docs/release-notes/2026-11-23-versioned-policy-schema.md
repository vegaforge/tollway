---
date: 2026-11-23
feature: Versioned, schema-validated policies with a JSON Schema and Node policy-file loader
scope: feat
packages: ["@vegaforge/tollway-core"]
scenario-impact: none
---

# Versioned policy schema and loader

`@vegaforge/tollway-core` now validates a policy when the engine is built
instead of discovering a bad amount on the first payment. `policySchema` is the
runtime form of `Policy`; every object is strict, so a typo such as
`budgets.dialy` is an error rather than a rule that enforces nothing. Amounts
must be integer strings and `rateLimit.requestsPerMinute` must be a
non-negative integer.

Policies carry a required `policyVersion`. `parsePolicy` migrates the legacy,
unversioned shape (and explicit version 0) to version 1 before validating, and
returns every issue with its field path instead of throwing.
`createPolicyEngine` throws one `PolicyValidationError` listing those issues at
construction, and `planSmartAccountPolicy` validates its input the same way.

The schema covers the per-service and per-resource caps from #192 (`cap`,
`dailyCap`, `window` and `match`), so the separate cap checks that
`createPolicyEngine` ran are gone: a bad `windowSeconds` or cap is now reported
with its field path.

Breaking for code that builds policies: `Policy` requires `policyVersion`, so
typed literals need `policyVersion: 1` or the `PolicyInput` type. Invalid
policies now throw `PolicyValidationError` at construction instead of failing
on the first payment.

The schema is published as JSON Schema at
`packages/core/schema/policy.schema.json`, with a description on every field,
also importable as
`@vegaforge/tollway-core/schema/policy.schema.json`, and a test fails when the
committed file is stale. `loadPolicyFile` reads and validates a JSON policy
from disk through the Node-only
`@vegaforge/tollway-core/policy-loader` subpath, so `node:fs` stays out of the
edge-safe main entry. A policy file may carry a `$schema` line naming the
schema, which editors use and the engine ignores.

The CommonJS build now splits shared code into a chunk, as the ESM build
already did, so both entry points share one `TollwayError` class and
`instanceof` works across them.

Pull request: #328.
