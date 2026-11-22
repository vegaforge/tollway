---
"@vegaforge/tollway-server": patch
---

The MPP charge handler's `verify` now proves the credential's `source` account signed for the payment (a `transfer` from the source with its envelope or Soroban authorization signature, or a push-mode signature over the challenge and hash) before reporting it as the payer, so a credential naming another account is rejected before the service policy sees it.
