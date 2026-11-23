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
  dispatcher: { batchSize: 50 },
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

`emit` resolves once the rows are written. It does not wait for a delivery,
and it never rejects: if the rows cannot be written (for example, the SQLite
file stays locked past the busy timeout), each webhook is listed in the
returned `DeliveryReport.failures` with `attempts: 0` and passed to
`onDeliveryFailure`. Those events are not stored, so alert on them.

Local handlers registered with `hub.on` still run inline, with the `retry`
policy, whether or not an outbox is configured. The outbox does not use
`retry`; see "Backoff" below.

## Rows, ids and headers

`emit` assigns `TollwayEvent.id` (a UUID) once, at emit time, unless the caller
supplied one. Every delivery of that event carries the same id. Each delivery
row also has its own delivery id. It is the same on every retry of that row,
and new only when a row is enqueued or replayed.

| Header | Meaning |
| ------ | ------- |
| `Tollway-Event-Id` | The event id. Dedupe on this. |
| `Tollway-Delivery-Id` | The delivery row's id: the same across retries of one row, new on replay. Useful in delivery logs. |
| `Tollway-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256>` when the subscription has a secret. |

An outbox row stores the subscription id, the event and bookkeeping. It never
stores the subscription secret or its extra headers. The dispatcher resolves
the subscription in memory at send time, so after a restart the same
subscriptions must be registered again; a row whose subscription is gone is
dead-lettered instead of delivered to a guessed URL.

Give each subscription a stable `id` when two subscriptions share a URL.
Without one the id defaults to the URL.

## Signing and verification

The signed string is `"<t>.<body>"`: the unix timestamp from the header, a
dot, then the exact body bytes sent. The signature is recomputed on every
attempt with a fresh timestamp. The secret never appears in a delivery error,
a row or a log. An empty `secret` is refused when the subscription is
registered; leave the field out to send unsigned.

A receiver verifies the raw body, before parsing it. With a Fetch API
`Request`:

```ts
import { verifyWebhookSignature } from "@vegaforge/tollway-observability";

export async function handleTollwayWebhook(request: Request): Promise<Response> {
  const secret = process.env.TOLLWAY_WEBHOOK_SECRET;
  if (!secret) throw new Error("TOLLWAY_WEBHOOK_SECRET is not set");

  // The exact bytes received, not a parsed and re-serialized object.
  const rawBody = await request.text();
  const result = await verifyWebhookSignature({
    payload: rawBody,
    header: request.headers.get("tollway-signature") ?? "",
    secret,
  });
  if (!result.valid) {
    return new Response(null, { status: 401 });
  }
  const event: unknown = JSON.parse(rawBody);
  // Dedupe on event.id (also sent as Tollway-Event-Id), then process it.
  return new Response(null, { status: 204 });
}
```

`toleranceSeconds` defaults to 300 and rejects a captured delivery replayed
later. The comparison is constant time. A receiver should also dedupe on
`Tollway-Event-Id` for direct replays inside the tolerance window.

## Backoff

A failed attempt is retried after a jittered exponential delay: half of the
capped delay is fixed, half is random, so retries of one outage do not arrive
together. The defaults are sized for an outage rather than a blip: 1 second
before the second attempt, a 2x factor, a 1 hour cap and 16 attempts, which
keeps a row retrying for between about 2 and 4 hours before it dead-letters.
`dispatcher.maxAttempts`, `initialDelayMs`, `backoffFactor`, `maxDelayMs`,
`batchSize`, `leaseMs`, `intervalMs` and `stopTimeoutMs` override them. The
hub's `retry` option applies to inline delivery and local handlers only. A
subscription without a secret is delivered unsigned, exactly as before.

## Leases

`claim(batch, leaseMs)` takes due rows atomically and leases each one for
`leaseMs` under a fresh lease token. A second dispatcher, in this process or
another one sharing the SQLite file, cannot claim a row that is still leased.
If a process dies, the lease expires and the row becomes claimable again;
that is why delivery is at-least-once rather than exactly-once.

