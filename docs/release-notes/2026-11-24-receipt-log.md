---
date: 2026-11-24
feature: A hash-chained receipt log with signed checkpoints and an fsynced JSON Lines store
scope: feat
packages: ["@vegaforge/tollway-core", "@vegaforge/tollway-observability"]
scenario-impact: none
---

# Receipt log

Services can now keep receipts in a tamper-evident log. `createReceiptLog` in
`@vegaforge/tollway-core` appends signed receipts to a chain in which every
entry (`{ seq, prevHash, receipt, appendedAt, entryHash }`) commits to the one
before it by SHA-256 over its canonical bytes. Checkpoints of the log's size
and head hash are signed with any `ReceiptSigner`, on demand or every
`checkpointEvery` appends, and handed to `onCheckpoint` so they can be kept
outside the log. `verifyReceiptLog(entries, { verifier, checkpoint })` reports
the first failing `seq` and whether the entry was modified, unlinked, missing
or moved, carries a bad receipt signature, or the log is shorter than the
checkpoint.

- `append` verifies each receipt's signature before writing and queues
  concurrent calls, so the chain never forks inside one process.
- `createMemoryReceiptLogStore` (core) and `openJsonlReceiptLogStore`
  (observability) store the entries. The file store fsyncs every append,
  re-checks the chain on open, and refuses a file with a partial last line
  until `repairJsonlReceiptLog` removes it. Core never imports `node:fs`.
- Core gains the `receipt-log-conflict` and `corrupt-receipt-log` error codes.

Tail truncation is only detectable with a checkpoint held outside the log; the
guarantees, formats and offline verification are in `docs/receipt-log.md`.
Closes #171 in pull request #346.
