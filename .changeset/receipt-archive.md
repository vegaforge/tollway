---
"@vegaforge/tollway-observability": minor
"@vegaforge/tollway-core": minor
---

Adds a receipt archive: `createMemoryReceiptArchive` and `createSqliteReceiptArchive`, with idempotent append, schema checks on write and read, optional signature verification, filtered search and stable cursor paging. Core gains the `receipt-conflict` error code.
