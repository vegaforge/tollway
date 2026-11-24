---
"@vegaforge/tollway-channels": minor
---

Make channel close crash-safe and resume interrupted closes from chain state (#176).

- `close` records the attempt before submitting, keeps the channel `closing`
  when the outcome is unknown, and returns it to `open` only on the new
  `CloseNotSubmittedError`. A settlement that differs from the last
  commitment moves the channel to the terminal `settlement-mismatched`.
- New `resume` and `resumeAll`, and errors `SettlementNotFoundError` and
  `MissingEventHistoryError`.
- Breaking for custom implementations: `MppChannelAdapter` requires
  `getChannelState` and `findChannelSettlement`, `CommitmentStore` requires
  `listChannelsByStatus`, and `ChannelStatus` gains `settlement-mismatched`.
