---
"@vegaforge/tollway-client": minor
"@vegaforge/tollway-server": minor
---

Retry x402 payments only where a retry cannot pay twice (#203).

- `createClient({ retry: { maxAttempts, sleep } })`, on by default with
  `maxAttempts: 2`: a payment the service challenged again is re-checked
  against the policy and signed afresh for the same terms; a payment the
  service is still settling is resent unchanged after `Retry-After` (at most
  30 seconds); a payment that may have landed rejects with
  `AmbiguousSettlementError` and is never retried.
- New `retry` client event, `SettlementOutcomeError`, `SignedTerms`,
  `MAX_RETRY_AFTER_MS`, and `SettleRequest.pinned`. A custom settler that
  wants retries throws `SettlementOutcomeError`; anything else still fails
  at once.
- The gate's "settlement in progress" 409 now carries `Retry-After: 1`.
