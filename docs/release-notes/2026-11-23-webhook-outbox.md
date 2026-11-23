---
date: 2026-11-23
feature: Durable webhook delivery with a persisted outbox
scope: feat
packages: [@vegaforge/tollway-observability]
scenario-impact: needs_automation
---

# Durable webhook delivery with a persisted outbox

Webhook delivery no longer has to live and die with the process that emitted
the event. `createObservabilityHub({ outbox })` makes `emit` write one
delivery row per matching subscription and resolve once the rows are stored;
`hub.startDispatcher()` then POSTs them with jittered exponential backoff, and
`hub.stop()` waits for in-flight attempts on shutdown. Without an `outbox`,
`emit` behaves exactly as before, so the change is opt-in.

Events now carry a stable `id` (UUID) assigned at emit time. Every request
includes `Tollway-Event-Id` for receiver-side dedupe and a `Tollway-Delivery-Id`
that is new for each enqueue and replay. Delivery is at-least-once and
unordered, and a retried row is claimed under a lease so two dispatchers
sharing one store cannot deliver the same row at once. A row that spends
`maxAttempts` moves to dead letter with its last error; `listDeadLetters()`
shows it and `replay(id)` re-enqueues it with attempts reset and a fresh
delivery id.

`createSqliteWebhookOutbox({ filename })` is restart-safe and uses the
built-in `node:sqlite` module, so it adds no dependency; `createMemoryWebhookOutbox()`
covers tests and single-process demos. Rows store the subscription id, never
the secret, and a retry is signed with a fresh timestamp at send time, so a
receiver can verify forged and replayed deliveries with the exported
`verifyWebhookSignature`. The `WebhookOutbox` interface is the seam for a
shared database when a deployment needs one.

The delivery guarantees, header format, verification example and replay
workflow are in [`docs/webhook-delivery.md`](../webhook-delivery.md). The
manual scenario for restart, dead letter and replay should become an
automated test.

Closes #220.
