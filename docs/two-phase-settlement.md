# Two-phase settlement: settle after the route succeeds

By default the gate settles a payment before the route handler runs. That is
the cheapest path, but a handler that then throws or answers 500 has already
charged the payer, and an x402 settlement cannot be undone. Two-phase
settlement changes the order for routes that can fail after payment, such as
inference or data endpoints under load: the payment is verified and locked,
the route runs with its response held, and the payment settles only if the
route succeeded (#152).

## Turning it on

Every adapter takes the same option, `settlement`, with the same two values.
`"before-handler"` is the default and behaves exactly as before.

```ts
import { createPaywall } from "@vegaforge/tollway-server";
import { expressPaywall } from "@vegaforge/tollway-adapter-express";
import { fastifyPaywall } from "@vegaforge/tollway-adapter-fastify";
import { honoPaywall } from "@vegaforge/tollway-adapter-hono";
import { withPaywall } from "@vegaforge/tollway-adapter-next";

const gate = createPaywall(config, deps);

app.get("/infer", expressPaywall(gate, { settlement: "after-handler" }), handler);
fastify.get("/infer", { preHandler: fastifyPaywall(gate, { settlement: "after-handler" }) }, handler);
hono.get("/infer", honoPaywall(gate, { settlement: "after-handler" }), handler);
export const GET = withPaywall(gate, handler, { settlement: "after-handler" });
```

Route tables take it too: `expressRouteTable(table, options)`,
`fastifyRouteTable`, `honoRouteTable` and `withRouteTable(table, handler, options)`.

The gate must come from `createPaywall` or a route table: a hand-written
`Gate` function has no `authorize`, and the adapter refuses it at construction.

## What the route sees

No receipt exists while the route runs. `res.locals.tollwayReceipt`
(Express), `request.tollwayReceipt` (Fastify), the `tollwayReceipt` context
variable (Hono) and the `receipt` argument (Next) are only set for a replay
of a payment that already settled. In Next, a handler used in this mode has
the type `AfterHandlerPaidHandler`, whose `receipt` is optional.

## What the client sees

| The route | /settle | The client gets |
| --------- | ------- | --------------- |
| answers 2xx, 3xx or 4xx | succeeds | the route's response with `PAYMENT-RESPONSE` and `TOLLWAY-RECEIPT` added |
| answers 2xx, 3xx or 4xx | refuses | 502 `settlement-failed`, with the facilitator's reason in `upstreamReason`; the route's response and headers are discarded |
| answers a failure status (any 5xx by default) | never called | the route's response, unchanged, with no payment headers |
| throws | never called | the framework's error response; Next rethrows the error |
| writes more than `maxResponseBytes` | never called | 500 `response-too-large`; the route's response is discarded |
| outlives the payment's validity window | never called | 504 `handler-timeout` |
| any, while the gate itself fails (authorize or settle throws) | not reached, or unknown | 502 with `{ "error": "payment backend unavailable" }`, the same answer every adapter gives a throwing gate (#107) |
| holds the lock past a lost renewal | never called | 503 `payment-not-settled` (message starting `lock-lost`), `Retry-After: 1` |

A request that duplicates a payment while its route is still running waits
for it. If that payment settles, the duplicate gets a replay. If it does not,
the duplicate gets 503 `payment-not-settled` with `Retry-After: 1`,
because the payment is still unspent and may be sent again.

A replay of a payment that already settled runs the route like the
single-shot gate does, and nothing settles a second time, whatever the route
answers.

### How a throw is detected

Hono and Next see the thrown error itself, so a throw never settles, even
under an error handler that answers 200. Express and Fastify hand a thrown
error to their own error handler before the response reaches the gate, so
there the throw is recognised by the status that handler writes. Their
default handlers answer 500. An app whose error handler answers a thrown
error with a non-failure status should widen `twoPhase.isFailureStatus` to
cover it.

The shared adapter conformance suite (`@vegaforge/tollway-server/testing`,
`runAdapterConformance`) runs these cases through all four adapters, each
driver mounting its adapter with `settlement: "after-handler"`, and asserts
the `/settle` count in every case.

A two-phase attempt reports to the gate's `observer` (#106) like a
single-shot one: a settled payment records a `settled` metric and emits
`receipt.created` once `settle()` succeeds; an abandoned one records
`failed`. The recorded latency runs from authorization to the decision, so it
includes the route's own time.

## Configuration

Set on the paywall (or route) config, under `twoPhase`:

- `isFailureStatus(status)`: which statuses abandon the payment. Defaults to
  any 5xx.
- `maxResponseBytes`: the most the adapter holds while settling, counted as
  the route writes, so a streamed response is cut off as soon as it passes
  the limit. Defaults to 1 MiB. A positive integer is required.

The handler has the payment's validity window, `maxTimeoutSeconds` (60 by
default), counted from authorization. A route that takes longer is
abandoned with 504 instead of being settled late.

## What you give up

- The whole response is held in memory until settlement finishes, up to
  `maxResponseBytes`. Streaming to the client starts only after settlement,
  so two-phase mode does not suit long-lived streams.
- The client waits for the handler and `/settle` in sequence, so latency is
  the handler's time plus the settlement's.
- The settlement lock is held, and renewed every third of
  `settlementLockTtlMs`, for the handler's whole run. If a renewal fails, the
  payment is not settled (503 `payment-not-settled`) because another process may have
  taken it over.

## Calling it without an adapter

`createPaywall` returns a `PaywallGate`: the single-shot function plus
`authorize(request)`. `authorize` answers `payment-required`, `rejected`,
`settled` (a replay) or `authorized`. An `authorized` payment carries
`settle()`, `abandon(reason)`, `isFailure(status)` and `maxResponseBytes`.
Call exactly one of `settle()` or `abandon()`. A second `settle()`, or
`settle()` after `abandon()`, throws a `TypeError`; `abandon()` is
idempotent and does nothing after `settle()`. The helpers the adapters use,
`holdNodeResponse` for a Node `ServerResponse` and `readBodyWithin` for a Web
`Response`, are exported from `@vegaforge/tollway-server` for other
frameworks.
