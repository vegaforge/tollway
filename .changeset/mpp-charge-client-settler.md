---
"@vegaforge/tollway-client": minor
---

Adds `createMppChargeSettler`, a `ClientSettler` that pays MPP charge routes on Stellar with `@stellar/mpp`. It checks the challenge's amount, recipient, token contract and network against the approved offer before signing, supports `pull` and `push` modes, and cross-checks MPP's `Payment-Receipt` against the Tollway receipt. Also exports `offerAssetContract` and `MPP_NETWORK_ID`. The package gains runtime dependencies on `@stellar/mpp`, `mppx`, `@stellar/stellar-sdk` and `zod`.
