---
"@vegaforge/tollway-server": minor
---

Dynamic-price routes: a misbehaving price function is a 500 rejection instead of a thrown error, with the error passed to the new `PaywallDeps.onPriceError`; a settled payment retried after its quote expired replays its receipt instead of getting a 402; and `PaywallConfig.previousQuoteSecrets` supports rotating `quoteSecret` (#293).
