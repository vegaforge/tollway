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
construction.

The schema is published as JSON Schema at
`packages/core/schema/policy.schema.json`, also importable as
`@vegaforge/tollway-core/schema/policy.schema.json`, and a test fails when the
committed file is stale. `loadPolicyFile` reads and validates a JSON policy
from disk through the Node-only
`@vegaforge/tollway-core/policy-loader` subpath, so `node:fs` stays out of the
edge-safe main entry.
