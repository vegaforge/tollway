---
date: 2026-11-18
feature: a settled payment pays for one HTTP method
scope: fix
packages: ["@tollway/server"]
scenario-impact: none
---

# One payment, one HTTP method

When one gate is mounted on several methods of a path (a Next.js route file
exporting `GET` and `POST`, Express `app.all`, Hono `app.on`), a payment made
for one method no longer unlocks the others. The gate records the request
method with every settlement, in memory and in the settlement cache, and only
replays a receipt for the same method. Another method gets
`409 payment already settled for a different offer`, and the payment is never
settled a second time.

`SettlementCache` now stores a `SettlementEntry` (`{ receipt, method }`)
instead of a bare receipt. A Redis entry written by an older version is
refused during a rolling deploy instead of being settled again. Retries of the
same method replay exactly as before.

Decision: ADR-2026-11-18-method-binding.