Every result (delivered, failed, dead letter, released) is written only if
the writer still holds the row's lease token. A dispatcher that lost its
lease changes nothing, and reports a `WebhookLeaseLostError` through
`onError`, so it can never turn a row another dispatcher delivered into a
dead letter.

Two rules keep a lease from expiring while its request is still open:

- With an outbox, `requestTimeoutMs` must be at least 1ms (the default is
  5000ms), and `dispatcher.leaseMs` (default 30000ms) must be longer. The
  hub refuses any other combination at construction.
- `stop()` waits up to `stopTimeoutMs` for in-flight deliveries. After that it
  aborts the requests still open, and only then releases their leases, so
  another dispatcher can retry them without the first request still running.
  The abort ends the attempt even if a custom `fetch` ignores its signal.

Timers are unref'd, so a dispatcher alone never keeps a Node process alive.

Timers are unref'd, so a dispatcher alone never keeps a Node process alive.

## Dead letters and replay

When a row reaches `maxAttempts`, it moves to `dead-letter` with its last
error. It stays out of claims until an operator replays it:

```ts
const dead = await outbox.listDeadLetters();
for (const row of dead) {
  console.warn(row.id, row.eventId, row.subscriptionId, row.attempts, row.lastError);
  if (row.replayedAs === null) {
    const replacement = await outbox.replay(row.id);
    // `replacement.id` is new, attempts are back to 0, the event id is unchanged.
    console.info(`replayed ${row.id} as ${replacement.id}`);
  }
}
```

`attempts` on a dead letter counts every POST, the last one included; a row
dead-lettered because its subscription is gone shows only the attempts that
were sent. `replay` throws for an unknown id, a row that has not
dead-lettered, or one that was already replayed, rather than pretending it
worked or sending the event twice. The original dead-letter row stays in the
list as a record, with `replayedAs` naming its replacement.

## Retention

Delivered rows are not needed after delivery, so they are removed:

- The memory store drops a row as soon as it is delivered.
- The dispatcher purges delivered rows from the store once they are older than
  `dispatcher.deliveredRetentionMs` (default 24 hours), checking at most once
  per `dispatcher.purgeIntervalMs` (default 1 minute). Keep the window long
  enough for whatever reads delivered rows for audit, or call
  `outbox.purgeDelivered(olderThan)` yourself on your own schedule.

Pending and dead-letter rows are never purged. Dead letters stay until an
operator deals with them, so watch `listDeadLetters()` and alert on growth. A
replayed dead letter can be deleted from the database by hand once the
replacement is delivered.

## Stores

| Store | Restart-safe | Use |
| ----- | ------------ | --- |
| `createMemoryWebhookOutbox()` | No | Tests and single-process demos. |
| `createSqliteWebhookOutbox({ filename, busyTimeoutMs? })` | Yes | One host, or several processes on one filesystem. |

The SQLite store uses the built-in `node:sqlite` module and adds no
dependency. It needs Node 22.13 or later, where the module works without a
flag; on an older Node, `createSqliteWebhookOutbox` throws an error naming the
version it needs. The claim runs inside `BEGIN IMMEDIATE`, which is what makes
concurrent dispatchers safe.

When several processes share one file, a write waits up to `busyTimeoutMs`
(default 500ms) for another connection's lock before it fails with `database is
locked`. `node:sqlite` is synchronous, so that wait blocks the event loop:
keep it short. A failed claim is retried on the next pass, and a failed
enqueue is reported by `emit` as described above. The store does not replace
the metrics store planned in [#217](https://github.com/vegaforge/tollway/issues/217).

`WebhookOutbox` is an interface. A deployment that needs a shared database can
implement it elsewhere as long as `claim` is atomic, and pass the
implementation to the hub.
