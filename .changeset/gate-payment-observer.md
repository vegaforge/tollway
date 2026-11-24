---
"@vegaforge/tollway-server": minor
"@vegaforge/tollway-observability": patch
---

Report settled and failed payments to an optional structural observer (#106).

- `PaywallDeps.observer` records a metric and emits `receipt.created` for each fresh settlement, and records a `failed` metric for a rejected verification or a settlement that fails or throws. Replays from the cache, and requests that share another request's settlement of the same payment, are not reported again.
- Observer failures and rejected event deliveries go to `onObserverError` and never change the payment outcome. Event delivery is not awaited.
- Adds the exported `PaymentObserver`, `PaymentObserverMetric` and `PaymentObserverEvent` types; no runtime dependency on `@vegaforge/tollway-observability`.
- Observability stores now accept an empty `payer` on a `failed` metric, the gate's value when no payer was verified. Every other outcome still requires a payer.
