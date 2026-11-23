---
date: 2026-11-23
feature: Agent-side receipt store and spend ledger
scope: feat
packages: [@vegaforge/tollway-client, @vegaforge/tollway-core]
scenario-impact: none
---

# Agent-side receipt store and spend ledger

An agent can now keep the receipts it receives and answer "how much have I
spent, per service, asset and model, over this window" without a database of
its own. `createClient({ receiptStore })` writes each verified receipt before
`pay()` resolves, and the store answers ledger queries over everything it
holds.

`createMemoryReceiptStore()` ships in the main entry. `createSqliteReceiptStore()`
ships at `@vegaforge/tollway-client/sqlite` and uses the built-in `node:sqlite`
module, so no dependency is downloaded or compiled at install time; that
subpath needs Node 22.13 or later, which the client package now states in its
`engines` field. Both backends implement the same `ReceiptStore` interface:
`put` is idempotent by receipt id, `get` looks one up, and `query` filters by
payee, asset, model, resource and an inclusive issuedAt window with keyset
pagination on `(issuedAt, id)`.

The ledger returns totals per `(payee, asset)` and per `(model, asset)`, as
integer strings summed with `bigint`. It never adds amounts across assets,
because a USDC amount and a native amount are denominated in different units.
The SQLite store validates every receipt it reads with `signedReceiptSchema`,
so a corrupted row is an error rather than a malformed receipt.

A payment settles before its receipt is stored, so a store failure cannot be
allowed to lose the receipt: `pay()` resolves with the receipt, sets
`storeError` on the result and calls the new `onStoreError(error, receipt)`
hook, mirroring the gate's `cacheError` and `onCacheError`. The write itself is
awaited, so a receipt is in the store before the caller sees the payment
succeed.

Closes #204.
