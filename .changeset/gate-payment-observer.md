---
"@vegaforge/tollway-server": minor
---

Report settled and failed payments to an optional structural observer (#106).

- `PaywallDeps.observer` records metrics and emits `receipt.created` for fresh settlements; replayed cache hits are not reported again.
- Observer failures and rejected event deliveries go to `onObserverError` and never change the payment outcome. Event delivery is not awaited.
- Adds the exported `PaymentObserver`, `PaymentObserverMetric` and `PaymentObserverEvent` types; no runtime dependency on `@vegaforge/tollway-observability`.
