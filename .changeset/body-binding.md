---
"@vegaforge/tollway-core": minor
"@vegaforge/tollway-server": minor
"@vegaforge/tollway-adapter-express": minor
"@vegaforge/tollway-adapter-fastify": minor
"@vegaforge/tollway-adapter-hono": minor
"@vegaforge/tollway-adapter-next": minor
---

Bind the request body into the paid resource identity with `PaywallConfig.bindBody` (#164). The identity becomes `<resource>#body-sha256=<digest>`, so a payment for one body never unlocks another and the receipt records which body was paid. Bodies over `maxBytes` get 413 before any facilitator call, and compressed bodies get 415. Core adds `bodyDigest` and `bindBodyToResource` so a client computes the same identity. Every adapter passes the body without consuming it; Fastify needs the new `fastifyRawBody` preParsing hook.
