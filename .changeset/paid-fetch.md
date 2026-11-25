---
"@vegaforge/tollway-client": minor
---

Add `createPaidFetch`, a drop-in `fetch` that pays x402 V2 and MPP 402 challenges through `client.pay()` and returns the paid `Response` with the verified receipt (#201). `createClient` takes `settlers` (one per model, never falling through to another model), `PayRequest.exchange` and `PayResult.response`, and settlers gain an optional `settleExchange` that answers a 402 the caller already received and replays the caller's request, so a paid call is exactly two HTTP requests. `SettlementOutcomeError` carries the refusing 402 as `challenge` for the retry.
