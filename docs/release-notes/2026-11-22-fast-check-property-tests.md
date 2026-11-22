---
date: 2026-11-22
feature: Property and fuzz tests harden payment headers, cache entries, receipts and policy budgets
scope: chore
packages: [@vegaforge/tollway-core, @vegaforge/tollway-server]
scenario-impact: none
---

# Property tests for the payment boundaries

Tollway now exercises four money-and-trust boundaries with `fast-check`
properties instead of a handful of hand-picked examples. The tests pin the
seed `0x517fa72e` and run 200 cases each, so a CI failure can be replayed
locally.

Core covers canonical receipt bytes (key permutations at every depth, a clean
JSON round trip, idempotence, no insignificant whitespace, and rejection of
non-finite numbers), signed receipts (sign/verify round trips plus tampering
with a body field, the key, the `keyId` and the signature value), and the
policy engine against an independent `bigint` reference model for daily,
total, per-service and 60-second rate ceilings. Server covers the
`encodeHeader`/`decodeHeader` pair for arbitrary JSON including non-ASCII,
case-insensitive and first-value header reads, malformed-header fuzzing, and
the Redis cache boundary: arbitrary stored text is either a miss or a value
that parses as a signed receipt.

No production behaviour changes. These properties state the behaviour the
current functions already claim, so they keep passing when issue #165 replaces
the canonicalisation algorithm and when issue #43 changes the header encoding.
Closes #246.
