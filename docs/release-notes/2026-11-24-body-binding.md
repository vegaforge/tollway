---
date: 2026-11-24
feature: Bind the request body into the paid resource, so a payment for one body never unlocks another
scope: fix
packages: ["@vegaforge/tollway-core", "@vegaforge/tollway-server", "@vegaforge/tollway-adapter-express", "@vegaforge/tollway-adapter-fastify", "@vegaforge/tollway-adapter-hono", "@vegaforge/tollway-adapter-next"]
scenario-impact: none
---

# Body binding

A route where the body is what is bought, such as `POST /infer`, used to have one resource identity for every body. A payment settled for a cheap prompt was a valid cached replay for an expensive one, and the receipt said only `/infer`. The regression test reproduced this: body A's payment, replayed with body B behind a shared cache, settled.

`PaywallConfig.bindBody: { maxBytes, contentTypes? }` now binds the SHA-256 of the exact body bytes into the identity: `/infer#body-sha256=<base64url digest>`. It goes in the challenge, the cache binding and the receipt, so the replay gets 409 and the receipt shows which body was paid. Routes without `bindBody` are unchanged. `bodyDigest` and `bindBodyToResource` in `@vegaforge/tollway-core` let a client compute the same identity before paying; `docs/receipt-format.md` documents the format.

A body over `maxBytes` gets 413 before any payment is decoded or any facilitator is called: a `Content-Length` over the limit is refused without reading, and a chunked body as soon as the limit is passed. A body with a `Content-Encoding` other than `identity` gets 415, because the digest is over the bytes as sent. A route that binds the body but gets none from its adapter fails closed with 500.

Every adapter hands the gate the body without consuming the handler's copy. Hono and Next read a clone. Express uses the raw bytes a parser kept (`express.raw()`, or `req.rawBody` from `express.json({ verify })`), or reads the stream itself and leaves the bytes on `req.body`. Fastify gets a new `fastifyRawBody` preParsing hook that keeps the raw bytes and hands the parser an identical stream. The Next proxy passes no body, so `bindBody` routes behind it fail closed; use `withPaywall` for them. The design choices this issue left to its thread (the `#body-sha256=` format and refusing compressed bodies) are explained on the new "Paying for a request body" docs page.

Closes #164. Pull request: #338.
