---
date: 2026-11-24
feature: A searchable receipt archive with memory and SQLite implementations
scope: feat
packages: ["@vegaforge/tollway-observability", "@vegaforge/tollway-core"]
scenario-impact: none
---

# Receipt archive

`@vegaforge/tollway-observability` can now keep every signed receipt and search
them. `createMemoryReceiptArchive()` keeps receipts in process, and
`createSqliteReceiptArchive({ filename })` keeps them in a file through the
built-in `node:sqlite`. Both pass one conformance suite.

- `append` is idempotent by receipt id. A different body under an existing id
  throws the new `receipt-conflict` error and the stored receipt is kept.
- Receipts are checked with `signedReceiptSchema` on append and on read. An
  optional `verifier` stores only receipts whose signature verifies.
- The canonical JSON of each receipt is stored as given, so later receipt
  versions are kept exactly.
- `search(filter, { limit, cursor })` filters by payer, payee, model, network,
  asset, resource or resource prefix, issue time, transaction hash, and channel
  with an optional sequence. Results are newest first, with an opaque cursor
  that stays stable while receipts are appended. SQLite indexes every filter.

The dashboard's `ReceiptsSnapshot` gains `nextCursor` (the stub returns
`null`), so the receipts view can page through the archive later. The service
API on top of the archive is #225.

Pull request: #334.
