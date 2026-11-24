---
date: 2026-11-24
feature: Serialise channel commits and closes per channel
scope: fix
packages: ["@vegaforge/tollway-channels"]
scenario-impact: none
---

# Serialise channel commits and closes per channel

Concurrent calls on one channel no longer race. Before this change, `commit` calls that overlapped each read the same sequence and cumulative amount, so only one commit landed and the rest failed with `CommitmentConflictError`. A close could also read a stale stream.

`createChannelManager` now queues `commit` and `close` per channel. Each task starts after the previous one for that channel settles. Two commits of 60 and 60 against a deposit of 100 now land as sequence 0 (cumulative 60), and the second is refused with `CommitmentExceedsDepositError` because 120 exceeds the deposit. A later commit of 30 lands as sequence 1 (cumulative 90). Two closes submit one close transaction, and the second rejects with `ChannelAlreadyClosedError`. Commits on different channels do not wait for each other.

The `CommitmentStore` compare-and-set from #175 is unchanged, so a store shared between processes still refuses a lost race. The in-process queue removes the race inside one process. The queue entry is dropped once it drains, so the queue map only holds busy channels.

A commit that starts after a close has begun now rejects with `ChannelNotOpenError` and is never signed, and the close settles the last recorded commitment. A fast-check property test covers random interleavings of commits and one close. For any order of calls, the stream has no gap or duplicate sequence, never passes the deposit, and the single close settles exactly the cumulative recorded before it. The test checks every call's outcome against a sequential model. `fast-check` is a new dev dependency of `@vegaforge/tollway-channels`.
