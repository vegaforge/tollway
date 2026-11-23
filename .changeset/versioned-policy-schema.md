---
"@vegaforge/tollway-core": minor
---

A versioned zod policy schema with construction-time validation, migration for
legacy unversioned policies, a committed JSON Schema, and a Node-only
`@vegaforge/tollway-core/policy-loader` for validating policy files.

Breaking changes:

- `Policy` now requires `policyVersion`, so a `const policy: Policy = { ... }`
  literal without it stops compiling. Add `policyVersion: 1`, or type an
  unversioned literal as `PolicyInput`, which `createPolicyEngine` and
  `planSmartAccountPolicy` accept and migrate.
- `createPolicyEngine` and `planSmartAccountPolicy` now throw
  `PolicyValidationError` (code `invalid-policy`) when they are called with an
  invalid policy. Before, a bad budget amount surfaced as a rejected
  `evaluate()` on the first payment, and a bad cap as an `invalid-amount`
  error at creation.
