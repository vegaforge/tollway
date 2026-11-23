---
"@vegaforge/tollway-client": minor
"@vegaforge/tollway-core": minor
---

`@vegaforge/tollway-client` gains a `ReceiptStore` with an in-memory backend and a SQLite backend at `@vegaforge/tollway-client/sqlite`, plus a spend ledger over the stored receipts. `createClient({ receiptStore, onStoreError })` writes each verified receipt before `pay()` resolves; a failed write keeps the receipt, sets `storeError` on the result and calls `onStoreError`. `@vegaforge/tollway-core` adds the `invalid-receipt-query`, `invalid-cursor` and `corrupt-receipt` error codes the store reports through `TollwayError`.
