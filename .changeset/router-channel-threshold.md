---
"@vegaforge/tollway-core": minor
---

Make channel promotion configurable through `createDefaultRouter({ channelThreshold })` (#105).

- `channelThreshold` is `{ requestsPerMinute, minWindowSeconds }`. Both must be positive integers; anything else throws a `TollwayError` at construction.
- The router returns `mpp-channel` with reason `traffic` only when the traffic snapshot meets both values, the offer (or, with no offer, the policy) lists `mpp-channel`, the policy allows it, and the counterparty is not quarantined. An override still wins.
- With no options the router behaves exactly as before: traffic is never promoted.
- Adds the `recovery-not-effective` error code used by channel recovery.
