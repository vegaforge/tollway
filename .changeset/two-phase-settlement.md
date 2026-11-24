---
"@vegaforge/tollway-server": minor
"@vegaforge/tollway-adapter-express": minor
"@vegaforge/tollway-adapter-fastify": minor
"@vegaforge/tollway-adapter-hono": minor
"@vegaforge/tollway-adapter-next": minor
---

Add opt-in two-phase settlement: settle only after the route handler succeeds. `createPaywall` now returns a `PaywallGate` with `authorize(request)`, which verifies and locks a payment and returns an `authorized` outcome carrying `settle()` and `abandon(reason)`. Every adapter takes `{ settlement: "after-handler" }` (default `"before-handler"`, unchanged): the route runs with its response held, a route that throws or answers a failure status (any 5xx by default) is never charged, and a failed settlement replaces the held response with the rejection. `PaywallConfig.twoPhase` sets the failure statuses and the response limit (1 MiB by default). The server also exports `holdNodeResponse`, `readBodyWithin`, `responseTooLarge`, `settlementTiming` and `twoPhaseAuthorizer` for adapters.
