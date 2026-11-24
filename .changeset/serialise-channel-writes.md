---
"@vegaforge/tollway-channels": patch
---

Serialise commits and closes per channel in `createChannelManager`. Concurrent `commit` calls on one channel now run in order: each reads the sequence and cumulative amount the one before it wrote. The deposit check holds, and sequences stay strictly increasing. Before, racing commits failed with `CommitmentConflictError`, so one commit won and the others were refused. Concurrent `close` calls submit one close, and a commit that races a close settles with the last recorded commitment. Commits on different channels still run in parallel. The `CommitmentStore` compare-and-set stays in place for stores shared between processes.
