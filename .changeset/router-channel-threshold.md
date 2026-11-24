---
"@vegaforge/tollway-core": minor
---

Make channel promotion configurable through `createDefaultRouter({ channelThreshold })` (#105).

- `channelThreshold` is a positive finite integer number of requests per minute; invalid values throw a `TollwayError` at construction.
- With no options the router behaves exactly as before: traffic is not promoted to MPP channels automatically.
- Promotion still requires an eligible route, no quarantine and a usable channel adapter.
- Adds the `recovery-not-effective` error code used by channel recovery.
