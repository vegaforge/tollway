---
"@vegaforge/tollway-server": minor
"@vegaforge/tollway-core": patch
---

`createMppChargeHandler` is a real MPP charge handler built on `mppx` 0.8.19 and `@stellar/mpp` 0.7.1 (new dependencies). It takes `recipient`, `currency` (SAC address), `network`, `secretKey`, `store` and an optional `feePayer`. `MppChargeHandler` gains an optional `challenge()`; the gate adds the MPP `WWW-Authenticate` challenge to its 402 on routes that accept `mpp-charge`, and reads the MPP credential from `Authorization: Payment ...`. Breaking for the mock: an MPP payment sent in `PAYMENT-SIGNATURE` is now rejected with 400. New exports: `readMppCredential`, `MPP_AUTHORIZATION_HEADER`, `MppChargeChallenge`, `MppChargeChallengeInput`. `MppChargePayment.payload` is documented as the `Payment ...` credential.
