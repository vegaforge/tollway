---
date: 2026-11-20
feature: Stream live updates from the service over SSE
scope: feat
packages: []
scenario-impact: none
---

# Stream live updates from the service over SSE

The dashboard now updates in real time without page reloads.

**What changed**

`@vegaforge/tollway-service` gains `GET /v1/events/stream`, a server-sent event
endpoint that streams six typed event types as they occur:

- `receipt.created` — a new canonical signed receipt
- `channel.opened` / `channel.closed` — MPP channel lifecycle changes
- `budget.warning` — a policy budget is nearing or over its limit
- `anomaly.detected` — a spend spike or policy stop
- `metrics.delta` — running totals (settled count, open channels, anomaly count)

Events carry monotonically increasing integer ids. A client that reconnects
sends `Last-Event-ID`; the service replays missed events from a bounded
in-memory buffer (default 1 000 events). When the requested id has aged out
of the buffer the service sends a `reset` event and the client refetches its
snapshot.

A Next.js route handler at `/api/events/stream` proxies the stream server-side,
adding the `SERVICE_API_KEY` so the key never reaches the browser. EventSource
cannot set an `Authorization` header; the proxy solves this.

The `useEventStream` hook opens the stream, handles reconnect, and dispatches
Zod-validated events to registered handlers. Views gain a small
`live / reconnecting / paused` indicator. Incoming events are coalesced via
`requestAnimationFrame` so a flood of receipts does not freeze rendering.

**Dashboard views updated**

- **Receipts** — new receipts prepend (deduplicated by id); shows stream badge.
- **Channels** — `channel.opened` appends a row; `channel.closed` updates
  status in place; shows stream badge.
- **Anomalies** — now a live feed instead of an empty state; shows stream badge.
- **Overview** — headline counters (`Payments settled`, `Open channels`,
  `Anomalies detected`) update from `metrics.delta` events.

**Ordering and replicas**

Event ids are monotonic within one service process. With multiple replicas each
replica has its own counter; a client reconnecting to a different replica
receives a `reset` and refetches. See
`docs/dashboard-data-contracts.md`, "Stream ordering and resume" for details
and the Redis Streams path to fix this.

**Configuration**

`apps/dashboard/.env.example` gains two new variables:

```
SERVICE_URL=http://localhost:3200     # service base URL (default)
SERVICE_API_KEY=<at-least-16-chars>  # added server-side by the proxy
```

`apps/tollway-service/.env.example` documents the complementary
`SERVICE_API_KEY` variable on the service side.

Closes #238.
