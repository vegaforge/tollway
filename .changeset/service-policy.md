---
"@vegaforge/tollway-server": minor
"@vegaforge/tollway-adapter-express": minor
"@vegaforge/tollway-adapter-fastify": minor
"@vegaforge/tollway-adapter-hono": minor
"@vegaforge/tollway-adapter-next": minor
---

Add an optional per-payer service policy to the gate: payer allow and deny lists, requests per payer per window, and spend per payer per asset per window, evaluated after `/verify` and before settlement. Denials carry stable `service-policy:*` reason codes, window denials carry `Retry-After`, and a denied payment is never sent to `/settle`. State is bounded to 10 000 payers in memory with LRU eviction and sits behind `ServicePolicyStore` for a shared store (#190). Framework adapters pass rejection headers through, including `Retry-After`.
