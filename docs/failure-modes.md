# Failure modes on the payment path

What the gate does when a facilitator or the shared settlement store fails, and
what an operator should do about each case. The rule behind every row is the
one in AGENTS.md: a payment is settled at most once, and no request returns a
resource without a receipt. Where the gate cannot tell whether a payment
settled, it fails closed and keeps the payment retriable rather than guessing.

The tests that pin these rows down live in `packages/server/src/gate.failure.test.ts`
and `packages/server/src/facilitator.failure.test.ts`, driven by the harness in
`packages/server/src/testing/faults.ts`.

## Deadlines and the settlement hold

`PaywallDeps.facilitatorTimeoutMs` bounds how long the gate waits for each
`/verify` and `/settle` call, default 15 seconds. `createHttpFacilitator({ timeoutMs })`
sets a transport deadline for the same calls; it aborts the socket, which the
gate's own deadline cannot do. The `@x402/core` client defaults to 90 seconds
when `timeoutMs` is omitted.

A `/verify` that misses its deadline is a rejection, because nothing has settled
and a retry is always safe.

A `/settle` whose outcome is unknown is held. That covers a `/settle` that
misses the gate's deadline, and one that fails after the request may have
reached the facilitator: a transport timeout, a connection reset, or an error
answer. Only a failure that proves the request never left the process (a
refused connection, or a DNS failure: `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`
in the cause chain) frees the payment at once.

While a payment is held:

- this process keeps the payment's in-flight slot, so a retry here shares the
  held attempt and gets the same answer;
- this process keeps renewing the cross-process settlement lock, so a retry in
  any other process gets 409 `settlement in progress`;
- nothing calls `/settle` for the payment again.

The hold ends at the first of:

- the abandoned call answers with a success: the receipt is written to the
  settlement cache first, so a retry replays it;
- the abandoned call answers with a definite failure (`success: false`, or a
  refused connection): the payment can be tried again;
- `PaywallDeps.ambiguousSettlementHoldMs` has passed since the `/settle` call
  started, default 120 seconds.

Set `ambiguousSettlementHoldMs` to at least the payment authorization's lifetime
(`maxTimeoutSeconds`, 60 seconds by default) plus the facilitator transport
timeout. After that the authorization can no longer be submitted, so a retry
cannot settle a payment that is still in flight. The gate refuses a hold that is
not longer than `facilitatorTimeoutMs`.

If the process holding a payment dies, its lock is no longer renewed and expires
after `settlementLockTtlMs`. That is the one case where a retry can reach
`/settle` while the first call may still land.

## Facilitator failures

| Failure | Gate outcome | Payer may have been charged | Operator action |
| ------- | ------------ | --------------------------- | --------------- |
| `/verify` hangs past the deadline | rejected, 503, reason `facilitator-timeout`, `Retry-After: 1` | no | Check facilitator health; the agent retries with the same payment. |
| `/verify` returns a malformed body, a non-protocol body, or a transport error | thrown `TollwayError("payment-failed")` | no | Adapter behaviour for a thrown gate error is #107; the payment was never settled. Check the facilitator version and URL. |
| `/settle` hangs past the deadline | rejected, 503, reason `settlement-unknown`, `Retry-After` equal to the hold; payment held | possibly | Do not ask the agent to pay again. If the hold ends without an answer, reconcile the payment nonce on chain. |
| `/settle` answers success after the deadline | the original request already got the 503 above; the late receipt is cached, then the hold ends | yes | None. A retry replays the late receipt. |
| `/settle` answers success after the deadline but the cache write fails | the hold continues to its end; the failure goes to `onCacheError` | yes | Reconcile the nonce on chain: once the hold ends, a retry would settle again. |
| `/settle` returns `success: false` | rejected, 502, reason from the facilitator; payment freed | no | Treat as an insufficient balance or a rejected authorization; the agent may pay again. |
| `/settle` fails after the request may have been sent (timeout, reset, error answer) | thrown `TollwayError("payment-failed")`; payment held | possibly | Same as a hung `/settle`: retries are refused until the hold ends. Check facilitator health. |
| `/settle` connection refused or DNS failure | thrown `TollwayError("payment-failed")`; payment freed at once | no | Retriable. Check the facilitator URL and health. |
| `/supported` fails | the gate never calls it; payments are unaffected | no | Capability checks run at startup (`createFacilitatorValidator`); see the deployment guide. |

## Settlement lock timing

A locked settlement holds a `SET NX PX` lock under `<prefix>lock:<model>:<nonce>`.
The holder renews it every third of its TTL while the settlement runs, and for
as long as the payment is held, so a slow `/settle` or an ambiguous one keeps
duplicate protection across processes. AGENTS.md item 4.

When the hold ends the gate releases the lock. A lock that was lost or could
not be released during the hold is reported through `onCacheError`.

## Settlement store (Redis) failures

| Failure | Gate outcome | Payer may have been charged | Operator action |
| ------- | ------------ | --------------------------- | --------------- |
| `get` fails | thrown store error, nothing verified, nothing settled | no | Fail closed by design. Restore Redis; the agent retries. |
| `SET NX` for the lock fails or the lock is held elsewhere | thrown store error, or rejected 409 `settlement in progress` | no | A 409 means another process is settling this payment; a thrown error means the store is down. |
| `set` fails after a successful settlement | settled, 200 with the receipt, `cacheError` set and sent to `onCacheError` | yes | The payer got its receipt. A retry may not be recognised as a replay until the write succeeds or the TTL passes. |
| `release` fails after a successful settlement | settled, 200 with the receipt, `cacheError` set | yes | The lock expires at its TTL. Check Redis latency. |
| renewal fails or the lock is lost mid-settlement | settled, 200 with the receipt, `lockLost` and `cacheError` set | yes | Treat as an alert: another process may have settled the same payment. Reconcile the nonce. |
| the store is slower than the lock TTL | the lock can expire while `/settle` runs; `lockLost` is reported with the receipt | yes | Treat as an alert: a second process that received the same payment in that gap could have settled it too. Keep store latency well under a third of `settlementLockTtlMs`, or raise the TTL. |
| a foreign or corrupt value under the settlement key | treated as a miss; the payment settles once and the entry is overwritten | yes | Check for another tenant or a manual write sharing the key prefix. |

## Multi-process deployments

Everything in this page assumes the lock methods are implemented. A cache
without `acquire`, `renew` and `release` (the in-memory cache) only deduplicates
concurrent requests inside one process, so the 409 rows and the cross-process
part of the hold do not apply across replicas. Use `createRedisSettlementCache` for more than one
process.
