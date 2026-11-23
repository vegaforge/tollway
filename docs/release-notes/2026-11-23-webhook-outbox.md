---
date: 2026-11-23
feature: Durable webhook delivery with a persisted outbox
scope: feat
packages: [@vegaforge/tollway-observability]
scenario-impact: none
---

# Durable webhook delivery with a persisted outbox

Webhook delivery no longer has to live and die with the process that emitted
the event. `createObservabilityHub({ outbox })` makes `emit` write one
delivery row per matching subscription and resolve once the rows are stored;
`hub.startDispatcher()` then POSTs them with jittered exponential backoff, and
`hub.stop()` waits for in-flight attempts on shutdown. Without an `outbox`,
`emit` behaves exactly as before, so the change is opt-in. With one, `emit`
still never rejects: a row that cannot be written is listed in the report's
`failures`.

Events now carry a stable `id` (UUID) assigned at emit time. Every request
includes `Tollway-Event-Id` for receiver-side dedupe and a `Tollway-Delivery-Id`
naming the delivery row, the same across its retries and new on replay.
Delivery is at-least-once and unordered. Each claimed row carries a lease
token, and every result write must present it, so a dispatcher whose lease
expired can never overwrite the result of the one that reclaimed the row. An
outbox needs a request timeout shorter than the lease, and `stop()` aborts
requests still open before it releases their leases.

A row that spends `maxAttempts` (16 by default, retried for about 2 to 4
hours) moves to dead letter with its last error and every attempt counted;
`listDeadLetters()` shows it and `replay(id)` re-enqueues it once, with
attempts reset and a fresh delivery id. Delivered rows are purged after
`dispatcher.deliveredRetentionMs` (24 hours by default), and the memory store
drops them at once.

`createSqliteWebhookOutbox({ filename, busyTimeoutMs })` is restart-safe, uses
the built-in `node:sqlite` module (Node 22.13 or later) so it adds no
dependency, and waits briefly for a lock held by another process.
`createMemoryWebhookOutbox()` covers tests and single-process demos. Rows store
the subscription id, never the secret, and a retry is signed with a fresh
timestamp at send time, so a receiver can verify forged and replayed
deliveries with the exported `verifyWebhookSignature`. The `WebhookOutbox`
interface is the seam for a shared database when a deployment needs one.

The delivery guarantees, header format, leases, retention, verification
example and replay workflow are in
[`docs/webhook-delivery.md`](../webhook-delivery.md). The restart, dead letter
and replay paths are covered by automated tests.

Closes #220. Pull request: #326.
