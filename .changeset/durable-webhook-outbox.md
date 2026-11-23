---
"@vegaforge/tollway-observability": minor
---

Add durable webhook delivery. `TollwayEvent` now has a stable `id` assigned at emit time, and every delivery carries `Tollway-Event-Id` and `Tollway-Delivery-Id` headers. Pass `outbox` to `createObservabilityHub` to persist one row per deliverable webhook instead of POSTing inline; `createMemoryWebhookOutbox()` and `createSqliteWebhookOutbox({ filename })` ship, with `enqueue`, atomic `claim`, `markDelivered`, `markFailed`, `deadLetter`, `listDeadLetters`, `replay` and `release`. `hub.startDispatcher()` / `hub.stop()` deliver claimed rows under a lease with jittered exponential backoff, move exhausted rows to dead letter and replay them with a fresh delivery id. Subscriptions accept `id` and `secret`; signed attempts are recomputed at send time with a fresh timestamp, and `signWebhookPayload` / `verifyWebhookSignature` are exported. The secret is never stored on a row. Without an `outbox`, `emit` keeps its inline behaviour.
