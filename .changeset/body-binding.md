---
"@vegaforge/tollway-core": minor
"@vegaforge/tollway-server": minor
"@vegaforge/tollway-adapter-express": minor
"@vegaforge/tollway-adapter-fastify": minor
"@vegaforge/tollway-adapter-hono": minor
"@vegaforge/tollway-adapter-next": minor
---

Bind the request body into the paid resource identity with `PaywallConfig.bindBody` (#164). The identity becomes `<resource>#body-sha256=<digest>`, so a payment for one body never unlocks another and the receipt records which body was paid. Bodies over `maxBytes` get 413 `body-too-large` before any facilitator call, and compressed bodies or unlisted media types get 415 `body-not-supported`; both use the gate error body and are listed in `GATE_ERRORS`. With several payment options, every option is offered under the bound identity. Core adds `bodyDigest` and `bindBodyToResource` so a client computes the same identity. Every adapter passes the body without consuming it; Fastify needs the new `fastifyRawBody` preParsing hook.
