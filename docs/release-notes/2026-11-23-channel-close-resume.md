---
date: 2026-11-23
feature: Channel closes survive a crash or an unknown outcome, and resume from chain state
scope: fix
packages: ["@vegaforge/tollway-channels"]
scenario-impact: none
---

# Crash-safe channel close and resume

A channel close no longer gets stuck, and no longer reopens a channel whose
settlement may have landed.

- Before submitting, `close` records the attempt on the channel: an id, the
  ledger it started at, and the time. A process that dies mid-close leaves
  the channel `closing` with that record.
- When the adapter fails after it may have submitted, such as a poll
  timeout, the channel stays `closing`. It returns to `open` only when the
  adapter throws `CloseNotSubmittedError`, which the Stellar adapter does for
  its checks that run before anything is sent.
- A settlement that differs from the last commitment moves the channel to
  the terminal status `settlement-mismatched`, with the expected and
  observed amounts. It never takes another commit.
- `resume(channelId)` decides from the chain what happened to a `closing`
  channel: no close on chain, so it closes again; closed and empty, so it
  finds the settlement and marks the channel `closed` with its transaction
  hash and remainder; closed with funds left, so it hands the channel to
  recovery (#38) as `recovering`. A close the chain reports but whose
  settlement cannot be found throws `SettlementNotFoundError`, and an RPC that
  no longer keeps events back to the attempt throws
  `MissingEventHistoryError`. Either way the channel stays `closing`.
- `resumeAll()` resumes every `closing` channel and reports each result,
  errors included, without stopping at the first failure.

`MppChannelAdapter` gains `getChannelState` and `findChannelSettlement`,
both read-only. The Stellar adapter finds the settlement in the channel
contract's events: the transaction whose `close` event is effective at its
own ledger, with its `withdraw` and `refund` amounts. `CommitmentStore`
gains `listChannelsByStatus`, kept separate from the paged `listChannels`
of #179 and #227.

Repeated and concurrent `resume` calls in one process submit at most one
close. Two processes over a shared store can still both submit until the
store offers compare-and-set (#175), so run `resume` from one process until
then. docs/design.md open question 1 now describes `@stellar/mpp` 0.7.1.

Pull request: #329. Closes #176.
