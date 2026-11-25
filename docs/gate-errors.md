# Gate error codes

Every rejection the gate returns carries a stable `code` (#161). Clients branch
on the code; the `message` is for people and may change between releases. All
four adapters (Express, Fastify, Hono, Next, including the Next proxy) render a
rejection with `renderGateRejection` from `@vegaforge/tollway-server`, so the
status, headers and body are identical in every framework.

## Body

```json
{
  "error": {
    "code": "payment-invalid",
    "message": "the payment was refused",
    "upstreamReason": "invalid_exact_stellar_payload_wrong_amount"
  }
}
```

- `code` is one of the codes below. It is never a facilitator's own string.
- `message` is a human-readable explanation.
- `upstreamReason` is present only when the facilitator, the MPP handler or
  the local pre-validator gave a reason of its own. It is passed through as
  received, for logs and debugging. Its vocabulary is upstream's (for x402 on
  Stellar, the `invalidReason` names of `@x402/stellar`), so do not build
  client logic on it.

## Codes

"Retry the same payment" says whether sending the identical signed payment
again is safe and may succeed. Where it is "no", the agent pays the fresh
challenge, fixes its request, or stops.

| Code | Status | Retry the same payment | Headers | When |
| ---- | ------ | ---------------------- | ------- | ---- |
| `payment-malformed` | 400 | no | | `PAYMENT-SIGNATURE` is not a base64 x402 V2 payload, has another `x402Version`, or an MPP payment arrived in it. Also a malformed `payment-identifier` extension or id, or a missing id on a route that requires one (#153). |
| `payment-invalid` | 402 | no | `PAYMENT-REQUIRED` | The payment was refused: by the local pre-validator (#159), by `/verify`, or by the MPP handler. The fresh challenge lets the agent sign again without another unpaid request. |
| `service-policy:not-allowed` | 403 | no | | The service policy does not serve this payer (allowlist miss or denylist hit; the answer does not say which). |
| `service-policy:rate-limited` | 429 | yes, after `Retry-After` | `Retry-After` | The payer made too many requests in the current window. |
| `service-policy:spend-exceeded` | 429 | yes, after `Retry-After` | `Retry-After` | The payer would exceed its spend cap in the current window. |
| `offer-mismatch` | 409 | no | | This payment already settled for another resource, price, asset, payee, network, model or HTTP method. Never retry it. |
| `settlement-in-progress` | 409 | yes, after `Retry-After` | `Retry-After` | Another request, in this process or another, is settling the same payment right now. |
| `settlement-failed` | 502 | no | | The facilitator refused to settle. The payment is free to be paid again with a new signature. |
| `facilitator-unavailable` | 503 | yes, after `Retry-After` | `Retry-After` | The facilitator could not be reached, answered with something unusable, or missed the `/verify` deadline. Nothing was settled. |
| `settlement-unknown` | 503 | yes, after `Retry-After` | `Retry-After` | `/settle` may have landed. The payment is held until the outcome is known; `Retry-After` is the hold. A retry after it either replays the receipt or settles a payment known not to have landed. |
| `facilitator-invalid-response` | 500 | no | | The facilitator's `/verify` answer contradicts the payment (its nonce differs from the payment's idempotency key). |
| `price-unavailable` | 500 | no | | The route's dynamic price function threw or returned an invalid price. Nothing was charged. |
| `handler-not-configured` | 500 | no | | The route accepts a model whose handler is missing, or a route table is not ready. |
| `model-not-supported` | 501 | no | | The router chose a settlement model this gate does not implement. |
| `work-failed` | 424 | yes | | Only from `createPaidCall`, such as a paid MCP tool: the paid work failed after the payment was verified, so nothing was settled or cached. The same payment may be sent again. |
| `payment-not-settled` | 503 | yes, after `Retry-After` | `Retry-After` | Two-phase settlement (#152): the payment was verified but not settled, because the route failed or the settlement lock lapsed while it ran. A request that waited on that payment gets this; the payment is still unspent. |
| `handler-timeout` | 504 | no | | Two-phase settlement: the route ran longer than the payment's validity window (`maxTimeoutSeconds`), so the payment was not settled. |
| `response-too-large` | 500 | no | | Two-phase settlement: the route's response was larger than `twoPhase.maxResponseBytes`, so it was discarded and the payment was not settled. |
| `channel-refused` | 402 | no | | The MPP channel named in `TOLLWAY-CHANNEL` failed its on-chain checks, or is settling or closed (#173). The message starts with a channel code from [mpp-channels.md](mpp-channels.md). |
| `channel-rate-limited` | 429 | yes, after `Retry-After` | `Retry-After` | Too many channel registrations, or the fee payer's close budget is spent (#173, #174). |

`GATE_ERRORS` exports this table (status, retry guidance and headers per code)
and `GATE_ERROR_CODES` lists the codes, so services and clients can read it
instead of copying it.

## Retry-After

| Code | Default | Setting |
| ---- | ------- | ------- |
| `settlement-in-progress` | 1 second | `PaywallDeps.retryAfterSeconds.settlementInProgress` |
| `facilitator-unavailable` | 1 second | `PaywallDeps.retryAfterSeconds.facilitatorUnavailable` |
| `settlement-unknown` | the hold, `ambiguousSettlementHoldMs` rounded up to seconds | `PaywallDeps.ambiguousSettlementHoldMs` |
| `service-policy:*` | the time left in the policy window | the policy's `windowSeconds` |
| `channel-rate-limited` | the time left in the registration window, or 1 second for closes | `MppChannelOptions.registrationLimit` |

A settlement normally finishes in a few seconds, well inside the lock TTL, so a
one-second wait for `settlement-in-progress` keeps the agent close behind the
request that holds the payment. Raise it to throttle clients that retry hard.

## Thrown errors

Only failures the gate can classify become rejections. A facilitator client
signals unavailability by throwing a `TollwayError` with code
`facilitator-unavailable` (`createHttpFacilitator`, the failover client and the
MPP charge handler do), and the failover client signals a possibly landed
settlement with `outcome-unknown`. Any other error thrown inside the gate is a
defect, not a payment outcome, and still propagates to the framework's error
handler.

## Breaking change

Before #161 the body was `{ "error": "<reason>" }`, and a facilitator transport
failure was thrown as `TollwayError("payment-failed")`, which each framework
rendered differently. Clients that read `error` as a string must read
`error.code` instead. Custom facilitator clients that want a 503 rather than a
thrown error throw `TollwayError("facilitator-unavailable", ...)`, keeping the
network error as `cause` so a refused connection can be told apart from one that
may have reached the facilitator.
