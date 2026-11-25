---
"@vegaforge/tollway-core": minor
"@vegaforge/tollway-observability": minor
---

Adds a hash-chained receipt log with signed checkpoints: `createReceiptLog`, `createMemoryReceiptLogStore`, `verifyReceiptLog` and `verifyReceiptLogCheckpoint` in core, and the fsynced JSON Lines store `openJsonlReceiptLogStore` with `repairJsonlReceiptLog` in observability. Core gains the `receipt-log-conflict` and `corrupt-receipt-log` error codes.
