# Failure modes on the payment path

What the gate does when a facilitator or the shared settlement store fails, and
what an operator should do about each case. The rule behind every row is the
one in AGENTS.md: a payment is settled at most once, and no request returns a
resource without a receipt. Where the gate cannot tell whether a payment
settled, it fails closed and keeps the payment retriable rather than guessing.

The tests that pin these rows down live in `packages/server/src/gate.failure.test.ts`
and `packages/server/src/facilitator.failure.test.ts`, driven by the harness in
`packages/server/src/testing/faults.ts`.

## Deadlines

`PaywallDeps.facilitatorTimeoutMs` bounds every `/verify` and `/settle` call,
default 15 seconds. `createHttpFacilitator({ timeoutMs })` sets a transport
deadline for the same calls; it aborts the socket, which the gate's own
deadline cannot do. Keep the transport deadline at or below the gate's, so the
connection closes first. The `@x402/core` client defaults to 90 seconds when
`timeoutMs` is omitted.

A verify that misses its deadline is a rejection, because nothing has settled
and a retry is always safe. A settle that misses its deadline is an
ambiguity, because the transaction may still land.

## Facilitator failures

| Failure | Gate outcome | Payer may have been charged | Operator action |
| ------- | ------------ | --------------------------- | --------------- |
| `/verify` hangs past the deadline | rejected, 503, reason `facilitator-timeout`, `Retry-After: 1` | no | Check facilitator health; the agent retries with the same payment. |
| `/verify` returns a malformed body, a non-protocol body, or a transport error | thrown `TollwayError("payment-failed")` | no | Adapter behaviour for a thrown gate error is #107; the payment was never settled. Check the facilitator version and URL. |
| `/settle` hangs past the deadline | rejected, 503, reason `settlement-unknown`, `Retry-After` equal to the settlement lock TTL | possibly | Do not ask the agent to pay again. Reconcile the payment nonce on chain before the lock TTL passes; a retry inside that window gets the same 503. |
| `/settle` answers success after the deadline | the original request already got the 503 above; the late receipt is written to the settlement cache | yes | None until the cache expires. A later retry replays the late receipt. |
| `/settle` returns `success: false` | rejected, 502, reason from the facilitator | no | Treat as an insufficient balance or a rejected authorization; the agent may pay again. |
| `/settle` fails at the transport layer | thrown `TollwayError("payment-failed")`, lock released | no | Retriable. Check facilitator health. |
| `/supported` fails | thrown `TollwayError("payment-failed")` | no | Capability checks are advisory; a paying request does not depend on them. |

## Settlement lock timing

A locked settlement holds a `SET NX PX` lock under `<prefix>lock:<model>:<nonce>`.
The holder renews it every third of its TTL while the settlement runs, so a slow
but healthy `/settle` keeps duplicate protection. AGENTS.md item 4.

When a settle is abandoned at its deadline the gate does not release the lock.
It stays until its TTL, and the in-flight slot for that payment is freed when
the abandoned call answers or when the TTL passes, whichever comes first. Until
then a retry of the same payment either shares the in-flight result or is
rejected with 409 `settlement in progress` from the lock.

After the lock TTL the payment is retriable again. If the abandoned `/settle`
lands later than that, the payment can settle twice. This window is the cost of
not holding a request open forever; reconcile any `settlement-unknown` before
the TTL passes if the amount matters.

## Settlement store (Redis) failures

| Failure | Gate outcome | Payer may have been charged | Operator action |
| ------- | ------------ | --------------------------- | --------------- |
| `get` fails | thrown store error, nothing verified, nothing settled | no | Fail closed by design. Restore Redis; the agent retries. |
| `SET NX` for the lock fails or the lock is held elsewhere | thrown store error, or rejected 409 `settlement in progress` | no | A 409 means another process is settling this payment; a thrown error means the store is down. |
| `set` fails after a successful settlement | settled, 200 with the receipt, `cacheError` set and sent to `onCacheError` | yes | The payer got its receipt. A retry may not be recognised as a replay until the write succeeds or the TTL passes. |
| `release` fails after a successful settlement | settled, 200 with the receipt, `cacheError` set | yes | The lock expires at its TTL. Check Redis latency. |
| renewal fails or the lock is lost mid-settlement | settled, 200 with the receipt, `lockLost` and `cacheError` set | yes | Treat as an alert: another process may have settled the same payment. Reconcile the nonce. |
| the store is slower than the lock TTL | bounded by the TTL; `lockLost` is reported when the lock cannot be confirmed | yes | Raise `settlementLockTtlMs` above the observed p99, or fix the store. |

## Multi-process deployments

Everything in this page assumes the lock methods are implemented. A cache
without `acquire`, `renew` and `release` (the in-memory cache) only deduplicates
concurrent requests inside one process, so the 409 and lock-abandonment rows do
not apply across replicas. Use `createRedisSettlementCache` for more than one
process.
