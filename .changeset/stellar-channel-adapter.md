---
"@vegaforge/tollway-channels": minor
---

Add `createStellarMppChannelAdapter`, an `MppChannelAdapter` backed by `@stellar/mpp` 0.7.1 for a deployed one-way-channel contract: `openChannel` checks the contract on chain, `signCommitment` signs off chain only, and `closeChannel` settles with one transaction.
