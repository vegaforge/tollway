---
date: 2026-11-18
feature: a verified receipt is exactly the signed receipt
scope: fix
packages: ["@vegaforge/tollway-core", "@vegaforge/tollway-client"]
scenario-impact: none
---

# A verified receipt has nothing added to it

`verifyReceipt` used to ignore fields it did not recognise, so a correctly
signed receipt with an extra, unsigned field (for example
`refunded: "true"`) still verified, and the caller kept the extra field. The
receipt schemas are now strict, so any unsigned field makes the receipt
invalid, and a valid result returns the parsed receipt as `result.receipt`.

`@vegaforge/tollway-client` returns that parsed receipt from `pay()`, never the object
its settler produced. Without a verifier the signature is still not checked,
but a receipt that does not match the schema is rejected with
`TollwayError` code `invalid-receipt`.

Every receipt Tollway has issued still verifies; none of them carry extra
fields.

Decision: ADR-2026-11-18-strict-receipt-verification.
