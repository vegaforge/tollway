# Durable webhook delivery

`@vegaforge/tollway-observability` can deliver webhook events from a persisted
outbox instead of POSTing inline during `emit`. The outbox makes a delivery
survive a process restart, gives a failed delivery a bounded retry schedule,
keeps an exhausted delivery for an operator to replay, and lets a receiver
dedupe on ids that are stable across attempts and processes.

Delivery is **at-least-once**. Ordering is **not** guaranteed: a retried row
can arrive after a later event, and two dispatchers can interleave. A receiver
that must not process an event twice dedupes on `Tollway-Event-Id`.

## Opting in

Pass an `outbox` to the hub. Without one, `emit` keeps the inline behaviour
and nothing is persisted.

```ts
import {
  createObservabilityHub,
  createSqliteWebhookOutbox,
} from "@vegaforge/tollway-observability";

const outbox = createSqliteWebhookOutbox({ filename: "/var/lib/tollway/webhooks.db" });
const hub = createObservabilityHub({
  outbox,
  webhooks: [
    {
      id: "billing",
      url: "https://billing.example.com/tollway",
      events: ["receipt.created"],
      secret: process.env.TOLLWAY_WEBHOOK_SECRET,
    },
  ],
  dispatcher: { maxAttempts: 8, intervalMs: 1_000, batchSize: 50 },
});

hub.startDispatcher();

await hub.emit({
  type: "receipt.created",
  at: new Date().toISOString(),
  data: { receiptId: "r-1" },
});

// On shutdown:
await hub.stop();
```

`emit` resolves once the rows are written. It does not wait for a delivery.
Local handlers registered with `hub.on` still run inline, with the existing
retry policy, whether or not an outbox is configured.

## Rows, ids and headers

`emit` assigns `TollwayEvent.id` (a UUID) once, at emit time, unless the caller
supplied one. Every delivery of that event carries the same id. Each delivery
also gets its own delivery id, new on every enqueue and replay.

| Header | Meaning |
| ------ | ------- |
| `Tollway-Event-Id` | The event id. Dedupe on this. |
| `Tollway-Delivery-Id` | This attempt's row id. Useful in delivery logs. |
| `Tollway-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256>` when the subscription has a secret. |

An outbox row stores the subscription id, the event and bookkeeping. It never
stores the subscription secret or its extra headers. The dispatcher resolves
the subscription in memory at send time, so after a restart the same
subscriptions must be registered again; a row whose subscription is gone is
dead-lettered instead of delivered to a guessed URL.

Give each subscription a stable `id` when two subscriptions share a URL.
Without one the id defaults to the URL.

## Signing and verification

The signature covers the exact bytes sent, including the `t=` prefix in the
signed string, and is recomputed on every attempt with a fresh timestamp. The
secret never appears in a delivery error, a row or a log.

```ts
import { verifyWebhookSignature } from "@vegaforge/tollway-observability";

const result = await verifyWebhookSignature({
  payload: rawBody, // exact bytes received, not a parsed and re-serialized object
  header: request.headers["tollway-signature"] ?? "",
  secret: process.env.TOLLWAY_WEBHOOK_SECRET ?? "",
});
if (!result.valid) {
  return new Response(null, { status: 401 });
}
```

`toleranceSeconds` defaults to 300 and rejects a captured delivery replayed
later. The comparison is constant time. A receiver should also dedupe on
`Tollway-Event-Id` for direct replays inside the tolerance window.

## Backoff

A failed attempt is retried after a jittered exponential delay: half of the
capped delay is fixed, half is random, so retries of one outage do not arrive
together. The defaults are 100ms before the second attempt, a 2x factor, a
60s cap and 3 attempts. `dispatcher.maxAttempts`, `initialDelayMs`,
`backoffFactor`, `maxDelayMs`, `batchSize`, `leaseMs`, `intervalMs` and
`stopTimeoutMs` override them. A subscription without a secret is delivered
unsigned, exactly as before.

## Leases

`claim(batch, leaseMs)` takes due rows with one atomic statement and leases
them for `leaseMs`. A second dispatcher, in this process or another one
sharing the SQLite file, cannot claim a row that is still leased. If a
process dies, the lease expires and the row becomes claimable again; that is
why delivery is at-least-once rather than exactly-once. `stop()` waits up to
`stopTimeoutMs` for in-flight deliveries and releases the leases of rows that
are still running, so another dispatcher can retry them immediately.

Timers are unref'd, so a dispatcher alone never keeps a Node process alive.

## Dead letters and replay

When a row reaches `maxAttempts`, it moves to `dead-letter` with its last
error. It stays out of claims until an operator replays it:

```ts
const dead = await outbox.listDeadLetters();
for (const row of dead) {
  console.warn(row.id, row.eventId, row.subscriptionId, row.lastError);
}

const replacement = await outbox.replay(dead[0].id);
// `replacement.id` is new, attempts are back to 0, the event id is unchanged.
```

`replay` throws for an unknown id or a row that has not dead-lettered, rather
than pretending it worked. The original dead-letter row stays in the list as
a record.

## Stores

| Store | Restart-safe | Use |
| ----- | ------------ | --- |
| `createMemoryWebhookOutbox()` | No | Tests and single-process demos. |
| `createSqliteWebhookOutbox({ filename })` | Yes | One host, or several processes on one filesystem. |

The SQLite store uses the built-in `node:sqlite` module (Node 22.13 or later;
it needs the `--experimental-sqlite` flag on 22.5 to 22.12) and adds no
dependency. The claim is one `UPDATE ... RETURNING` inside `BEGIN IMMEDIATE`,
which is what makes concurrent dispatchers safe. The store does not replace
the metrics store planned in [#217](https://github.com/vegaforge/tollway/issues/217).

`WebhookOutbox` is an interface. A deployment that needs a shared database can
implement it elsewhere as long as `claim` is atomic, and pass the
implementation to the hub.
